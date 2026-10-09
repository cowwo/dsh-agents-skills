// dsh-agents-skills · Host 半行为测试
//
// 用真实的 Cordis Context 实例化服务，把 `DSH_HOME` 指到临时目录，
// 跑一遍「读 → 写 → 覆盖写（备份）→ 失败路径」。
// 这样验的是插件自己的读写语义，不依赖浏览器或 Remote 载体。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, '..');

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

/**
 * 在一个临时 `DSH_HOME` 里构造服务并交给调用方。
 *
 * 除了服务实例本身，还给出**影子接收者**：Typert Gateway 调用 Remote 方法时
 * 用的就是这个（`receiverContext.extend({invocation}).get(service)`），
 * 它和实例不是同一个对象——用私有成员 `#x` 的服务会在这里当场被 V8 拒掉。
 * @param {(service: object, home: string, shadow: object) => Promise<void>} run 测试主体
 */
async function withService(run) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-agents-skills-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const { default: GlobalAgentService } = await import(pathToFileURL(join(packageDir, 'lib', 'index.js')).href);
    const ctx = new Context();
    const service = new GlobalAgentService(ctx, {});
    const shadow = ctx.extend({ invocation: { namespace: 'globalAgent', method: 'read' } }).get('globalAgent');
    await run(service, home, shadow);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * 按 Gateway 的方式调用：在影子接收者上取方法并以它为 `this` 调用。
 * @param {object} receiver 影子接收者
 * @param {string} method 方法名
 * @param {object} request 参数
 * @returns {Promise<object>} 结果
 */
function callOn(receiver, method, request) {
  return Reflect.get(receiver, method).call(receiver, request);
}

test('网关的影子接收者能调用 read / write（用 #私有成员就会炸在这）', async () => {
  await withService(async (service, home, shadow) => {
    assert.notEqual(shadow, service, '影子接收者必须与实例不同，否则这条测试没有意义');
    assert.equal(shadow.constructor.name, 'GlobalAgentService');

    const initial = await callOn(shadow, 'read', {});
    assert.equal(initial.ok, true);
    assert.equal(initial.exists, false);

    const written = await callOn(shadow, 'write', { content: '# 影子写入\n' });
    assert.equal(written.ok, true);
    assert.equal(written.bytes, Buffer.byteLength('# 影子写入\n'));
    assert.equal(await readFile(join(home, 'AGENTS.md'), 'utf8'), '# 影子写入\n');

    const again = await callOn(shadow, 'read', {});
    assert.equal(again.content, '# 影子写入\n');
    assert.equal(again.exists, true);
  });
});

test('影子接收者上取到的结果字段与直接调用完全一致', async () => {
  await withService(async (service, home, shadow) => {
    const direct = await service.read({});
    const viaShadow = await callOn(shadow, 'read', {});
    assert.deepEqual(viaShadow, direct);
  });
});

test('文件不存在时读取返回 exists=false 而不是报错', async () => {
  await withService(async (service, home) => {
    const state = await service.read({});
    assert.equal(state.ok, true);
    assert.equal(state.exists, false);
    assert.equal(state.content, '');
    assert.equal(state.path, join(home, 'AGENTS.md'));
    assert.equal(state.limitBytes, 65536);
  });
});

test('写入会创建文件，读回来是同一份内容', async () => {
  await withService(async (service) => {
    const written = await service.write({ content: '# 全局规则\n' });
    assert.equal(written.ok, true);
    assert.equal(written.exists, true);
    assert.equal(written.bytes, Buffer.byteLength('# 全局规则\n'));
    assert.equal(written.backup, '');

    const state = await service.read({});
    assert.equal(state.exists, true);
    assert.equal(state.content, '# 全局规则\n');
    assert.equal(state.size, written.bytes);
  });
});

test('覆盖写之前把旧内容备份到 AGENTS.md.bak', async () => {
  await withService(async (service, home) => {
    await service.write({ content: 'first' });
    const second = await service.write({ content: 'second' });
    assert.equal(second.ok, true);
    assert.equal(second.backup, join(home, 'AGENTS.md.bak'));
    assert.equal(await readFile(join(home, 'AGENTS.md.bak'), 'utf8'), 'first');
    assert.equal((await service.read({})).content, 'second');
  });
});

test('空内容写入 = 清空但保留文件', async () => {
  await withService(async (service) => {
    await service.write({ content: 'x' });
    const cleared = await service.write({ content: '' });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.exists, true);
    assert.equal(cleared.size, 0);
    const state = await service.read({});
    assert.equal(state.exists, true);
    assert.equal(state.content, '');
  });
});

test('缺少 content 的写入被拒，且不改动磁盘', async () => {
  await withService(async (service) => {
    await service.write({ content: 'keep' });
    const failed = await service.write({});
    assert.equal(failed.ok, false);
    assert.ok(failed.error.length > 0);
    assert.equal((await service.read({})).content, 'keep');
  });
});

test('结果字段与 typert 清单的结果 schema 完全一致', async () => {
  const { TYPERT } = await import(pathToFileURL(join(packageDir, 'lib', 'typert.host.js')).href);
  const schema = TYPERT.invocations[0].result.create();
  const expected = Object.keys(schema.shape).sort();
  await withService(async (service) => {
    const missing = await service.read({});
    assert.deepEqual(Object.keys(missing).sort(), expected);
    const written = await service.write({ content: 'x' });
    assert.deepEqual(Object.keys(written).sort(), expected);
    const failed = await service.write({});
    assert.deepEqual(Object.keys(failed).sort(), expected);
  });
});

test('写入时可以补出缺失的 DSH_HOME 目录', async () => {
  await withService(async (service, home) => {
    const nested = join(home, 'deep', 'nested');
    process.env.DSH_HOME = nested;
    const written = await service.write({ content: 'nested' });
    assert.equal(written.ok, true);
    assert.equal(await readFile(join(nested, 'AGENTS.md'), 'utf8'), 'nested');
  });
});

test('目录占位时读取不抛异常', async () => {
  await withService(async (service, home) => {
    await mkdir(join(home, 'AGENTS.md'), { recursive: true });
    const state = await service.read({});
    assert.equal(state.ok, true);
    assert.equal(state.exists, false);
    await writeFile(join(home, 'other.txt'), 'x');
  });
});
