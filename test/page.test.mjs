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
  // 新形状：「本地·未托管」既是状态 chip 的文案（恒在工具条里），也是一个分组键。
  // 判据改为语义的——本地组不渲染、本地行不出现——不再断言整页不含这四个字。
  assert.equal(res.body.includes('data-fold="__local__"'), false, '未托管组被隐藏');
  assert.equal(res.body.includes('data-name="mine"'), false, '未托管行不出现');
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

test('技能列表：一仓一折叠卡，行是 data-state / data-name，仓库级动作不在这一页', async () => {
  const { createPageHandler } = await loadPage();
  const { deps } = depsOf();
  const handler = createPageHandler(deps);
  const res = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=skills&check=1' }), res);

  assert.match(res.body, /<form class="skills-form" method="post">/, '操作仍在一张真实表单里');
  // 新形状：每个来源仓库一个 <details class="fold" data-fold="<repoKey>">，卡内才是表格。
  assert.match(res.body, /<details class="fold" open data-fold="a\/b">/, '有待办的仓库默认展开');
  assert.match(res.body, /<details class="fold" data-fold="__local__">/, '本地组也有一张卡');
  assert.equal(/<details class="fold" open data-fold="__local__">/.test(res.body), false, '没有待办就默认折起');
  assert.match(res.body, /<table class="skills">/);
  assert.match(res.body, /<colgroup>/, '固定列宽用 colgroup');

  // 行语义：data-name 是技能名，data-state 是状态（new/upd/gone/local/ok）。
  const rows = rowsOf(res.body);
  assert.deepEqual(rows.map((row) => row.name).sort(), ['gone', 'mine', 'new-one', 'tdd'], '四行数据');
  assert.deepEqual(rows.map((row) => row.name + '=' + row.state).sort(),
    ['gone=gone', 'mine=local', 'new-one=new', 'tdd=upd'], '每行自报状态');
  for (const row of rows) assert.equal(tdsOf(row.html).length, 7, row.name + ' 行 7 列');

  // 表体骨架：不许 rowspan / colspan（刻意保留的约束）。
  const tbody = tbodyOf(res.body);
  assert.equal(/rowspan/.test(tbody), false, '表体里没有 rowspan（CSS 注释里提到它是另一回事）');
  assert.equal(/colspan/.test(tbody), false, '表体里没有跨列单元格');
  assert.equal(/<tr class="group"/.test(res.body), false, '没有分组行');

  // 仓库条已删除：技能页只做行级/批量动作，仓库级动作在仓库页与仓库子页。
  assert.equal(res.body.includes('repostrip'), false, '技能页没有仓库条');
  assert.equal(/name="row" value="check\|/.test(res.body), false, '技能页没有仓库级「检查」');
  assert.equal(/name="row" value="installAll\|/.test(res.body), false, '技能页没有「装全部新增」');
  assert.match(res.body, /class="content skills-page"/, '技能页的内容列带 skills-page 标记');
});

test('操作列只挂有意义的按钮：已装且最新的行只有「删除」', async () => {
  const { createPageHandler } = await loadPage();
  const { deps } = depsOf();
  const handler = createPageHandler(deps);
  const res = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=skills&check=1' }), res);

  assert.deepEqual(rowActionsOf(rowByName(res.body, 'new-one').html), ['install'], '新增行只有安装');
  assert.deepEqual(rowActionsOf(rowByName(res.body, 'gone').html), ['remove'], '上游已移除行只有删除');
  assert.deepEqual(rowActionsOf(rowByName(res.body, 'mine').html), ['remove'], '已装且最新的行只有删除，没有「更新」');
  assert.deepEqual(rowActionsOf(rowByName(res.body, 'tdd').html), ['update', 'remove'], '可更新行给更新与删除');
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
  // 语义：删掉的「上游已移除」行不再被标成已移除（技能本身还在 overview 里，所以行仍渲染）。
  assert.equal(rowByName(after.body, 'gone').state, 'ok', '删掉的已移除项不再标已移除');
  assert.equal(chipsOf(after.body).get('上游已移除').count, 0, '已移除计数归零');
  // 更新过的行不再是「可更新」状态（回落成已装）。
  assert.equal(rowByName(after.body, 'tdd').state, 'ok', '更新过的可更新项要消失');
  assert.equal(chipsOf(after.body).get('可更新').count, 0, '可更新计数归零');
  assert.equal(/\bundefined\b/.test(after.body), false, '回跳后不留 undefined');
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
  assert.equal(before.body.includes('count hot'), false, '还没检查过就没有待办徽章');
  assert.match(before.body, /href="\/dsh-agents-skills\?tab=todo"/, '「待办」是独立导航项');

  await handler(fakeReq({ url: '/dsh-agents-skills?tab=skills&check=1' }), fakeRes());
  const after = fakeRes();
  await handler(fakeReq({ url: '/dsh-agents-skills?tab=agent' }), after);
  // 待办徽章是「热」计数（旧皮肤叫 count warn，新皮肤叫 count hot）——按语义找那个非零计数即可。
  assert.match(after.body, /<span class="count (hot|warn)">3<\/span>/, '检查缓存里的待办数（新增 1 + 可更新 1 + 已移除 1）');
  assert.equal(after.body.includes('count hot">0<'), false, '零待办不该出现热徽章');
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
// 语义读页面（不锁死 class 名 / 列序 / CSS 正文，只认行为钩子与协议值）
// ---------------------------------------------------------------------------

/**
 * 取所有数据行（新形状：每行带 data-name / data-state）。
 * 技能页一仓一张表，所以这里跨整页扫 <tr>，只保留带 data-name 的数据行（表头行没有）。
 * @param {string} html 页面 HTML
 * @returns {{ name: string, state: string, attrs: string, html: string }[]} 行
 */
function rowsOf(html) {
  return [...html.matchAll(/<tr([^>]*)>([\s\S]*?)<\/tr>/g)]
    .filter((match) => /data-name="/.test(match[1]))
    .map((match) => ({
      attrs: match[1],
      html: match[2],
      name: /data-name="([^"]*)"/.exec(match[1])?.[1] ?? '',
      state: /data-state="([^"]*)"/.exec(match[1])?.[1] ?? '',
    }));
}

/**
 * 取页面上所有 tbody（技能页每个仓库一张表）。
 * @param {string} html 页面 HTML
 * @returns {string[]} tbody 内容
 */
function tbodiesOf(html) {
  return [...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].map((match) => match[1]);
}

/**
 * 按技能名取一行。
 * @param {string} html 页面 HTML
 * @param {string} name 技能名
 * @returns {{ name: string, state: string, attrs: string, html: string }} 行
 */
function rowByName(html, name) {
  return rowsOf(html).find((row) => row.name === name);
}

/**
 * 一行的所有 <td> 内容（顺序即列序，不额外假设）。
 * @param {string} rowHtml 行 HTML
 * @returns {string[]} 单元格内容
 */
function tdsOf(rowHtml) {
  return [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => match[1]);
}

/**
 * 操作列里的 row 协议取值（install / update / remove …）。
 * @param {string} rowHtml 行 HTML
 * @returns {string[]} 动作名
 */
function rowActionsOf(rowHtml) {
  const cell = /<td class="actions">([\s\S]*?)<\/td>/.exec(rowHtml);
  return cell === null ? [] : [...cell[1].matchAll(/value="(\w+)\|/g)].map((match) => match[1]);
}

/**
 * 状态筛选 chip 的读数：文案 → { count, pressed }。
 * @param {string} html 页面 HTML
 * @returns {Map<string, { count: number, pressed: boolean }>} chip 读数
 */
function chipsOf(html) {
  const map = new Map();
  for (const match of html.matchAll(/<a class="chip"[^>]*aria-pressed="(true|false)"[^>]*>([^<]*)<span class="n">(\d+)<\/span><\/a>/g)) {
    map.set(match[2], { count: Number(match[3]), pressed: match[1] === 'true' });
  }
  return map;
}

/**
 * 折叠卡：键 → 是否展开（data-fold 是服务端渲染的稳定钩子）。
 * @param {string} html 页面 HTML
 * @returns {Map<string, boolean>} 键到展开状态
 */
function foldsOf(html) {
  const map = new Map();
  for (const match of html.matchAll(/<details class="fold"([^>]*)>/g)) {
    const key = /data-fold="([^"]*)"/.exec(match[1])?.[1];
    if (key !== undefined) map.set(key, /\sopen(\s|$)/.test(match[1]));
  }
  return map;
}

/**
 * 仓库列表页的卡片标题顺序。
 * @param {string} html 页面 HTML
 * @returns {string[]} 标题（仓库名 / 本地 · 未托管）
 */
function cardTitlesOf(html) {
  return [...html.matchAll(/<article class="card">[\s\S]*?<a class="name"[^>]*>([^<]*)<\/a>/g)].map((match) => match[1]);
}

// ---------------------------------------------------------------------------
// 新信息架构：仓库列表（默认）/ 仓库子页 / 待办 / 所有技能 / Agent。
// ---------------------------------------------------------------------------

test('仓库列表：无 ?tab 时默认渲染；行含子页链接，页头含添加表单（action=subscribe）', async () => {
  const res = await renderPage('/dsh-agents-skills');
  assert.equal(res.status, 200);
  assert.match(res.body, /<h1>仓库<\/h1>/, '默认页是仓库列表');
  assert.match(res.body, /<a[^>]*href="\/dsh-agents-skills\?tab=repos"[^>]*aria-current="page"/, '左栏「仓库」是当前项');
  assert.match(res.body, /owner\/repo<\/span>/, '输入框旁标明 owner/repo 写法');
  assert.match(res.body, /<input type="text" name="source"[^>]*placeholder="[^"]+"/, '有占位提示');
  assert.match(res.body, /name="action" value="subscribe"/, '添加走现成的 subscribe 协议');
  assert.match(res.body, /name="source"/);
  assert.match(res.body, /<button[^>]*type="submit"[^>]*>添加<\/button>/);
  // 仓库名链到该仓子页（卡片式仓库列表）
  assert.match(res.body, /href="\/dsh-agents-skills\?tab=repo&amp;repo=a%2Fb"/, '仓库名链到子页');
  assert.deepEqual(cardTitlesOf(res.body), ['a/b', '本地 · 未托管'], '一仓一张卡，本地沉底');
  assert.match(res.body, /<a[^>]*href="\/dsh-agents-skills\?tab=repos&amp;check=2"[^>]*>检查更新<\/a>/, '页头检查更新走 links.check');
  // 仓库级动作仍在这一页（技能页已不再有仓库条）；没检查过时只给「检查」。
  const cards = [...res.body.matchAll(/<article class="card">([\s\S]*?)<\/article>/g)].map((match) => match[1]);
  assert.deepEqual([...cards[0].matchAll(/name="row" value="([^"]*)"/g)].map((match) => match[1]), ['check|a/b|'], '卡片头给仓库级动作');
  const checked = (await renderPage('/dsh-agents-skills?tab=repos&check=1')).body;
  assert.deepEqual([...checked.matchAll(/name="row" value="([^"]*)"/g)].map((match) => match[1]),
    ['check|a/b|', 'installAll|a/b|', 'updateAll|a/b|'], '查过之后新增批量动作');
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
  // 状态徽章语义：徽章文案 + bdot 圆点（不锁 class 名尾缀）。
  assert.match(res.body, /<span class="badge [a-z]+"><span class="bdot"><\/span>新增 1<\/span>/, '新增徽章');
  assert.match(res.body, /<span class="badge [a-z]+"><span class="bdot"><\/span>可更新 1<\/span>/, '可更新徽章');
  assert.match(res.body, /<span class="badge [a-z]+"><span class="bdot"><\/span>已移除 1<\/span>/, '已移除徽章');
  // 行级动作：检查 + 装全部新增 + 更新全部
  assert.match(res.body, /name="row" value="check\|a\/b\|">检查<\/button>/);
  assert.match(res.body, /name="row" value="installAll\|a\/b\|">装全部新增 \(1\)<\/button>/);
  assert.match(res.body, /name="row" value="updateAll\|a\/b\|">更新全部 \(1\)<\/button>/);
  // 来源列三态
  assert.match(res.body, /订阅<\/span>/, '订阅仓的来源写「订阅」');
  assert.match(res.body, /本地 · 未托管/);
  // 本地卡没有仓库级按钮，也不该出现 check| 加空 source
  const localCard = [...res.body.matchAll(/<article class="card">([\s\S]*?)<\/article>/g)]
    .map((match) => match[1]).find((card) => card.includes('本地 · 未托管'));
  assert.equal(/name="row"/.test(localCard), false, '本地卡没有按钮');
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
  // 语义：一个带 bdot 的「检查失败」徽章，原因在 title 里（class 尾缀不锁死）。
  assert.match(res.body, /<span class="badge [a-z]+" title="API 限额用完了"><span class="bdot"><\/span>检查失败<\/span>/);
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
  assert.deepEqual(cardTitlesOf(res.body), ['a/b', 'm/m', 'z/z', '本地 · 未托管'], 'pending desc + source asc + local 沉底');
});

test('仓库列表：无仓无订阅时给引导文案，不渲染空表', async () => {
  const res = await renderPage('/dsh-agents-skills?tab=repos', { overview: async () => overviewOf([]) });
  assert.match(res.body, /还没有仓库。在上面输入 owner\/repo 添加一个，或去<a href="\/dsh-agents-skills\?tab=skills">「所有技能」<\/a>里搜索安装。/);
  assert.equal(res.body.includes('<table class="skills">'), false, '空态不渲染空表');
});

test('仓库子页：面包屑 + 只渲染该仓的行 + 去掉仓库列', async () => {
  const res = await renderPage('/dsh-agents-skills?tab=repo&repo=a%2Fb&check=1');
  assert.equal(res.status, 200);
  assert.match(res.body, /<a[^>]*href="\/dsh-agents-skills\?tab=repos">← 仓库<\/a>/, '面包屑回仓库列表');
  assert.match(res.body, /<h1[^>]*>a\/b<\/h1>/);
  // 语义：子页没有「仓库」列，其余 7 个表头都在。
  assert.equal(/<th>仓库<\/th>/.test(res.body), false, '子页没有仓库列');
  for (const head of ['技能', '状态', '说明', '来源路径', '装于', '操作']) {
    assert.equal(res.body.includes('<th>' + head + '</th>') || res.body.includes('>' + head + '</th>'), true, '表头有 ' + head);
  }
  assert.equal((res.body.match(/<th[ >]/g) ?? []).length, 7, '子页表格 7 列');
  assert.match(res.body, /已装 2\/3 · 新增 1 · 可更新 1 · 已移除 1/, '页头统计');
  const rows = rowsOf(res.body);
  assert.deepEqual(rows.map((row) => row.name + '=' + row.state), ['gone=gone', 'new-one=new', 'tdd=upd'], '按名字排序');
  for (const row of rows) assert.equal(tdsOf(row.html).length, 7, row.name + ' 行 7 列');
  assert.equal(res.body.includes('data-name="mine"'), false, '别的仓（本地）的行不出现');
  // 子页也有整套批量协议，仓库位仍是本仓 source
  assert.match(res.body, /name="back" value="\?tab=repo&amp;repo=a%2Fb"/);
  assert.match(res.body, /name="row" value="install\|a\/b\|new-one"/);
  assert.match(res.body, /<div class="batchbar" id="batchbar">/);
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
  assert.match(res.body, /已装 0 · 未检查/, '页头统计说未检查');

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
  assert.match(res.body, /<h1[^>]*>本地 · 未托管<\/h1>/);
  assert.match(res.body, /name="row" value="remove\|\|mine">删除</);
  assert.equal(res.body.includes('name="row" value="check|'), false, '本地页没有检查按钮');
  assert.equal(res.body.includes('installAll'), false, '本地页没有装全部新增');
  assert.equal(res.body.includes('updateAll'), false, '本地页没有更新全部');
  // 判据是「没有勾选框元素」——CSS 里那句 input[name="pick"] 的选中态样式不算。
  assert.equal(/<input[^>]*name="pick"/.test(res.body), false, '已装行没有勾选框');
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
  assert.match(res.body, /新增 1 · 可更新 1 · 上游已移除 1/);
  assert.match(res.body, /<button class="[^"]*" type="submit" name="batch" value="updateAll">更新全部 \(1\)<\/button>/);
  const rows = rowsOf(res.body);
  assert.deepEqual(rows.map((row) => row.name), ['gone', 'new-one', 'tdd'], '三条待办');
  assert.equal(res.body.includes('data-name="mine"'), false, '已装且最新的行不进待办');
  assert.match(res.body, /<td[^>]*><a href="\/dsh-agents-skills\?tab=repo&amp;repo=a%2Fb">/, '待办的仓库列链到子页');
  for (const row of rows) assert.equal(tdsOf(row.html).length, 8, row.name + ' 行 8 列');
});

test('待办：两个空态分支（没查过 → 引导去检查；查过且无待办 → 说已最新）', async () => {
  const cold = await renderPage('/dsh-agents-skills?tab=todo');
  assert.match(cold.body, /还没检查过/);
  assert.match(cold.body, /<a class="[^"]*" href="\/dsh-agents-skills\?tab=todo&amp;check=2">检查更新<\/a>/, '冷启动给检查入口');
  assert.equal(cold.body.includes('没有待办：所有盯着的仓库都已装上且最新。'), false);

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
  assert.equal(clean.body.includes('name="row" value="check|'), false, '待办页只列待办，不挂仓库级检查按钮');
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
  for (const url of ['/dsh-agents-skills', '/dsh-agents-skills?tab=repos&check=1', '/dsh-agents-skills?tab=repo&repo=a%2Fb&check=1', '/dsh-agents-skills?tab=todo&check=1', '/dsh-agents-skills?tab=skills', '/dsh-agents-skills?tab=agent', '/dsh-agents-skills?tab=skills&q=react', '/dsh-agents-skills?check=1', '/dsh-agents-skills?tab=skills&check=1&state=new', '/dsh-agents-skills?tab=skills&check=1&filter=tdd&pickall=1']) {
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
  // 行数按「实际行」算：末尾换行不算多一行（199 行与 200 行都合规）。
  const lineCount = res.body.split('\n').length - (res.body.endsWith('\n') ? 1 : 0);
  assert.equal(lineCount <= 200, true, '交互层 ≤200 行，实际 ' + lineCount);
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
  // 关掉 JS 之后每个操作都要有服务端等价物：批量与行内是 POST 表单字段，筛选/导航是 GET 链接，
  // 折叠是原生 <details>（浏览器自己就能开合）。
  assert.match(body, /<form class="skills-form" method="post">/, '批量与行内操作是真实表单');
  assert.match(body, /name="batch" value="install"/, '批量安装靠表单字段');
  assert.match(body, /name="batch" value="update"/, '批量更新靠表单字段');
  assert.match(body, /name="batch" value="remove"/, '批量删除靠表单字段');
  assert.match(body, /name="row" value="install\|a\/b\|new-one"/, '行级安装靠表单字段');
  assert.match(body, /<details class="fold" open data-fold="a\/b">/, '分组折叠是原生 details');
  assert.match(body, /<details class="fold"><summary>搜索安装<\/summary>/, '搜索安装也是原生 details');
  assert.match(body, /<form class="field" method="get" action="\/dsh-agents-skills">/, '状态/名字筛选是 GET 表单');
  // 状态 chip 全是 GET 链接（含 state= 那些新取值）。
  assert.match(body, /<a class="chip"[^>]*href="[^"]*state=new"[^>]*>/, '新增 chip 是链接');
  assert.match(body, /<a class="chip"[^>]*href="[^"]*state=local"[^>]*>/, '本地 chip 是链接');
  // 仓库页的添加与仓库级动作同样是真实表单。
  const repos = (await renderPage('/dsh-agents-skills?tab=repos&check=1')).body;
  assert.match(repos, /<form class="toolbar" method="post">[\s\S]*name="action" value="subscribe"/, '添加仓库是 POST 表单');
  assert.match(repos, /name="row" value="check\|a\/b\|"/, '仓库级检查靠表单字段，不靠 JS');
});

test('（e）提交中禁用：交互层给被点的按钮打标记，样式里也有对应的等待视觉', async () => {
  // 不再逐字匹配 .busy 的 CSS 正文（调样式不该让测试变红）：只要求「交互层会标记/禁用提交按钮」
  // 且「样式里有对 .busy 或 [disabled] 的处理」这两件可观察的能力。
  const asset = (await renderPage('/dsh-agents-skills?asset=page-ui.js')).body;
  assert.match(asset, /(classList\.(add|toggle)\(\s*['"]busy['"]|\.disabled\s*=\s*true)/, '交互层标记提交中的按钮');
  const style = (await renderPage('/dsh-agents-skills')).body;
  assert.match(style, /\.busy\b|\[disabled\]/, '样式里有提交中/禁用视觉');
});

test('（f）底部说明不再声称「禁止一切脚本」', async () => {
  const body = (await renderPage('/dsh-agents-skills?tab=skills')).body;
  assert.equal(body.includes('禁止一切脚本'), false);
  assert.equal(body.includes('不含任何脚本'), false);
  assert.match(body, /页面脚本仅限本站自身的一个文件/);
});

test('（b）表头粘性偏移必须是 0；td/th 不 sticky；tbody 无 rowspan / colspan', async () => {
  const res = await renderPage('/dsh-agents-skills?tab=skills&check=1');
  // 语义：解析 CSS 规则，凡声明 sticky 的表头/单元格，偏移必须是 0（top:38px 那次的教训）；
  // 不逐字匹配选择器文本（改样式不该误报）。
  const stickyOffsets = cssRules(res.body)
    .filter((rule) => /position:\s*sticky/.test(rule.body) && /(^|[^\w-])t[dh]([.:\[#\s]|$)/.test(rule.selector))
    .map((rule) => /top:\s*([^;]+)/.exec(rule.body)?.[1].trim() ?? '');
  for (const offset of stickyOffsets) {
    assert.equal(offset === '0' || offset === '0px', true, '粘性偏移必须归零，实际是 ' + offset);
  }
  // 表头是粘的（这条能力要保留）：存在针对表头的 sticky 规则。
  assert.equal(stickyOffsets.length > 0, true, '表头仍有粘性（否则长表滚没了表头）');
  // tbody 里不许 rowspan / colspan：有数据与空表两种渲染都查（技能页每仓一张表，逐张查）
  const empty = await renderPage('/dsh-agents-skills?tab=skills&check=1', { overview: async () => overviewOf([]) });
  for (const [label, html] of [['有数据', res.body], ['空表', empty.body]]) {
    for (const tbody of tbodiesOf(html)) {
      assert.equal(/rowspan/.test(tbody), false, label + ' tbody 无 rowspan');
      assert.equal(/colspan/.test(tbody), false, label + ' tbody 无 colspan');
    }
  }
  // 仓库子页 / 待办页的表体同样不许合并单元格
  const otherViews = [
    ['仓库子页', '/dsh-agents-skills?tab=repo&repo=a%2Fb&check=1'],
    ['待办', '/dsh-agents-skills?tab=todo&check=1'],
  ];
  for (const [label, url] of otherViews) {
    for (const tbody of tbodiesOf((await renderPage(url)).body)) {
      assert.equal(/rowspan/.test(tbody), false, label + ' tbody 无 rowspan');
      assert.equal(/colspan/.test(tbody), false, label + ' tbody 无 colspan');
    }
  }
});

test('（c）仓库条已删除：仓库级动作只出现在仓库页与仓库子页，按真实表单字段判定', async () => {
  const skillsPage = (await renderPage('/dsh-agents-skills?tab=skills&check=1')).body;
  assert.equal(skillsPage.includes('repostrip'), false, '技能页没有仓库条');
  assert.equal(/name="row" value="check\|/.test(skillsPage), false, '技能页没有仓库级「检查」');
  assert.equal(/name="row" value="installAll\|/.test(skillsPage), false, '技能页没有「装全部新增」');
  assert.equal(/name="row" value="updateAll\|/.test(skillsPage), false, '技能页没有仓库级「更新全部」');

  const repos = (await renderPage('/dsh-agents-skills?tab=repos&check=1')).body;
  assert.match(repos, /name="row" value="check\|a\/b\|"/);
  assert.match(repos, /name="row" value="installAll\|a\/b\|"/);
  assert.match(repos, /name="row" value="updateAll\|a\/b\|"/);

  const sub = (await renderPage('/dsh-agents-skills?tab=repo&repo=a%2Fb&check=1')).body;
  assert.match(sub, /name="row" value="check\|a\/b\|"/, '仓库子页也保留仓库级动作');

  const local = (await renderPage('/dsh-agents-skills?tab=repo&repo=__local__')).body;
  assert.equal(/name="row" value="check\|/.test(local), false, '本地子页没有检查类动作');
});

test('（d）状态列每行最多一个徽章，并发原因合并进 title，可见性作后缀文字', async () => {
  const wonky = skillOf('wonky', 'a/b', { valid: false, modelInvocable: false, userInvocable: false });
  const delta = deltaOf();
  delta.repos[0].updatable.push({ name: 'wonky', path: 'skills/wonky', installedHash: 'old', remoteHash: 'new' });
  const res = await renderPage('/dsh-agents-skills?tab=skills&check=1', {
    overview: async () => overviewOf([wonky, skillOf('gone', 'a/b'), skillOf('mine', '')]),
    check: async () => delta,
  });
  const rows = rowsOf(res.body);
  assert.deepEqual(rows.map((row) => row.name).sort(), ['gone', 'mine', 'new-one', 'wonky'], '四行数据');
  const statusCells = rows.map((row) => /<td class="status">([\s\S]*?)<\/td>/.exec(row.html)[1]);
  for (const cell of statusCells) {
    assert.equal((cell.match(/<span class="badge/g) ?? []).length <= 1, true, '状态格最多一个徽章：' + cell);
  }
  const wonkyCell = statusCells.find((cell) => /格式不合规/.test(cell));
  // 徽章带 bdot 圆点；并发原因合并进 title（分号连接），class 尾缀不锁死。
  assert.match(wonkyCell, /<span class="badge [a-z]+" title="格式不合规；可更新"><span class="bdot"><\/span>格式不合规<\/span>/, '优先级与 title 合并');
  // 可见性（模型专用 / 仅用户可用）是徽章后面的小号文字，不是另一个徽章。
  const badgeStripped = wonkyCell.replace(/<span class="badge[^>]*><span class="bdot"><\/span>[^<]*<\/span>/g, '');
  assert.match(badgeStripped, /仅用户可用 ·模型专用/, '可见性是徽章外的后缀文字');
  assert.equal(/<span class="badge[^>]*>仅用户可用/.test(res.body), false, '可见性不渲染成徽章');
  // 徽标一律带 bdot 语义点（新皮肤）：徽章数与圆点数相等。
  const badgeCount = (res.body.match(/<span class="badge[^>]*>/g) ?? []).length;
  const bdotCount = (res.body.match(/<span class="bdot"><\/span>/g) ?? []).length;
  assert.equal(bdotCount, badgeCount, '每个徽章都带 <span class="bdot"> 圆点');
  // 上游已移除行的技能名带删除线样式钩子
  assert.match(res.body, /<tr class="orphan"/, 'orphan 行有删除线样式钩子');
  assert.match(rowByName(res.body, 'gone').html, /class="lock" title="上游已移除"/, 'orphan 行有「已移除」角标');
});

test('（e）表格下方两个 details.fold；有搜索结果时搜索区默认展开', async () => {
  const plain = await renderPage('/dsh-agents-skills?tab=skills&check=1');
  // 语义：表格下方恰好一个「搜索安装」折叠区与一个「使用说明」折叠区（分组卡另有 data-fold）。
  assert.equal((plain.body.match(/<details class="fold"><summary>搜索安装<\/summary>/g) ?? []).length, 1, '一个搜索折叠区');
  assert.equal((plain.body.match(/<details class="fold"><summary>使用说明<\/summary>/g) ?? []).length, 1, '一个说明折叠区');
  const searched = await renderPage('/dsh-agents-skills?tab=skills&q=react');
  assert.match(searched.body, /<details class="fold" open><summary>搜索安装<\/summary>/, '有结果时带 open');
  assert.equal((searched.body.match(/<details class="fold" open><summary>搜索安装<\/summary>/g) ?? []).length, 1);
  // 分组卡是带 data-fold 的 details；搜索/说明折叠区没有 data-fold。
  assert.equal(foldsOf(plain.body).size, 2, 'plain 页有两个分组卡（a/b 与本地）');
});

test('（f）技能页默认折叠策略：只展开有待办的仓库，筛选时命中的组也展开', async () => {
  const plain = await renderPage('/dsh-agents-skills?tab=skills&check=1');
  const folds = foldsOf(plain.body);
  assert.deepEqual([...folds.keys()].sort(), ['__local__', 'a/b'], '每个分组一张卡');
  assert.equal(folds.get('a/b'), true, '有待办的仓库默认展开');
  assert.equal(folds.get('__local__'), false, '没有待办的仓库默认折起');

  // 用了筛选：命中的组要展开（否则筛选结果被折在里面看不见）。
  const filtered = await renderPage('/dsh-agents-skills?tab=skills&check=1&state=local');
  assert.deepEqual([...foldsOf(filtered.body).keys()], ['__local__'], '筛选后只剩命中的组');
  assert.equal(foldsOf(filtered.body).get('__local__'), true, '筛选命中的组展开');

  // 没检查过：没有任何待办，所有组都折起。
  const cold = await renderPage('/dsh-agents-skills?tab=skills');
  for (const [key, open] of foldsOf(cold.body)) {
    assert.equal(open, false, key + ' 未检查时折起');
  }
});

test('（g）页面吃 DSH 设计令牌，旧自研变量（--paper/--ink/…）彻底消失', async () => {
  const body = (await renderPage('/dsh-agents-skills')).body;
  // 令牌来自 dsh-client-ui-theme 的副本：至少若干种 alias 语义色都在。
  const aliasTokens = new Set(body.match(/--dsw-alias-[a-z0-9-]+/g) ?? []);
  assert.equal(aliasTokens.size >= 10, true, 'DSH alias 令牌数量足够，实际 ' + aliasTokens.size);
  for (const token of ['--dsw-alias-bg-base', '--dsw-alias-label-primary', '--dsw-alias-border-l2', '--dsw-alias-link']) {
    assert.equal(aliasTokens.has(token), true, '有 ' + token);
  }
  // 旧自研变量：定义与引用都不许再有（注意别把令牌定义段里的其它名字误判）。
  const legacy = /--(paper|ink|sub|line|line-soft|amber|ok|err)(?![a-z0-9-])\s*[):,;]/g;
  assert.deepEqual([...new Set(body.match(legacy) ?? [])], [], '不出现旧自研变量');
  assert.equal(/var\(--(paper|ink|line|line-soft|amber)\b/.test(body), false, '自有样式不再引用旧变量');
});

test('（h）主题偏好三路 SSR：html 属性 + body 暗色属性 + system 的媒体查询', async () => {
  const { normalizeThemePreference } = await loadPage();
  assert.equal(normalizeThemePreference('light'), 'light');
  assert.equal(normalizeThemePreference('dark'), 'dark');
  assert.equal(normalizeThemePreference('system'), 'system');
  assert.equal(normalizeThemePreference('solarized'), 'system', '非法值回退 system');
  assert.equal(normalizeThemePreference(undefined), 'system', '读不到回退 system');

  const light = (await renderPage('/dsh-agents-skills', { theme: async () => 'light' })).body;
  assert.match(light, /<html lang="zh-CN" data-theme-pref="light">/);
  assert.equal(/<body data-ds-dark-theme>/.test(light), false, '亮色不烤暗色属性');
  assert.equal(/@media \(prefers-color-scheme: dark\)/.test(light), false, '亮色只射一套');

  const dark = (await renderPage('/dsh-agents-skills', { theme: async () => 'dark' })).body;
  assert.match(dark, /<html lang="zh-CN" data-theme-pref="dark">/);
  assert.match(dark, /<body data-ds-dark-theme>/, '暗色在 body 上烤出宿主同名属性');
  assert.equal(/@media \(prefers-color-scheme: dark\)/.test(dark), false, '暗色只射一套');

  for (const [label, overrides] of [['缺省', {}], ['非法', { theme: async () => 'weird' }], ['读取抛错', { theme: async () => { throw new Error('设置服务没起来'); } }]]) {
    const body = (await renderPage('/dsh-agents-skills', overrides)).body;
    assert.match(body, /<html lang="zh-CN" data-theme-pref="system">/, label + ' 回退 system');
    assert.equal(/<body data-ds-dark-theme>/.test(body), false, label + ' 不烤暗色属性');
    assert.match(body, /@media \(prefers-color-scheme: dark\)\{[\s\S]*body\{/, label + ' 暗色包在媒体查询里');
  }
});

// ---------------------------------------------------------------------------
// 新参数与新前端钩子：状态筛选、名字筛选、批量增强。
// ---------------------------------------------------------------------------

test('GET ?state=：状态 chip 语义筛选（new / upd / gone / local / all）', async () => {
  const cases = [
    ['new', ['new-one']],
    ['upd', ['tdd']],
    ['gone', ['gone']],
    ['local', ['mine']],
    ['all', ['gone', 'new-one', 'tdd', 'mine']],
  ];
  for (const [state, names] of cases) {
    const res = await renderPage('/dsh-agents-skills?tab=skills&check=1&state=' + state);
    assert.equal(res.status, 200, state);
    assert.deepEqual(rowsOf(res.body).map((row) => row.name), names, 'state=' + state + ' 只留命中的行');
    const chips = chipsOf(res.body);
    assert.equal(chips.get(state === 'all' ? '全部' : state === 'upd' ? '可更新' : state === 'gone' ? '上游已移除' : state === 'local' ? '本地·未托管' : '新增').pressed, true,
      'state=' + state + ' 的 chip 处于选中态');
  }
});

test('GET ?filter=：按技能名子串筛选，非法 state 回退 all，超长 filter 截到 64 字', async () => {
  const hit = await renderPage('/dsh-agents-skills?tab=skills&check=1&filter=new');
  assert.deepEqual(rowsOf(hit.body).map((row) => row.name), ['new-one'], '子串命中一行');
  assert.match(hit.body, /name="filter" value="new"/, '筛选值回填进输入框');
  assert.match(hit.body, /data-live-filter/, '筛选框带实时筛选钩子');

  const miss = await renderPage('/dsh-agents-skills?tab=skills&check=1&filter=zzz');
  assert.deepEqual(rowsOf(miss.body), [], '没有命中就没有数据行');
  assert.match(miss.body, /没有匹配的技能/, '空态说人话');

  const illegal = await renderPage('/dsh-agents-skills?tab=skills&check=1&state=evil');
  assert.equal(chipsOf(illegal.body).get('全部').pressed, true, '非法 state 回退 all');
  assert.equal(rowsOf(illegal.body).length, 4, '非法 state 不筛掉任何行');

  const long = await renderPage('/dsh-agents-skills?tab=skills&check=1&filter=' + 'x'.repeat(100));
  assert.equal(/name="filter" value="([^"]*)"/.exec(long.body)[1].length, 64, 'filter 截到 64 字');
});

test('新前端钩子齐全：data-live-filter / data-name / data-state / data-rowpick / data-checkall / data-fold / batchbar', async () => {
  const body = (await renderPage('/dsh-agents-skills?tab=skills&check=1')).body;
  assert.match(body, /<input type="search" name="filter"[^>]*data-live-filter/, '实时筛选钩子');
  assert.match(body, /<input type="checkbox" data-checkall aria-label="[^"]*">/, '分组全选钩子');
  assert.match(body, /<input type="checkbox" name="pick" value="a\/b\|new-one" data-rowpick/, '单行勾选钩子');
  assert.match(body, /id="batchbar"/, '批量条有 id');
  assert.match(body, /id="pickCount" data-pick-count/, '计数位有 id 与钩子');
  assert.match(body, /<details class="fold" open data-fold="a\/b">/, '分组折叠带 data-fold');
  for (const row of rowsOf(body)) {
    assert.equal(/data-state="[a-z]+"/.test(row.attrs), true, '行有 data-state');
    assert.equal(/data-name="[^"]+"/.test(row.attrs), true, '行有 data-name');
  }
});

test('frontmatter 残渣（>/|-/|->）不再落进说明列', async () => {
  const { cleanDescription } = await loadPage();
  for (const residue of ['>', '|-', '>-', '>-2', '|+']) {
    assert.equal(cleanDescription(residue), '', '残渣 ' + residue + ' 被清成空');
  }
  assert.equal(cleanDescription('正常说明'), '正常说明');
  assert.equal(cleanDescription(null), '');

  const skills = [
    skillOf('r-gt', 'a/b', { description: '>' }),
    skillOf('r-pipe', 'a/b', { description: '|-' }),
    skillOf('good', 'a/b', { description: '正常说明' }),
  ];
  const res = await renderPage('/dsh-agents-skills?tab=skills&check=1', { overview: async () => overviewOf(skills) });
  assert.equal(tbodyOf(res.body).includes('|-'), false, '表体里不再出现孤立的 |-');
  assert.equal(tdsOf(rowByName(res.body, 'r-gt').html)[3].includes('&gt;'), false, '说明列不再出现孤立的 >');
  assert.match(tdsOf(rowByName(res.body, 'good').html)[3], /正常说明/, '正常说明照常显示');
});

test('协议值语义不变：row / batch / pick / subscribe / check / tab / pickall / back', async () => {
  const skills = (await renderPage('/dsh-agents-skills?tab=skills&check=1')).body;
  assert.match(skills, /name="back" value="\?tab=skills&amp;check=1"/, 'back 是本站相对查询串');
  assert.match(skills, /name="row" value="install\|a\/b\|new-one"/, 'row = 动作|仓库|技能');
  assert.match(skills, /name="row" value="update\|a\/b\|tdd"/);
  assert.match(skills, /name="row" value="remove\|a\/b\|gone"/);
  assert.match(skills, /name="pick" value="a\/b\|new-one"/, 'pick = 仓库|技能');
  for (const batch of ['install', 'update', 'remove', 'updateAll']) {
    assert.match(skills, new RegExp('name="batch" value="' + batch + '"'), 'batch=' + batch);
  }
  assert.match(skills, /href="\/dsh-agents-skills\?tab=skills&amp;check=1&amp;pickall=1"/, 'pickall 链接');
  assert.match(skills, /href="\/dsh-agents-skills\?tab=skills&amp;check=1&amp;todo=1"/, 'todo=1 链接');
  assert.match(skills, /href="\/dsh-agents-skills\?tab=skills&amp;check=2"/, 'check=2 强制重查链接');
  for (const tab of ['repos', 'skills', 'todo', 'agent']) {
    assert.match(skills, new RegExp('href="/dsh-agents-skills\\?tab=' + tab + '"'), '导航到 tab=' + tab);
  }
  const repos = (await renderPage('/dsh-agents-skills?tab=repos&check=1')).body;
  assert.match(repos, /name="action" value="subscribe"/, 'subscribe 协议不变');
  assert.match(repos, /name="source"/, 'subscribe 的参数名不变');
  const repo = (await renderPage('/dsh-agents-skills?tab=repo&repo=a%2Fb&check=1')).body;
  assert.match(repo, /name="back" value="\?tab=repo&amp;repo=a%2Fb"/, '子页 back 带 repo');
});
