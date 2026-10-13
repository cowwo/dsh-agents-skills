// dsh-agents-skills · 全局 Agent 提示词（`$DSH_HOME/AGENTS.md`）的读写
//
// 抽成独立模块的原因：这条路径有**两个入口**——设置页的 Remote 方法，和独立页的
// 表单 POST。两边必须走同一份实现（整文件替换 + 覆盖前备份），否则迟早出现
// 「设置页存了会备份、独立页存了不备份」这种分叉。
//
// 全部是模块级函数：没有 `this`、没有私有成员。Typert Gateway 用**影子接收者**
// 调用 Remote 方法，任何私有品牌检查都会在方法执行前抛错。

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 被管理的文件名（位于 harness home 下）。 */
const FILE_NAME = 'AGENTS.md'
/** 每次覆盖前做的一格备份的后缀。 */
const BACKUP_SUFFIX = '.bak'
/** 指令加载器注入这个文件时应用的字节上限。 */
export const AGENT_LIMIT_BYTES = 65536

/**
 * 展开 harness home 配置接受的 `~` 写法。
 * @param {string} value - 配置值或默认值。
 * @returns {string} 展开后的路径。
 */
function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * 按指令加载器的规则解析 harness home：`$DSH_HOME`，否则 `~/.dsh`。
 * @returns {string} harness home 绝对路径。
 */
export function resolveDshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.length > 0) return expandHome(configured)
  return join(homedir(), '.dsh')
}

/**
 * @returns {string} 被管理文件的绝对路径。
 */
export function agentFilePath() {
  return join(resolveDshHome(), FILE_NAME)
}

/**
 * 把抛出的值转成人话（页面只渲染字符串）。
 * @param {unknown} error - 抛出的值。
 * @returns {string} 可读信息。
 */
export function messageOf(error) {
  if (error === null || error === undefined) return '未知错误'
  const message = error.message
  return typeof message === 'string' ? message : String(error)
}

/**
 * @param {string} text - 要测量的文本。
 * @returns {number} UTF-8 字节数。
 */
function byteLength(text) {
  return new TextEncoder().encode(text).length
}

/**
 * 所有操作共用的扁平结果：浏览器侧严格校验，失败用 ok=false + error 表达，
 * 不换形状。
 * @param {string} path - 文件绝对路径。
 * @param {string} [error] - 失败原因。
 * @returns {object} 归零状态。
 */
function emptyState(path, error = '') {
  return {
    ok: error.length === 0,
    path,
    exists: false,
    size: 0,
    content: '',
    bytes: 0,
    backup: '',
    limitBytes: AGENT_LIMIT_BYTES,
    error,
  }
}

/**
 * 读当前磁盘状态（不创建文件）。
 * @returns {Promise<object>} 文件状态。
 */
export async function readAgentFile() {
  const path = agentFilePath()
  let info = null
  try {
    info = await stat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState(path)
    return emptyState(path, messageOf(error))
  }
  if (!info.isFile()) return emptyState(path)
  try {
    const content = await readFile(path, 'utf8')
    return {
      ok: true,
      path,
      exists: true,
      size: byteLength(content),
      content,
      bytes: 0,
      backup: '',
      limitBytes: AGENT_LIMIT_BYTES,
      error: '',
    }
  } catch (error) {
    return emptyState(path, messageOf(error))
  }
}

/**
 * 整文件替换，覆盖前把旧内容备份到同目录的 `AGENTS.md.bak`。
 * @param {string} content - 新的全文。
 * @returns {Promise<object>} 写入后的状态。
 */
export async function writeAgentFile(content) {
  const path = agentFilePath()
  // 校验放在这里而不是调用方：两个入口（设置页 / 独立页）都要挡住非字符串。
  if (typeof content !== 'string') return emptyState(path, '参数 content 必须是字符串')
  let backup = ''
  try {
    const previous = await readAgentFile()
    if (previous.exists === true && previous.content.length > 0) {
      const backupPath = path + BACKUP_SUFFIX
      await writeFile(backupPath, previous.content, 'utf8')
      backup = backupPath
    }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
  } catch (error) {
    return { ...emptyState(path, messageOf(error)), backup }
  }

  const size = byteLength(content)
  return {
    ok: true,
    path,
    exists: true,
    size,
    content,
    bytes: size,
    backup,
    limitBytes: AGENT_LIMIT_BYTES,
    error: '',
  }
}
