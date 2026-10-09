// dsh-agents-skills · typert 清单格式护栏
//
// 这份清单由**手写**维护，而 dsh-typert-loader 在**启动/激活时**校验它。
// 清单里任何字段写错，后果不是"插件静默失效"，而是整棵插件树加载失败：
//
//   dsh: plugin tree failed to load: failed to apply loader entry typert-loader:
//   typert-loader: ... parameter has a missing or empty wire
//
// 所以这里直接调用官方的 validateTypertManifest，而不是复刻它的规则——
// 复刻的规则会随 DSH 升级而过期，调用官方校验器不会。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, '..');

/**
 * 解析一个 DSH 自带的模块；测试在没有 profile 的环境下也要能跑，
 * 所以锚点按"正在运行的 DSH" → "常见安装路径" 依次尝试。
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

/** @returns {Promise<object>} 本插件的手写 TYPERT 清单 */
async function loadManifest() {
  const { TYPERT } = await import(pathToFileURL(join(packageDir, 'lib', 'typert.host.js')).href);
  return TYPERT;
}

test('官方校验器接受本插件的 typert 清单', async () => {
  const { validateTypertManifest } = requireDsh('@deepseek-ai/dsh-typert-loader');
  const manifest = validateTypertManifest('dsh-agents-skills', await loadManifest());
  assert.equal(manifest.package, 'dsh-agents-skills');
  assert.equal(manifest.invocations.length, 2);
});

test('每个参数都带 wire / source / strict codec', async () => {
  const manifest = await loadManifest();
  for (const invocation of manifest.invocations) {
    assert.ok(invocation.parameters.length > 0, `${invocation.id} 应至少有一个参数`);
    for (const parameter of invocation.parameters) {
      assert.equal(typeof parameter.wire, 'string', `${invocation.id} 的 wire 必须是字符串`);
      assert.equal(parameter.source, 'json', `${invocation.id} 的参数必须来自 JSON`);
      assert.equal(parameter.codec.mode, 'strict', `${invocation.id} 必须用 strict codec`);
      assert.equal(typeof parameter.codec.create, 'function', `${invocation.id} 的 codec 必须带 create() 工厂`);
    }
    assert.equal(invocation.result.mode, 'strict', `${invocation.id} 的结果必须用 strict codec`);
    assert.equal(typeof invocation.result.create, 'function', `${invocation.id} 的结果 codec 必须带 create() 工厂`);
  }
});

test('读写两个方法的参数与结果 schema 都能接受真实报文', async () => {
  const manifest = await loadManifest();
  const byMethod = new Map(manifest.invocations.map((invocation) => [invocation.method, invocation]));
  const read = byMethod.get('read');
  const write = byMethod.get('write');
  assert.ok(read && write, '清单必须同时声明 read 与 write');

  assert.deepEqual(read.parameters[0].codec.create().parse({}), {});
  assert.deepEqual(write.parameters[0].codec.create().parse({ content: 'x' }), { content: 'x' });
  assert.throws(() => write.parameters[0].codec.create().parse({}), 'write 缺少 content 必须被拒');

  const state = {
    ok: true,
    path: '/root/.dsh/AGENTS.md',
    exists: true,
    size: 3,
    content: 'abc',
    bytes: 3,
    backup: '',
    limitBytes: 65536,
    error: ''
  };
  assert.deepEqual(read.result.create().parse(state), state);
  assert.throws(() => read.result.create().parse({ ok: true }), '字段不全的结果必须被拒');
});
