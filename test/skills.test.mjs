// dsh-agents-skills · 技能面板测试
//
// 覆盖三块：
//   1. 纯解析（frontmatter / CLI 输出）——不碰网络也不碰磁盘；
//   2. 差异计算（GitHub tree + 锁文件 → 新增 / 可更新 / 已移除）；
//   3. 宿主半服务——用临时 `$DSH_AGENTS_HOME` 跑 overview / read，并在**影子接收者**
//      上调用（Remote 方法一旦碰私有成员，这里会当场炸）。
//
// 不联网：check 只用「空来源」或「写法非法的来源」，search 只用空关键词（提前返回），
// action 只用非法动作（不发子进程）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

const { Context } = requireDsh('@deepseek-ai/cordis');

/** @returns {Promise<object>} lib/skills.js */
async function loadSkills() {
  return await import(pathToFileURL(join(libDir, 'skills.js')).href);
}

/** @returns {Promise<object>} lib/typert.host.js 的 TYPERT 清单 */
async function loadManifest() {
  const { TYPERT } = await import(pathToFileURL(join(libDir, 'typert.host.js')).href);
  return TYPERT;
}

/**
 * 在一个临时 agents home 里跑测试主体。
 * @param {(home: string) => Promise<void>} run 测试主体
 */
async function withAgentsHome(run) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-skills-test-'));
  const previous = process.env.DSH_AGENTS_HOME;
  process.env.DSH_AGENTS_HOME = home;
  try {
    await run(home);
  } finally {
    if (previous === undefined) delete process.env.DSH_AGENTS_HOME;
    else process.env.DSH_AGENTS_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * 造一个技能目录束。
 * @param {string} home agents home
 * @param {string} name 技能名
 * @param {string} body frontmatter 之后的正文
 * @param {string} [frontmatter] 覆盖默认 frontmatter
 */
async function writeSkill(home, name, body = '正文', frontmatter = undefined) {
  const dir = join(home, 'skills', name);
  await mkdir(dir, { recursive: true });
  const head = frontmatter ?? `---\nname: ${name}\ndescription: ${name} 的说明\n---\n`;
  await writeFile(join(dir, 'SKILL.md'), head + body, 'utf8');
}

/**
 * 造一个锁文件。
 * @param {string} home agents home
 * @param {Record<string, object>} skills 锁条目
 */
async function writeLock(home, skills) {
  await writeFile(join(home, '.skill-lock.json'), JSON.stringify({ version: 3, skills }, null, 2), 'utf8');
}

// ── 1. 纯解析 ────────────────────────────────────────────────────────────────

test('frontmatter：合法技能解析出名字、说明与两个调用开关', async () => {
  const { parseFrontmatter } = await loadSkills();
  const parsed = parseFrontmatter('---\nname: code-review\ndescription: 审查改动\nwhenToUse: 需要评审时\n---\n# 正文\n');
  assert.equal(parsed.name, 'code-review');
  assert.equal(parsed.description, '审查改动');
  assert.equal(parsed.valid, true);
  assert.equal(parsed.modelInvocable, true);
  assert.equal(parsed.userInvocable, true);
});

test('frontmatter：disable-model-invocation / user-invocable 走 DSH 的布尔语法', async () => {
  const { parseFrontmatter } = await loadSkills();
  const off = parseFrontmatter('---\nname: hidden\ndescription: x\ndisable-model-invocation: true\nuser-invocable: "no"\n---\n');
  assert.equal(off.modelInvocable, false);
  assert.equal(off.userInvocable, false);
  const on = parseFrontmatter('---\nname: shown\ndescription: x\ndisable-model-invocation: OFF\nuser-invocable: 1\n---\n');
  assert.equal(on.modelInvocable, true);
  assert.equal(on.userInvocable, true);
  const broken = parseFrontmatter('---\nname: weird\ndescription: x\ndisable-model-invocation: maybe\n---\n');
  assert.equal(broken.valid, false);
  assert.match(broken.error, /disable-model-invocation/);
});

test('frontmatter：name 非 kebab-case 或缺 description 时标为无效但不抛错', async () => {
  const { parseFrontmatter } = await loadSkills();
  const badName = parseFrontmatter('---\nname: Bad_Name\ndescription: x\n---\n');
  assert.equal(badName.valid, false);
  assert.match(badName.error, /kebab-case/);
  const noDesc = parseFrontmatter('---\nname: ok-name\n---\n');
  assert.equal(noDesc.valid, false);
  assert.match(noDesc.error, /description/);
  const noFront = parseFrontmatter('# 没有 frontmatter\n');
  assert.equal(noFront.valid, false);
});

test('parseFindOutput：解析 npx skills find 的真实输出', async () => {
  const { parseFindOutput } = await loadSkills();
  const text = [
    '',
    'vercel-labs/agent-skills@vercel-composition-patterns 383.1K installs',
    '└ https://skills.sh/vercel-labs/agent-skills/vercel-composition-patterns',
    '',
    'anthropics/skills@web-artifacts-builder 107.3K installs',
    '└ https://skills.sh/anthropics/skills/web-artifacts-builder',
    '',
  ].join('\n');
  const results = parseFindOutput(text);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    repo: 'vercel-labs/agent-skills',
    skill: 'vercel-composition-patterns',
    installs: '383.1K',
    url: 'https://skills.sh/vercel-labs/agent-skills/vercel-composition-patterns',
  });
  assert.equal(results[1].installs, '107.3K');
});

test('parseListOutput：解析 npx skills add -l 的降级清单', async () => {
  const { parseListOutput } = await loadSkills();
  const text = [
    '◇  Found 38 skills',
    '◇  Available Skills',
    '│',
    '│    ask-matt',
    '│',
    '│      Ask which skill or flow fits your situation.',
    '│',
    '│    tdd',
    '│',
    '│      Test-driven development.',
  ].join('\n');
  const parsed = parseListOutput(text);
  assert.equal(parsed.count, 38);
  assert.deepEqual(parsed.skills.map((item) => item.name), ['ask-matt', 'tdd']);
  assert.equal(parsed.skills[0].description, 'Ask which skill or flow fits your situation.');
});

test('stripAnsi / parseSource / dirFromSkillPath 的边界', async () => {
  const { stripAnsi, parseSource, dirFromSkillPath, tailOf } = await loadSkills();
  assert.equal(stripAnsi('\u001b[36mask-matt\u001b[39m'), 'ask-matt');
  assert.deepEqual(parseSource('https://github.com/mattpocock/skills.git'), { slug: 'mattpocock/skills', owner: 'mattpocock', repo: 'skills', skill: '' });
  assert.equal(parseSource('mattpocock/skills@tdd').skill, 'tdd');
  assert.equal(parseSource('不是仓库'), null);
  assert.equal(dirFromSkillPath('skills/engineering/pr/SKILL.md'), 'skills/engineering/pr');
  assert.equal(dirFromSkillPath('SKILL.md'), '');
  assert.equal(dirFromSkillPath(undefined), '');
  assert.equal(tailOf('abcdef', 3), '…def');
});

// ── 2. 差异计算 ──────────────────────────────────────────────────────────────

test('skillsFromTree：只认 SKILL.md（仓库根或任意层级），并带上目录 sha', async () => {
  const { skillsFromTree } = await loadSkills();
  const tree = [
    { path: 'skills/engineering/pr', type: 'tree', sha: 'aaa' },
    { path: 'skills/engineering/pr/SKILL.md', type: 'blob', sha: 'blob1' },
    { path: 'skills/engineering/tdd', type: 'tree', sha: 'bbb' },
    { path: 'skills/engineering/tdd/SKILL.md', type: 'blob', sha: 'blob2' },
    { path: 'skills/engineering/tdd/references/x.md', type: 'blob', sha: 'blob3' },
    { path: 'README.md', type: 'blob', sha: 'blob4' },
  ];
  const found = skillsFromTree(tree);
  assert.deepEqual(found, [
    { dir: 'skills/engineering/pr', name: 'pr', hash: 'aaa' },
    { dir: 'skills/engineering/tdd', name: 'tdd', hash: 'bbb' },
  ]);
});

test('computeDelta：新增 / 可更新 / 上游已移除 三类一次算清', async () => {
  const { computeDelta } = await loadSkills();
  const lock = {
    pr: { source: 'mattpocock/skills', skillPath: 'skills/engineering/pr/SKILL.md', skillFolderHash: 'aaa' },
    tdd: { source: 'mattpocock/skills', skillPath: 'skills/engineering/tdd/SKILL.md', skillFolderHash: 'old' },
    gone: { source: 'mattpocock/skills', skillPath: 'skills/engineering/gone/SKILL.md', skillFolderHash: 'ccc' },
    other: { source: 'vercel-labs/skills', skillPath: 'skills/find-skills/SKILL.md', skillFolderHash: 'ddd' },
  };
  const available = [
    { dir: 'skills/engineering/pr', name: 'pr', hash: 'aaa' },
    { dir: 'skills/engineering/tdd', name: 'tdd', hash: 'new' },
    { dir: 'skills/engineering/chief-of-staff', name: 'chief-of-staff', hash: 'eee' },
  ];
  const delta = computeDelta('mattpocock/skills', lock, available);
  assert.equal(delta.available, 3);
  assert.equal(delta.installed, 3);
  assert.deepEqual(delta.newSkills, [{ name: 'chief-of-staff', path: 'skills/engineering/chief-of-staff', remoteHash: 'eee' }]);
  assert.deepEqual(delta.updatable, [{ name: 'tdd', path: 'skills/engineering/tdd', installedHash: 'old', remoteHash: 'new' }]);
  assert.deepEqual(delta.orphan, [{ name: 'gone', path: 'skills/engineering/gone' }]);
  assert.equal(delta.error, '');
});

test('computeDelta：锁条目没有 skillPath 时退化为按名字比对', async () => {
  const { computeDelta } = await loadSkills();
  const lock = { alpha: { source: 'o/r' }, beta: { source: 'o/r' } };
  const delta = computeDelta('o/r', lock, [{ dir: 'skills/alpha', name: 'alpha', hash: 'x' }]);
  assert.deepEqual(delta.newSkills, []);
  assert.deepEqual(delta.orphan, [{ name: 'beta', path: '' }]);
  assert.deepEqual(delta.updatable, []);
});

// ── 2b. 订阅仓库清单 ─────────────────────────────────────────────────────────

test('订阅清单：缺文件 / 坏 JSON / 非数组都返回 []，读的时候去空白去重', async () => {
  const { readSubscriptions, subscriptionsPath } = await loadSkills();
  await withAgentsHome(async (home) => {
    assert.equal(subscriptionsPath(), join(home, '.skill-subscriptions.json'));
    assert.deepEqual(await readSubscriptions(), [], '缺文件 → []');

    await writeFile(subscriptionsPath(), '{ 这不是 JSON', 'utf8');
    assert.deepEqual(await readSubscriptions(), [], '坏 JSON → []');

    await writeFile(subscriptionsPath(), '{"sources":["a/b"]}', 'utf8');
    assert.deepEqual(await readSubscriptions(), [], '不是数组 → []');

    await writeFile(subscriptionsPath(), '["o/r",42,"","  a/b  ","o/r",null]', 'utf8');
    assert.deepEqual(await readSubscriptions(), ['o/r', 'a/b'], '非字符串 / 空串被丢掉，重复项合一');
  });
});

test('addSubscription：校验失败 / 重复 / 成功三条路径，落盘是原子的', async () => {
  const { addSubscription, readSubscriptions, subscriptionsPath, parseSource } = await loadSkills();
  assert.equal(parseSource('不是仓库'), null);

  await withAgentsHome(async (home) => {
    const bad = await addSubscription('不是仓库');
    assert.equal(bad.ok, false);
    assert.match(bad.error, /owner\/repo/);
    assert.equal(bad.summary, '');
    assert.deepEqual(await readSubscriptions(), [], '校验失败不改文件');

    const first = await addSubscription('mattpocock/skills');
    assert.equal(first.ok, true);
    assert.equal(first.error, '');
    assert.match(first.summary, /已订阅 mattpocock\/skills/);
    assert.deepEqual(JSON.parse(await readFile(subscriptionsPath(), 'utf8')), ['mattpocock/skills']);

    const again = await addSubscription('mattpocock/skills');
    assert.equal(again.ok, true, '重复订阅也算成功');
    assert.match(again.summary, /已在订阅清单里/);
    assert.deepEqual(await readSubscriptions(), ['mattpocock/skills'], '不会写重复项');

    const url = await addSubscription('https://github.com/owner/repo.git');
    assert.equal(url.ok, true);
    assert.deepEqual(await readSubscriptions(), ['mattpocock/skills', 'owner/repo'], 'URL 归一成 slug 后追加');

    const leftovers = (await readdir(home)).filter((name) => name.includes('.tmp'));
    assert.deepEqual(leftovers, [], '临时文件写完就 rename 掉了，不留残骸');
  });
});

test('overview：纯订阅仓并进 repos（installed=0），分组带 origin', async () => {
  const { skillsOverview, groupSkills, addSubscription } = await loadSkills();
  await withAgentsHome(async (home) => {
    await writeSkill(home, 'alpha');
    await writeSkill(home, 'mine', '正文', '---\nname: mine\ndescription: 手写的\n---\n');
    await writeLock(home, { alpha: { source: 'o/r', skillPath: 'skills/alpha/SKILL.md', skillFolderHash: 'h1' } });
    await addSubscription('sub/repo');

    const state = await skillsOverview();
    assert.deepEqual(state.repos, [
      { source: 'o/r', installed: 1, names: ['alpha'] },
      { source: 'sub/repo', installed: 0, names: [] },
    ]);

    // 渲染层就是这么用的：订阅清单 → 分组。纯订阅仓一格都不缺，字段与派生组完全一致（只多 origin）。
    const subscriptions = state.repos.filter((repo) => repo.installed === 0).map((repo) => repo.source);
    const groups = groupSkills(state.skills, null, subscriptions);
    const subscribed = groups.find((group) => group.source === 'sub/repo');
    const derived = groups.find((group) => group.source === 'o/r');
    const local = groups.find((group) => group.local);

    assert.equal(subscribed.origin, 'subscribed');
    assert.equal(subscribed.local, false);
    assert.equal(subscribed.installed, 0);
    assert.equal(subscribed.available, -1);
    assert.equal(subscribed.checked, false);
    assert.equal(subscribed.mode, '');
    assert.equal(subscribed.error, '');
    assert.deepEqual(subscribed.news, []);
    assert.deepEqual(subscribed.updatable, []);
    assert.deepEqual(subscribed.orphans, []);
    assert.deepEqual(subscribed.items, []);
    assert.equal(subscribed.pending, 0);
    assert.deepEqual(Object.keys(subscribed).sort(), Object.keys(derived).sort(), '订阅组的字段集必须与派生组一致');

    assert.equal(derived.origin, 'derived');
    assert.equal(local.origin, 'local');
    assert.equal(local.key, '__local__');
  });
});

test('checkRepos：零已装的订阅仓，全部可装技能都进 news；分组后落在订阅组里', async () => {
  const { checkRepos, groupSkills, addSubscription } = await loadSkills();
  await withAgentsHome(async () => {
    await addSubscription('sub/repo');
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
      const delta = await checkRepos({ sources: ['sub/repo'] });
      assert.equal(delta.repos.length, 1);
      assert.equal(delta.repos[0].mode, 'api');
      assert.equal(delta.repos[0].installed, 0);
      assert.deepEqual(delta.repos[0].newSkills.map((item) => item.name), ['one', 'two']);
      assert.deepEqual(delta.repos[0].updatable, []);
      assert.deepEqual(delta.repos[0].orphan, []);

      const groups = groupSkills([], delta, ['sub/repo']);
      assert.equal(groups.length, 1);
      assert.equal(groups[0].origin, 'subscribed');
      assert.equal(groups[0].checked, true);
      assert.equal(groups[0].pending, 2);
      assert.deepEqual(groups[0].news.map((item) => item.name), ['one', 'two']);
      assert.deepEqual(groups[0].items.map((item) => item.kind + ':' + item.name), ['new:one', 'new:two']);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test('checkRepos：空来源时的默认名单 = 锁文件来源 ∪ 订阅清单', async () => {
  const { checkRepos, addSubscription } = await loadSkills();
  await withAgentsHome(async (home) => {
    await writeLock(home, { alpha: { source: 'o/r', skillPath: 'skills/alpha/SKILL.md', skillFolderHash: 'h1' } });
    await addSubscription('sub/repo');
    const realFetch = globalThis.fetch;
    const asked = [];
    globalThis.fetch = async (url) => {
      asked.push(String(url).split('/repos/')[1].split('/git/')[0]);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ tree: [] }) };
    };
    try {
      const delta = await checkRepos({});
      assert.deepEqual(delta.repos.map((repo) => repo.source), ['o/r', 'sub/repo'], '订阅仓也要被检查到');
      assert.deepEqual(asked.sort(), ['o/r', 'sub/repo']);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ── 3. 宿主半服务 ────────────────────────────────────────────────────────────

/**
 * 起一个真实的 Cordis Context，注册两个 Service，并给出 skillsPanel 的影子接收者。
 * @param {(shadow: object, home: string, services: object) => Promise<void>} run 测试主体
 */
async function withServices(run) {
  await withAgentsHome(async (home) => {
    const { default: GlobalAgentService } = await import(pathToFileURL(join(libDir, 'index.js')).href);
    const ctx = new Context();
    new GlobalAgentService(ctx, {});
    // `ctx.plugin()` 是异步生效的（真实宿主里整棵插件树加载完才开始服务请求），
    // 测试里等它就绪再取影子接收者。
    for (let waited = 0; ctx.get('skillsPanel') === undefined && waited < 200; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const shadow = ctx.extend({ invocation: { namespace: 'skillsPanel', method: 'overview' } }).get('skillsPanel');
    await run(shadow, home, { ctx, globalAgent: ctx.get('globalAgent'), skillsPanel: ctx.get('skillsPanel') });
  });
}

/**
 * 按 Gateway 的方式调用：影子接收者上取方法并以它为 this。
 * @param {object} receiver 影子接收者
 * @param {string} method 方法名
 * @param {object} request 参数
 * @returns {Promise<object>} 结果
 */
function callOn(receiver, method, request) {
  return Reflect.get(receiver, method).call(receiver, request);
}

test('第二个 Service 会随插件一起注册，且能在影子接收者上调用', async () => {
  await withServices(async (shadow, home, services) => {
    assert.ok(services.skillsPanel, 'skillsPanel 必须被注册');
    assert.notEqual(shadow, services.skillsPanel, '影子接收者必须与实例不同');
    assert.equal(shadow.constructor.name, 'SkillsPanelService');

    await writeSkill(home, 'alpha');
    await writeLock(home, {
      alpha: { source: 'o/r', skillPath: 'skills/alpha/SKILL.md', skillFolderHash: 'h1', installedAt: '2026-01-01T00:00:00.000Z' },
    });
    const state = await callOn(shadow, 'overview', {});
    assert.equal(state.ok, true);
    assert.equal(state.root, join(home, 'skills'));
    assert.equal(state.lockExists, true);
    assert.equal(state.skills.length, 1);
    assert.equal(state.skills[0].name, 'alpha');
    assert.equal(state.skills[0].managed, true);
    assert.equal(state.skills[0].source, 'o/r');
    assert.equal(state.skills[0].valid, true);
    assert.deepEqual(state.repos, [{ source: 'o/r', installed: 1, names: ['alpha'] }]);
    assert.ok(Array.isArray(state.notes));
  });
});

test('overview：目录里有但锁文件里没有的技能也能看到（managed=false）', async () => {
  await withServices(async (shadow, home) => {
    await writeSkill(home, 'mine', '正文', '---\nname: mine\ndescription: 手写的\n---\n');
    await writeSkill(home, 'broken', '正文', '---\nname: broken\n---\n');
    const state = await callOn(shadow, 'overview', {});
    assert.equal(state.lockExists, false);
    assert.deepEqual(state.skills.map((item) => item.name), ['broken', 'mine']);
    const mine = state.skills.find((item) => item.name === 'mine');
    assert.equal(mine.managed, false);
    assert.equal(mine.source, '');
    assert.equal(mine.kind, 'bundle');
    const broken = state.skills.find((item) => item.name === 'broken');
    assert.equal(broken.valid, false);
    assert.match(broken.detail, /description/);
  });
});

test('overview：软链进来的技能目录也要认（DSH 自己就是按 stat 发现的）', async () => {
  await withServices(async (shadow, home) => {
    const real = await mkdtemp(join(tmpdir(), 'dsh-skills-real-'));
    try {
      await mkdir(join(real, 'linked'), { recursive: true });
      await writeFile(join(real, 'linked', 'SKILL.md'), '---\nname: linked\ndescription: 软链技能\n---\n正文\n', 'utf8');
      await mkdir(join(home, 'skills'), { recursive: true });
      await symlink(join(real, 'linked'), join(home, 'skills', 'linked'), 'dir');
      // 断链不应让扫描炸掉，只是被跳过。
      await symlink(join(real, 'missing'), join(home, 'skills', 'broken'), 'dir');
      const state = await callOn(shadow, 'overview', {});
      assert.deepEqual(state.skills.map((item) => item.name), ['linked']);
      assert.equal(state.skills[0].valid, true);
      assert.equal(state.skills[0].kind, 'bundle');
    } finally {
      await rm(real, { recursive: true, force: true });
    }
  });
});

test('overview：订阅清单里的仓在零已装时也进 repos（Remote 影子接收者路径）', async () => {
  await withServices(async (shadow, home) => {
    await writeFile(join(home, '.skill-subscriptions.json'), JSON.stringify(['sub/repo'], null, 2), 'utf8');
    const state = await callOn(shadow, 'overview', {});
    assert.deepEqual(state.repos, [{ source: 'sub/repo', installed: 0, names: [] }]);
    assert.deepEqual(state.skills, []);
  });
});

test('read：本地技能按名字读回正文', async () => {
  await withServices(async (shadow, home) => {
    await writeSkill(home, 'alpha', '这是正文\n');
    const read = await callOn(shadow, 'read', { name: 'alpha', source: '', path: '' });
    assert.equal(read.ok, true);
    assert.equal(read.kind, 'local');
    assert.equal(read.name, 'alpha');
    assert.equal(read.path, join(home, 'skills', 'alpha', 'SKILL.md'));
    assert.match(read.content, /这是正文/);
    assert.equal(read.bytes, Buffer.byteLength(read.content, 'utf8'));
    const missing = await callOn(shadow, 'read', { name: 'nope', source: '', path: '' });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /没有这个技能/);
    const empty = await callOn(shadow, 'read', { name: '', source: '', path: '' });
    assert.equal(empty.ok, false);
  });
});

test('check：空来源走锁文件；写法非法的来源直接报错，不发网络请求', async () => {
  await withServices(async (shadow) => {
    const empty = await callOn(shadow, 'check', { sources: [] });
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.repos, []);
    assert.equal(typeof empty.checkedAt, 'string');

    const bad = await callOn(shadow, 'check', { sources: ['不是仓库'] });
    assert.equal(bad.ok, true);
    assert.equal(bad.repos.length, 1);
    assert.equal(bad.repos[0].mode, 'failed');
    assert.match(bad.repos[0].error, /owner\/repo/);
  });
});

test('buildActionArgs：命令拼装（装加 -a universal、删不加 -a、更新接多个名字）', async () => {
  const { buildActionArgs } = await loadSkills();
  assert.deepEqual(
    buildActionArgs({ kind: 'install', source: 'mattpocock/skills', name: '', skills: ['pr', 'tdd'] }).args,
    ['add', 'mattpocock/skills', '-a', 'universal', '-g', '-y', '--json', '-s', 'pr', '-s', 'tdd'],
  );
  assert.deepEqual(
    buildActionArgs({ kind: 'install', source: 'mattpocock/skills', name: '', skills: [] }).args,
    ['add', 'mattpocock/skills', '-a', 'universal', '-g', '-y', '--json'],
  );
  assert.deepEqual(
    buildActionArgs({ kind: 'remove', source: '', name: 'tdd', skills: [] }).args,
    ['remove', '-g', '-y', '-s', 'tdd'],
  );
  assert.deepEqual(
    buildActionArgs({ kind: 'update', source: '', name: 'tdd', skills: [] }).args,
    ['update', '-g', '-y', 'tdd'],
  );
  assert.deepEqual(
    buildActionArgs({ kind: 'update', source: '', name: '', skills: ['a', 'b'] }).args,
    ['update', '-g', '-y', 'a', 'b'],
  );
  assert.deepEqual(
    buildActionArgs({ kind: 'update', source: '', name: '', skills: [] }).args,
    ['update', '-g', '-y'],
  );
  assert.equal(buildActionArgs({ kind: 'install', source: '', name: '', skills: [] }).args, null);
  assert.match(buildActionArgs({ kind: 'install', source: '', name: '', skills: [] }).error, /缺少仓库名/);
  assert.match(buildActionArgs({ kind: 'remove', source: '', name: '', skills: [] }).error, /缺少技能名/);
  assert.match(buildActionArgs({ kind: 'x', source: '', name: '', skills: [] }).error, /不支持的动作/);
  // 空名字与空技能名会被丢掉，不会变成空参数。
  assert.deepEqual(
    buildActionArgs({ kind: 'update', source: '', name: '', skills: ['', 'a', ''] }).args,
    ['update', '-g', '-y', 'a'],
  );
});

test('参数校验：以 - 开头的值、非法技能名、穿越目录都被拒', async () => {
  const { assertSkillNames, assertQuery, assertRemotePath, parseSource, buildActionArgs } = await loadSkills();

  // 技能名：kebab-case，且天然挡住 `--all` 这类开关
  assert.deepEqual(assertSkillNames(['pr', 'chief-of-staff']).names, ['pr', 'chief-of-staff']);
  assert.equal(assertSkillNames('--all').ok, false);
  assert.equal(assertSkillNames('Bad_Name').ok, false);
  assert.equal(assertSkillNames(['pr', 'ok', '-x']).ok, false);

  // 仓库：段落以 - 开头会被 CLI 当开关，必须拒
  assert.equal(parseSource('mattpocock/skills').slug, 'mattpocock/skills');
  assert.equal(parseSource('--all/repo'), null);
  assert.equal(parseSource('owner/--all'), null);
  assert.equal(parseSource('owner/../etc'), null);
  assert.equal(parseSource('owner/repo@--all'), null);
  assert.equal(buildActionArgs({ kind: 'install', source: '--all/repo', name: '', skills: [] }).args, null);

  // 关键词：不能以 - 开头（否则 --owner 之类会被当成开关）
  assert.equal(assertQuery('react performance').ok, true);
  assert.equal(assertQuery('中文关键词').ok, true);
  assert.equal(assertQuery('--owner mattpocock').ok, false);
  assert.equal(assertQuery('a'.repeat(65)).ok, false);
  assert.equal(assertQuery('  ').ok, false);

  // 远程目录：不允许穿越
  assert.equal(assertRemotePath('skills/engineering/pr').ok, true);
  assert.equal(assertRemotePath('../../user').ok, false);
  assert.equal(assertRemotePath('skills/../../x').ok, false);
  assert.equal(assertRemotePath('').ok, false);
});

test('search / action：参数不合法时给出人话，且不启动子进程', async () => {
  await withServices(async (shadow, home) => {
    const search = await callOn(shadow, 'search', { query: '   ' });
    assert.equal(search.ok, false);
    assert.match(search.error, /关键词不能为空/);

    const unknown = await callOn(shadow, 'action', { kind: 'nope', source: '', name: '', skills: [] });
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /不支持的动作/);

    const noSource = await callOn(shadow, 'action', { kind: 'install', source: '', name: '', skills: ['x'] });
    assert.equal(noSource.ok, false);
    assert.match(noSource.error, /缺少仓库名/);

    const noName = await callOn(shadow, 'action', { kind: 'remove', source: '', name: '', skills: [] });
    assert.equal(noName.ok, false);
    assert.match(noName.error, /缺少技能名/);

    assert.equal(unknown.command, '');
    assert.equal(unknown.code, -1);
    const still = await callOn(shadow, 'overview', {});
    assert.deepEqual(still.skills, []);
  });
});

test('清单里的五个调用与真实服务的绑定、方法签名对得上', async () => {
  const manifest = await loadManifest();
  await withServices(async (shadow, home, services) => {
    const instance = services.skillsPanel;
    const binding = Reflect.get(instance, 'typertRemote');
    assert.ok(binding, 'TypertRemoteService 必须在实例上挂 typertRemote 绑定');
    // 只断言字符串字段：binding.service 是服务实例本身（Cordis 代理），
    // 对它做深比较会让断言库去遍历代理属性而抛「without inject」。
    assert.equal(binding.serviceKey, 'skillsPanel');
    assert.equal(binding.namespace, 'skillsPanel');
    for (const invocation of manifest.invocations.filter((item) => item.service === 'skillsPanel')) {
      assert.equal(invocation.namespace, 'skillsPanel', `${invocation.id} 的 namespace 必须是 skillsPanel`);
      assert.equal(typeof Reflect.get(instance, invocation.method), 'function', `${invocation.id} 在服务上没有对应方法`);
      assert.doesNotThrow(() => invocation.parameters[0].codec.create().parse({ name: '', source: '', path: '', kind: '', query: '', sources: [], skills: [] }), `${invocation.id} 的参数 schema 必须容忍全空对象里的已知字段`);
      void home;
      void shadow;
    }
  });
});

test('五个技能方法的结果字段与 typert 清单的 schema 完全一致', async () => {
  const manifest = await loadManifest();
  const byMethod = new Map(
    manifest.invocations
      .filter((invocation) => invocation.service === 'skillsPanel')
      .map((invocation) => [invocation.method, invocation]),
  );
  assert.deepEqual([...byMethod.keys()].sort(), ['action', 'check', 'overview', 'read', 'search']);

  await withServices(async (shadow, home) => {
    await writeSkill(home, 'alpha');
    const samples = new Map([
      ['overview', await callOn(shadow, 'overview', {})],
      ['check', await callOn(shadow, 'check', { sources: ['bad'] })],
      ['search', await callOn(shadow, 'search', { query: '' })],
      ['action', await callOn(shadow, 'action', { kind: 'nope', source: '', name: '', skills: [] })],
      ['read', await callOn(shadow, 'read', { name: 'alpha', source: '', path: '' })],
      ['read-miss', await callOn(shadow, 'read', { name: 'nope', source: '', path: '' })],
    ]);
    for (const [label, value] of samples) {
      const method = label === 'read-miss' ? 'read' : label;
      const schema = byMethod.get(method).result.create();
      assert.deepEqual(Object.keys(value).sort(), Object.keys(schema.shape).sort(), `${label} 的字段集必须与 schema 一致`);
      assert.doesNotThrow(() => schema.parse(value), `${label} 的结果必须通过 strict codec`);
    }
    const repoDelta = samples.get('check').repos[0];
    assert.deepEqual(Object.keys(repoDelta).sort(), Object.keys(byMethod.get('check').result.create().shape.repos.element.shape).sort());
  });
});
