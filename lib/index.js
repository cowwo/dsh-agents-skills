import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

/** File name of the user-global instruction file under `$DSH_HOME`. */
const FILE_NAME = 'AGENTS.md'
/** Suffix of the one-slot backup taken before every overwrite. */
const BACKUP_SUFFIX = '.bak'
/** Budget the instruction loader applies when it injects this file. */
const LIMIT_BYTES = 65536

/**
 * Expand the `~` forms the harness home configuration accepts.
 * @param {string} value - configured or default path.
 * @returns {string} the expanded path.
 */
function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * Resolve the harness home exactly as the instruction loader does:
 * `$DSH_HOME` when set, otherwise `~/.dsh`.
 * @returns {string} absolute harness home.
 */
function resolveDshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.length > 0) return expandHome(configured)
  return join(homedir(), '.dsh')
}

/**
 * @returns {string} absolute path of the managed file.
 */
function filePath() {
  return join(resolveDshHome(), FILE_NAME)
}

/**
 * Describe a thrown value for the UI, which renders strings, not Error objects.
 * @param {unknown} error - thrown value.
 * @returns {string} human-readable message.
 */
function messageOf(error) {
  if (error === null || error === undefined) return '未知错误'
  const message = error.message
  return typeof message === 'string' ? message : String(error)
}

/**
 * @param {string} text - text to measure.
 * @returns {number} UTF-8 byte length.
 */
function byteLength(text) {
  return new TextEncoder().encode(text).length
}

/**
 * One flat result shape for every operation: the browser side validates it
 * strictly, so failures carry `ok: false` plus `error` instead of changing shape.
 * @param {string} path - absolute file path.
 * @param {string} [error] - failure reason.
 * @returns {object} a zeroed state.
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
    limitBytes: LIMIT_BYTES,
    error,
  }
}

/**
 * Read the current on-disk state.
 *
 * A plain module function on purpose: a Remote method runs with a **shadow
 * receiver** (`receiverContext.extend({ invocation }).get(service)`), so a
 * `#private` member — or any private brand — would fail V8's brand check with
 * `TypeError: Receiver must be an instance of class ...` before doing any work.
 * @returns {Promise<object>} the current file state.
 */
async function currentState() {
  const path = filePath()
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
      limitBytes: LIMIT_BYTES,
      error: '',
    }
  } catch (error) {
    return emptyState(path, messageOf(error))
  }
}

/**
 * Replace the file, backing the previous content up first. Same shadow-receiver
 * constraint as {@link currentState}: no `this`, no private members.
 * @param {string} content - full replacement text.
 * @returns {Promise<object>} the state after the write.
 */
async function writeState(content) {
  const path = filePath()
  let backup = ''
  try {
    const previous = await currentState()
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
    limitBytes: LIMIT_BYTES,
    error: '',
  }
}

/**
 * Reads and replaces the user-global Agent prompt file (`$DSH_HOME/AGENTS.md`)
 * — the file presets inject into every new session's first request. The
 * settings page and the agent share this one code path.
 *
 * Both methods stay free of `this` and of private members so the Typert Gateway
 * can call them on its shadow receiver.
 */
export class GlobalAgentService extends TypertRemoteService {
  /**
   * @param {object} ctx - owning Cordis context.
   * @param {object} config - plugin row config (unused).
   */
  constructor(ctx, config) {
    super(ctx, 'globalAgent')
  }

  /**
   * Read the global prompt file without creating it.
   * @returns {Promise<object>} the current file state.
   */
  async read(request) {
    return await currentState()
  }

  /**
   * Replace the global prompt file, backing the previous content up first.
   * @param {{ content: string }} request - full replacement text.
   * @returns {Promise<object>} the state after the write.
   */
  async write(request) {
    const content = request !== null && typeof request === 'object' && typeof request.content === 'string'
      ? request.content
      : null
    if (content === null) return emptyState(filePath(), '参数 content 必须是字符串')
    return await writeState(content)
  }
}

export default GlobalAgentService
