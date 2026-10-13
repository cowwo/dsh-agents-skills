// dsh-agents-skills · 独立页（服务端渲染）测试
//
// 覆盖三块：
//   1. 转义与表单解析（XSS 与开放重定向的第一道防线）；
//   2. 请求处理器：门禁拒绝、GET 渲染、POST 动作与回跳、检查结果缓存与摘除；
//   3. **分组规则对照**：宿主 `groupSkills` 与设置页 `buildGroups` 必须输出一致
//      （两份实现、一份语义；不一致这条测试就会红）。
//
// 不联网、不跑 CLI：deps 全部用替身。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, '..');
const libDir = join(packageDir, 'lib');

/**
 * 解析一个 DSH 自带的模块（测试环境里没有 profile 的依赖树）。
 * @param {string} specifier 裸包名
 * @returns {object} 模块
 */
function requireDsh(specifier) {
  const anchors = [
    process.argv[1],
    process.env.DSH_HOME === undefined ? undefined : join(process.env.DSH_HOME, 'profiles', 'web', 'cordis.yml'),
    '/root/.dsh/profiles/web/cordis.yml',
    join(packageDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  ].filter((anchor) => typeof anchor === 'string');
  for (const anchor of anchors) {
    try {
      return createRequire(anchor)(specifier);
    } catch { /* 换下一个锚点 */ }
  }
  throw new Error(`无法解析 ${specifier}：找不到正在运行的 DSH 安装`);
}

/** @returns {Promise<object>} lib/page.js */
async function loadPage() {
  return await import(pathToFileURL(join(libDir, 'page.js')).href);
}

/** @returns {Promise<object>} lib/skills.js */
async function loadSkills() {
  return await import(pathToFileURL(join(libDir, 'skills.js')).href);
}

/**
 * 造一个假的请求对象（把请求体按真实流的方式异步派发）。
 * @param {{ method?: string, url?: string, body?: string, headers?: object }} options 选项
 * @returns {object} 假请求
 */
function fakeReq(options = {}) {
  const method = options.method ?? 'GET';
  const url = options.url ?? '/dsh-agents-skills';
  const body = options.body ?? '';
  const listeners = { data: [], end: [], error: [] };
  const req = {
    method,
    url,
    headers: options.headers ?? { host: 'localhost:3081' },
    on(event, callback) {
      if (listeners[event] !== undefined) listeners[event].push(callback);
      return req;
    },
    destroy() { /* 替身不需要真的销毁 */ },
  };
  queueMicrotask(() => {
    if (body.length > 0) for (const callback of listeners.data) callback(Buffer.from(body));
    for (const callback of listeners.end) callback();
  });
  return req;
}

/** @returns {object} 假响应 */
function fakeRes() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers ?? {};
      return res;
    },
    end(chunk) {
      if (chunk !== undefined) res.body += String(chunk);
    },
  };
  return res;
}

/**
 * 造一个技能行。
 * @param {string} name 名字
 * @param {string} source 来源仓库（空串 = 本地未托管）
 * @param {object} [extra] 额外字段
 * @returns {object} 技能行
 */
function skillOf(name, source, extra = {}) {
  return {
    name,
    dirName: name,
    kind: 'bundle',
    path: '/root/.agents/skills/' + name + '/SKILL.md',
    description: name + ' 的说明',
    detail: '',
    valid: true,
    modelInvocable: true,
    userInvocable: true,
    managed: source.length > 0,
    source,
    installedAt: '2026-09-09T13:30:29.698Z',
    updatedAt: '2026-09-09T13:30:29.698Z',
    ...extra,
  };
}

/**
 * 造首屏数据。
 * @param {object[]} skills 技能行
 * @returns {object} overview
 */
function overviewOf(skills) {
  return {
    ok: true,
    agentsHome: '/root/.agents',
    root: '/root/.agents/skills',
    lockPath: '/root/.agents/.skill-lock.json',
    lockExists: true,
    npxPath: '/usr/local/bin/npx',
    tokenSource: 'gh',
    tokenUser: 'cowwo',
    skills,
    repos: [],
    notes: [],
    pagePath: '/dsh-agents-skills',
    error: '',
  };
}

/**
 * 造检查结果。
 * @returns {object} delta
 */
function deltaOf() {
  return {
    ok: true,
    checkedAt: '2026-10-10T03:00:00.000Z',
    tokenSource: 'gh',
    rateLimitText: '本次剩余 4990/5000',
    repos: [{
      source: 'a/b',
      mode: 'api',
      available: 3,
      installed: 2,
      newSkills: [{ name: 'new-one', path: 'skills/new-one', remoteHash: 'h1' }],
      updatable: [{ name: 'tdd', path: 'skills/tdd', installedHash: 'old', remoteHash: 'new' }],
      orphan: [{ name: 'gone', path: 'skills/gone' }],
      error: '',
    }],
    error: '',
  };
}

/**
 * 造一个可观测的依赖集合。
 * @param {object} [overrides] 覆盖项
 * @returns {object} deps
 */
function depsOf(overrides = {}) {
  const calls = { check: 0, search: 0, action: [], agentWrite: [] };
  const deps = {
    pagePath: '/dsh-agents-skills',
    guard: () => undefined,
    overview: async () => overviewOf([skillOf('tdd', 'a/b'), skillOf('gone', 'a/b'), skillOf('mine', '')]),
    check: async () => { calls.check += 1; return deltaOf(); },
    search: async () => { calls.search += 1; return { ok: true, query: 'react', results: [{ repo: 'x/y', skill: 'z', installs: '1.2K', url: 'https://skills.sh/x/y/z' }], command: 'npx -y skills find react', note: '共 1 条', error: '' }; },
    action: async (request) => { calls.action.push(request); return { ok: true, kind: request.kind, command: 'npx -y skills ' + request.kind, code: 0, durationMs: 1200, output: '', summary: request.kind + ' 完成', error: '' }; },
    agentRead: async () => ({
      ok: true,
      path: '/root/.dsh/AGENTS.md',
      exists: true,
      size: 12,
      content: '# 全局规则\n',
      bytes: 0,
      backup: '',
      limitBytes: 65536,
      error: '',
    }),
    agentWrite: async (content) => {
      calls.agentWrite.push(content);
      if (typeof content !== 'string') return { ok: false, path: '/root/.dsh/AGENTS.md', exists: false, size: 0, content: '', bytes: 0, backup: '', limitBytes: 65536, error: '参数 content 必须是字符串' };
      return { ok: true, path: '/root/.dsh/AGENTS.md', exists: true, size: Buffer.byteLength(content, 'utf8'), content, bytes: Buffer.byteLength(content, 'utf8'), backup: '/root/.dsh/AGENTS.md.bak', limitBytes: 65536, error: '' };
    },
    ...overrides,
  };
  return { deps, calls };
}

test('escapeHtml：远端仓库来的文本一律转义', async () => {
  const { escapeHtml } = await loadPage();
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('a"b\'c&d'), 'a&quot;b&#39;c&amp;d');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(42), '42');
});

test('parseForm：重复的 skills 收集成数组', async () => {
  const { parseForm } = await loadPage();
  const form = parseForm('action=install&source=a%2Fb&skills=pr&skills=tdd&back=%3Fcheck%3D1');
  assert.equal(form.get('action'), 'install');
  assert.equal(form.get('source'), 'a/b');
  assert.deepEqual(form.all('skills'), ['pr', 'tdd']);
  assert.equal(form.get('back'), '?check=1');
  assert.equal(form.get('missing'), '');
});

test('safeBack：只接受本站相对查询串，挡住开放重定向', async () => {
  const { safeBack } = await loadPage();
  assert.equal(safeBack('?check=1&todo=1', '/dsh-agents-skills'), '/dsh-agents-skills?check=1&todo=1');
  assert.equal(safeBack('', '/dsh-agents-skills'), '/dsh-agents-skills');
  assert.equal(safeBack('https://evil.example/', '/dsh-agents-skills'), '/dsh-agents-skills');
  assert.equal(safeBack('//evil.example', '/dsh-agents-skills'), '/dsh-agents-skills');
  assert.equal(safeBack('?a=//evil', '/dsh-agents-skills'), '/dsh-agents-skills');
  assert.equal(safeBack('?<script>', '/dsh-agents-skills'), '/dsh-agents-skills');
});

test('门禁拒绝时直接返回 401/403，不读请求体也不渲染', async () => {
  const { createPageHandler } = await loadPage();
  for (const rejection of [401, 403]) {
    const { deps } = depsOf({ guard: () => rejection });
    const handler = createPageHandler(deps);
    const res = fakeRes();
    await handler(fakeReq(), res);
    assert.equal(res.status, rejection);
    assert.equal(res.body.includes('<html'), false);
  }
});

test('GET：渲染分组列表，远端说明里的脚本被转义', async () => {
  const { createPageHandler } = await loadPage();
  const evil = skillOf('evil', 'a/b', { description: '<script>alert(1)</script>', valid: false, modelInvocable: false });
  const { deps } = depsOf({ overview: async () => overviewOf([skillOf('tdd', 'a/b'), evil, skillOf('mine', '')]) });
  const handler = createPageHandler(deps);
  const res = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=skills' }), res);

  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.headers['content-security-policy'], /default-src 'none'/);
  assert.equal(res.body.includes('<script>alert(1)</script>'), false, '脚本必须被转义');
  assert.match(res.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(res.body, /a\/b/, '仓库分组在');
  assert.match(res.body, /本地·未托管/);
  assert.match(res.body, /格式不合规/);
  assert.match(res.body, /仅用户可用/);
  assert.match(res.body, /检查更新/);
  assert.match(res.body, /回到 DSH 界面/);
  assert.deepEqual(
    [...res.body.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]),
    ['<script src="/dsh-agents-skills?asset=page-ui.js" defer>'],
    '唯一的脚本标签是外链交互层',
  );
});

test('GET ?check=1：渲染待办徽章，并在两分钟内复用缓存', async () => {
  const { createPageHandler } = await loadPage();
  let clock = 1000;
  const { deps, calls } = depsOf();
  const handler = createPageHandler({ ...deps, now: () => clock });

  const first = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=skills&check=1' }), first);
  assert.equal(calls.check, 1);
  assert.match(first.body, /新增 1/);
  assert.match(first.body, /可更新 1/);
  assert.match(first.body, /已移除 1/);
  assert.match(first.body, /上游已移除/);

  clock += 60000;
  const second = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=skills&check=1' }), second);
  assert.equal(calls.check, 1, '两分钟内不该再发请求');

  clock += 120000;
  const third = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=skills&check=1' }), third);
  assert.equal(calls.check, 2, '超过缓存时长要重查');

  const forced = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=skills&check=2' }), forced);
  assert.equal(calls.check, 3, 'check=2 强制重查');
});

test('GET ?todo=1：只留有事的仓库与待办行', async () => {
  const { createPageHandler } = await loadPage();
  const { deps } = depsOf();
  const handler = createPageHandler(deps);
  const res = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=skills&check=1&todo=1' }), res);
  assert.match(res.body, /new-one/, '新增行在');
  assert.match(res.body, /gone/, '上游已移除行在');
  assert.equal(res.body.includes('本地·未托管'), false, '未托管组被隐藏');
  assert.match(res.body, /显示全部/);
});

test('GET ?q=：走搜索并渲染结果', async () => {
  const { createPageHandler } = await loadPage();
  const { deps, calls } = depsOf();
  const handler = createPageHandler(deps);
  const res = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=skills&q=react' }), res);
  assert.equal(calls.search, 1);
  assert.match(res.body, /x\/y@z/);
  assert.match(res.body, /1\.2K/);
  assert.match(res.body, /<th>仓库@技能<\/th><th>安装量<\/th>/, '搜索结果也是一张表');
});

test('技能列表：8 列纯平铺，每行都写仓库名，没有 rowspan / 分组行', async () => {
  const { createPageHandler } = await loadPage();
  const { deps } = depsOf();
  const handler = createPageHandler(deps);
  const res = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=skills&check=1' }), res);

  assert.match(res.body, /<table class="skills">/);
  assert.match(res.body, /<th class="pick"><\/th><th>仓库<\/th><th>技能<\/th><th>状态<\/th><th>说明<\/th><th>来源路径<\/th><th>装于<\/th><th class="actions">操作<\/th>/);
  assert.match(res.body, /<colgroup>/, '固定列宽用 colgroup');

  // 平铺：每行都是 8 个单元格，没有任何合并
  const tbody = res.body.slice(res.body.indexOf('<tbody>'), res.body.indexOf('</tbody>'));
  const perRow = [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => (m[1].match(/<td/g) || []).length);
  assert.equal(perRow.length, 4, '四行数据（tdd / gone / new-one / mine）');
  assert.deepEqual([...new Set(perRow)], [8], '每行都是 8 个单元格');
  assert.equal(/rowspan/.test(tbody), false, '表体里没有 rowspan（CSS 注释里提到它是另一回事）');
  assert.equal(/<tr class="group"/.test(res.body), false, '没有分组行');
  assert.equal(/colspan/.test(tbody), false, '表体里没有跨列单元格');

  // 每行都写仓库名：看「仓库」这一格本身，a/b 的两行各写一次
  const repoCells = [...tbody.matchAll(/<td class="mono repo-name"><span class="clip" title="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(repoCells, ['a/b', 'a/b', 'a/b', '本地·未托管'], '每行都写仓库名（a/b 三行各写一次），本地行写「本地·未托管」');
  assert.match(tbody, /本地·未托管/);

  // 仓库条：仓库级按钮在这里
  assert.match(res.body, /<div class="repostrip">/);
  assert.match(res.body, /name="row" value="check\|a\/b\|">重查</, '仓库条里有重查');
  assert.match(res.body, /name="row" value="installAll\|a\/b\|">装全部新增 \(1\)</, '仓库条里有批量安装');
  assert.match(res.body, /name="row" value="updateAll\|a\/b\|">更新全部 \(1\)</, '仓库条里有批量更新');

  // 滚动结构：表体自己滚、表头 sticky 偏移 0（偏移非 0 会盖住第一行）
  assert.match(res.body, /<main class="content skills-page">/, '技能页的 main 带 skills-page');
  assert.match(res.body, /\.table-scroll \{ flex: 1 1 auto; min-height: 0; overflow: auto;/);
  // flex 列里的横条不许被压缩：批量条曾被压到 20px，按钮溢出压住了表头
  assert.match(res.body, /\.content\.skills-page > \*:not\(\.skills-form\) \{ flex: 0 0 auto; \}/);
  assert.match(res.body, /\.batchbar \{ flex: 0 0 auto; min-height: 34px;/);
  assert.match(res.body, /\.repostrip \{ flex: 0 0 auto;/);
  assert.match(res.body, /thead th \{ position: sticky; top: 0;/);
  // 表头的粘性偏移必须是 0：非 0 会让表头被"往下推"，盖住第一行（上一版就是这么坏的）。
  assert.equal(/thead th \{ position: sticky; top: [1-9]/.test(res.body), false, '表头粘性偏移必须是 0');
  // 单元格一律不做 sticky（左栏 .nav 的 sticky 是另一回事，它是相对视口的）
  for (const selector of ['td.repo', 'td.pick', 'td.actions', 'th.pick', 'th.actions']) {
    assert.equal(new RegExp(selector.replace('.', '\\.') + '[^{}]*\\{[^}]*position: sticky').test(res.body), false,
      selector + ' 不做 sticky');
  }
  assert.match(res.body, /<form class="skills-form" method="post">/);
});

test('操作列只挂有意义的按钮：已装且最新的行只有「删除」', async () => {
  const { createPageHandler } = await loadPage();
  const { deps } = depsOf();
  const handler = createPageHandler(deps);
  const res = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=skills&check=1' }), res);

  const tbody = res.body.slice(res.body.indexOf('<tbody>'), res.body.indexOf('</tbody>'));
  const rows = [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  const actionsOf = (html) => {
    const cell = /<td class="actions">([\s\S]*?)<\/td>/.exec(html);
    return [...cell[1].matchAll(/value="(\w+)\|/g)].map((m) => m[1]);
  };
  const byName = new Map(rows.map((html) => [/name="row" value="[^|]+\|[^|]*\|([^"]+)"/.exec(html)?.[1]
    ?? /title="([^"]+)"/.exec(html)?.[1], html]));
  const findRow = (name) => rows.find((html) => html.includes('>' + name + '<'));

  assert.deepEqual(actionsOf(findRow('new-one')), ['install'], '新增行只有安装');
  assert.deepEqual(actionsOf(findRow('gone')), ['remove'], '上游已移除行只有删除');
  assert.deepEqual(actionsOf(findRow('mine')), ['remove'], '已装且最新的行只有删除，没有「更新」');
});

test('POST action=check：只重查一个仓库，并并进缓存', async () => {
  const { createPageHandler } = await loadPage();
  const seen = [];
  const { deps } = depsOf({
    check: async (request) => {
      seen.push(request.sources);
      return {
        ok: true,
        checkedAt: '2026-10-10T04:00:00.000Z',
        tokenSource: 'gh',
        rateLimitText: '',
        repos: [{ source: 'a/b', mode: 'api', available: 9, installed: 3, newSkills: [], updatable: [], orphan: [], error: '' }],
        error: '',
      };
    },
  });
  const handler = createPageHandler(deps);

  const res = fakeRes();
  await handler(fakeReq({ method: 'POST', body: 'row=' + encodeURIComponent('check|a/b|') + '&back=' + encodeURIComponent('?tab=skills&check=1') }), res);
  assert.equal(res.status, 303);
  assert.deepEqual(seen, [['a/b']], '只查这一个仓库');
  assert.match(decodeURIComponent(res.headers.location), /已重查 a\/b/);

  const after = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=skills&check=1' }), after);
  // 已装数来自 overview（2 个），可用数来自这次重查（9）——两者拼在一起才是这一格的读数。
  assert.match(after.body, /已装 2\/9/, '重查结果并进了缓存');
});

test('POST install：参数正确、303 回跳、并摘掉刚装上的「新增」', async () => {
  const { createPageHandler } = await loadPage();
  const { deps, calls } = depsOf();
  const handler = createPageHandler(deps);

  const before = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=skills&check=1' }), before);
  assert.match(before.body, /new-one/);

  const res = fakeRes();
  await handler(fakeReq({
    method: 'POST',
    body: 'row=' + encodeURIComponent('install|a/b|new-one') + '&back=' + encodeURIComponent('?check=1'),
  }), res);
  assert.equal(res.status, 303);
  assert.match(res.headers.location, /^\/dsh-agents-skills\?check=1&msg=/, '回跳必须是本站绝对路径');
  assert.match(res.headers.location, /ok=1/);
  assert.equal(calls.action.length, 1);
  assert.deepEqual(calls.action[0], { kind: 'install', source: 'a/b', name: '', skills: ['new-one'] });

  const after = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=skills&check=1' }), after);
  assert.equal(after.body.includes('new-one'), false, '刚装上的不该再显示为新增');
});

test('POST remove / update：动作与摘除规则', async () => {
  const { createPageHandler } = await loadPage();
  const { deps, calls } = depsOf();
  const handler = createPageHandler(deps);
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=skills&check=1' }), fakeRes());

  const removed = fakeRes();
  await handler(fakeReq({ method: 'POST', body: 'row=' + encodeURIComponent('remove||gone') }), removed);
  assert.equal(removed.status, 303);
  assert.deepEqual(calls.action[0], { kind: 'remove', source: '', name: 'gone', skills: [] });

  const updated = fakeRes();
  await handler(fakeReq({ method: 'POST', body: 'batch=update&pick=' + encodeURIComponent('a/b|tdd') + '&pick=' + encodeURIComponent('a/b|other') }), updated);
  assert.deepEqual(calls.action[1], { kind: 'update', source: '', name: '', skills: ['tdd', 'other'] });

  const after = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=skills&check=1' }), after);
  assert.equal(after.body.includes('>上游已移除<'), false, '删掉的已移除项要消失（页脚说明文字不算）');
  assert.equal(after.body.includes('可更新 1'), false, '更新过的可更新项要消失');
});

test('批量安装：按仓库分组，一个仓库只跑一次 CLI', async () => {
  const { createPageHandler } = await loadPage();
  const { deps, calls } = depsOf();
  const handler = createPageHandler(deps);
  const res = fakeRes();
  await handler(fakeReq({
    method: 'POST',
    body: 'batch=install'
      + '&pick=' + encodeURIComponent('a/b|new-one')
      + '&pick=' + encodeURIComponent('a/b|new-two')
      + '&pick=' + encodeURIComponent('x/y|other'),
  }), res);

  assert.equal(res.status, 303);
  assert.equal(calls.action.length, 2, '两个仓库 → 两次调用');
  assert.deepEqual(calls.action[0], { kind: 'install', source: 'a/b', name: '', skills: ['new-one', 'new-two'] });
  assert.deepEqual(calls.action[1], { kind: 'install', source: 'x/y', name: '', skills: ['other'] });
  assert.match(decodeURIComponent(res.headers.location), /安装 3 个/);
});

test('批量删除与批量更新：一次提交处理多行', async () => {
  const { createPageHandler } = await loadPage();
  const { deps, calls } = depsOf();
  const handler = createPageHandler(deps);

  const removed = fakeRes();
  await handler(fakeReq({ method: 'POST', body: 'batch=remove&pick=' + encodeURIComponent('a/b|gone') + '&pick=' + encodeURIComponent('a/b|other') }), removed);
  assert.equal(calls.action.length, 2, 'remove 一次只吃一个名字，逐个跑');
  assert.match(decodeURIComponent(removed.headers.location), /删除 2 个/);

  const updated = fakeRes();
  await handler(fakeReq({ method: 'POST', body: 'batch=update&pick=' + encodeURIComponent('a/b|tdd') }), updated);
  assert.deepEqual(calls.action[2], { kind: 'update', source: '', name: '', skills: ['tdd'] });
});

test('仓库格的批量按钮走检查缓存：没检查过就提示先检查', async () => {
  const { createPageHandler } = await loadPage();
  const { deps, calls } = depsOf();
  const handler = createPageHandler(deps);

  const cold = fakeRes();
  await handler(fakeReq({ method: 'POST', body: 'row=' + encodeURIComponent('installAll|a/b|') }), cold);
  assert.equal(calls.action.length, 0);
  assert.match(decodeURIComponent(cold.headers.location), /还没检查过/);

  await handler(fakeReq({ url: '/dsh-agents-skills?tab=skills&check=1' }), fakeRes());
  const warm = fakeRes();
  await handler(fakeReq({ method: 'POST', body: 'row=' + encodeURIComponent('installAll|a/b|') }), warm);
  assert.deepEqual(calls.action[0], { kind: 'install', source: 'a/b', name: '', skills: ['new-one'] }, '用缓存里的新增名单');
  assert.match(decodeURIComponent(warm.headers.location), /安装 1 个/);
});

test('?pickall=1：待办行默认勾上，已装行没有勾选框', async () => {
  const { createPageHandler } = await loadPage();
  const { deps } = depsOf();
  const handler = createPageHandler(deps);
  const res = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=skills&check=1&pickall=1' }), res);

  assert.match(res.body, /name="pick" value="a\/b\|new-one" checked/, '新增行被勾上');
  assert.match(res.body, /name="pick" value="a\/b\|gone" checked/, '上游已移除行被勾上');
  assert.match(res.body, /name="pick" value="a\/b\|tdd" checked/, '可更新行也是待办，一起勾上');
  assert.match(res.body, /取消全选/, '再点一次可以取消');
  // 已装且无事可做的行（本地未托管的 mine）连勾选框都不给
  assert.equal(res.body.includes('value="|mine"'), false, '已装且最新的行没有勾选框');
});

test('POST 非法动作与非法回跳都被挡住', async () => {
  const { createPageHandler } = await loadPage();
  const { deps, calls } = depsOf();
  const handler = createPageHandler(deps);

  const bad = fakeRes();
  await handler(fakeReq({ method: 'POST', body: 'row=' + encodeURIComponent('nope||x') + '&back=' + encodeURIComponent('https://evil.example') }), bad);
  assert.equal(bad.status, 303);
  assert.match(bad.headers.location, /^\/dsh-agents-skills\?msg=/, '回跳必须落回本站路径');
  assert.equal(calls.action.length, 0);
});

test('POST 动作抛错时给出人话，不把异常丢给宿主', async () => {
  const { createPageHandler } = await loadPage();
  const { deps } = depsOf({ action: async () => { throw new Error('npx 不见了'); } });
  const handler = createPageHandler(deps);
  const res = fakeRes();
  await handler(fakeReq({ method: 'POST', body: 'row=' + encodeURIComponent('remove||gone') }), res);
  assert.equal(res.status, 303);
  assert.match(decodeURIComponent(res.headers.location), /npx 不见了/);
});

test('POST action=subscribe：调依赖、303 带着 message 与 back 回跳', async () => {
  const { createPageHandler } = await loadPage();
  const seen = [];
  const { deps } = depsOf({
    subscribe: async (source) => {
      seen.push(source);
      return { ok: true, kind: 'subscribe', source, summary: '已订阅 ' + source, error: '' };
    },
  });
  const handler = createPageHandler(deps);
  const res = fakeRes();
  await handler(fakeReq({
    method: 'POST',
    body: 'action=subscribe&source=' + encodeURIComponent('mattpocock/skills') + '&back=' + encodeURIComponent('?tab=skills&check=1'),
  }), res);

  assert.equal(res.status, 303);
  assert.deepEqual(seen, ['mattpocock/skills']);
  assert.match(res.headers.location, /^\/dsh-agents-skills\?tab=skills&check=1&msg=/, '回跳必须落回本站路径');
  assert.match(decodeURIComponent(res.headers.location), /已订阅 mattpocock\/skills/);
  assert.match(res.headers.location, /ok=1/);
});

test('POST action=subscribe：没有 subscribe 依赖时退化为现有行为', async () => {
  const { createPageHandler } = await loadPage();
  const { deps } = depsOf();
  assert.equal(deps.subscribe, undefined, '缺省就是没有这个动作');
  const handler = createPageHandler(deps);
  const res = fakeRes();
  await handler(fakeReq({ method: 'POST', body: 'action=subscribe&source=a/b' }), res);

  assert.equal(res.status, 303);
  assert.match(decodeURIComponent(res.headers.location), /没有要执行的动作/);
  assert.equal(res.headers.location.includes('ok=1'), false);
});

test('POST action=subscribe：失败给人话；guard 拦下时根本不调依赖', async () => {
  const { createPageHandler } = await loadPage();
  let called = 0;
  const failing = depsOf({
    subscribe: async () => {
      called += 1;
      return { ok: false, kind: 'subscribe', source: '', summary: '', error: '仓库写法应为 owner/repo' };
    },
  });
  const res = fakeRes();
  await createPageHandler(failing.deps)(fakeReq({ method: 'POST', body: 'action=subscribe&source=' + encodeURIComponent('不是仓库') }), res);
  assert.equal(res.status, 303);
  assert.match(decodeURIComponent(res.headers.location), /订阅失败：仓库写法应为 owner\/repo/);
  assert.equal(called, 1);

  const guarded = depsOf({
    guard: () => 401,
    subscribe: async () => {
      called += 1;
      return { ok: true, kind: 'subscribe', source: 'a/b', summary: '已订阅 a/b', error: '' };
    },
  });
  const denied = fakeRes();
  await createPageHandler(guarded.deps)(fakeReq({ method: 'POST', body: 'action=subscribe&source=a/b' }), denied);
  assert.equal(denied.status, 401);
  assert.equal(called, 1, 'guard 拒绝后不许调 subscribe');
});

test('订阅仓渲染：installed=0、items 空的组不炸，仓库条与空表行都在', async () => {
  const { createPageHandler } = await loadPage();
  const { deps } = depsOf({
    overview: async () => ({ ...overviewOf([]), repos: [{ source: 'sub/repo', installed: 0, names: [] }] }),
  });
  const handler = createPageHandler(deps); // 不给 subscriptions 依赖：从 overview 的合并结果里认订阅仓
  const res = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=skills' }), res);

  assert.equal(res.status, 200);
  assert.match(res.body, /sub\/repo/);
  assert.match(res.body, /已装 0/);
  assert.match(res.body, /未检查/);
  assert.match(res.body, /<tbody><tr><td class="pick"><\/td>/, '一个技能都没有时，表体给「空表」行而不是真空');
  assert.equal(res.body.includes('undefined'), false);
});

test('路由接线：插件挂上 /dsh-agents-skills，门禁接的是 connection.requestRejection', async () => {
  const { Context, Service } = requireDsh('@deepseek-ai/cordis');
  const previousHome = process.env.DSH_AGENTS_HOME;
  const home = await mkdtemp(join(tmpdir(), 'dsh-skills-route-'));
  process.env.DSH_AGENTS_HOME = home;
  try {
    /** 假 webServer：只记录注册进来的路由。 */
    class FakeWebServer extends Service {
      constructor(ctx) {
        super(ctx, 'webServer');
        this.routes = [];
      }

      register(route) {
        this.routes.push(route);
        return () => { this.routes = this.routes.filter((item) => item !== route); };
      }
    }

    /** 假 connection：记录被问过的请求，并按配置返回拒绝码。 */
    class FakeConnection extends Service {
      constructor(ctx) {
        super(ctx, 'connection');
        this.seen = [];
        this.rejection = undefined;
      }

      requestRejection(request) {
        this.seen.push(request.headers.host);
        return this.rejection;
      }
    }

    const ctx = new Context();
    ctx.plugin(FakeWebServer);
    ctx.plugin(FakeConnection);
    const { default: GlobalAgentService } = await import(pathToFileURL(join(libDir, 'index.js')).href);
    new GlobalAgentService(ctx, {});
    for (let waited = 0; ctx.get('skillsPanel') === undefined && waited < 200; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    for (let waited = 0; ctx.get('webServer').routes.length === 0 && waited < 200; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const webServer = ctx.get('webServer');
    assert.equal(webServer.routes.length, 1, '必须只注册一条路由');
    assert.equal(webServer.routes[0].kind, 'exact');
    assert.equal(webServer.routes[0].path, '/dsh-agents-skills');

    // 没登录：connection 说 401 → 路由必须原样返回 401，且不渲染
    const connection = ctx.get('connection');
    connection.rejection = 401;
    const denied = fakeRes();
    await webServer.routes[0].handler(fakeReq(), denied);
    assert.equal(denied.status, 401);
    assert.equal(denied.body.includes('<html'), false);
    assert.deepEqual(connection.seen, ['localhost:3081'], '门禁拿到的就是原始请求');

    // 登录过：正常渲染，并且 overview 里带上了挂载路径（设置页据此显示入口链接）
    connection.rejection = undefined;
    const ok = fakeRes();
    await webServer.routes[0].handler(fakeReq(), ok);
    assert.equal(ok.status, 200);
    assert.match(ok.body, /<title>Agents&amp;Skills/);
    const shadow = ctx.extend({ invocation: { namespace: 'skillsPanel', method: 'overview' } }).get('skillsPanel');
    const overview = await Reflect.get(shadow, 'overview').call(shadow, {});
    assert.equal(overview.pagePath, '/dsh-agents-skills');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_AGENTS_HOME;
    else process.env.DSH_AGENTS_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('真实接线：POST action=subscribe 写清单 + 顺带检查一次新增（index.js）', async () => {
  const { Context, Service } = requireDsh('@deepseek-ai/cordis');
  const previousHome = process.env.DSH_AGENTS_HOME;
  const home = await mkdtemp(join(tmpdir(), 'dsh-skills-sub-'));
  process.env.DSH_AGENTS_HOME = home;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      tree: [
        { path: 'skills/one', type: 'tree', sha: 's1' },
        { path: 'skills/one/SKILL.md', type: 'blob', sha: 'b1' },
        { path: 'skills/two', type: 'tree', sha: 's2' },
        { path: 'skills/two/SKILL.md', type: 'blob', sha: 'b2' },
      ],
    }),
  });
  try {
    /** 假 webServer：只记录注册进来的路由。 */
    class FakeWebServer extends Service {
      constructor(ctx) {
        super(ctx, 'webServer');
        this.routes = [];
      }

      register(route) {
        this.routes.push(route);
        return () => { this.routes = this.routes.filter((item) => item !== route); };
      }
    }

    /** 假 connection：登录过（不拒绝）。 */
    class FakeConnection extends Service {
      constructor(ctx) {
        super(ctx, 'connection');
      }

      requestRejection() {
        return undefined;
      }
    }

    const ctx = new Context();
    ctx.plugin(FakeWebServer);
    ctx.plugin(FakeConnection);
    const { default: GlobalAgentService } = await import(pathToFileURL(join(libDir, 'index.js')).href);
    new GlobalAgentService(ctx, {});
    for (let waited = 0; ctx.get('webServer') === undefined || ctx.get('webServer').routes.length === 0; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (waited > 200) break;
    }

    const res = fakeRes();
    await ctx.get('webServer').routes[0].handler(fakeReq({
      method: 'POST',
      body: 'action=subscribe&source=' + encodeURIComponent('mattpocock/skills'),
    }), res);

    assert.equal(res.status, 303);
    const location = decodeURIComponent(res.headers.location);
    assert.match(location, /ok=1/);
    assert.match(location, /已订阅 mattpocock\/skills/);
    assert.match(location, /新增 2/, '顺带的检查结论并进 summary');
    assert.deepEqual(JSON.parse(await readFile(join(home, '.skill-subscriptions.json'), 'utf8')), ['mattpocock/skills']);
  } finally {
    globalThis.fetch = realFetch;
    if (previousHome === undefined) delete process.env.DSH_AGENTS_HOME;
    else process.env.DSH_AGENTS_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('GET ?tab=agent：渲染编辑器、路径、字节数、草稿提示，且不发任何检查请求', async () => {
  const { createPageHandler } = await loadPage();
  const { deps, calls } = depsOf();
  const handler = createPageHandler(deps);
  const res = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=agent' }), res);

  assert.equal(res.status, 200);
  assert.match(res.body, /<title>Agents&amp;Skills/);
  assert.match(res.body, /\/root\/\.dsh\/AGENTS\.md/);
  assert.match(res.body, /已存在 · 12 字节 · 上限 65536 字节/);
  assert.match(res.body, /name="content"/);
  assert.match(res.body, /# 全局规则/, '正文回填进 textarea');
  assert.match(res.body, /切换标签会丢弃未保存的修改/);
  assert.match(res.body, /name="action" value="saveAgent"/);
  assert.equal(calls.check, 0, '打开 Agent 页不该发 GitHub 请求');
  assert.deepEqual(
    [...res.body.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]),
    ['<script src="/dsh-agents-skills?asset=page-ui.js" defer>'],
    '唯一的脚本标签是外链交互层',
  );
  assert.equal(res.headers['set-cookie'].startsWith('dsh-agents-skills-tab=agent'), true, '要记住标签');
  assert.match(res.headers['set-cookie'], /HttpOnly; SameSite=Strict/);
});

test('GET ?tab=agent：正文里的脚本被转义在 textarea 里', async () => {
  const { createPageHandler } = await loadPage();
  const { deps } = depsOf({
    agentRead: async () => ({ ok: true, path: '/root/.dsh/AGENTS.md', exists: true, size: 30, content: '</textarea><script>alert(1)</script>', bytes: 0, backup: '', limitBytes: 65536, error: '' }),
  });
  const handler = createPageHandler(deps);
  const res = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=agent' }), res);
  assert.equal(res.body.includes('<script>alert(1)</script>'), false);
  assert.match(res.body, /&lt;\/textarea&gt;&lt;script&gt;/);
});

test('GET ?tab=agent：超过字节预算给警告', async () => {
  const { createPageHandler } = await loadPage();
  const { deps } = depsOf({
    agentRead: async () => ({ ok: true, path: '/root/.dsh/AGENTS.md', exists: true, size: 70000, content: 'x', bytes: 0, backup: '', limitBytes: 65536, error: '' }),
  });
  const handler = createPageHandler(deps);
  const res = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=agent' }), res);
  assert.match(res.body, /已超过 65536 字节预算/);
});

test('POST saveAgent：走同一个写入口，回跳到 Agent 页并带上字节数与备份', async () => {
  const { createPageHandler } = await loadPage();
  const { deps, calls } = depsOf();
  const handler = createPageHandler(deps);
  const res = fakeRes();
  await handler(fakeReq({
    method: 'POST',
    body: 'action=saveAgent&content=' + encodeURIComponent('abc') + '&back=' + encodeURIComponent('?tab=agent'),
  }), res);

  assert.equal(res.status, 303);
  assert.deepEqual(calls.agentWrite, ['abc']);
  const location = decodeURIComponent(res.headers.location);
  assert.match(location, /^\/dsh-agents-skills\?tab=agent&msg=/);
  assert.match(location, /已保存 · 3 字节 · 旧内容已备份到 \/root\/\.dsh\/AGENTS\.md\.bak/);
  assert.match(location, /ok=1/);
});

test('POST saveAgent 失败时给出人话', async () => {
  const { createPageHandler } = await loadPage();
  const { deps } = depsOf({ agentWrite: async () => ({ ok: false, path: '/root/.dsh/AGENTS.md', exists: false, size: 0, content: '', bytes: 0, backup: '', limitBytes: 65536, error: '磁盘只读' }) });
  const handler = createPageHandler(deps);
  const res = fakeRes();
  await handler(fakeReq({ method: 'POST', body: 'action=saveAgent&content=x' }), res);
  assert.match(decodeURIComponent(res.headers.location), /保存失败：磁盘只读/);
});

test('记住上次看的标签：带 tab 的请求写 cookie，之后不带 tab 也能落到那一页', async () => {
  const { createPageHandler } = await loadPage();
  const { deps } = depsOf();
  const handler = createPageHandler(deps);

  const first = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=agent' }), first);
  assert.match(first.headers['set-cookie'], /^dsh-agents-skills-tab=agent/);

  const second = fakeRes();
  await handler(fakeReq({ headers: { host: 'localhost:3081', cookie: 'other=1; dsh-agents-skills-tab=agent' } }), second);
  assert.match(second.body, /name="content"/, 'cookie 记住了 Agent 页');
  assert.equal(second.headers['set-cookie'], undefined, '没带 tab 参数就不重写 cookie');

  const third = fakeRes();
  await handler(fakeReq({ headers: { host: 'localhost:3081', cookie: 'dsh-agents-skills-tab=skills' } }), third);
  assert.match(third.body, /搜索安装/, 'cookie 说 skills 就落到「所有技能」页');

  // 新 tab 值同样读写：repos（默认）/ todo。
  const repos = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=repos' }), repos);
  assert.match(repos.headers['set-cookie'], /^dsh-agents-skills-tab=repos/);
  const reposEcho = fakeRes();
  await handler(fakeReq({ headers: { host: 'localhost:3081', cookie: 'dsh-agents-skills-tab=repos' } }), reposEcho);
  assert.match(reposEcho.body, /<h1>仓库<\/h1>/, 'cookie 说 repos 就落到仓库列表');
  assert.equal(reposEcho.headers['set-cookie'], undefined);

  const todo = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=todo' }), todo);
  assert.match(todo.headers['set-cookie'], /^dsh-agents-skills-tab=todo/);
  const todoEcho = fakeRes();
  await handler(fakeReq({ headers: { host: 'localhost:3081', cookie: 'dsh-agents-skills-tab=todo' } }), todoEcho);
  assert.match(todoEcho.body, /<h1>待办<\/h1>/, 'cookie 说 todo 就落到待办页');

  // 子页 tab=repo 不写 cookie（cookie 只记四个顶层标签）。
  const sub = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=repo&repo=a%2Fb' }), sub);
  assert.equal(sub.headers['set-cookie'], undefined, 'tab=repo 不是顶层标签，不写 cookie');
});

test('左栏：显示技能数，有待办缓存时再显示待办数', async () => {
  const { createPageHandler } = await loadPage();
  const { deps } = depsOf();
  const handler = createPageHandler(deps);

  const before = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=agent' }), before);
  assert.match(before.body, /<span class="count">3<\/span>/, '技能数来自 overview');
  assert.equal(before.body.includes('count warn'), false, '还没检查过就没有待办徽章');
  assert.match(before.body, /待办<\/a>/, '「待办」是独立导航项');

  await handler(fakeReq({ url: '/dsh-agents-skills?tab=skills&check=1' }), fakeRes());
  const after = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=agent' }), after);
  assert.match(after.body, /<span class="count warn">3<\/span>/, '检查缓存里的待办数（新增 1 + 可更新 1 + 已移除 1）');
});

test('宿主 groupSkills 与设置页 buildGroups 输出完全一致', async () => {
  const { groupSkills } = await loadSkills();
  // 用替身加载 Client 半，取它那份分组实现
  const code = await readFile(join(packageDir, 'client', 'client.js'), 'utf8');
  let captured = null;
  // eslint-disable-next-line no-new-func -- 故意用 Function 构造器模拟模块加载器
  new Function('window', code)({ __ModuleLoader__: { load: (spec) => { captured = spec; } } });
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
  };
  const client = captured.factory((name) => {
    if (name === 'react') return React;
    throw new Error('没有替身的依赖：' + name);
  });

  const skills = [skillOf('tdd', 'a/b'), skillOf('gone', 'a/b'), skillOf('pr', 'a/b'), skillOf('find-skills', 'v/w'), skillOf('mine', '')];
  const delta = deltaOf();
  const host = groupSkills(skills, delta);
  const browser = client.__internals.buildGroups(overviewOf(skills), delta);
  assert.deepEqual(
    host.map((group) => ({ key: group.key, pending: group.pending, items: group.items.map((item) => item.kind + ':' + item.name) })),
    browser.map((group) => ({ key: group.key, pending: group.pending, items: group.items.map((item) => item.kind + ':' + item.name) })),
  );

  const hostTodo = host.filter((group) => group.pending > 0).map((group) => group.key);
  const browserTodo = client.__internals.filterTodo(browser, true).map((group) => group.key);
  assert.deepEqual(hostTodo, browserTodo);
});

// ---------------------------------------------------------------------------
// 版式铁律（新皮肤）：以下几条是验收裁判，改动样式时先看这里。
// ---------------------------------------------------------------------------

/**
 * 渲染一页。
 * @param {string} url 请求地址
 * @param {object} [overrides] deps 覆盖项
 * @returns {Promise<object>} 假响应
 */
async function renderPage(url, overrides = {}) {
  const { createPageHandler } = await loadPage();
  const { deps } = depsOf(overrides);
  const handler = createPageHandler(deps);
  const res = fakeRes();
  await handler(fakeReq({ url }), res);
  return res;
}

/**
 * 把页面里的 CSS 拆成规则（去掉注释），方便按选择器断言。
 * @param {string} html 页面 HTML
 * @returns {{ selector: string, body: string }[]} 规则列表
 */
function cssRules(html) {
  const style = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');
  return [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1].trim(), body: match[2] }));
}

/**
 * 取数据表 tbody。
 * @param {string} html 页面 HTML
 * @returns {string} tbody 内容
 */
function tbodyOf(html) {
  return html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
}

// ---------------------------------------------------------------------------
// 新信息架构：仓库列表（默认）/ 仓库子页 / 待办 / 所有技能 / Agent。
// ---------------------------------------------------------------------------

test('仓库列表：无 ?tab 时默认渲染；行含子页链接，页头含添加表单（action=subscribe）', async () => {
  const res = await renderPage('/dsh-agents-skills');
  assert.equal(res.status, 200);
  assert.match(res.body, /<h1>仓库<\/h1>/, '默认页是仓库列表');
  assert.match(res.body, /class="navitem active" href="\/dsh-agents-skills\?tab=repos"/, '左栏「仓库」是 active');
  assert.match(res.body, /placeholder="owner\/repo，例如 anthropics\/skills"/, '添加表单的占位文案');
  assert.match(res.body, /name="action" value="subscribe"/, '添加走现成的 subscribe 协议');
  assert.match(res.body, /name="source"/);
  assert.match(res.body, /<button class="primary" type="submit">添加<\/button>/);
  // 仓库名链到该仓子页
  assert.match(res.body, /href="\/dsh-agents-skills\?tab=repo&amp;repo=a%2Fb"/, '仓库名链到子页');
  assert.match(res.body, /<th>仓库<\/th><th>已装<\/th><th>状态<\/th><th>来源<\/th><th class="actions">操作<\/th>/, '5 列');
  assert.match(res.body, /<a class="btn" href="\/dsh-agents-skills\?tab=repos&amp;check=2">检查更新<\/a>/, '页头检查更新走 links.check');
  const tbody = tbodyOf(res.body);
  const perRow = [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => (m[1].match(/<td/g) || []).length);
  assert.deepEqual([...new Set(perRow)], [5], '仓库列表每行 5 个单元格');
});

test('仓库列表：订阅仓未检查显示「订阅·未检查」，行级按钮按状态给', async () => {
  const { createPageHandler } = await loadPage();
  const { deps } = depsOf({
    overview: async () => ({ ...overviewOf([skillOf('tdd', 'a/b'), skillOf('gone', 'a/b'), skillOf('mine', '')]), repos: [{ source: 'sub/repo', installed: 0, names: [] }] }),
  });
  const handler = createPageHandler(deps);
  const res = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=repos&check=1' }), res);

  assert.match(res.body, /订阅·未检查/, '订阅但没查过的仓明说「订阅·未检查」');
  // 检查失败的仓给红徽章并把 error 放进 title
  assert.match(res.body, /<span class="badge ok">新增 1<\/span>/);
  assert.match(res.body, /<span class="badge warn">可更新 1<\/span>/);
  assert.match(res.body, /<span class="badge err">已移除 1<\/span>/);
  // 行级动作：检查 + 装全部新增 + 更新全部
  assert.match(res.body, /name="row" value="check\|a\/b\|">检查</);
  assert.match(res.body, /name="row" value="installAll\|a\/b\|">装全部新增 \(1\)</);
  assert.match(res.body, /name="row" value="updateAll\|a\/b\|">更新全部 \(1\)</);
  // 来源列三态
  assert.match(res.body, /<td class="dim">订阅<\/td>/);
  assert.match(res.body, /本地·未托管/);
  // 本地行没有仓库级按钮，也不该出现 check| 加空 source
  const localRow = tbodyOf(res.body).split('<tr>').find((row) => row.includes('本地·未托管'));
  assert.equal(/name="row"/.test(localRow), false, '本地行没有按钮');
});

test('仓库列表：检查失败的仓显示红徽章「检查失败」，title 放原因', async () => {
  const { createPageHandler } = await loadPage();
  const { deps } = depsOf({
    check: async () => ({
      ok: true,
      checkedAt: '2026-10-10T03:00:00.000Z',
      tokenSource: 'gh',
      rateLimitText: '',
      repos: [{ source: 'a/b', mode: 'failed', available: 0, installed: 2, newSkills: [], updatable: [], orphan: [], error: 'API 限额用完了' }],
      error: '',
    }),
  });
  const handler = createPageHandler(deps);
  const res = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=repos&check=1' }), res);
  assert.match(res.body, /<span class="badge err" title="API 限额用完了">检查失败<\/span>/);
});

test('仓库列表：待办多的在前、同待办按名字、本地恒在最底', async () => {
  const { createPageHandler } = await loadPage();
  const { deps } = depsOf({
    overview: async () => ({ ...overviewOf([skillOf('tdd', 'a/b'), skillOf('gone', 'a/b'), skillOf('tdd', 'z/z'), skillOf('mine', '')]), repos: [{ source: 'm/m', installed: 0, names: [] }] }),
  });
  const handler = createPageHandler(deps);
  const res = fakeRes();
  // a/b 有 3 个待办；z/z 与 m/m 都是 0；本地最后。
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=repos&check=1' }), res);
  const titles = [...tbodyOf(res.body).matchAll(/<td class="mono repo-name repo-link"><a href="[^"]*"><span class="clip" title="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(titles, ['a/b', 'm/m', 'z/z', '本地·未托管'], 'pending desc + source asc + local 沉底');
});

test('仓库列表：无仓无订阅时给引导文案，不渲染空表', async () => {
  const res = await renderPage('/dsh-agents-skills?tab=repos', { overview: async () => overviewOf([]) });
  assert.match(res.body, /还没有仓库。在上面输入 owner\/repo 添加一个，或去<a href="\/dsh-agents-skills\?tab=skills">「所有技能」<\/a>里搜索安装。/);
  assert.equal(res.body.includes('<table class="skills">'), false, '空态不渲染空表');
});

test('仓库子页：面包屑 + 只渲染该仓的行 + 7 列（去掉仓库列）', async () => {
  const res = await renderPage('/dsh-agents-skills?tab=repo&repo=a%2Fb&check=1');
  assert.equal(res.status, 200);
  assert.match(res.body, /<div class="crumbs"><a href="\/dsh-agents-skills\?tab=repos">← 仓库<\/a><\/div>/, '面包屑回仓库列表');
  assert.match(res.body, /<h1 class="mono">a\/b<\/h1>/);
  assert.match(res.body, /<th class="pick"><\/th><th>技能<\/th><th>状态<\/th><th>说明<\/th><th>来源路径<\/th><th>装于<\/th><th class="actions">操作<\/th>/, '7 列，没有仓库列');
  assert.match(res.body, /已装 2\/3 · 新增 1 · 可更新 1 · 已移除 1/, '页头统计');
  const tbody = tbodyOf(res.body);
  const perRow = [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => (m[1].match(/<td/g) || []).length);
  assert.deepEqual([...new Set(perRow)], [7], '子页每行 7 个单元格');
  assert.match(tbody, /new-one/);
  assert.match(tbody, /gone/);
  assert.equal(tbody.includes('mine'), false, '别的仓（本地）的行不出现');
  // 子页也有整套批量协议，仓库位仍是本仓 source
  assert.match(res.body, /<form class="skills-form" method="post"><input type="hidden" name="back" value="\?tab=repo&amp;repo=a%2Fb">/);
  assert.match(res.body, /name="row" value="install\|a\/b\|new-one"/);
  assert.match(res.body, /<div class="batchbar">/);
  assert.match(res.body, /href="\/dsh-agents-skills\?tab=repo&amp;repo=a%2Fb&amp;pickall=1"/);
});

test('仓库子页：订阅仓未检查时表格位置给一行提示', async () => {
  const { createPageHandler } = await loadPage();
  const { deps } = depsOf({
    overview: async () => ({ ...overviewOf([]), repos: [{ source: 'sub/repo', installed: 0, names: [] }] }),
  });
  const handler = createPageHandler(deps);
  const res = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=repo&repo=sub%2Frepo' }), res);
  assert.equal(res.status, 200);
  assert.match(res.body, /尚未检查，点右上角\[检查\]看看有什么可装。/);
  assert.match(res.body, /<span class="dim stats">已装 0 · 未检查<\/span>/);

  // 订阅但已装了技能、又没查过：提示行 + 已装行并存（不藏用户的技能）
  const filled = depsOf({
    overview: async () => ({ ...overviewOf([skillOf('tdd', 'sub/repo')]), repos: [{ source: 'sub/repo', installed: 1, names: ['tdd'] }] }),
  });
  const filledRes = fakeRes();
  await createPageHandler(filled.deps)(fakeReq({ url: '/dsh-agents-skills?tab=repo&repo=sub%2Frepo' }), filledRes);
  assert.match(filledRes.body, /尚未检查，点右上角\[检查\]看看有什么可装。/);
  assert.match(filledRes.body, /value="remove\|sub\/repo\|tdd">删除</, '已装行照常显示');
  assert.equal(tbodyOf(filledRes.body).includes('这个仓库还没有技能'), false);
});

test('仓库子页：__local__ 只有已装行与[删除]，没有检查类按钮', async () => {
  const res = await renderPage('/dsh-agents-skills?tab=repo&repo=__local__');
  assert.equal(res.status, 200);
  assert.match(res.body, /<h1 class="mono">本地·未托管<\/h1>/);
  assert.match(res.body, /name="row" value="remove\|\|mine">删除</);
  assert.equal(res.body.includes('value="check|'), false, '本地页没有检查按钮');
  assert.equal(res.body.includes('installAll'), false, '本地页没有装全部新增');
  assert.equal(res.body.includes('updateAll'), false, '本地页没有更新全部');
  assert.equal(res.body.includes('name="pick"'), false, '已装行没有勾选框');
});

test('仓库子页：不存在的 repo key 不炸，给人话', async () => {
  const res = await renderPage('/dsh-agents-skills?tab=repo&repo=nope%2Fnope');
  assert.equal(res.status, 200);
  assert.match(res.body, /没有找到这个仓库。/);
  assert.match(res.body, /← 仓库/);
});

test('待办：只列 kind != installed 的行，仓库列链到子页，可「更新全部」', async () => {
  const res = await renderPage('/dsh-agents-skills?tab=todo&check=1');
  assert.equal(res.status, 200);
  assert.match(res.body, /<h1>待办<\/h1>/);
  assert.match(res.body, /新增 1 · 可更新 1 · 已移除 1/);
  assert.match(res.body, /<button type="submit" name="batch" value="updateAll">更新全部 \(1\)<\/button>/);
  const tbody = tbodyOf(res.body);
  assert.match(tbody, /new-one/);
  assert.match(tbody, /gone/);
  assert.match(tbody, /tdd/);
  assert.equal(tbody.includes('mine'), false, '已装且最新的行不进待办');
  assert.match(tbody, /<td class="mono repo-name repo-link"><a href="\/dsh-agents-skills\?tab=repo&amp;repo=a%2Fb">/, '待办的仓库列链到子页');
  const perRow = [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => (m[1].match(/<td/g) || []).length);
  assert.deepEqual([...new Set(perRow)], [8], '跨仓聚合表 8 列');
});

test('待办：两个空态分支（没查过 → 引导去检查；查过且无待办 → 说已最新）', async () => {
  const cold = await renderPage('/dsh-agents-skills?tab=todo');
  assert.match(cold.body, /还没检查过，先点<a class="btn" href="\/dsh-agents-skills\?tab=todo&amp;check=2">检查更新<\/a>。/);

  const clean = await renderPage('/dsh-agents-skills?tab=todo&check=1', {
    check: async () => ({
      ok: true,
      checkedAt: '2026-10-10T03:00:00.000Z',
      tokenSource: 'gh',
      rateLimitText: '',
      repos: [{ source: 'a/b', mode: 'api', available: 2, installed: 2, newSkills: [], updatable: [], orphan: [], error: '' }],
      error: '',
    }),
  });
  assert.match(clean.body, /没有待办：所有盯着的仓库都已装上且最新。/);
  assert.equal(clean.body.includes('value="check|a/b|"'), false, '待办页只列待办，不挂仓库级检查按钮');
});

test('路由与视图装配：repos / repo / todo / skills / agent 都返回 200', async () => {
  for (const url of ['/dsh-agents-skills', '/dsh-agents-skills?tab=repos', '/dsh-agents-skills?tab=repo&repo=a%2Fb', '/dsh-agents-skills?tab=todo', '/dsh-agents-skills?tab=skills', '/dsh-agents-skills?tab=agent']) {
    const res = await renderPage(url);
    assert.equal(res.status, 200, url);
    assert.match(res.body, /<title>Agents&amp;Skills/, url);
  }
  assert.match((await renderPage('/dsh-agents-skills?tab=skills')).body, /<h1>所有技能<\/h1>/, 'view 4 标题改为「所有技能」');
});

test('待办：同一处理器里刚检查过，切到 tab=todo 仍用缓存结果', async () => {
  const { createPageHandler } = await loadPage();
  const { deps, calls } = depsOf();
  const handler = createPageHandler(deps);
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=repos&check=1' }), fakeRes());
  const res = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=todo' }), res);
  assert.equal(calls.check, 1, '切标签不该再发一轮检查请求');
  assert.match(res.body, /new-one/);
});

// 铁律（新版）：允许少量 JS 之后，页面上**只允许**一种脚本标签——外链本站自己 serve 的
// 交互层 `<script src="?asset=page-ui.js" defer>`；内联 <script>、javascript: 链接、on* 内联事件
// 仍然一律禁止。旧铁律「一个 <script 都不许有」由这条改写而来，语义不缩水。
const PAGE_UI_TAG = '<script src="/dsh-agents-skills?asset=page-ui.js" defer></script>';

test('（a）脚本铁律：只允许外链 page-ui.js；无内联 <script> / javascript: / 内联事件', async () => {
  for (const url of ['/dsh-agents-skills', '/dsh-agents-skills?tab=repos&check=1', '/dsh-agents-skills?tab=repo&repo=a%2Fb&check=1', '/dsh-agents-skills?tab=todo&check=1', '/dsh-agents-skills?tab=skills', '/dsh-agents-skills?tab=agent', '/dsh-agents-skills?tab=skills&q=react', '/dsh-agents-skills?check=1']) {
    const res = await renderPage(url);
    assert.equal(res.status, 200, url);
    const tags = [...res.body.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)].map((match) => match[0]);
    assert.deepEqual(tags, [PAGE_UI_TAG], url + ' 只允许一个外链脚本标签');
    assert.equal(/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(res.body), false, url + ' 没有内联 <script>');
    assert.equal(/javascript:/i.test(res.body), false, url + ' 不含 javascript: 链接');
    assert.equal(/\son[a-z]+\s*=/i.test(res.body), false, url + ' 不含内联事件');
  }
});

test('（a2）head 里引用交互层资产，带 defer，且不在 body 里内联', async () => {
  const res = await renderPage('/dsh-agents-skills');
  const head = res.body.slice(0, res.body.indexOf('</head>'));
  assert.equal(head.includes(PAGE_UI_TAG), true, 'head 里有外链脚本');
  assert.equal(res.body.indexOf(PAGE_UI_TAG) < res.body.indexOf('</head>'), true, 'script 在 </head> 之前');
  // 自定义路径也要跟着走（引用的是 pagePath，不是写死的常量）
  const custom = await renderPage('/dsh-agents-skills', { pagePath: '/skills-admin' });
  assert.match(custom.body, /<script src="\/skills-admin\?asset=page-ui\.js" defer><\/script>/);
});

test('（b）?asset=page-ui.js：200 + JS content-type + no-store；内容是 fetch 拦截层，无 eval / new Function / import(', async () => {
  const res = await renderPage('/dsh-agents-skills?asset=page-ui.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/javascript; charset=utf-8$/);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.match(res.body, /fetch\(/, '有 fetch 拦截');
  assert.match(res.body, /addEventListener\('click'/, '拦截站内 GET 链接');
  assert.match(res.body, /addEventListener\('submit'/, '拦截 POST 表单');
  assert.match(res.body, /DOMParser/, '用 DOMParser 局部替换');
  assert.match(res.body, /pushState/, '导航后 pushState');
  assert.match(res.body, /popstate/, '前进/后退也重新拉取');
  assert.equal(/\beval\s*\(/.test(res.body), false, '不用 eval');
  assert.equal(/new\s+Function/.test(res.body), false, '不用 new Function');
  assert.equal(/\bimport\s*\(/.test(res.body), false, '不用动态 import');
  assert.equal(/localStorage/.test(res.body), false, '不读 localStorage');
  assert.equal(res.body.split('\n').length <= 200, true, '交互层 ≤200 行');
});

test('（b2）资产路由：别的资产名 404；门禁对资产同样生效（fail closed）', async () => {
  const other = await renderPage('/dsh-agents-skills?asset=evil.js');
  assert.equal(other.status, 404);
  const denied = await renderPage('/dsh-agents-skills?asset=page-ui.js', { guard: () => 401 });
  assert.equal(denied.status, 401, '没过门禁就拿不到资产');
});

test('（c）CSP：script-src 只放行 self；不含 unsafe-inline / data: / blob:；其余维持或更严', async () => {
  const csp = (await renderPage('/dsh-agents-skills')).headers['content-security-policy'];
  assert.match(csp, /script-src 'self'/, '只放行本站自己那一个文件');
  assert.equal(/script-src[^;]*'unsafe-inline'/.test(csp), false, 'script-src 不许 unsafe-inline');
  assert.equal(/script-src[^;]*data:/.test(csp), false, 'script-src 不许 data:');
  assert.equal(/script-src[^;]*blob:/.test(csp), false, 'script-src 不许 blob:');
  assert.equal(/unsafe-eval/.test(csp), false, '不许 unsafe-eval');
  assert.match(csp, /default-src 'none'/, '兜底仍是全禁');
  assert.match(csp, /connect-src 'self'/, 'pjax 的 fetch 需要 connect-src self');
  assert.match(csp, /style-src 'unsafe-inline'/, '内联 <style> 维持现状');
  assert.match(csp, /form-action 'self'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
});

test('（d）无 JS 兜底不变：交互仍全在真实表单 / GET 链接 / 原生 details 里', async () => {
  const body = (await renderPage('/dsh-agents-skills?tab=skills&check=1')).body;
  assert.match(body, /<form class="skills-form" method="post">/, '批量与行内操作是真实表单');
  assert.match(body, /name="row" value="check\|a\/b\|"/, '仓库按钮靠表单字段，不靠 JS');
  assert.match(body, /name="batch" value="install"/, '批量按钮靠表单字段，不靠 JS');
  assert.match(body, /<details class="fold"><summary>搜索安装<\/summary>/, '折叠是原生 details');
});

test('（e）.busy 样式在 STYLE 里（提交中禁用视觉）', async () => {
  const rule = cssRules((await renderPage('/dsh-agents-skills')).body).find((item) => item.selector === '.busy');
  assert.ok(rule, 'STYLE 里有 .busy 规则');
  assert.match(rule.body, /opacity:\s*\.6/);
  assert.match(rule.body, /cursor:\s*wait/);
});

test('（f）底部说明不再声称「禁止一切脚本」', async () => {
  const body = (await renderPage('/dsh-agents-skills?tab=skills')).body;
  assert.equal(body.includes('禁止一切脚本'), false);
  assert.equal(body.includes('不含任何脚本'), false);
  assert.match(body, /页面脚本仅限本站自身的一个文件/);
});

test('（b）表头 sticky top:0；td/th 不 sticky；tbody 无 rowspan / colspan', async () => {
  const res = await renderPage('/dsh-agents-skills?check=1');
  assert.match(res.body, /thead th \{ position: sticky; top: 0;/);
  assert.equal(/thead th \{ position: sticky; top: [1-9]/.test(res.body), false, '偏移必须是 0（top:38px 那次的教训）');
  // 解析所有 CSS 规则：凡涉及 th/td 的（thead 除外）都不许 position: sticky
  const offenders = cssRules(res.body).filter((rule) => {
    const selectors = rule.selector.split(',').map((item) => item.trim()).filter((item) => !/^thead\b/.test(item));
    return selectors.some((item) => /(^|[^\w-])t[dh]([.:\[#\s]|$)/.test(item)) && /position:\s*sticky/.test(rule.body);
  });
  assert.deepEqual(offenders, [], 'th/td 一律不做 sticky');
  // tbody 里不许 rowspan / colspan：技能页的有数据与空表两种渲染都查
  const empty = await renderPage('/dsh-agents-skills?tab=skills&check=1', { overview: async () => overviewOf([]) });
  for (const [label, html] of [['有数据', res.body], ['空表', empty.body]]) {
    const tbody = tbodyOf(html);
    assert.equal(/rowspan/.test(tbody), false, label + ' tbody 无 rowspan');
    assert.equal(/colspan/.test(tbody), false, label + ' tbody 无 colspan');
  }
  // 仓库列表 / 仓库子页 / 待办页的表体同样不许合并单元格
  const otherViews = [
    ['仓库列表', '/dsh-agents-skills?tab=repos&check=1'],
    ['仓库子页', '/dsh-agents-skills?tab=repo&repo=a%2Fb&check=1'],
    ['待办', '/dsh-agents-skills?tab=todo&check=1'],
  ];
  for (const [label, url] of otherViews) {
    const tbody = tbodyOf((await renderPage(url)).body);
    assert.equal(/rowspan/.test(tbody), false, label + ' tbody 无 rowspan');
    assert.equal(/colspan/.test(tbody), false, label + ' tbody 无 colspan');
  }
});

test('（c）批量条与仓库条都 flex:0 0 auto；仓库条单行横滚；弹性链每级 min-height:0', async () => {
  const res = await renderPage('/dsh-agents-skills?check=1');
  const rules = cssRules(res.body);
  const ruleOf = (selector) => rules.find((rule) => rule.selector === selector);
  assert.match(ruleOf('.batchbar').body, /flex: 0 0 auto/, '.batchbar 不许被压缩');
  assert.match(ruleOf('.repostrip').body, /flex: 0 0 auto/, '.repostrip 不许被压缩');
  assert.match(ruleOf('.repostrip').body, /flex-wrap: nowrap/, '.repostrip 单行');
  assert.match(ruleOf('.repostrip').body, /overflow-x: auto/, '.repostrip 横滚');
  assert.match(res.body, /\.skills-form > \.repostrip, \.skills-form > \.batchbar \{ flex: 0 0 auto; \}/);
  assert.match(ruleOf('.content.skills-page').body, /min-height: 0/);
  assert.match(ruleOf('.skills-form').body, /min-height: 0/);
  assert.match(ruleOf('.table-scroll').body, /min-height: 0/);
  assert.match(ruleOf('.table-scroll').body, /flex: 1 1 auto/);
});

test('（d）状态列每行最多一个徽章，并发原因合并进 title，可见性作后缀文字', async () => {
  const wonky = skillOf('wonky', 'a/b', { valid: false, modelInvocable: false, userInvocable: false });
  const delta = deltaOf();
  delta.repos[0].updatable.push({ name: 'wonky', path: 'skills/wonky', installedHash: 'old', remoteHash: 'new' });
  const res = await renderPage('/dsh-agents-skills?tab=skills&check=1', {
    overview: async () => overviewOf([wonky, skillOf('gone', 'a/b'), skillOf('mine', '')]),
    check: async () => delta,
  });
  const tbody = tbodyOf(res.body);
  const statusCells = [...tbody.matchAll(/<td class="status">([\s\S]*?)<\/td>/g)].map((match) => match[1]);
  assert.equal(statusCells.length, 4, '四行数据各有状态格（gone / new-one / wonky / mine）');
  for (const cell of statusCells) {
    assert.equal((cell.match(/<span class="badge/g) ?? []).length <= 1, true, '状态格最多一个徽章：' + cell);
  }
  const wonkyCell = statusCells.find((cell) => /格式不合规/.test(cell));
  assert.match(wonkyCell, /<span class="badge err" title="格式不合规；可更新">格式不合规<\/span>/, '优先级与 title 合并');
  assert.match(wonkyCell, /<span class="dim suffix">·仅用户可用 ·模型专用<\/span>/, '可见性是后缀文字');
  assert.equal(/<span class="badge[^>]*>仅用户可用/.test(tbody), false, '可见性不渲染成徽章');
  // 上游已移除行的技能名带删除线样式
  assert.match(tbody, /<td class="mono skill-name orphan">/, 'orphan 行技能名有删除线样式钩子');
});

test('（e）表格下方两个 details.fold；有搜索结果时搜索区默认展开', async () => {
  const plain = await renderPage('/dsh-agents-skills?tab=skills&check=1');
  assert.equal((plain.body.match(/<details class="fold"/g) ?? []).length, 2, '两个折叠区');
  assert.match(plain.body, /<details class="fold"><summary>搜索安装<\/summary>/, '默认不展开');
  assert.match(plain.body, /<details class="fold"><summary>使用说明<\/summary>/);
  const searched = await renderPage('/dsh-agents-skills?tab=skills&q=react');
  assert.match(searched.body, /<details class="fold" open><summary>搜索安装<\/summary>/, '有结果时带 open');
  assert.equal((searched.body.match(/<details class="fold"/g) ?? []).length, 2);
});

test('（f）技能表 min-width 为 900px，不再是 1080px', async () => {
  const res = await renderPage('/dsh-agents-skills?check=1');
  assert.match(res.body, /table\.skills \{ table-layout: fixed; min-width: 900px; \}/);
  assert.equal(res.body.includes('min-width: 1080px'), false, '旧的 1080px 必须消失');
});

test('（g）纵向 padding 20px 与页面高度 calc(100vh - 40px) 同源', async () => {
  const res = await renderPage('/dsh-agents-skills?check=1');
  const padY = /--pad-y: (\d+)px/.exec(res.body);
  assert.ok(padY, '定义了 --pad-y');
  assert.equal(Number(padY[1]), 20, '纵向 padding = 20px');
  assert.equal(Number(padY[1]) * 2, 40, '2 × 20px = 40px');
  assert.match(res.body, /padding: var\(--pad-y\) var\(--pad-x\)/, 'body 的 padding 只引用变量');
  assert.match(res.body, /height: calc\(100vh - 2 \* var\(--pad-y\)\)/, '页面高度引用同一个 --pad-y');
  assert.equal(res.body.includes('calc(100vh - 48px)'), false, '旧的 48px 魔法数字必须消失');
});

test('（h）≤720px：导航横排、页面高度 auto、表格滚动容器 max-height:70vh', async () => {
  const res = await renderPage('/dsh-agents-skills?check=1');
  const media = /@media \(max-width: 720px\) \{([\s\S]*?)\n\}/.exec(res.body);
  assert.ok(media, '有 720px 断点');
  assert.match(media[1], /\.nav \{[^}]*flex-direction: row/);
  assert.match(media[1], /\.content\.skills-page \{ height: auto; \}/);
  assert.match(media[1], /\.table-scroll \{ max-height: 70vh; \}/);
});
