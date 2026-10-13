// dsh-agents-skills · Client 半冒烟测试
//
// Client 半是给浏览器模块加载器写的（`window.__ModuleLoader__.load`），没有构建步骤，
// 所以这里用两个替身把它在 Node 里跑起来：
//   - 假的 `window.__ModuleLoader__` 抓住 factory；
//   - 极简 React 替身（createElement / useState / useEffect / useMemo）+ 一个走树的
//     "穷人版渲染"，把函数组件递归展开成文本。
// 它验的是「能注册、能渲染出预期文案、没有写崩的分支」，不验真实交互与样式——
// 那些要在浏览器里点。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, '..');

/**
 * 极简 React 替身。
 * @returns {object} React 形状的对象
 */
function fakeReact(overrides = []) {
  const queue = overrides.slice();
  return {
    createElement(type, props, ...children) {
      return { type, props: props === null || props === undefined ? {} : props, children };
    },
    useState(initial) {
      // 前几次调用可以喂预设值（外壳的 tab 与 pagePath），后面自然回落到初始值。
      if (queue.length > 0) return [queue.shift(), () => {}];
      return [typeof initial === 'function' ? initial() : initial, () => {}];
    },
    useEffect() { /* 冒烟测试不跑副作用 */ },
    useMemo(factory) { return factory(); },
  };
}

/**
 * 把函数组件递归展开成纯文本（够用就好：验证渲染路径与文案，不验证 hooks 语义）。
 * @param {object} node 元素或子节点
 * @param {object} React React 替身
 * @returns {string} 展开后的文本
 */
function renderText(node, React) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((child) => renderText(child, React)).join('');
  if (typeof node.type === 'function') {
    const element = node.type({ ...node.props, children: node.children }, {});
    return renderText(element, React);
  }
  return (node.children ?? []).map((child) => renderText(child, React)).join('');
}

/**
 * 用替身加载 client/client.js。
 * @returns {Promise<{ exports: object, React: object }>} 模块导出与 React 替身
 */
async function loadClient(overrides = []) {
  const code = await readFile(join(packageDir, 'client', 'client.js'), 'utf8');
  let captured = null;
  const loader = { load(spec) { captured = spec; } };
  // eslint-disable-next-line no-new-func -- 故意用 Function 构造器模拟模块加载器
  new Function('window', code)({ __ModuleLoader__: loader });
  assert.ok(captured, 'client 必须调用 __ModuleLoader__.load');
  assert.equal(captured.id, 'dsh-agents-skills');
  const React = fakeReact(overrides);
  const exports = captured.factory((name) => {
    if (name === 'react') return React;
    throw new Error('没有替身的依赖：' + name);
  });
  return { exports, React };
}

/**
 * 用假的 slots/connection 跑一遍 apply，取出注册信息。
 * @param {object} exports client 模块导出
 * @returns {{ spec: object, component: Function }} 注册内容
 */
function registerSection(exports) {
  const registered = [];
  const slots = {
    inject(name, callback) { callback(); },
    register(spec, component) { registered.push({ spec, component }); return () => {}; },
  };
  const scoped = { slots, connection: { rpc: { call: () => Promise.resolve({ ok: true, value: {} }) } } };
  const ctx = { inject(deps, callback) { callback(scoped); } };
  exports.apply(ctx);
  assert.equal(registered.length, 1, '必须只注册一个 settings.section');
  return registered[0];
}

test('Client 半注册的是 Agents&Skills 设置页', async () => {
  const { exports } = await loadClient();
  assert.deepEqual(exports.inject, ['slots', 'connection']);
  const { spec } = registerSection(exports);
  assert.equal(spec.name, 'settings.section');
  assert.equal(spec.id, 'global-agent');
  assert.equal(spec.order, 25);
  assert.equal(spec.label, 'Agents&Skills');
});

test('首个渲染出两个标签，Agent 面板内容与技能面板的控件都在', async () => {
  const { exports, React } = await loadClient();
  const { component } = registerSection(exports);
  const text = renderText(component({ rpc: { call: () => Promise.resolve({ ok: true, value: {} }) } }), React);
  // 标签
  assert.match(text, /Agent/);
  assert.match(text, /Skills/);
  // 标签 1（原有编辑器的关键文案）
  assert.match(text, /全局 Agent 提示词/);
  assert.match(text, /重新读取/);
  // 标签 2（按仓库的列表 + 控件）
  assert.match(text, /检查更新/);
  assert.match(text, /全部更新/);
  assert.match(text, /全部展开/);
  assert.match(text, /仅显示待办/);
  assert.match(text, /搜索安装/);
  assert.match(text, /npx skills/);
});

test('宿主上报了独立页路径时，标签行右侧出现「Agents&Skills」入口', async () => {
  // 外壳的两个 useState 依次是 tab 与 pagePath，喂预设值即可渲染出链接。
  const { exports, React } = await loadClient(['agent', '/dsh-agents-skills']);
  const { component } = registerSection(exports);
  const text = renderText(component({ rpc: { call: () => Promise.resolve({ ok: true, value: {} }) } }), React);
  assert.match(text, /Agents&Skills ↗/, '入口链接必须在标签行里');
});

test('宿主没上报路径（非 Web 宿主 / 注册冲突）时，入口链接不出现', async () => {
  const { exports, React } = await loadClient(['agent', '']);
  const { component } = registerSection(exports);
  const text = renderText(component({ rpc: { call: () => Promise.resolve({ ok: true, value: {} }) } }), React);
  assert.equal(text.includes('Agents&Skills ↗'), false);
});

/**
 * 造一份 overview 结果。
 * @param {object[]} skills 技能行
 * @returns {object} overview 结果
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
    error: '',
  };
}

/**
 * 造一个技能行。
 * @param {string} name 技能名
 * @param {string} source 来源仓库（空串 = 本地未托管）
 * @returns {object} 技能行
 */
function skillOf(name, source) {
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
  };
}

test('buildGroups：按仓库分组、组内按名字排、状态判定正确、未托管排最后', async () => {
  const { exports } = await loadClient();
  const { buildGroups } = exports.__internals;
  const state = overviewOf([
    skillOf('tdd', 'mattpocock/skills'),
    skillOf('pr', 'mattpocock/skills'),
    skillOf('gone', 'mattpocock/skills'),
    skillOf('find-skills', 'vercel-labs/skills'),
    skillOf('dsh-plugin-compatibility', ''),
  ]);
  const delta = {
    ok: true,
    checkedAt: '2026-10-10T00:00:00.000Z',
    tokenSource: 'gh',
    rateLimitText: '',
    repos: [
      {
        source: 'mattpocock/skills',
        mode: 'api',
        available: 5,
        installed: 3,
        // pr 已经装了 → 不该再显示成「新增」（两份数据不打架）
        newSkills: [{ name: 'pr', path: 'skills/pr', remoteHash: 'x' }, { name: 'chief-of-staff', path: 'skills/chief-of-staff', remoteHash: 'y' }],
        updatable: [{ name: 'tdd', path: 'skills/tdd', installedHash: 'old', remoteHash: 'new' }],
        orphan: [{ name: 'gone', path: 'skills/gone' }],
        error: '',
      },
    ],
    error: '',
  };
  const groups = buildGroups(state, delta);

  assert.deepEqual(groups.map((group) => group.key), ['mattpocock/skills', 'vercel-labs/skills', '__local__'], '有待办的排前面，未托管永远最后');
  assert.equal(groups[0].pending, 3, '新增 1 + 可更新 1 + 已移除 1');
  assert.equal(groups[1].pending, 0);
  assert.equal(groups[1].checked, false, '没有检查结果的仓库标未检查');
  assert.deepEqual(groups[0].items.map((item) => item.kind + ':' + item.name), [
    'new:chief-of-staff',
    'orphan:gone',
    'installed:pr',
    'update:tdd',
  ], '组内按名字排；已装的 pr 不再出现在新增里；上游已移除的 gone 只占一行');
  assert.equal(groups[0].items.find((item) => item.name === 'gone').row.name, 'gone', '上游已移除那一行仍带已装信息');
  assert.deepEqual(groups[2].items.map((item) => item.name), ['dsh-plugin-compatibility']);
  assert.equal(groups[2].local, true);
});

test('filterTodo：只留有事的仓库，且组内只留待办行', async () => {
  const { exports } = await loadClient();
  const { buildGroups, filterTodo } = exports.__internals;
  const state = overviewOf([skillOf('tdd', 'a/b'), skillOf('zzz', 'a/b'), skillOf('local-one', '')]);
  const delta = {
    ok: true,
    checkedAt: '2026-10-10T00:00:00.000Z',
    tokenSource: 'gh',
    rateLimitText: '',
    repos: [{ source: 'a/b', mode: 'api', available: 3, installed: 2, newSkills: [{ name: 'new-one', path: 'skills/new-one', remoteHash: 'h' }], updatable: [], orphan: [], error: '' }],
    error: '',
  };
  const groups = buildGroups(state, delta);
  assert.equal(filterTodo(groups, false).length, 2, '不勾选时两组都在');
  const visible = filterTodo(groups, true);
  assert.deepEqual(visible.map((group) => group.key), ['a/b'], '没有待办的仓库与「本地·未托管」都被隐藏');
  assert.deepEqual(visible[0].items.map((item) => item.name), ['new-one'], '组内只剩待办行');
  assert.deepEqual(groups[0].items.map((item) => item.name), ['new-one', 'tdd', 'zzz'], '原分组数据不被修改');
});
