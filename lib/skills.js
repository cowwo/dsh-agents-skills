// dsh-agents-skills · 技能管理的纯逻辑层
//
// 分工：
//   - 磁盘与锁文件（`$DSH_AGENTS_HOME/.skill-lock.json` + `<agentsHome>/skills`）是**事实来源**；
//   - 订阅仓库清单（`<agentsHome>/.skill-subscriptions.json`）是本插件自己的登记表：
//     登记过的仓库一个技能都没装也要出现在列表里（盯它的新增），且只增不减；
//   - 装 / 删 / 更新 / 搜索交给外面的 `npx skills`（skills.sh 生态的包管理器）；
//   - 「仓库新增了哪些技能」靠 GitHub 的 git tree API 一次请求算出：
//     锁文件里的 `skillFolderHash` 就是技能目录的 git tree sha，和 tree 返回的 sha 可直接比对。
//
// 本文件所有导出都是模块级函数：没有 `this`、没有私有成员。Typert Gateway 用
// **影子接收者**调用 Remote 方法，任何私有品牌检查都会在方法执行前抛错。

import { execFile } from 'node:child_process'
import { constants as FS_CONSTANTS } from 'node:fs'
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'

/** 技能正文文件名（目录束形态）。 */
const SKILL_FILE = 'SKILL.md'
/** 技能名规则，与 DSH 的校验一致（kebab-case）。 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** GitHub 的 owner / repo 段落允许的字符。 */
const GITHUB_SEGMENT = /^[A-Za-z0-9._-]+$/
/** 搜索关键词：字母（含中文）、数字、空格与少量符号，最长 64。 */
const QUERY_TEXT = /^[\p{L}\p{N} ._+@/-]{1,64}$/u
/** 远程技能目录：允许的字符（不含 `..`，避免打到 GitHub 别的接口）。 */
const REMOTE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/
/** skills CLI 的锁文件，放在 agents home 根下。 */
const LOCK_NAME = '.skill-lock.json'
/** 订阅仓库清单（本插件自己的登记表），同样放在 agents home 根下。 */
const SUBSCRIPTIONS_NAME = '.skill-subscriptions.json'
/** 用户级技能根目录名。 */
const SKILLS_DIR_NAME = 'skills'
/** 装 / 更新要克隆仓库，给足时间。 */
const ACTION_TIMEOUT_MS = 300000
/** 搜索 / 列仓库只读，短一些。 */
const QUERY_TIMEOUT_MS = 180000
/** 回传前把 CLI 输出截到这么长，避免把整段日志塞进页面。 */
const OUTPUT_TAIL = 4000
/** 未登录 GitHub API 的公共限流（次/小时）。 */
const ANON_RATE_LIMIT = 60

/**
 * 把 `~` 展开成家目录（与 harness 的 home 路径约定一致）。
 * @param {string} value - 配置或默认路径。
 * @returns {string} 展开后的路径。
 */
function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * agents home：`$DSH_AGENTS_HOME`，否则 `~/.agents`。
 * 这是各 harness 共享的技能目录，也是 `npx skills -g` 的落点。
 * @returns {string} 绝对路径。
 */
export function resolveAgentsHome() {
  const configured = process.env.DSH_AGENTS_HOME
  if (typeof configured === 'string' && configured.length > 0) return expandHome(configured)
  return join(homedir(), '.agents')
}

/**
 * @returns {string} 用户级技能根绝对路径。
 */
export function skillsRoot() {
  return join(resolveAgentsHome(), SKILLS_DIR_NAME)
}

/**
 * @returns {string} skills CLI 锁文件的绝对路径。
 */
export function lockPath() {
  return join(resolveAgentsHome(), LOCK_NAME)
}

/**
 * @returns {string} 订阅仓库清单的绝对路径（`<agentsHome>/.skill-subscriptions.json`）。
 */
export function subscriptionsPath() {
  return join(resolveAgentsHome(), SUBSCRIPTIONS_NAME)
}

/**
 * 把抛出的值转成人话（页面只渲染字符串）。
 * @param {unknown} error - 抛出的值。
 * @returns {string} 可读信息。
 */
export function messageOf(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  const message = error.message
  return typeof message === 'string' ? message : String(error)
}

/**
 * 去掉 ANSI 颜色与光标控制码，CLI 输出才能被解析。
 * @param {string} text - 原始文本。
 * @returns {string} 纯文本。
 */
export function stripAnsi(text) {
  if (typeof text !== 'string') return ''
  return text
    .replace(/\u001b\][^\u0007]*\u0007/g, '')
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\u001b\[[0-9]*G/g, '')
    .replace(/\r/g, '\n')
    .replace(/[^\n\u0020-\u007e\u00a0-\uffff]/g, '')
}

/**
 * 取文本尾部若干字符。
 * @param {string} text - 原始文本。
 * @param {number} [max] - 上限，默认 {@link OUTPUT_TAIL}。
 * @returns {string} 截断后的文本。
 */
export function tailOf(text, max = OUTPUT_TAIL) {
  if (typeof text !== 'string') return ''
  if (text.length <= max) return text
  return '…' + text.slice(text.length - max)
}

/**
 * @param {unknown} value - 任意值。
 * @returns {value is Record<string, unknown>} 是否是普通对象。
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {unknown} value - 任意值。
 * @returns {string} 传入字符串，否则空串。
 */
function stringOf(value) {
  return typeof value === 'string' ? value : ''
}

// ── frontmatter ───────────────────────────────────────────────────────────────

/**
 * 按 DSH 的语法解析 frontmatter 里的布尔值。
 * 接受 YAML 布尔与大小写不敏感的 true/false、yes/no、on/off、1/0。
 * @param {string} raw - 原始标量文本。
 * @returns {boolean | null} 解析结果；拼写非法时返回 null（调用方按「非法」处理）。
 */
export function parseBoolean(raw) {
  const value = raw.trim().replace(/^["']|["']$/g, '').toLowerCase()
  if (value === 'true' || value === 'yes' || value === 'on' || value === '1') return true
  if (value === 'false' || value === 'no' || value === 'off' || value === '0') return false
  return null
}

/**
 * 从技能文件头部取出我们关心的字段。
 *
 * 只做行级 YAML 解析（不引 yaml 依赖）：本插件展示与判定只用 name / description
 * 与两个调用开关，其余字段原样忽略。
 * @param {string} text - SKILL.md 全文。
 * @returns {{ name: string, description: string, modelInvocable: boolean, userInvocable: boolean, valid: boolean, error: string }} 解析结果。
 */
export function parseFrontmatter(text) {
  const result = { name: '', description: '', modelInvocable: true, userInvocable: true, valid: false, error: '' }
  if (typeof text !== 'string' || !text.startsWith('---')) {
    result.error = '缺少以 --- 开头的 frontmatter'
    return result
  }
  const end = text.indexOf('\n---', 3)
  if (end < 0) {
    result.error = 'frontmatter 没有闭合的 ---'
    return result
  }
  const block = text.slice(text.indexOf('\n', 3) + 1, end)
  for (const line of block.split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1]
    const raw = match[2]
    if (key === 'name') result.name = raw.trim().replace(/^["']|["']$/g, '')
    else if (key === 'description') result.description = raw.trim().replace(/^["']|["']$/g, '')
    else if (key === 'disable-model-invocation') {
      const parsed = parseBoolean(raw)
      if (parsed === null) result.error = 'disable-model-invocation 不是合法布尔值'
      else result.modelInvocable = !parsed
    } else if (key === 'user-invocable') {
      const parsed = parseBoolean(raw)
      if (parsed === null) result.error = 'user-invocable 不是合法布尔值'
      else result.userInvocable = parsed
    }
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result.name)) {
    if (result.error.length === 0) result.error = 'name 缺失或不是 kebab-case'
    return result
  }
  if (result.description.length === 0) {
    if (result.error.length === 0) result.error = 'description 缺失'
    return result
  }
  result.valid = result.error.length === 0
  return result
}

// ── 锁文件与磁盘 ──────────────────────────────────────────────────────────────

/**
 * 读 skills CLI 的锁文件（v3：`{ version, skills: { name: entry } }`）。
 * 文件损坏时返回空表而不是抛错——页面要能显示「锁文件读不了」。
 * @returns {Promise<{ path: string, exists: boolean, skills: Record<string, object>, error: string }>} 锁文件状态。
 */
export async function readLock() {
  const path = lockPath()
  try {
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text)
    const skills = isObject(parsed) && isObject(parsed.skills) ? parsed.skills : {}
    return { path, exists: true, skills, error: '' }
  } catch (error) {
    if (error.code === 'ENOENT') return { path, exists: false, skills: {}, error: '' }
    return { path, exists: true, skills: {}, error: messageOf(error) }
  }
}

/**
 * 读订阅仓库清单（一个字符串数组，内容形如 `owner/repo`）。
 *
 * 与锁文件一样**绝不抛**：文件不存在、内容损坏、或不是数组都当成「没有订阅」，
 * 页面只是少几格，不能因为一个坏文件就整页打不开。
 * @returns {Promise<string[]>} 订阅的仓库 slug（去空白、去空串、去重，保持文件顺序）。
 */
export async function readSubscriptions() {
  let parsed = null
  try {
    parsed = JSON.parse(await readFile(subscriptionsPath(), 'utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const items = []
  const seen = new Set()
  for (const item of parsed) {
    if (typeof item !== 'string') continue
    const value = item.trim()
    if (value.length === 0 || seen.has(value)) continue
    seen.add(value)
    items.push(value)
  }
  return items
}

/**
 * 原子地写订阅仓库清单：先写同目录临时文件，再 rename 覆盖。
 *
 * rename 在同一文件系统里是原子的，所以读的一方要么看到旧的整份，要么看到新的整份，
 * 不会读到写了一半的 JSON（也不会因为中间态被当成「损坏」而清空订阅）。
 * @param {unknown} list - 字符串数组；非字符串项、空串与重复项会被丢掉。
 * @returns {Promise<string[]>} 实际写进去的清单。
 */
export async function writeSubscriptions(list) {
  const items = []
  const seen = new Set()
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item !== 'string') continue
    const value = item.trim()
    if (value.length === 0 || seen.has(value)) continue
    seen.add(value)
    items.push(value)
  }
  const path = subscriptionsPath()
  await mkdir(dirname(path), { recursive: true })
  const temp = path + '.' + String(process.pid) + '.' + Math.random().toString(36).slice(2) + '.tmp'
  await writeFile(temp, JSON.stringify(items, null, 2) + '\n', 'utf8')
  try {
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => { /* 临时文件清不掉就算了 */ })
    throw error
  }
  return items
}

/**
 * 订阅一个来源仓库：校验写法 → 去重 → 追加 → 原子落盘。
 *
 * 没有「退订」：清单只增，要删就手改 {@link subscriptionsPath} 指向的文件。
 * 已经订阅过不算失败（用户重复点一次不该看到红色报错）。
 * @param {unknown} source - 用户输入，形如 `owner/repo` 或 GitHub URL。
 * @returns {Promise<{ ok: boolean, kind: string, source: string, summary: string, error: string }>} 结果。
 */
export async function addSubscription(source) {
  const parsed = parseSource(source)
  if (parsed === null) {
    return { ok: false, kind: 'subscribe', source: '', summary: '', error: '仓库写法应为 owner/repo' }
  }
  const slug = parsed.slug
  const current = await readSubscriptions()
  if (current.includes(slug)) {
    return {
      ok: true,
      kind: 'subscribe',
      source: slug,
      summary: '已在订阅清单里：' + slug + '（共 ' + String(current.length) + ' 个）',
      error: '',
    }
  }
  const next = [...current, slug]
  try {
    await writeSubscriptions(next)
  } catch (error) {
    return { ok: false, kind: 'subscribe', source: slug, summary: '', error: '订阅清单写入失败：' + messageOf(error) }
  }
  return {
    ok: true,
    kind: 'subscribe',
    source: slug,
    summary: '已订阅 ' + slug + '（共 ' + String(next.length) + ' 个）',
    error: '',
  }
}

/**
 * 锁条目里的技能目录（`skills/engineering/pr/SKILL.md` → `skills/engineering/pr`）。
 * @param {unknown} skillPath - 锁条目 skillPath。
 * @returns {string} 目录路径；未知时为空串。
 */
export function dirFromSkillPath(skillPath) {
  const value = stringOf(skillPath)
  if (value.length === 0) return ''
  if (value === SKILL_FILE) return ''
  const suffix = '/' + SKILL_FILE
  return value.endsWith(suffix) ? value.slice(0, -suffix.length) : ''
}

/**
 * 扫描用户级技能根（只扫一层，与 DSH 的发现规则一致）。
 * 目录束 `<名字>/SKILL.md` 与平铺文件 `<名字>.md` 都算，点目录跳过。
 * @returns {Promise<{ root: string, items: object[], error: string }>} 磁盘状态。
 */
export async function scanDiskSkills() {
  const root = skillsRoot()
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return { root, items: [], error: '' }
    return { root, items: [], error: messageOf(error) }
  }

  const items = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    // 用 stat 而不是 Dirent 类型：技能目录**允许是软链**（DSH 自己也是按路径 stat 发现的），
    // 只看 readdir 的 isDirectory() 会把软链目录漏掉；断链则直接跳过。
    let info = null
    try {
      info = await stat(join(root, entry.name))
    } catch {
      continue
    }
    if (info.isDirectory()) {
      const file = join(root, entry.name, SKILL_FILE)
      try {
        const skillInfo = await stat(file)
        if (!skillInfo.isFile()) continue
      } catch {
        continue
      }
      const parsed = parseFrontmatter(await readFile(file, 'utf8').catch(() => ''))
      items.push({
        name: parsed.name.length > 0 ? parsed.name : entry.name,
        dirName: entry.name,
        kind: 'bundle',
        path: file,
        description: parsed.description,
        detail: parsed.error,
        modelInvocable: parsed.modelInvocable,
        userInvocable: parsed.userInvocable,
        valid: parsed.valid,
      })
      continue
    }
    if (info.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name !== SKILL_FILE) {
      const file = join(root, entry.name)
      const parsed = parseFrontmatter(await readFile(file, 'utf8').catch(() => ''))
      const fallback = entry.name.slice(0, -3)
      items.push({
        name: parsed.name.length > 0 ? parsed.name : fallback,
        dirName: fallback,
        kind: 'flat',
        path: file,
        description: parsed.description,
        detail: parsed.error,
        modelInvocable: parsed.modelInvocable,
        userInvocable: parsed.userInvocable,
        valid: parsed.valid,
      })
    }
  }
  items.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return { root, items, error: '' }
}

/**
 * 按 PATH 查找可执行文件（不 spawn，避免额外进程）。
 * @param {string} name - 可执行文件名。
 * @returns {Promise<string>} 绝对路径；找不到返回空串。
 */
export async function findExecutable(name) {
  const raw = process.env.PATH
  if (typeof raw !== 'string' || raw.length === 0) return ''
  for (const dir of raw.split(delimiter)) {
    if (dir.length === 0) continue
    const candidate = join(dir, name)
    try {
      await access(candidate, FS_CONSTANTS.X_OK)
      return candidate
    } catch { /* 继续找 */ }
  }
  return ''
}

/**
 * 取 GitHub token：环境变量优先，其次 gh CLI 的 hosts.yml。
 *
 * 裸调（无 token）也能用公共仓库，但只有 60 次/小时；有 token 是 5000 次/小时并支持私有仓库。
 * @returns {Promise<{ token: string, source: string, user: string }>} token 状态。
 */
export async function resolveToken() {
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const value = process.env[key]
    if (typeof value === 'string' && value.length > 0) return { token: value, source: 'env', user: '' }
  }
  const dir = stringOf(process.env.GH_CONFIG_DIR).length > 0 ? expandHome(process.env.GH_CONFIG_DIR) : join(homedir(), '.config', 'gh')
  try {
    const text = await readFile(join(dir, 'hosts.yml'), 'utf8')
    const token = /oauth_token:\s*(\S+)/.exec(text)
    const user = /user:\s*(\S+)/.exec(text)
    if (token !== null) return { token: token[1], source: 'gh', user: user === null ? '' : user[1] }
  } catch { /* 没登录 gh 就走裸调 */ }
  return { token: '', source: 'none', user: '' }
}

// ── GitHub ───────────────────────────────────────────────────────────────────

/**
 * 解析 `owner/repo`、`owner/repo@skill` 或 GitHub URL。
 * @param {string} value - 用户输入的仓库。
 * @returns {{ slug: string, owner: string, repo: string, skill: string } | null} 解析结果。
 */
export function parseSource(value) {
  const raw = stringOf(value).trim()
  if (raw.length === 0) return null
  let body = raw
  let skill = ''
  const at = body.lastIndexOf('@')
  if (at > 0 && !body.startsWith('http')) {
    skill = body.slice(at + 1)
    body = body.slice(0, at)
  }
  body = body.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  const parts = body.split('/').filter((part) => part.length > 0)
  if (parts.length !== 2) return null
  // 段落字符集要收紧：这两个值最终会进命令行参数与 URL——`..`、空白、以 `-` 开头
  // （会被 CLI 当成开关）都不该进来。
  for (const part of parts) {
    if (!GITHUB_SEGMENT.test(part) || part === '.' || part === '..' || part.startsWith('-')) return null
  }
  if (skill.length > 0 && !SKILL_NAME.test(skill)) return null
  return { slug: parts[0] + '/' + parts[1], owner: parts[0], repo: parts[1], skill }
}

/**
 * 校验要传给 `npx skills` 的技能名。
 *
 * 这些值最终是 argv 里的参数：不校验的话，以 `-` 开头的名字会被 CLI 当成开关
 * （例如 `--all` 会变成「把该仓库全部技能装给所有 agent」）。
 * @param {unknown} value - 一个名字或名字数组。
 * @returns {{ ok: boolean, names: string[], error: string }} 校验结果。
 */
export function assertSkillNames(value) {
  const list = Array.isArray(value) ? value : [value]
  const names = []
  for (const item of list) {
    if (item === undefined || item === null || item === '') continue
    const name = stringOf(item).trim()
    if (name.length === 0) continue
    if (!SKILL_NAME.test(name)) return { ok: false, names: [], error: '技能名不合法（只允许小写字母、数字与连字符）：' + name.slice(0, 40) }
    names.push(name)
  }
  return { ok: true, names, error: '' }
}

/**
 * 校验搜索关键词。
 * @param {unknown} value - 关键词。
 * @returns {{ ok: boolean, query: string, error: string }} 校验结果。
 */
export function assertQuery(value) {
  const query = stringOf(value).trim()
  if (query.length === 0) return { ok: false, query: '', error: '关键词不能为空' }
  // 以 `-` 开头的会被 `npx skills find` 当成开关（例如 --owner），直接拒掉。
  if (query.startsWith('-')) return { ok: false, query: '', error: '关键词不能以 - 开头' }
  if (!QUERY_TEXT.test(query)) return { ok: false, query: '', error: '关键词含有不支持的字符（最长 64 个字符）' }
  return { ok: true, query, error: '' }
}

/**
 * 校验远程技能目录（会被拼进 GitHub API 的 URL）。
 * @param {unknown} value - 形如 `skills/engineering/pr` 的目录。
 * @returns {{ ok: boolean, path: string, error: string }} 校验结果。
 */
export function assertRemotePath(value) {
  const path = stringOf(value).trim()
  if (path.length === 0) return { ok: false, path: '', error: '缺少技能目录' }
  if (path.length > 200 || !REMOTE_PATH.test(path) || path.split('/').some((part) => part === '..')) {
    return { ok: false, path: '', error: '技能目录不合法' }
  }
  return { ok: true, path, error: '' }
}

/**
 * 取仓库整棵文件树（一次请求拿到全部路径与 sha）。
 * @param {{ owner: string, repo: string }} source - 仓库。
 * @param {string} token - GitHub token，可空。
 * @returns {Promise<{ ok: boolean, tree: object[], remaining: number, limit: number, error: string }>} 结果。
 */
export async function fetchRepoTree(source, token) {
  const url = 'https://api.github.com/repos/' + source.owner + '/' + source.repo + '/git/trees/HEAD?recursive=1'
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-agents-skills',
    'x-github-api-version': '2022-11-28',
  }
  if (token.length > 0) headers.authorization = 'Bearer ' + token
  let response = null
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) })
  } catch (error) {
    return { ok: false, tree: [], remaining: -1, limit: -1, error: '网络请求失败：' + messageOf(error) }
  }
  const remaining = Number(response.headers.get('x-ratelimit-remaining'))
  const limit = Number(response.headers.get('x-ratelimit-limit'))
  if (!response.ok) {
    let detail = ''
    try {
      const body = await response.json()
      detail = stringOf(body.message)
    } catch { /* 响应不是 JSON */ }
    const hint = response.status === 403 || response.status === 404
      ? '（可能是限流、私有仓库或仓库不存在；配好 gh 登录可用 5000 次/小时）'
      : ''
    return {
      ok: false,
      tree: [],
      remaining: Number.isFinite(remaining) ? remaining : -1,
      limit: Number.isFinite(limit) ? limit : -1,
      error: 'HTTP ' + String(response.status) + (detail.length > 0 ? ' ' + detail : '') + hint,
    }
  }
  try {
    const body = await response.json()
    const tree = isObject(body) && Array.isArray(body.tree) ? body.tree : []
    return {
      ok: true,
      tree,
      remaining: Number.isFinite(remaining) ? remaining : -1,
      limit: Number.isFinite(limit) ? limit : -1,
      error: '',
    }
  } catch (error) {
    return { ok: false, tree: [], remaining: -1, limit: -1, error: '响应解析失败：' + messageOf(error) }
  }
}

/**
 * 从文件树里取出技能清单：`SKILL.md`（仓库根或任意层级）。
 * @param {object[]} tree - git tree 条目。
 * @returns {{ dir: string, name: string, hash: string }[]} 技能清单。
 */
export function skillsFromTree(tree) {
  const byPath = new Map()
  for (const entry of tree) {
    if (isObject(entry) && typeof entry.path === 'string') byPath.set(entry.path, entry)
  }
  const found = []
  for (const entry of tree) {
    if (!isObject(entry) || entry.type !== 'blob' || typeof entry.path !== 'string') continue
    if (entry.path !== SKILL_FILE && !entry.path.endsWith('/' + SKILL_FILE)) continue
    const dir = dirFromSkillPath(entry.path)
    const folder = byPath.get(dir)
    found.push({
      dir,
      name: dir.length === 0 ? '' : basename(dir),
      hash: folder !== undefined && typeof folder.sha === 'string' ? folder.sha : '',
    })
  }
  found.sort((left, right) => (left.dir < right.dir ? -1 : left.dir > right.dir ? 1 : 0))
  return found
}

/**
 * 算一个仓库的差异：新增 / 可更新 / 上游已移除。
 * @param {string} source - 仓库 slug。
 * @param {Record<string, object>} lockSkills - 锁文件里的全部技能。
 * @param {object[]} available - {@link skillsFromTree} 的结果。
 * @returns {{ source: string, available: number, installed: number, newSkills: object[], updatable: object[], orphan: object[], error: string }} 差异。
 */
export function computeDelta(source, lockSkills, available) {
  const installed = []
  for (const [name, entry] of Object.entries(lockSkills)) {
    if (!isObject(entry) || entry.source !== source) continue
    installed.push({
      name,
      dir: dirFromSkillPath(entry.skillPath),
      hash: stringOf(entry.skillFolderHash),
    })
  }

  const availableByDir = new Map()
  const availableByName = new Set()
  for (const item of available) {
    if (item.dir.length > 0) availableByDir.set(item.dir, item)
    if (item.name.length > 0) availableByName.add(item.name)
  }

  const installedDirs = new Set()
  const installedNames = new Set()
  for (const item of installed) {
    installedNames.add(item.name)
    if (item.dir.length > 0) installedDirs.add(item.dir)
  }

  // 锁条目可能没有 skillPath（老版本或手工写入），所以目录与名字**任一命中**就算同一个技能：
  // 只看目录会把「同一技能换了目录」误报成新增，只看名字又会漏掉真正的改名。
  const repoName = source.split('/').pop() ?? ''
  const newSkills = []
  for (const item of available) {
    const name = item.name.length > 0 ? item.name : repoName
    const known = item.dir.length > 0
      ? installedDirs.has(item.dir) || installedNames.has(name)
      : installedNames.has(name) || installed.some((entry) => entry.dir.length === 0)
    if (!known) newSkills.push({ name, path: item.dir, remoteHash: item.hash })
  }

  const updatable = []
  for (const item of installed) {
    if (item.dir.length === 0) continue
    const remote = availableByDir.get(item.dir)
    if (remote === undefined) continue
    if (remote.hash.length === 0 || item.hash.length === 0) continue
    if (remote.hash !== item.hash) {
      updatable.push({ name: item.name, path: item.dir, installedHash: item.hash, remoteHash: remote.hash })
    }
  }

  const orphan = []
  for (const item of installed) {
    const gone = item.dir.length > 0
      ? !availableByDir.has(item.dir) && !availableByName.has(item.name)
      : !availableByName.has(item.name) && !available.some((entry) => entry.dir.length === 0)
    if (gone) orphan.push({ name: item.name, path: item.dir })
  }

  return { source, available: available.length, installed: installed.length, newSkills, updatable, orphan, error: '' }
}

// ── npx skills 命令行 ─────────────────────────────────────────────────────────

/**
 * CLI 的运行环境：把 npm 缓存指到可写临时目录。
 *
 * 本机 `/root/.npm` 存在 root 归属的缓存文件，直接跑 npx 会 `EACCES`；
 * 显式指定缓存目录是最省事且不动用户家目录的做法。
 * @returns {NodeJS.ProcessEnv} 子进程环境。
 */
function cliEnv() {
  return {
    ...process.env,
    npm_config_cache: join(tmpdir(), 'dsh-skills-npm-cache'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  }
}

/**
 * 跑 `npx -y skills …`。
 * @param {string[]} args - skills 子命令与参数。
 * @param {number} timeoutMs - 超时毫秒。
 * @returns {Promise<{ ok: boolean, code: number, command: string, stdout: string, stderr: string, durationMs: number, error: string }>} 运行结果。
 */
export function runCli(args, timeoutMs) {
  const started = Date.now()
  const command = 'npx -y skills ' + args.join(' ')
  return new Promise((resolve) => {
    execFile('npx', ['-y', 'skills', ...args], {
      env: cliEnv(),
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const durationMs = Date.now() - started
      const out = stripAnsi(stringOf(stdout))
      const err = stripAnsi(stringOf(stderr))
      if (error === null || error === undefined) {
        return resolve({ ok: true, code: 0, command, stdout: out, stderr: err, durationMs, error: '' })
      }
      const code = typeof error.code === 'number' ? error.code : -1
      let message = messageOf(error)
      if (error.code === 'ENOENT') message = '找不到 npx：请确认 Node.js/npm 已安装并在 PATH 中'
      else if (error.killed === true || error.signal !== null && error.signal !== undefined) message = '命令超时（' + String(Math.round(timeoutMs / 1000)) + ' 秒）已终止'
      else if (err.trim().length > 0) message = err.trim().split('\n').slice(-3).join(' / ')
      resolve({ ok: false, code, command, stdout: out, stderr: err, durationMs, error: message })
    })
  })
}

/**
 * 解析 `npx skills find <关键词>` 的输出。
 *
 * 形如：
 * ```
 * vercel-labs/agent-skills@vercel-composition-patterns 383.1K installs
 * └ https://skills.sh/vercel-labs/agent-skills/vercel-composition-patterns
 * ```
 * @param {string} text - CLI 输出（已去 ANSI）。
 * @returns {{ repo: string, skill: string, installs: string, url: string }[]} 搜索结果。
 */
export function parseFindOutput(text) {
  const results = []
  const lines = stripAnsi(text).split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*(\S+@\S+)\s+([0-9][0-9.,]*[KMB]?)\s+installs?\s*$/.exec(lines[index])
    if (match === null) continue
    const at = match[1].lastIndexOf('@')
    let url = ''
    const next = lines[index + 1] === undefined ? '' : lines[index + 1]
    const urlMatch = /https:\/\/skills\.sh\/\S+/.exec(next)
    if (urlMatch !== null) url = urlMatch[0]
    results.push({
      repo: match[1].slice(0, at),
      skill: match[1].slice(at + 1),
      installs: match[2],
      url,
    })
  }
  return results
}

/**
 * 解析 `npx skills add <仓库> -l` 的技能清单（无 token / 限流时的降级通道）。
 * @param {string} text - CLI 输出（已去 ANSI）。
 * @returns {{ count: number, skills: { name: string, description: string }[] }} 清单。
 */
export function parseListOutput(text) {
  const plain = stripAnsi(text)
  const lines = plain.split('\n')
  /** 只有框线或空白的行（CLI 会用它分隔技能名与描述）。 */
  const isSeparator = (line) => /^[\s│|]*$/.test(line)
  const skills = []
  for (let index = 0; index < lines.length; index += 1) {
    const name = /^[\s│|]*([a-z0-9][a-z0-9-]{1,60})\s*$/.exec(lines[index])
    if (name === null) continue
    let cursor = index + 1
    while (cursor < lines.length && isSeparator(lines[cursor])) cursor += 1
    const description = cursor < lines.length ? /^[\s│|]{4,}(\S.*?)\s*$/.exec(lines[cursor]) : null
    skills.push({ name: name[1], description: description === null ? '' : description[1] })
  }
  const found = /Found\s+(\d+)\s+skills?/i.exec(plain)
  return { count: found === null ? skills.length : Number(found[1]), skills }
}

/**
 * 用 CLI 列出一个仓库里可装的技能（降级模式：只知道名字与描述，没有 hash）。
 * @param {string} source - 仓库 slug。
 * @returns {Promise<{ ok: boolean, names: string[], error: string }>} 结果。
 */
export async function listRepoViaCli(source) {
  const run = await runCli(['add', source, '-l'], QUERY_TIMEOUT_MS)
  const parsed = parseListOutput(run.stdout + '\n' + run.stderr)
  if (parsed.skills.length === 0) {
    return { ok: false, names: [], error: run.error.length > 0 ? run.error : 'CLI 没有列出任何技能' }
  }
  return { ok: true, names: parsed.skills.map((item) => item.name), error: '' }
}

// ── 对外操作 ─────────────────────────────────────────────────────────────────

/** 「本地·未托管」这一组的固定 key（它没有来源仓库）。 */
export const LOCAL_GROUP_KEY = '__local__'

/**
 * 把「已安装技能」与「检查结果」拼成按仓库分组的列表。
 *
 * **这是宿主与浏览器两侧共用的唯一分组规则**：独立页（服务端渲染）与设置页
 * （React）都按它渲染，`test/page.test.mjs` 里有一条"两份实现输出必须一致"的
 * 对照测试——客户端那份在 `client/client.js` 的 `buildGroups`。
 *
 * 两条不打架的规则：已装上的不再显示为「新增」；删掉的也不再挂在「上游已移除」。
 *
 * 第三个参数是**订阅仓库**清单：订阅是本地登记（装不装都在），所以一个技能都没装的
 * 订阅仓也要有自己的格子，字段与派生组完全一致、只多一个 `origin`。
 * @param {object[]} skills - overview 里的技能行。
 * @param {object | null} delta - check 的结果；未检查时传 null。
 * @param {unknown[]} [subscriptions] - 订阅仓库 slug（也容忍 `{ source }` 对象）。
 * @returns {object[]} 分组（有待办的在前，未托管最后）。
 */
export function groupSkills(skills, delta, subscriptions = []) {
  const rows = Array.isArray(skills) ? skills : []
  const bySource = new Map()
  const local = []
  for (const item of rows) {
    if (stringOf(item.source).length === 0) {
      local.push(item)
      continue
    }
    const bucket = bySource.get(item.source) ?? []
    bucket.push(item)
    bySource.set(item.source, bucket)
  }

  // 订阅仓：先认下来（哪怕一个技能都没装），空桶照样走下面同一套拼装。
  const subscribed = new Set()
  for (const item of Array.isArray(subscriptions) ? subscriptions : []) {
    const source = typeof item === 'string' ? item.trim() : (isObject(item) ? stringOf(item.source).trim() : '')
    if (source.length === 0) continue
    subscribed.add(source)
    if (!bySource.has(source)) bySource.set(source, [])
  }

  const deltaBySource = new Map()
  for (const repo of delta === null || !Array.isArray(delta.repos) ? [] : delta.repos) deltaBySource.set(repo.source, repo)

  const groups = []
  for (const [source, installed] of bySource) {
    const repo = deltaBySource.get(source)
    const installedNames = new Set(installed.map((item) => item.name))
    const updatable = (repo === undefined ? [] : repo.updatable).filter((item) => installedNames.has(item.name))
    const updatableNames = new Set(updatable.map((item) => item.name))
    const orphans = (repo === undefined ? [] : repo.orphan).filter((item) => installedNames.has(item.name))
    const news = (repo === undefined ? [] : repo.newSkills).filter((item) => !installedNames.has(item.name))
    const orphanNames = new Set(orphans.map((item) => item.name))
    const items = installed
      .filter((item) => !orphanNames.has(item.name))
      .map((item) => ({ kind: updatableNames.has(item.name) ? 'update' : 'installed', name: item.name, row: item }))
      .concat(news.map((item) => ({ kind: 'new', name: item.name, remote: item })))
      .concat(orphans.map((item) => ({ kind: 'orphan', name: item.name, remote: item, row: installed.find((entry) => entry.name === item.name) })))
      .sort(compareByName)
    groups.push({
      key: source,
      source,
      local: false,
      // origin：这一格是「登记过的订阅仓」还是「因为装了技能才派生出来的」（订阅优先）。
      origin: subscribed.has(source) ? 'subscribed' : 'derived',
      installed: installed.length,
      available: repo === undefined ? -1 : repo.available,
      checked: repo !== undefined,
      mode: repo === undefined ? '' : repo.mode,
      error: repo === undefined ? '' : repo.error,
      news,
      updatable,
      orphans,
      items,
      pending: news.length + updatable.length + orphans.length,
    })
  }
  if (local.length > 0) {
    groups.push({
      key: LOCAL_GROUP_KEY,
      source: '',
      local: true,
      origin: 'local',
      installed: local.length,
      available: -1,
      checked: true,
      mode: 'local',
      error: '',
      news: [],
      updatable: [],
      orphans: [],
      items: local.map((item) => ({ kind: 'installed', name: item.name, row: item })).sort(compareByName),
      pending: 0,
    })
  }

  groups.sort((left, right) => {
    if (left.local !== right.local) return left.local ? 1 : -1
    if (right.pending !== left.pending) return right.pending - left.pending
    return left.source < right.source ? -1 : left.source > right.source ? 1 : 0
  })
  return groups
}

/**
 * 按名字排序。
 * @param {{ name: string }} left - 左。
 * @param {{ name: string }} right - 右。
 * @returns {number} 比较结果。
 */
function compareByName(left, right) {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

/**
 * 未找到技能时的空差异行（字段齐全，浏览器侧严格校验才不会炸）。
 * @param {string} source - 仓库 slug。
 * @param {string} error - 失败原因。
 * @returns {object} 差异行。
 */
function failedRepo(source, error) {
  return { source, mode: 'failed', available: 0, installed: 0, newSkills: [], updatable: [], orphan: [], error }
}

/**
 * 检查一个仓库：API 优先，失败回落 CLI。
 * @param {string} source - 仓库 slug。
 * @param {Record<string, object>} lockSkills - 锁文件内容。
 * @param {{ token: string, source: string }} token - token 状态。
 * @returns {Promise<object>} 该仓库的差异行。
 */
async function checkOne(source, lockSkills, token) {
  const parsed = parseSource(source)
  if (parsed === null) return failedRepo(source, '仓库写法应为 owner/repo')
  const fetched = await fetchRepoTree(parsed, token.token)
  if (fetched.ok) {
    return { ...computeDelta(source, lockSkills, skillsFromTree(fetched.tree)), mode: 'api' }
  }
  const fallback = await listRepoViaCli(source)
  const installed = Object.entries(lockSkills)
    .filter(([, entry]) => isObject(entry) && entry.source === source)
    .map(([name]) => name)
  if (!fallback.ok) {
    return failedRepo(source, fetched.error + '；CLI 回落也失败：' + fallback.error)
  }
  const newSkills = fallback.names.filter((name) => !installed.includes(name))
  const orphan = installed.filter((name) => !fallback.names.includes(name))
  return {
    source,
    mode: 'cli',
    available: fallback.names.length,
    installed: installed.length,
    newSkills: newSkills.map((name) => ({ name, path: '', remoteHash: '' })),
    updatable: [],
    orphan: orphan.map((name) => ({ name, path: '' })),
    error: '已降级为 CLI 列表模式（' + fetched.error + '）：只能判断新增与移除，无法判断更新',
  }
}

/**
 * 面板首屏：已安装技能 + 来源仓库分组 + 环境信息（纯本地，零网络）。
 * @param {{ pagePath?: string }} [extra] - 独立页的挂载路径；未挂载时为空串。
 * @returns {Promise<object>} 视图状态。
 */
export async function skillsOverview(extra = {}) {
  const pagePath = isObject(extra) ? stringOf(extra.pagePath) : ''
  const lock = await readLock()
  const disk = await scanDiskSkills()
  const npx = await findExecutable('npx')
  const token = await resolveToken()

  const managed = new Map()
  for (const [name, entry] of Object.entries(lock.skills)) {
    if (!isObject(entry)) continue
    managed.set(name, entry)
  }

  const skills = disk.items.map((item) => {
    const entry = managed.get(item.name)
    return {
      name: item.name,
      dirName: item.dirName,
      kind: item.kind,
      path: item.path,
      description: item.description,
      detail: item.detail,
      valid: item.valid,
      modelInvocable: item.modelInvocable,
      userInvocable: item.userInvocable,
      managed: entry !== undefined,
      source: entry === undefined ? '' : stringOf(entry.source),
      installedAt: entry === undefined ? '' : stringOf(entry.installedAt),
      updatedAt: entry === undefined ? '' : stringOf(entry.updatedAt),
    }
  })

  const groups = new Map()
  for (const item of skills) {
    if (item.source.length === 0) continue
    const bucket = groups.get(item.source) ?? []
    bucket.push(item.name)
    groups.set(item.source, bucket)
  }
  // 订阅 ∪ 锁文件派生：订阅仓一个技能都没装也要在列表里（installed=0、names 空），
  // 界面上落成「未检查」的一格，而不是凭空消失。已装技能的仓库不会被订阅清单重复一遍。
  const subscriptions = await readSubscriptions()
  const repoRows = [...groups.entries()]
    .map(([source, names]) => ({ source, installed: names.length, names: names.slice().sort() }))
  for (const source of subscriptions) {
    if (!groups.has(source)) repoRows.push({ source, installed: 0, names: [] })
  }
  const repos = repoRows.sort((left, right) => right.installed - left.installed || (left.source < right.source ? -1 : 1))

  const notes = []
  if (npx.length === 0) notes.push('PATH 里找不到 npx：装/删/更新/搜索都不可用，列表仍可看')
  if (!lock.exists) notes.push('还没有 skills CLI 锁文件：技能可能不是用 npx skills 装的，只能看与删')
  if (lock.error.length > 0) notes.push('锁文件读取失败：' + lock.error)
  if (disk.error.length > 0) notes.push('技能目录读取失败：' + disk.error)
  const agentsHome = resolveAgentsHome()
  if (join(homedir(), '.agents') !== agentsHome) {
    notes.push('注意：$DSH_AGENTS_HOME 指向 ' + agentsHome + '，而 npx skills 只会写 ~/.agents')
  }
  if (token.source === 'none') notes.push('未检测到 GitHub token：检查更新走匿名限流（60 次/小时）')
  else if (token.source === 'gh') notes.push('GitHub 走 gh 登录（' + (token.user.length > 0 ? token.user : '已登录') + '，5000 次/小时）')

  return {
    ok: true,
    agentsHome,
    root: disk.root,
    lockPath: lock.path,
    lockExists: lock.exists,
    npxPath: npx,
    tokenSource: token.source,
    tokenUser: token.user,
    skills,
    repos,
    notes,
    pagePath,
    error: '',
  }
}

/**
 * 检查来源仓库的更新（每个仓库一次 GitHub 请求）。
 * @param {{ sources?: string[] }} request - 可选：只检查指定仓库；空表示锁文件里的全部来源 ∪ 订阅清单。
 * @returns {Promise<object>} 每个仓库的差异。
 */
export async function checkRepos(request) {
  const lock = await readLock()
  const requested = isObject(request) && Array.isArray(request.sources)
    ? request.sources.filter((item) => typeof item === 'string' && item.length > 0)
    : []
  // 默认要盯的不只是「装了东西的仓库」，还包括登记过的订阅仓（可能一个技能都还没装）。
  const installedSources = Object.values(lock.skills)
    .filter((entry) => isObject(entry) && stringOf(entry.source).length > 0)
    .map((entry) => stringOf(entry.source))
  const subscribed = await readSubscriptions()
  const every = [...new Set([...installedSources, ...subscribed])]
  const sources = requested.length > 0 ? requested : every.sort()
  const token = await resolveToken()

  const repos = []
  let remaining = -1
  let limit = -1
  for (const source of sources) {
    const parsed = parseSource(source)
    if (parsed === null) {
      repos.push(failedRepo(source, '仓库写法应为 owner/repo'))
      continue
    }
    const fetched = await fetchRepoTree(parsed, token.token)
    if (fetched.ok) {
      if (fetched.remaining >= 0) remaining = fetched.remaining
      if (fetched.limit >= 0) limit = fetched.limit
      repos.push({ ...computeDelta(source, lock.skills, skillsFromTree(fetched.tree)), mode: 'api' })
      continue
    }
    const fallback = await listRepoViaCli(source)
    const installed = Object.entries(lock.skills)
      .filter(([, entry]) => isObject(entry) && entry.source === source)
      .map(([name]) => name)
    if (!fallback.ok) {
      repos.push(failedRepo(source, fetched.error + '；CLI 回落也失败：' + fallback.error))
      continue
    }
    repos.push({
      source,
      mode: 'cli',
      available: fallback.names.length,
      installed: installed.length,
      newSkills: fallback.names.filter((name) => !installed.includes(name)).map((name) => ({ name, path: '', remoteHash: '' })),
      updatable: [],
      orphan: installed.filter((name) => !fallback.names.includes(name)).map((name) => ({ name, path: '' })),
      error: '已降级为 CLI 列表模式（' + fetched.error + '）：只能判断新增与移除，无法判断更新',
    })
  }

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    tokenSource: token.source,
    rateLimitText: limit > 0 ? '本次剩余 ' + String(remaining) + '/' + String(limit) : (token.source === 'none' ? '匿名限流 ' + String(ANON_RATE_LIMIT) + ' 次/小时' : ''),
    repos,
    error: '',
  }
}

/**
 * 搜索 skills.sh 生态（转发 `npx skills find`）。
 * @param {{ query?: string }} request - 关键词。
 * @returns {Promise<object>} 搜索结果。
 */
export async function searchSkills(request) {
  const checked = assertQuery(isObject(request) ? request.query : '')
  if (!checked.ok) return { ok: false, query: '', results: [], command: '', note: '请输入关键词', error: checked.error }
  const query = checked.query
  const run = await runCli(['find', query], QUERY_TIMEOUT_MS)
  const results = parseFindOutput(run.stdout)
  if (results.length === 0) {
    return {
      ok: false,
      query,
      results: [],
      command: run.command,
      note: run.ok ? '没有搜到结果' : '搜索失败',
      error: run.ok ? '' : run.error,
    }
  }
  return { ok: true, query, results, command: run.command, note: '共 ' + String(results.length) + ' 条', error: '' }
}

/**
 * 把动作描述翻译成 `npx skills` 的参数表（纯函数，便于测试命令拼装）。
 *
 * 安装固定加 `-a universal`：只写 `~/.agents/skills`，不会顺带往 50 多个 agent
 * 目录里建软链；删除**不加** `-a`，让 CLI 按默认行为把可能的软链一起清掉。
 * @param {{ kind?: string, source?: string, skills?: string[], name?: string }} request - 动作描述。
 * @returns {{ kind: string, source: string, name: string, skills: string[], args: string[] | null, error: string }} 命令描述。
 */
export function buildActionArgs(request) {
  const kind = isObject(request) ? stringOf(request.kind) : ''
  const source = isObject(request) ? stringOf(request.source).trim() : ''
  const name = isObject(request) ? stringOf(request.name).trim() : ''
  const requested = isObject(request) && Array.isArray(request.skills) ? request.skills : []
  const base = { kind, source, name, skills: [], args: null, error: '' }

  if (kind === 'install') {
    if (source.length === 0) return { ...base, error: '缺少仓库名' }
    if (parseSource(source) === null) return { ...base, error: '仓库写法应为 owner/repo' }
    const checked = assertSkillNames(requested)
    if (!checked.ok) return { ...base, error: checked.error }
    const args = ['add', source, '-a', 'universal', '-g', '-y', '--json']
    for (const skill of checked.names) args.push('-s', skill)
    return { ...base, skills: checked.names, args }
  }
  if (kind === 'remove') {
    if (name.length === 0) return { ...base, error: '缺少技能名' }
    const checked = assertSkillNames(name)
    if (!checked.ok) return { ...base, error: checked.error }
    return { ...base, args: ['remove', '-g', '-y', '-s', checked.names[0]] }
  }
  if (kind === 'update') {
    const checked = assertSkillNames([...requested, name])
    if (!checked.ok) return { ...base, error: checked.error }
    // `npx skills update [skills...]`：不带名字=全部，带名字=只更新这些。
    return { ...base, skills: checked.names, args: ['update', '-g', '-y', ...checked.names] }
  }
  return { ...base, error: '不支持的动作：' + (kind.length > 0 ? kind : '(空)') }
}

/**
 * 执行装 / 删 / 更新，然后**回到磁盘与锁文件核对真实结果**。
 *
 * `npx skills` 的 `--json` 只在 add 上可用，所以「到底成没成」以磁盘与锁文件为准，
 * 而不是以命令退出码或它的 JSON 状态为准（例如全局装到 universal 目录时，
 * 其它 agent 的失败会写进 status，但技能其实已经落地）。
 * @param {{ kind?: string, source?: string, skills?: string[], name?: string }} request - 动作描述。
 * @returns {Promise<object>} 执行结果与核对结论。
 */
export async function runAction(request) {
  const built = buildActionArgs(request)
  const { kind, name, skills } = built
  if (built.args === null) return actionFailed(kind, built.error)

  const run = await runCli(built.args, ACTION_TIMEOUT_MS)
  const after = await scanDiskSkills()
  const lock = await readLock()
  const present = new Set(after.items.map((item) => item.name))
  const tracked = new Set(Object.keys(lock.skills))

  let summary = ''
  let ok = run.ok
  if (kind === 'install') {
    const wanted = skills.length > 0 ? skills : []
    const landed = wanted.filter((skill) => present.has(skill) || tracked.has(skill))
    summary = '请求安装 ' + String(wanted.length) + ' 个，落地 ' + String(landed.length) + ' 个'
      + (landed.length > 0 ? '：' + landed.join('、') : '')
    const missed = wanted.filter((skill) => !landed.includes(skill))
    if (missed.length > 0) summary += '；未落地：' + missed.join('、')
    ok = missed.length === 0 && wanted.length > 0
  } else if (kind === 'remove') {
    const gone = !present.has(name) && !tracked.has(name)
    summary = gone ? '已移除 ' + name : '磁盘或锁文件里仍能看到 ' + name + '，请重试'
    ok = gone
  } else {
    const count = [...skills, name].filter((item) => item.length > 0).length
    const scope = count === 0 ? '全部技能' : String(count) + ' 个技能'
    summary = run.ok ? '更新完成（' + scope + '）：' + lastMeaningfulLine(run.stdout) : '更新失败'
  }

  return {
    ok,
    kind,
    command: run.command,
    code: run.code,
    durationMs: run.durationMs,
    output: tailOf(run.stdout.length > 0 ? run.stdout : run.stderr),
    summary,
    error: run.error,
  }
}

/**
 * 动作失败时的统一结果（字段齐全）。
 * @param {string} kind - 动作名。
 * @param {string} error - 原因。
 * @returns {object} 结果。
 */
function actionFailed(kind, error) {
  return { ok: false, kind, command: '', code: -1, durationMs: 0, output: '', summary: '', error }
}

/**
 * 取输出里最后一行有内容的话，用来给个像样的结论。
 * @param {string} text - 输出。
 * @returns {string} 一行文本。
 */
function lastMeaningfulLine(text) {
  const lines = stripAnsi(text).split('\n').map((line) => line.replace(/[│└┌◇◆●■┃|]/g, '').trim()).filter((line) => line.length > 0)
  return lines.length === 0 ? '（无输出）' : lines[lines.length - 1]
}

/**
 * 读技能正文：本地的按名字找，远程的按 `仓库 + 路径` 取。
 * @param {{ name?: string, source?: string, path?: string }} request - 定位信息。
 * @returns {Promise<object>} 正文状态。
 */
export async function readSkill(request) {
  const name = isObject(request) ? stringOf(request.name).trim() : ''
  const source = isObject(request) ? stringOf(request.source).trim() : ''
  const path = isObject(request) ? stringOf(request.path).trim() : ''

  if (name.length > 0) {
    const disk = await scanDiskSkills()
    const item = disk.items.find((entry) => entry.name === name || entry.dirName === name)
    if (item === undefined) return readFailed('local', name, '本地没有这个技能')
    try {
      const content = await readFile(item.path, 'utf8')
      return {
        ok: true,
        kind: 'local',
        name: item.name,
        source: '',
        path: item.path,
        content,
        bytes: Buffer.byteLength(content, 'utf8'),
        error: '',
      }
    } catch (error) {
      return readFailed('local', name, messageOf(error), item.path)
    }
  }

  if (source.length > 0 && path.length > 0) {
    const parsed = parseSource(source)
    if (parsed === null) return readFailed('remote', name, '仓库写法应为 owner/repo')
    const checkedPath = assertRemotePath(path)
    if (!checkedPath.ok) return readFailed('remote', name, checkedPath.error)
    const token = await resolveToken()
    const url = 'https://api.github.com/repos/' + parsed.owner + '/' + parsed.repo + '/contents/' + checkedPath.path + '/SKILL.md?ref=HEAD'
    const headers = {
      accept: 'application/vnd.github.raw',
      'user-agent': 'dsh-agents-skills',
      'x-github-api-version': '2022-11-28',
    }
    if (token.token.length > 0) headers.authorization = 'Bearer ' + token.token
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) })
      if (!response.ok) return readFailed('remote', name, 'HTTP ' + String(response.status) + '：取不到 ' + checkedPath.path + '/SKILL.md')
      const content = await response.text()
      const parsedFile = parseFrontmatter(content)
      return {
        ok: true,
        kind: 'remote',
        name: parsedFile.name.length > 0 ? parsedFile.name : basename(checkedPath.path),
        source,
        path: checkedPath.path + '/' + SKILL_FILE,
        content,
        bytes: Buffer.byteLength(content, 'utf8'),
        error: '',
      }
    } catch (error) {
      return readFailed('remote', name, messageOf(error))
    }
  }

  return readFailed('local', name, '需要技能名，或仓库 + 路径')
}

/**
 * 读失败时的统一结果（字段齐全）。
 * @param {string} kind - local / remote。
 * @param {string} name - 技能名。
 * @param {string} error - 原因。
 * @param {string} [path] - 已知路径。
 * @returns {object} 结果。
 */
function readFailed(kind, name, error, path = '') {
  return { ok: false, kind, name, source: '', path, content: '', bytes: 0, error }
}
