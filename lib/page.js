// dsh-agents-skills · 独立页（服务端渲染）
//
// 为什么是服务端渲染的纯 HTML：这个插件没有构建步骤，而独立页要在**没有聊天界面**
// 的情况下打开，所以不引前端框架——展开/折叠用原生 `<details>`，操作全部是表单 POST。
// 交互层是 `client/page-ui.js` 一个外链文件（pjax 薄层，≤200 行、无依赖），把整页导航换成
// fetch + 局部替换，免得每次操作整页白闪、丢滚动、丢折叠折叠状态；CSP 用 script-src 'self'
// 只放行这一个文件，内联脚本仍然禁止。没有 JS 时页面照常工作（纯 SSR + 表单是兜底）。
//
// 门禁：路由自己调 `ctx.connection.requestRejection(req)`（宿主原话："Apply Connection's
// Host/Origin checks and browser authentication to another Web route"），也就是和聊天
// 界面**同一道门**。不这样做的话，exact 路由会绕过 `/api` 的栅栏——在"宿主机本地直连"
// 这条路上（它不经过反向代理）就是一个免密后门。

import { readFileSync } from 'node:fs'
import { groupSkills, readSubscriptions } from './skills.js'

/** 独立页默认路径；`?` 与空白不允许出现在路径里。 */
export const DEFAULT_PAGE_PATH = '/dsh-agents-skills'
/** 交互层资产名：`GET <pagePath>?asset=page-ui.js` 时 serve `client/page-ui.js`。 */
const PAGE_UI_ASSET = 'page-ui.js'
/** 交互层源码缓存（进程内读一次文件；文件缺失时为 null）。 */
let pageUiSourceCache = null

/**
 * 读交互层源码（`client/page-ui.js`，与本文件同包）。
 * @returns {string | null} JS 源码；读不到时为 null。
 */
function pageUiSource() {
  if (pageUiSourceCache !== null) return pageUiSourceCache
  try {
    pageUiSourceCache = readFileSync(new URL('../client/page-ui.js', import.meta.url), 'utf8')
    return pageUiSourceCache
  } catch {
    return null
  }
}
/** 表单体上限：Agent 编辑器会把整份 AGENTS.md（上限 65536 字节）URL 编码后提交，
 * 中文按 %XX 展开最多约 3 倍，所以给到 256 KiB。 */
const BODY_LIMIT_BYTES = 256 * 1024
/** 记住「上次看的标签」用的 cookie 名。 */
const TAB_COOKIE = 'dsh-agents-skills-tab'
/** cookie 有效期（秒）：一年。 */
const TAB_COOKIE_MAX_AGE = 31536000
/** 检查结果的缓存时长（毫秒）：一次检查是每个仓库 1 个 GitHub 请求。 */
const CHECK_CACHE_MS = 120000
/** `back` 参数允许的字符集：只能是本站的相对查询串。 */
const BACK_PATTERN = /^[?&A-Za-z0-9=%.+_~-]{0,300}$/

/**
 * HTML 转义。**所有**动态文本都要过这里——技能名、说明、正文都来自远端仓库。
 * @param {unknown} value - 任意值。
 * @returns {string} 转义后的文本。
 */
export function escapeHtml(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 解析 URL 编码的表单体（重复的键收集成数组）。
 * @param {string} text - 请求体。
 * @returns {{ get: (key: string) => string, all: (key: string) => string[] }} 表单访问器。
 */
export function parseForm(text) {
  let params = null
  try {
    params = new URLSearchParams(typeof text === 'string' ? text : '')
  } catch {
    params = new URLSearchParams('')
  }
  const form = params
  return {
    get(key) {
      return form.get(key) ?? ''
    },
    all(key) {
      return form.getAll(key).filter((item) => item.length > 0)
    },
  }
}

/**
 * 读请求体，超过上限就截断并报错。
 * @param {object} req - node 请求对象。
 * @param {number} [limit] - 字节上限。
 * @returns {Promise<{ ok: boolean, text: string, error: string }>} 请求体。
 */
export function readBody(req, limit = BODY_LIMIT_BYTES) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        resolve({ ok: false, text: '', error: '请求体过大' })
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve({ ok: true, text: Buffer.concat(chunks).toString('utf8'), error: '' }))
    req.on('error', (error) => resolve({ ok: false, text: '', error: error?.message ?? '读取请求体失败' }))
  })
}

/**
 * 校验回跳参数：只接受本站的相对查询串，防止被做成开放重定向。
 * @param {string} value - 表单里的 back 字段。
 * @param {string} fallback - 不合法时的回退路径。
 * @returns {string} 可安全用于 Location 的路径。
 */
export function safeBack(value, fallback) {
  const raw = typeof value === 'string' ? value : ''
  if (raw.length === 0) return fallback
  if (!raw.startsWith('?')) return fallback
  if (!BACK_PATTERN.test(raw)) return fallback
  if (raw.includes('//') || raw.includes('\\')) return fallback
  return fallback + raw
}

/**
 * 从 Cookie 头里取一个值。
 * @param {unknown} header - 请求的 cookie 头。
 * @param {string} name - cookie 名。
 * @returns {string} 值；没有时为空串。
 */
export function readCookie(header, name) {
  if (typeof header !== 'string' || header.length === 0) return ''
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(index + 1).trim())
    } catch {
      return ''
    }
  }
  return ''
}

/** 页面样式：跟随系统深浅色（独立页拿不到宿主的主题变量，这是诚实的替代）。 */
const STYLE = `
/* 运维台账风（ops ledger）：暖白纸面、等宽数据、细线分隔；唯一的彩色是状态色（绿/红/琥珀）。
   深浅两套主题只用 CSS 变量 + @media (prefers-color-scheme: dark) 覆盖，不写第二套选择器。 */
:root {
  color-scheme: light dark;
  --paper: #FBFAF8; --ink: #16181D; --sub: #585E66; --line: #E4E2DD; --line-soft: #EFEDE9;
  --amber: #B7791F; --ok: #1A7F37; --err: #CF222E;
  /* 纵向 padding 只在这里定义一次；页面高度公式引用同一个 --pad-y，
     所以 calc(100vh - 2*var(--pad-y)) 与 body 的上下 padding 永远同源（当前 = 40px）。
     绝不再写 top:38px 那种互不相干的魔法数字（上一版表头就是这么坏的）。 */
  --pad-y: 20px; --pad-x: 24px;
}
@media (prefers-color-scheme: dark) {
  :root { --paper: #191A1C; --ink: #E8E6E1; --sub: #9BA1A8; --line: #333331; --line-soft: #2B2B29;
    --amber: #E3B341; --ok: #3FB950; --err: #F85149; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: var(--pad-y) var(--pad-x); background: var(--paper); color: var(--ink);
  font: 13.5px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
.wrap { max-width: none; }
h1 { font-size: 16px; font-weight: 600; margin: 0; }
a { color: inherit; }
/* 数据（仓库名 / 技能名 / 路径 / 日期）走等宽栈；界面文字走系统黑体栈。 */
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
.dim { color: var(--sub); font-size: 12px; }
.btn, button { font: inherit; font-size: 12.5px; padding: 3px 10px; border-radius: 8px; border: 1px solid var(--line);
  background: transparent; color: inherit; cursor: pointer; text-decoration: none; display: inline-block; white-space: nowrap; }
.btn:hover, button:hover { background: rgba(127,127,127,.08); }
/* 主按钮 = 墨底纸字，不用蓝紫色。 */
button.primary { background: var(--ink); color: var(--paper); border-color: var(--ink); }
button.primary:hover { background: var(--ink); }
.btn.ghost, button.ghost { background: transparent; color: var(--sub); }
.btn.ghost:hover, button.ghost:hover { color: var(--ink); }
/* 提交中：交互层（client/page-ui.js）给被点的 submit 按钮加 .busy，禁用 + 变淡防连点。 */
.busy { opacity: .6; cursor: wait; }
form.inline { display: inline; }
.badge { display: inline-block; font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 999px;
  border: 1px solid var(--line); color: var(--sub); white-space: nowrap; }
.badge.ok { color: var(--ok); border-color: var(--ok); }
.badge.warn { color: var(--amber); border-color: var(--amber); }
.badge.err { color: var(--err); border-color: var(--err); }
/* 页头：最多两行。第一行 = h1 + 统计 dim 行 + 靠右的两个按钮。 */
.pagehead { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; padding-bottom: 6px; }
.pagehead .stats { min-width: 0; }
.head-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.head-actions .clip { max-width: 340px; min-width: 0; }
.notes { padding: 0 0 6px; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 10px 0; }
/* 表格：细线分隔 + 粘性表头。刻意**不用** rowspan、也不给单元格加 sticky——
   "跨行单元格 + 粘性单元格"会被浏览器画错位置并把行撑高（实测行高 60~150px）。 */
table { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 12.5px; }
table.skills { table-layout: fixed; min-width: 900px; }
table.search { table-layout: auto; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line-soft); vertical-align: middle; }
thead th { position: sticky; top: 0; z-index: 2; height: 30px; padding: 0 10px; background: var(--paper);
  border-bottom: 1px solid var(--line); font-weight: 600; color: var(--sub); white-space: nowrap; }
tbody tr { height: 34px; }
tbody tr:hover { background: rgba(127,127,127,.08); }
th.pick, td.pick { text-align: center; padding-left: 4px; padding-right: 4px; }
td.nowrap { white-space: nowrap; }
td .clip { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
td.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
td.repo-name { color: var(--sub); }
td.skill-name.orphan .clip { text-decoration: line-through; color: var(--sub); }
td.status .stack { display: inline-flex; align-items: center; gap: 4px; }
td.status .suffix { font-size: 11px; }
td.actions { white-space: nowrap; text-align: right; }
td.actions button { padding: 1px 9px; font-size: 12px; }
td.dim, td .dim { color: var(--sub); }
/* 仓库条：单行横滚，chip 内部不许换行（flex-wrap:nowrap）。 */
.repostrip { flex: 0 0 auto; display: flex; flex-wrap: nowrap; overflow-x: auto; gap: 6px; padding: 6px 0; }
.repostrip .repo-chip { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; white-space: nowrap;
  border: 1px solid var(--line); border-radius: 8px; padding: 3px 8px; }
.repostrip .repo-chip .mono { color: var(--ink); font-weight: 600; }
.repostrip .repo-chip button { padding: 1px 8px; font-size: 12px; }
/* 批量条：高度自动、最小 34px、不换行、横滚。它是 flex 子项，绝不许被压扁
   （历史上被压到 20px，按钮溢出盖住了表头——那是 bug）。 */
.batchbar { flex: 0 0 auto; min-height: 34px; height: auto; display: flex; align-items: center; gap: 6px;
  flex-wrap: nowrap; overflow-x: auto; border-bottom: 1px solid var(--line); }
.batchbar button, .batchbar a.btn { padding: 1px 9px; font-size: 12px; }
.batchbar .dim { white-space: nowrap; }
/* flex 链：内容列是固定高度的 flex 列，表格吃剩下的高度。从 .content.skills-page 到表格
   每级都带 min-height:0；除滚动容器（.table-scroll）外，每个 flex 子项都 flex:0 0 auto。 */
.content.skills-page { display: flex; flex-direction: column; min-height: 0;
  /* 与 body 的纵向 padding 同源：calc(100vh - 2*var(--pad-y)) = calc(100vh - 40px)。 */
  height: calc(100vh - 2 * var(--pad-y)); }
.content.skills-page > *:not(.skills-form) { flex: 0 0 auto; }
.skills-form { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.skills-form > .repostrip, .skills-form > .batchbar { flex: 0 0 auto; }
/* 表头 sticky top:0 —— 偏移量为 0，永远不会被"往下推"去盖住第一行（上一版 top:38px 就是这么坏的）。 */
.table-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; border-top: 1px solid var(--line); }
.search-scroll { overflow: auto; max-height: 360px; margin-top: 6px; border-top: 1px solid var(--line); }
/* 折叠区：原生 <details>，展开/收起不依赖 JS。 */
details.fold > summary { cursor: pointer; color: var(--sub); font-size: 12.5px; padding: 7px 0;
  border-top: 1px solid var(--line); list-style: none; }
details.fold > summary:hover { color: var(--ink); }
details.fold > summary::-webkit-details-marker { display: none; }
details.fold > summary::before { content: "\u25b8 "; }
details.fold[open] > summary::before { content: "\u25be "; }
.fold-body { color: var(--sub); font-size: 12px; line-height: 1.8; padding: 0 0 10px; }
.msg { border-radius: 8px; padding: 8px 12px; margin: 0 0 10px; font-size: 13px; border: 1px solid var(--line); }
.msg.ok { color: var(--ok); } .msg.err { color: var(--err); }
pre { white-space: pre-wrap; word-break: break-word; background: rgba(127,127,127,.08); border-radius: 8px; padding: 10px 12px; font-size: 12px; max-height: 320px; overflow: auto; }
input[type=text] { font: inherit; font-size: 13px; padding: 4px 10px; border-radius: 8px; border: 1px solid var(--line);
  background: transparent; color: inherit; min-width: 240px; }
textarea { width: 100%; max-width: 1100px; min-height: 340px; box-sizing: border-box; padding: 12px 14px; border-radius: 8px;
  border: 1px solid var(--line); background: transparent; color: inherit; resize: vertical;
  font: 12.5px/1.65 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.hint { font-size: 12px; color: var(--amber); }
/* 面包屑（仓库子页回列表）。 */
.crumbs { padding: 0 0 4px; font-size: 12.5px; }
.crumbs a { color: var(--sub); text-decoration: none; }
.crumbs a:hover { color: var(--ink); }
/* 仓库列表 / 子页 / 待办页把页头也放进 .skills-form 里（页头右侧按钮要和表格同一次提交），
   这些 flex 子项同样 flex:0 0 auto，不许被压扁。 */
.skills-form > .pagehead, .skills-form > .crumbs, .skills-form > .empty { flex: 0 0 auto; }
.empty { padding: 14px 2px; }
/* 仓库名做成子页链接时保持 mono 外观，不染蓝紫色。 */
td.repo-link a, td.repo-link a:visited { color: inherit; text-decoration: none; }
td.repo-link a:hover { text-decoration: underline; }
/* 导航与外壳 */
.layout { display: flex; gap: 22px; align-items: flex-start; }
.nav { flex: 0 0 160px; display: flex; flex-direction: column; gap: 4px; position: sticky; top: var(--pad-y); }
.brand { font-size: 12px; font-weight: 600; letter-spacing: .02em; color: var(--sub); padding: 0 10px 6px; }
/* active 二选一：这里选"左侧 3px --ink 竖条"，不用浅底加边框。 */
.navitem { display: flex; align-items: center; gap: 6px; padding: 6px 10px 6px 9px; border-radius: 8px;
  text-decoration: none; font-size: 13.5px; border-left: 3px solid transparent; }
.navitem:hover { background: rgba(127,127,127,.1); }
.navitem.active { border-left-color: var(--ink); font-weight: 600; }
.count { font-size: 11px; color: var(--sub); border: 1px solid var(--line); border-radius: 999px; padding: 0 6px; margin-left: auto; }
.count.warn { color: var(--amber); border-color: var(--amber); }
.content { flex: 1 1 auto; min-width: 0; }
/* ≤720px：导航变顶部横排、页面高度 auto、表格滚动容器 max-height:70vh。 */
@media (max-width: 720px) {
  .layout { flex-direction: column; gap: 12px; }
  .nav { flex: none; width: 100%; flex-direction: row; flex-wrap: wrap; position: static; }
  .brand { width: 100%; padding-bottom: 2px; }
  .content.skills-page { height: auto; }
  .table-scroll { max-height: 70vh; }
}
`

/**
 * 一个技能行。
 * @param {object} group - 分组。
 * @param {object} item - 行（kind/name/row/remote）。
 * @param {string} back - 回跳查询串（行内表单统一由外层表单带，这里只为签名兼容）。
 * @param {{ showRepo?: boolean, repoHref?: string }} [options] - showRepo=false 时不渲染「仓库」列（仓库子页少一列）；repoHref 非空时仓库名做成子页链接（待办页跨仓聚合）。
 * @returns {string} HTML。
 */
function renderItem(group, item, back, options = {}) {
  const row = item.row
  const remote = item.remote
  const showRepo = options.showRepo !== false
  const repoHref = typeof options.repoHref === 'string' ? options.repoHref : ''
  // 状态列每行最多一个徽章。优先级：格式不合规(红) > 上游已移除(红) > 可更新(琥珀) > 新增(绿)，
  // 无事 → dim「已装」。并发原因不叠徽章，而是合并进第一个徽章的 title（分号连接）。
  const reasons = []
  if (row !== undefined && row.valid !== true) reasons.push({ level: 'err', label: '格式不合规' })
  if (item.kind === 'orphan') reasons.push({ level: 'err', label: '上游已移除' })
  if (item.kind === 'update') reasons.push({ level: 'warn', label: '可更新' })
  if (item.kind === 'new') reasons.push({ level: 'ok', label: '新增' })
  const statusBadge = reasons.length === 0
    ? '<span class="dim">已装</span>'
    : '<span class="badge ' + reasons[0].level + '"'
      + (reasons.length > 1 ? ' title="' + escapeHtml(reasons.map((reason) => reason.label).join('；')) + '"' : '')
      + '>' + reasons[0].label + '</span>'
  // 「模型专用」「仅用户可用」不是状态：作为徽章后面的小号 dim 后缀文字，不渲染成徽章。
  const suffixes = []
  if (row !== undefined && row.modelInvocable !== true) suffixes.push('仅用户可用')
  if (row !== undefined && row.userInvocable !== true) suffixes.push('模型专用')
  const suffixText = suffixes.length === 0
    ? ''
    : '<span class="dim suffix">' + suffixes.map((text) => '·' + text).join(' ') + '</span>'

  const description = row !== undefined && row.description.length > 0
    ? row.description
    : (item.kind === 'new' ? '仓库里有、本地没装' : (item.kind === 'orphan' ? '仓库里已经没有这个技能了' : ''))

  // 整张表在**一个** <form> 里（表单不能嵌套），所以每行按钮靠 name/value 带上自己的目标：
  //   row = <动作>|<仓库>|<技能名>；勾选框用 pick = <仓库>|<技能名>。
  const target = escapeHtml(group.source) + '|' + escapeHtml(item.name)
  // 操作列只留"有事可做"的按钮：不给已装且最新的行挂一个没意义的「更新」。
  const buttons = []
  if (item.kind === 'new') {
    buttons.push('<button class="primary" type="submit" name="row" value="install|' + target + '">安装</button>')
  } else if (item.kind === 'update') {
    buttons.push('<button type="submit" name="row" value="update|' + target + '">更新</button>')
    buttons.push('<button type="submit" name="row" value="remove|' + target + '">删除</button>')
  } else {
    buttons.push('<button type="submit" name="row" value="remove|' + target + '">删除</button>')
  }
  // 只有能装或能删的行才给勾选框：已装且最新的技能勾了也没事可做。
  const selectable = item.kind === 'new' || item.kind === 'update' || item.kind === 'orphan'
  const checkbox = selectable
    ? '<input type="checkbox" name="pick" value="' + target + '"' + (item.checked === true ? ' checked' : '') + '>'
    : ''

  const location = remote !== undefined && typeof remote.path === 'string' && remote.path.length > 0
    ? remote.path
    : (row !== undefined && row.kind === 'bundle' ? item.name + '/SKILL.md' : '')

  const repoTitle = group.local ? '本地·未托管' : group.source
  const repoCell = showRepo
    ? '<td class="mono repo-name' + (repoHref.length > 0 ? ' repo-link' : '') + '">'
      + (repoHref.length > 0 ? '<a href="' + escapeHtml(repoHref) + '">' : '')
      + '<span class="clip" title="' + escapeHtml(repoTitle) + '">' + escapeHtml(repoTitle) + '</span>'
      + (repoHref.length > 0 ? '</a>' : '') + '</td>'
    : ''
  return '<tr>'
    + '<td class="pick">' + checkbox + '</td>'
    + repoCell
    + '<td class="mono skill-name' + (item.kind === 'orphan' ? ' orphan' : '') + '"><span class="clip" title="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) + '</span></td>'
    + '<td class="status"><span class="stack">' + statusBadge + suffixText + '</span></td>'
    + '<td><span class="clip" title="' + escapeHtml(description) + '">' + escapeHtml(description) + '</span></td>'
    + '<td class="mono dim"><span class="clip" title="' + escapeHtml(location) + '">' + escapeHtml(location) + '</span></td>'
    + '<td class="dim nowrap">' + (row !== undefined && row.installedAt.length > 0 ? escapeHtml(row.installedAt.slice(0, 10)) : '') + '</td>'
    + '<td class="actions">' + buttons.join('') + '</td></tr>'
}

/**
 * 仓库条里的一小块：仓库名 + 已装 x/y + 徽章 + 仓库级按钮。
 *
 * 表格本身是**纯平铺**的（每行都写仓库名，不做任何合并），仓库级操作放在这里，
 * 所以不需要 `rowspan`、也不需要分组行——这两样正是之前把界面搞坏的东西。
 * @param {object} group - 分组。
 * @returns {string} 一个 `<span>`。
 */
function renderRepoChip(group) {
  const badges = []
  if (group.checked) {
    if (group.news.length > 0) badges.push('<span class="badge ok">新增 ' + String(group.news.length) + '</span>')
    if (group.updatable.length > 0) badges.push('<span class="badge warn">可更新 ' + String(group.updatable.length) + '</span>')
    if (group.orphans.length > 0) badges.push('<span class="badge err">已移除 ' + String(group.orphans.length) + '</span>')
    if (group.mode === 'cli') badges.push('<span class="badge">降级模式</span>')
  } else if (!group.local) {
    badges.push('<span class="badge">未检查</span>')
  }
  const title = group.local ? '本地·未托管' : group.source
  const count = group.available >= 0
    ? '已装 ' + String(group.installed) + '/' + String(group.available)
    : '已装 ' + String(group.installed)
  const buttons = group.local ? '' : (
    '<button class="ghost" type="submit" name="row" value="check|' + escapeHtml(group.source) + '|">重查</button>'
    + (group.news.length === 0 ? '' : '<button class="primary" type="submit" name="row" value="installAll|' + escapeHtml(group.source) + '|">装全部新增 (' + String(group.news.length) + ')</button>')
    + (group.updatable.length === 0 ? '' : '<button type="submit" name="row" value="updateAll|' + escapeHtml(group.source) + '|">更新全部 (' + String(group.updatable.length) + ')</button>')
  )
  // chip 内部一律 nowrap：仓库名(mono、--ink、600) + 已装 x/y(dim) + 徽章 + 小按钮。
  return '<span class="repo-chip"><span class="mono">' + escapeHtml(title) + '</span>'
    + '<span class="dim">' + escapeHtml(count) + '</span>'
    + badges.join('')
    + (group.error.length > 0 ? '<span class="badge warn">' + escapeHtml(group.error) + '</span>' : '')
    + buttons + '</span>'
}

/**
 * 顶部提示条。
 * @param {string} text - 提示文本；空串时不渲染。
 * @param {boolean} ok - 成功还是失败。
 * @returns {string} HTML。
 */
function renderMessage(text, ok) {
  if (typeof text !== 'string' || text.length === 0) return ''
  return '<div class="msg ' + (ok ? 'ok' : 'err') + '">' + escapeHtml(text) + '</div>'
}

/**
 * 左栏导航：四项 + 计数徽章。窄屏由 CSS 变成顶部横排（不需要 JS）。
 * @param {string} tab - 当前标签（repos / repo / skills / todo / agent）。
 * @param {{ skills: number, pending: number }} counts - 计数。
 * @param {string} pagePath - 页面路径。
 * @returns {string} HTML。
 */
function renderNav(tab, counts, pagePath) {
  // 仓库子页仍算「仓库」这一项。
  const active = tab === 'repo' ? 'repos' : tab
  const item = (id, label, badges) => '<a class="navitem' + (active === id ? ' active' : '') + '" href="'
    + escapeHtml(pagePath) + '?tab=' + id + '">' + escapeHtml(label) + badges + '</a>'
  const skillsBadge = counts.skills > 0 ? '<span class="count">' + String(counts.skills) + '</span>' : ''
  const pendingBadge = counts.pending > 0 ? '<span class="count warn">' + String(counts.pending) + '</span>' : ''
  return '<nav class="nav"><div class="brand">Agents&amp;Skills</div>'
    + item('repos', '仓库', '')
    + item('skills', '所有技能', skillsBadge)
    + item('todo', '待办', pendingBadge)
    + item('agent', 'Agent', '')
    + '<a class="navitem" href="/">← 回到 DSH 界面</a>'
    + '</nav>'
}

/**
 * 页面骨架：head + 左栏 + 内容列。
 * @param {object} view - tab / fill / counts / pagePath / message / content。
 * @returns {string} HTML。
 */
function renderShell(view) {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>Agents&amp;Skills · dsh-agents-skills</title><style>' + STYLE + '</style>'
    // 唯一允许的脚本：外链本站自己 serve 的 pjax 薄层（CSP script-src 'self'），defer 不阻塞渲染。
    + '<script src="' + escapeHtml(view.pagePath) + '?asset=' + PAGE_UI_ASSET + '" defer></script>'
    + '</head><body>'
    + '<div class="wrap"><div class="layout">'
    + renderNav(view.tab, view.counts, view.pagePath)
    + '<main class="content' + (view.fill === true ? ' skills-page' : '') + '">' + view.message + view.content + '</main>'
    + '</div></div></body></html>'
}

/**
 * Agent 页：整份 AGENTS.md 的查看与保存（纯表单，SSR 事实源）。
 * @param {object} view - agent / counts / pagePath / message。
 * @returns {string} HTML。
 */
function renderAgentPage(view) {
  const agent = view.agent
  const status = agent.exists
    ? '已存在 · ' + String(agent.size) + ' 字节 · 上限 ' + String(agent.limitBytes) + ' 字节'
    : '尚未创建 · 保存后自动新建'
  // 页头一行：h1 + 状态 dim + 路径短显示（完整路径放在 title 里，窄屏靠省略号收住）。
  const head = '<div class="pagehead"><h1>Agent</h1>'
    + '<span class="dim">' + escapeHtml(status) + '</span>'
    + '<span class="head-actions mono dim"><span class="clip" title="' + escapeHtml(agent.path) + '">' + escapeHtml(agent.path) + '</span></span>'
    + '</div>'
  const content = head
    + '<form method="post">'
    + '<input type="hidden" name="action" value="saveAgent">'
    + '<input type="hidden" name="back" value="?tab=agent">'
    + '<textarea name="content" spellcheck="false" placeholder="在这里写全局规则，例如：# 全局规则">'
    + escapeHtml(agent.content) + '</textarea>'
    + '<div class="toolbar"><button class="primary" type="submit">保存</button>'
    + '<a class="btn ghost" href="' + escapeHtml(view.pagePath) + '?tab=agent">重新读取</a>'
    + '<span class="hint">切换标签会丢弃未保存的修改，先点保存。</span></div></form>'
    + (agent.size > agent.limitBytes
      ? '<div class="msg err">已超过 ' + String(agent.limitBytes) + ' 字节预算，超出部分可能被丢弃。</div>'
      : '')
    // 四行说明收进原生折叠区（不依赖 JS）。
    + '<details class="fold"><summary>使用说明</summary><div class="fold-body">'
    + '<div>这是「全局层」指令：装了 agent-instructions 的预设（本机是 standard / cordis / ptc）会在每个新会话的第一次请求里把它注入给模型，对所有项目生效。</div>'
    + '<div>保存是整文件替换：覆盖前旧内容会先备份到同目录的 AGENTS.md.bak；保存空内容等于清空规则但文件还在。</div>'
    + '<div>改动不影响当前会话，从下一个新会话开始生效。</div>'
    + '<div>这一页没有实时字数统计、没有 Ctrl+S、也不保护未保存的草稿（本页只加载了一个做局部刷新的小脚本，没有编辑器能力）；要这些就去设置里的 Agents&amp;Skills 面板。</div>'
    + '</div></details>'
  return renderShell({ tab: 'agent', counts: view.counts, pagePath: view.pagePath, message: view.message, content })
}

/**
 * 技能页：按来源仓库分组的列表 + 搜索安装 + 使用说明。
 * @param {object} view - 技能视图数据。
 * @returns {string} HTML。
 */
function renderSkillsPage(view) {
  const groups = view.groups
  const totals = groups.reduce((sum, group) => ({
    news: sum.news + group.news.length,
    updatable: sum.updatable + group.updatable.length,
    orphans: sum.orphans + group.orphans.length,
  }), { news: 0, updatable: 0, orphans: 0 })
  const repoCount = groups.filter((group) => !group.local).length
  const back = view.back
  const todoLink = view.links.todo
  const updateAll = groups.flatMap((group) => group.updatable.map((item) => item.name))
  const visible = view.todoOnly
    ? groups.filter((group) => group.pending > 0).map((group) => ({ ...group, items: group.items.filter((item) => item.kind !== 'installed') }))
    : groups

  const summary = view.delta === null
    ? '未检查'
    : '新增 ' + String(totals.news) + ' · 可更新 ' + String(totals.updatable) + ' · 已移除 ' + String(totals.orphans)

  // 头部最多两行：第一行 = h1「所有技能」+ 统计 dim 行 + 靠右的两个 .btn；第二行只放 notes（非空时）。
  const head = '<div class="pagehead"><h1>所有技能</h1>'
    + '<span class="dim stats">' + escapeHtml(String(view.skills.length) + ' 个技能 · ' + String(repoCount) + ' 个来源仓库 · ' + summary
      + (view.checkedAt.length > 0 ? ' · 上次检查 ' + view.checkedAt : '')) + '</span>'
    + '<span class="head-actions">'
    + '<a class="btn" href="' + escapeHtml(view.links.check) + '">检查更新</a>'
    + '<a class="btn" href="' + escapeHtml(todoLink) + '">' + (view.todoOnly ? '显示全部' : '仅显示待办') + '</a>'
    + '</span></div>'

  const notes = view.notes.length === 0 ? '' : '<div class="dim notes">' + view.notes.map((text) => '· ' + escapeHtml(text)).join('<br>') + '</div>'

  const columns = '<colgroup><col style="width:34px"><col style="width:140px"><col style="width:170px"><col style="width:96px">'
    + '<col><col style="width:170px"><col style="width:88px"><col style="width:120px"></colgroup>'
  const thead = '<thead><tr><th class="pick"></th><th>仓库</th><th>技能</th><th>状态</th><th>说明</th>'
    + '<th>来源路径</th><th>装于</th><th class="actions">操作</th></tr></thead>'
  // 空表也要 8 个 <td>：表体里一律不许出现 colspan / rowspan（硬约束）。
  const empty = '<tr><td class="pick"></td><td class="dim"></td><td class="dim"></td><td class="dim"></td>'
    + '<td class="dim">' + escapeHtml(view.todoOnly
      ? (view.delta === null ? '还没检查过，先点「检查更新」。' : '没有待办：所有来源仓库的技能都已装上且是最新的。')
      : (view.skills.length === 0 ? '这里还没有技能。可以用下面的「搜索安装」。' : '没有可显示的技能。')) + '</td>'
    + '<td class="dim"></td><td class="dim"></td><td class="actions"></td></tr>'
  // 纯平铺：没有 rowspan、没有分组行，每个仓库的技能各占一行、每行都写仓库名。
  // 行数按「可见分组里的技能行总数」算：订阅仓可能一个技能都没装（items 为空），
  // 那种情况下表体不能是空的，得照样给出「空表」那一行。
  const rowCount = visible.reduce((sum, group) => sum + group.items.length, 0)
  const rows = rowCount === 0
    ? empty
    : visible.map((group) => group.items
      .map((item) => {
        // 「选中全部待办」：勾选状态由 URL 决定（无 JS 也能全选），提交时浏览器按真实勾选发送。
        const row = view.pickAll === true && item.kind !== 'installed' ? { ...item, checked: true } : item
        return renderItem(group, row, back)
      })
      .join('')).join('')
  // 整张表包在**一个**表单里：勾选 + 批量条 + 行内单操作共用同一次提交。
  // 批量条与仓库条都是 flex 子项、flex:0 0 auto，不许被压扁（历史上批量条被压到 20px，按钮溢出压住表头）。
  const repostrip = visible.length === 0 ? '' : '<div class="repostrip">' + visible.map(renderRepoChip).join('') + '</div>'
  const body = '<form class="skills-form" method="post"><input type="hidden" name="back" value="' + escapeHtml(back) + '">'
    + repostrip
    + '<div class="batchbar">'
    + '<span class="dim">勾选行后：</span>'
    + '<button class="primary" type="submit" name="batch" value="install">安装选中</button>'
    + '<button type="submit" name="batch" value="update">更新选中</button>'
    + '<button type="submit" name="batch" value="remove">删除选中</button>'
    + '<a class="btn" href="' + escapeHtml(view.links.pickAll) + '">' + (view.pickAll ? '取消全选' : '选中全部待办') + '</a>'
    + (updateAll.length === 0 ? '' : '<button type="submit" name="batch" value="updateAll">更新全部 (' + String(updateAll.length) + ')</button>')
    + '</div>'
    + '<div class="table-scroll"><table class="skills">' + columns + thead + '<tbody>' + rows + '</tbody></table></div></form>'

  // 表格下方两个原生折叠区（不依赖 JS）：搜索安装 + 使用说明。有搜索结果时搜索区默认展开。
  const search = '<details class="fold"' + (view.results === null ? '' : ' open') + '>'
    + '<summary>搜索安装</summary>'
    + '<form class="toolbar" method="get" action="' + escapeHtml(view.pagePath) + '">'
    + '<input type="hidden" name="tab" value="skills">'
    + '<input type="text" name="q" value="' + escapeHtml(view.query) + '" placeholder="关键词，例如 react / review / changelog">'
    + '<button class="primary" type="submit">搜索</button></form>'
    + (view.results === null
      ? '<div class="dim">走 npx skills find，安装时用 -a universal，只落到用户级技能目录。</div>'
      : '<div class="dim">' + escapeHtml(view.results.note) + '</div>'
        + '<div class="search-scroll"><table class="search"><thead><tr><th>仓库@技能</th><th>安装量</th><th>链接</th><th></th></tr></thead><tbody>'
        + view.results.results.map((item) => '<tr><td class="mono">' + escapeHtml(item.repo + '@' + item.skill) + '</td>'
          + '<td><span class="badge">' + escapeHtml(item.installs) + '</span></td>'
          + '<td class="dim">' + (item.url.length > 0 ? '<a href="' + escapeHtml(item.url) + '" rel="noreferrer noopener" target="_blank">' + escapeHtml(item.url) + '</a>' : '') + '</td>'
          + '<td class="actions"><form method="post"><input type="hidden" name="action" value="install">'
          + '<input type="hidden" name="source" value="' + escapeHtml(item.repo) + '">'
          + '<input type="hidden" name="skills" value="' + escapeHtml(item.skill) + '">'
          + '<input type="hidden" name="back" value="' + escapeHtml(back) + '">'
          + '<button class="primary" type="submit">安装</button></form></td></tr>').join('')
        + '</tbody></table></div>')
    + '</details>'

  // 安装根路径与「每行都写仓库名」提示从头部挪到这里；再加原有四行说明。
  const guide = '<details class="fold"><summary>使用说明</summary><div class="fold-body">'
    + '<div class="mono">技能根目录：' + escapeHtml(view.root) + '</div>'
    + '<div>每行都写仓库名；仓库级按钮在上面的仓库条里。</div>'
    + '<div>技能就是带 frontmatter 的 Markdown：' + escapeHtml(view.root) + '/&lt;名字&gt;/SKILL.md 或平铺 &lt;名字&gt;.md，DSH 只扫这一层，改动由它自带的文件监听热生效——装完不用重启。</div>'
    + '<div>「新增」= 仓库里有、本地没装；「可更新」= 技能目录的 sha 与 npx skills 记的指纹不一致；「上游已移除」= 你装了但仓库里已经没有了（只提示，不自动删）。</div>'
    + '<div>装 / 删 / 更新 / 搜索都由 npx skills（skills.sh 生态）执行：安装加 -a universal，只写用户级目录；删除不加 -a，让 CLI 顺手清掉可能存在的软链。</div>'
    + '<div>这个页面与聊天界面共用同一道登录校验（DSH 的浏览器 cookie），没有登录过只能看到 401；页面脚本仅限本站自身的一个文件（client/page-ui.js，只做局部刷新），内联脚本仍被 CSP 禁止。</div>'
    + '</div></details>'

  return renderShell({
    tab: 'skills',
    fill: true,
    counts: view.counts,
    pagePath: view.pagePath,
    message: view.message,
    content: head + notes + body + search + guide,
  })
}

/**
 * 把检查时间说成人话（「3 分钟前」）。
 * @param {string} iso - ISO 时间。
 * @param {number} nowMs - 当前时间（毫秒）。
 * @returns {string} 人话；解析失败时为空串。
 */
function formatAgo(iso, nowMs) {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const minutes = Math.max(0, Math.round((nowMs - at) / 60000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return String(minutes) + ' 分钟前'
  const hours = Math.round(minutes / 60)
  if (hours < 24) return String(hours) + ' 小时前'
  return String(Math.round(hours / 24)) + ' 天前'
}

/**
 * 仓库列表「状态」格：无事 → dim 文案，有事 → 每行最多三个徽章。
 * @param {object} group - 分组。
 * @returns {string} HTML。
 */
function repoStatusOf(group) {
  if (group.error.length > 0 || group.mode === 'failed') {
    const reason = group.error.length > 0 ? group.error : '检查失败'
    return '<span class="badge err" title="' + escapeHtml(reason) + '">检查失败</span>'
  }
  if (!group.checked) {
    return group.origin === 'subscribed'
      ? '<span class="dim">订阅·未检查</span>'
      : '<span class="dim">未检查</span>'
  }
  const badges = []
  if (group.news.length > 0) badges.push('<span class="badge ok">新增 ' + String(group.news.length) + '</span>')
  if (group.updatable.length > 0) badges.push('<span class="badge warn">可更新 ' + String(group.updatable.length) + '</span>')
  if (group.orphans.length > 0) badges.push('<span class="badge err">已移除 ' + String(group.orphans.length) + '</span>')
  return badges.length === 0 ? '<span class="dim">已装上最新</span>' : badges.join('')
}

/**
 * 「来源」格文案：订阅仓库 / 派生仓库 / 本地·未托管。
 * @param {object} group - 分组。
 * @returns {string} 文案。
 */
function repoOriginLabel(group) {
  if (group.local || group.origin === 'local') return '本地'
  return group.origin === 'subscribed' ? '订阅' : '已装'
}

/**
 * 仓库级三个按钮：检查 / 装全部新增 / 更新全部（本地行没有）。
 * @param {object} group - 分组。
 * @returns {string} HTML。
 */
function repoButtons(group) {
  if (group.local) return ''
  const source = escapeHtml(group.source)
  const buttons = ['<button class="ghost" type="submit" name="row" value="check|' + source + '|">检查</button>']
  if (group.news.length > 0) {
    buttons.push('<button class="primary" type="submit" name="row" value="installAll|' + source + '|">装全部新增 (' + String(group.news.length) + ')</button>')
  }
  if (group.updatable.length > 0) {
    buttons.push('<button type="submit" name="row" value="updateAll|' + source + '|">更新全部 (' + String(group.updatable.length) + ')</button>')
  }
  return buttons.join('')
}

/**
 * 仓库的子页地址。
 * @param {string} pagePath - 页面路径。
 * @param {object} group - 分组。
 * @returns {string} 相对 URL。
 */
function repoHrefOf(pagePath, group) {
  const key = group.local ? '__local__' : group.key
  return pagePath + '?tab=repo&repo=' + encodeURIComponent(key)
}

/**
 * 「待办」里的「已装」读数：查过用 x/y，没查过只有已装数。
 * @param {object} group - 分组。
 * @returns {string} 文本。
 */
function installedTextOf(group) {
  return group.available >= 0 ? String(group.installed) + '/' + String(group.available) : String(group.installed)
}

/**
 * 批量条（勾选 + 三个批量动作 + 选中全部待办）；技能页 / 仓库子页 / 待办页共用。
 * @param {object} view - pickAll / links。
 * @returns {string} HTML。
 */
function renderBatchBar(view) {
  return '<div class="batchbar">'
    + '<span class="dim">勾选行后：</span>'
    + '<button class="primary" type="submit" name="batch" value="install">安装选中</button>'
    + '<button type="submit" name="batch" value="update">更新选中</button>'
    + '<button type="submit" name="batch" value="remove">删除选中</button>'
    + '<a class="btn" href="' + escapeHtml(view.links.pickAll) + '">' + (view.pickAll ? '取消全选' : '选中全部待办') + '</a>'
    + '</div>'
}

/**
 * 视图 1：仓库列表（默认页）。一行一个仓库，行内就是仓库级动作。
 * @param {object} view - groups / links / back / pagePath / checkedAgo / counts / message。
 * @returns {string} HTML。
 */
function renderRepoListPage(view) {
  // 排序：待办多的在前，平了按仓库名；本地恒在最底（groupSkills 已保证，这里再定一次）。
  const groups = view.groups.slice().sort((left, right) => {
    if (left.local !== right.local) return left.local ? 1 : -1
    if (right.pending !== left.pending) return right.pending - left.pending
    return left.source < right.source ? -1 : left.source > right.source ? 1 : 0
  })
  const subscribed = groups.filter((group) => group.origin === 'subscribed').length
  const todoTotal = groups.reduce((sum, group) => sum + group.pending, 0)
  const stats = String(groups.length) + ' 个仓库 · ' + String(subscribed) + ' 个订阅 · 待办 ' + String(todoTotal)
    + (view.checkedAgo.length > 0 ? ' · 上次检查 ' + view.checkedAgo : '')
  const head = '<div class="pagehead"><h1>仓库</h1>'
    + '<span class="dim stats">' + escapeHtml(stats) + '</span>'
    + '<span class="head-actions"><a class="btn" href="' + escapeHtml(view.links.check) + '">检查更新</a></span></div>'
  const addForm = '<form class="toolbar" method="post">'
    + '<input type="hidden" name="action" value="subscribe">'
    + '<input type="hidden" name="back" value="' + escapeHtml(view.back) + '">'
    + '<input type="text" name="source" placeholder="owner/repo，例如 anthropics/skills">'
    + '<button class="primary" type="submit">添加</button></form>'

  if (groups.length === 0) {
    const guide = '<div class="empty dim">还没有仓库。在上面输入 owner/repo 添加一个，或去'
      + '<a href="' + escapeHtml(view.pagePath) + '?tab=skills">「所有技能」</a>里搜索安装。</div>'
    return renderShell({
      tab: 'repos',
      fill: true,
      counts: view.counts,
      pagePath: view.pagePath,
      message: view.message,
      content: head + addForm + guide,
    })
  }

  const columns = '<colgroup><col><col style="width:80px"><col><col style="width:70px"><col style="width:230px"></colgroup>'
  const thead = '<thead><tr><th>仓库</th><th>已装</th><th>状态</th><th>来源</th><th class="actions">操作</th></tr></thead>'
  const rows = groups.map((group) => {
    const title = group.local ? '本地·未托管' : group.source
    return '<tr>'
      + '<td class="mono repo-name repo-link"><a href="' + escapeHtml(repoHrefOf(view.pagePath, group)) + '">'
      + '<span class="clip" title="' + escapeHtml(title) + '">' + escapeHtml(title) + '</span></a></td>'
      + '<td class="mono">' + escapeHtml(installedTextOf(group)) + '</td>'
      + '<td class="status"><span class="stack">' + repoStatusOf(group) + '</span></td>'
      + '<td class="dim">' + escapeHtml(repoOriginLabel(group)) + '</td>'
      + '<td class="actions">' + repoButtons(group) + '</td></tr>'
  }).join('')
  const body = '<form class="skills-form" method="post"><input type="hidden" name="back" value="' + escapeHtml(view.back) + '">'
    + '<div class="table-scroll"><table class="skills">' + columns + thead + '<tbody>' + rows + '</tbody></table></div></form>'

  return renderShell({
    tab: 'repos',
    fill: true,
    counts: view.counts,
    pagePath: view.pagePath,
    message: view.message,
    content: head + addForm + body,
  })
}

/**
 * 视图 2：仓库子页。技能表去掉「仓库」列，其余行渲染 / 批量协议与技能页同一套。
 * @param {object} view - group / groups / links / back / pagePath / pickAll / counts / message。
 * @returns {string} HTML。
 */
function renderRepoPage(view) {
  const group = view.group
  const pagePath = view.pagePath
  const crumbs = '<div class="crumbs"><a href="' + escapeHtml(pagePath) + '?tab=repos">← 仓库</a></div>'

  if (group === undefined) {
    return renderShell({
      tab: 'repo',
      fill: true,
      counts: view.counts,
      pagePath,
      message: view.message,
      content: crumbs + '<div class="msg err">没有找到这个仓库。</div>',
    })
  }

  const title = group.local ? '本地·未托管' : group.source
  let stats = '已装 ' + installedTextOf(group)
  if (group.local) {
    // 本地未托管：没有远端可对比，统计只说已装数。
  } else if (!group.checked) {
    stats += ' · 未检查'
  } else {
    stats += ' · 新增 ' + String(group.news.length) + ' · 可更新 ' + String(group.updatable.length) + ' · 已移除 ' + String(group.orphans.length)
  }
  const head = '<div class="pagehead"><h1 class="mono">' + escapeHtml(title) + '</h1>'
    + '<span class="dim stats">' + escapeHtml(stats) + '</span>'
    + '<span class="head-actions">' + repoButtons(group) + '</span></div>'

  const columns = '<colgroup><col style="width:34px"><col style="width:170px"><col style="width:96px">'
    + '<col><col style="width:170px"><col style="width:88px"><col style="width:120px"></colgroup>'
  const thead = '<thead><tr><th class="pick"></th><th>技能</th><th>状态</th><th>说明</th>'
    + '<th>来源路径</th><th>装于</th><th class="actions">操作</th></tr></thead>'
  const emptyRow = (description) => '<tr><td class="pick"></td><td class="dim"></td><td class="dim"></td>'
    + '<td class="dim">' + escapeHtml(description) + '</td><td class="dim"></td><td class="dim"></td><td class="actions"></td></tr>'

  const itemRows = group.items.map((item) => {
    const row = view.pickAll === true && item.kind !== 'installed' ? { ...item, checked: true } : item
    return renderItem(group, row, view.back, { showRepo: false })
  }).join('')
  let rows = ''
  if (!group.checked && !group.local) {
    // 订阅但还没查过：表格位置先给一行提示，已装的行使照常显示（不藏用户的技能）。
    rows = emptyRow('尚未检查，点右上角[检查]看看有什么可装。') + itemRows
  } else if (itemRows.length === 0) {
    rows = emptyRow('这个仓库还没有技能。')
  } else {
    rows = itemRows
  }

  const body = '<form class="skills-form" method="post"><input type="hidden" name="back" value="' + escapeHtml(view.back) + '">'
    + crumbs + head + renderBatchBar(view)
    + '<div class="table-scroll"><table class="skills">' + columns + thead + '<tbody>' + rows + '</tbody></table></div></form>'

  return renderShell({
    tab: 'repo',
    fill: true,
    counts: view.counts,
    pagePath,
    message: view.message,
    content: body,
  })
}

/**
 * 视图 3：待办。跨仓聚合所有 kind !== 'installed' 的行，按仓库组序。
 * @param {object} view - groups / links / back / pagePath / pickAll / delta / counts / message。
 * @returns {string} HTML。
 */
function renderTodoPage(view) {
  const groups = view.groups
  const totals = groups.reduce((sum, group) => ({
    news: sum.news + group.news.length,
    updatable: sum.updatable + group.updatable.length,
    orphans: sum.orphans + group.orphans.length,
  }), { news: 0, updatable: 0, orphans: 0 })
  const pending = totals.news + totals.updatable + totals.orphans
  const head = '<div class="pagehead"><h1>待办</h1>'
    + '<span class="dim stats">新增 ' + String(totals.news) + ' · 可更新 ' + String(totals.updatable) + ' · 已移除 ' + String(totals.orphans) + '</span>'
    + '<span class="head-actions">'
    + (totals.updatable === 0 ? '' : '<button type="submit" name="batch" value="updateAll">更新全部 (' + String(totals.updatable) + ')</button>')
    + '</span></div>'

  const columns = '<colgroup><col style="width:34px"><col style="width:140px"><col style="width:170px"><col style="width:96px">'
    + '<col><col style="width:170px"><col style="width:88px"><col style="width:120px"></colgroup>'
  const thead = '<thead><tr><th class="pick"></th><th>仓库</th><th>技能</th><th>状态</th><th>说明</th>'
    + '<th>来源路径</th><th>装于</th><th class="actions">操作</th></tr></thead>'

  let rows = ''
  if (pending === 0) {
    const description = view.delta === null
      ? '还没检查过，先点'
      : '没有待办：所有盯着的仓库都已装上且最新。'
    const link = view.delta === null ? '<a class="btn" href="' + escapeHtml(view.links.check) + '">检查更新</a>' : ''
    rows = '<tr><td class="pick"></td><td class="dim"></td><td class="dim"></td><td class="dim"></td>'
      + '<td class="dim">' + escapeHtml(description) + link + (view.delta === null ? '。' : '') + '</td>'
      + '<td class="dim"></td><td class="dim"></td><td class="actions"></td></tr>'
  } else {
    for (const group of groups) {
      for (const item of group.items) {
        if (item.kind === 'installed') continue
        const row = view.pickAll === true ? { ...item, checked: true } : item
        rows += renderItem(group, row, view.back, { showRepo: true, repoHref: repoHrefOf(view.pagePath, group) })
      }
    }
  }

  const body = '<form class="skills-form" method="post"><input type="hidden" name="back" value="' + escapeHtml(view.back) + '">'
    + head + renderBatchBar(view)
    + '<div class="table-scroll"><table class="skills">' + columns + thead + '<tbody>' + rows + '</tbody></table></div></form>'

  return renderShell({
    tab: 'todo',
    fill: true,
    counts: view.counts,
    pagePath: view.pagePath,
    message: view.message,
    content: body,
  })
}

/** 可路由的标签：仓库列表（默认）/ 仓库子页 / 所有技能 / 待办 / Agent。 */
const TAB_IDS = ['repos', 'repo', 'skills', 'todo', 'agent']
/** 能记进 cookie 的顶层标签；仓库子页不进 cookie（它需要 repo 参数才成立）。 */
const COOKIE_TABS = ['repos', 'skills', 'todo', 'agent']

/**
 * 造独立页的请求处理器。
 * @param {object} deps - 依赖（生产环境接真实实现，测试传替身）。
 * @param {(req: object) => (401 | 403 | undefined)} deps.guard - 门禁：与聊天界面同一道。
 * @param {() => Promise<object>} deps.overview - 首屏数据。
 * @param {(request: object) => Promise<object>} deps.check - 检查来源仓库。
 * @param {(request: object) => Promise<object>} deps.search - 搜索。
 * @param {(request: object) => Promise<object>} deps.action - 装 / 删 / 更新。
 * @param {(source: string) => Promise<{ ok: boolean, summary: string, error: string }>} [deps.subscribe] - 订阅一个来源仓库；缺省时 `action=subscribe` 退化为「没有要执行的动作」。
 * @param {() => Promise<string[]>} [deps.subscriptions] - 订阅仓库清单；缺省时从 overview 的合并结果里认（纯订阅仓 installed=0、names 为空）。
 * @param {() => Promise<object>} deps.agentRead - 读全局 Agent 提示词文件。
 * @param {(content: unknown) => Promise<object>} deps.agentWrite - 写全局 Agent 提示词文件。
 * @param {string} [deps.pagePath] - 页面路径。
 * @param {() => number} [deps.now] - 时钟（测试用）。
 * @returns {(req: object, res: object) => Promise<void>} 处理器。
 */
export function createPageHandler(deps) {
  const pagePath = typeof deps.pagePath === 'string' && deps.pagePath.length > 0 ? deps.pagePath : DEFAULT_PAGE_PATH
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  let cachedDelta = null
  let cachedAt = 0

  /**
   * 取检查结果：默认走缓存（两分钟），`force` 时重新查。
   * @param {boolean} force - 是否强制重查。
   * @returns {Promise<object | null>} 检查结果。
   */
  const deltaOf = async (force) => {
    if (!force && cachedDelta !== null && now() - cachedAt < CHECK_CACHE_MS) return cachedDelta
    const value = await deps.check({ sources: [] })
    cachedDelta = value
    cachedAt = now()
    return value
  }

  /**
   * 动作成功后把缓存里对应的条目摘掉（和设置页同一套规则），页面才不会自相矛盾。
   * @param {string} kind - 动作。
   * @param {string} source - install 的仓库。
   * @param {string[]} names - 受影响的技能名。
   */
  const prune = (kind, source, names) => {
    if (cachedDelta === null || names.length === 0) return
    const set = new Set(names)
    cachedDelta = {
      ...cachedDelta,
      repos: cachedDelta.repos.map((repo) => {
        if (kind === 'install') {
          if (repo.source !== source) return repo
          return { ...repo, newSkills: repo.newSkills.filter((item) => !set.has(item.name)) }
        }
        if (kind === 'update') return { ...repo, updatable: repo.updatable.filter((item) => !set.has(item.name)) }
        return {
          ...repo,
          updatable: repo.updatable.filter((item) => !set.has(item.name)),
          orphan: repo.orphan.filter((item) => !set.has(item.name)),
        }
      }),
    }
  }

  /**
   * 批量安装：**按仓库分组**，一个仓库只跑一次 CLI（多个 -s），否则 19 个技能要克隆 19 次。
   * @param {{ source: string, name: string }[]} entries - 选中项。
   * @returns {Promise<{ ok: boolean, text: string }>} 汇总。
   */
  const installMany = async (entries) => {
    const bySource = new Map()
    for (const entry of entries) {
      if (entry.source.length === 0 || entry.name.length === 0) continue
      const bucket = bySource.get(entry.source) ?? []
      bucket.push(entry.name)
      bySource.set(entry.source, bucket)
    }
    if (bySource.size === 0) return { ok: false, text: '没有选中可安装的技能' }
    let done = 0
    const failed = []
    for (const [source, names] of bySource) {
      const result = await deps.action({ kind: 'install', source, name: '', skills: names })
      if (result.ok) {
        done += names.length
        prune('install', source, names)
      } else {
        failed.push(source + '：' + (result.error.length > 0 ? result.error : (result.summary.length > 0 ? result.summary : '失败')))
      }
    }
    return {
      ok: failed.length === 0,
      text: '安装 ' + String(done) + ' 个' + (failed.length > 0 ? '；' + String(failed.length) + ' 个仓库失败（' + failed.join('；') + '）' : ''),
    }
  }

  /**
   * 批量更新：一次 CLI 调用带上全部名字。
   * @param {string[]} names - 技能名。
   * @returns {Promise<{ ok: boolean, text: string }>} 汇总。
   */
  const updateMany = async (names) => {
    if (names.length === 0) return { ok: false, text: '没有选中可更新的技能' }
    const result = await deps.action({ kind: 'update', source: '', name: '', skills: names })
    if (result.ok) prune('update', '', names)
    return {
      ok: result.ok,
      text: '更新 ' + String(names.length) + ' 个：' + (result.summary.length > 0 ? result.summary : (result.ok ? '完成' : '失败'))
        + (result.error.length > 0 ? '（' + result.error + '）' : ''),
    }
  }

  /**
   * 批量删除：CLI 的 remove 一次只吃一个名字，所以逐个跑（纯本地操作，很快）。
   * @param {string[]} names - 技能名。
   * @returns {Promise<{ ok: boolean, text: string }>} 汇总。
   */
  const removeMany = async (names) => {
    if (names.length === 0) return { ok: false, text: '没有选中可删除的技能' }
    let done = 0
    const failed = []
    for (const name of names) {
      const result = await deps.action({ kind: 'remove', source: '', name, skills: [] })
      if (result.ok) {
        done += 1
        prune('remove', '', [name])
      } else {
        failed.push(name)
      }
    }
    return {
      ok: failed.length === 0,
      text: '删除 ' + String(done) + ' 个' + (failed.length > 0 ? '；失败 ' + String(failed.length) + ' 个（' + failed.join('、') + '）' : ''),
    }
  }

  /**
   * 单个仓库重查：结果并进缓存，其余仓库不动。
   * @param {string} source - 仓库。
   * @returns {Promise<{ ok: boolean, text: string }>} 汇总。
   */
  const recheck = async (source) => {
    const value = await deps.check({ sources: [source] })
    if (cachedDelta === null) {
      cachedDelta = value
    } else {
      const merged = cachedDelta.repos
        .filter((repo) => !value.repos.some((item) => item.source === repo.source))
        .concat(value.repos)
      cachedDelta = { ...cachedDelta, ...value, repos: merged }
    }
    cachedAt = now()
    return { ok: true, text: '已重查 ' + source }
  }

  /**
   * 从缓存里取某个仓库（或全部仓库）的待办名单。
   * @param {string} source - 仓库；空串表示全部。
   * @param {'new' | 'update'} kind - 要新增还是要更新。
   * @returns {{ source: string, name: string }[] | null} 名单；没检查过时返回 null。
   */
  const pendingFromCache = (source, kind) => {
    if (cachedDelta === null) return null
    const repos = source.length === 0 ? cachedDelta.repos : cachedDelta.repos.filter((repo) => repo.source === source)
    const entries = []
    for (const repo of repos) {
      const list = kind === 'new' ? repo.newSkills : repo.updatable
      for (const item of list) entries.push({ source: repo.source, name: item.name })
    }
    return entries
  }

  return async function handle(req, res) {
    const rejection = deps.guard(req)
    if (rejection !== undefined) {
      res.writeHead(rejection, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
      res.end(rejection === 401 ? '未登录：请先在 DSH 界面完成登录（reopen the URL printed by dsh web）\n' : '禁止访问\n')
      return
    }

    const url = new URL(typeof req.url === 'string' ? req.url : pagePath, 'http://dsh.invalid')

    // 交互层资产：`GET <pagePath>?asset=page-ui.js`。门禁已经过了（和页面同一道），
    // 这里只 serve 自己包里那一个文件；读不到就给 404，别的资产名一律 404（不回落到渲染页面）。
    if (url.searchParams.has('asset')) {
      const source = url.searchParams.get('asset') === PAGE_UI_ASSET ? pageUiSource() : null
      if (source === null) {
        res.writeHead(404, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found\n')
        return
      }
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        // 不缓存：插件升级后浏览器必须拿到新的交互层，别和页面版本错位。
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      })
      res.end(source)
      return
    }

    if (req.method === 'POST') {
      const body = await readBody(req)
      if (!body.ok) {
        res.writeHead(413, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
        res.end(body.error + '\n')
        return
      }
      const form = parseForm(body.text)
      const back = safeBack(form.get('back'), pagePath)
      const action = form.get('action')
      const rowValue = form.get('row')
      const batchValue = form.get('batch')
      const picks = form.all('pick').map((value) => {
        const [source, name] = value.split('|')
        return { source: source ?? '', name: name ?? '' }
      })
      let message = ''
      let ok = false
      try {
        if (action === 'saveAgent') {
          // 与设置页同一个写入口（整文件替换 + 覆盖前备份），只是入口从 Remote 换成表单。
          const result = await deps.agentWrite(form.get('content'))
          ok = result.ok
          message = result.ok
            ? '已保存 · ' + String(result.bytes) + ' 字节' + (result.backup.length > 0 ? ' · 旧内容已备份到 ' + result.backup : '')
            : '保存失败：' + result.error
        } else if (action === 'subscribe' && typeof deps.subscribe === 'function') {
          // 订阅仓库：只把仓库登记进本地清单（没有退订），顺带的一次检查由依赖自己做。
          const result = await deps.subscribe(form.get('source'))
          ok = result !== null && typeof result === 'object' && result.ok === true
          const summary = result !== null && typeof result === 'object' && typeof result.summary === 'string' ? result.summary : ''
          const reason = result !== null && typeof result === 'object' && typeof result.error === 'string' ? result.error : ''
          message = ok
            ? (summary.length > 0 ? summary : '已订阅')
            : '订阅失败：' + (reason.length > 0 ? reason : (summary.length > 0 ? summary : '未知错误'))
        } else if (rowValue.length > 0) {
          // 行内单操作 / 仓库格按钮：`<动作>|<仓库>|<技能名>`
          const [kind, source, name] = rowValue.split('|')
          if (kind === 'check') {
            const result = await recheck(source ?? '')
            ok = result.ok
            message = result.text
          } else if (kind === 'installAll') {
            const entries = pendingFromCache(source ?? '', 'new')
            if (entries === null) {
              message = '还没检查过：先点「检查更新」'
            } else {
              const result = await installMany(entries)
              ok = result.ok
              message = result.text
            }
          } else if (kind === 'updateAll') {
            const entries = pendingFromCache(source ?? '', 'update')
            if (entries === null) {
              message = '还没检查过：先点「检查更新」'
            } else {
              const result = await updateMany(entries.map((entry) => entry.name))
              ok = result.ok
              message = result.text
            }
          } else if (kind === 'install') {
            const result = await installMany([{ source: source ?? '', name: name ?? '' }])
            ok = result.ok
            message = result.text
          } else if (kind === 'update') {
            const result = await updateMany([name ?? ''])
            ok = result.ok
            message = result.text
          } else if (kind === 'remove') {
            const result = await removeMany([name ?? ''])
            ok = result.ok
            message = result.text
          } else {
            message = '不支持的动作'
          }
        } else if (batchValue.length > 0) {
          // 表头批量：作用在勾选的行上
          if (batchValue === 'install') {
            const result = await installMany(picks)
            ok = result.ok
            message = result.text
          } else if (batchValue === 'update') {
            const result = await updateMany(picks.map((pick) => pick.name))
            ok = result.ok
            message = result.text
          } else if (batchValue === 'remove') {
            const result = await removeMany(picks.map((pick) => pick.name))
            ok = result.ok
            message = result.text
          } else if (batchValue === 'updateAll' || batchValue === 'installAll') {
            const entries = pendingFromCache('', batchValue === 'installAll' ? 'new' : 'update')
            if (entries === null) {
              message = '还没检查过：先点「检查更新」'
            } else {
              const result = batchValue === 'installAll' ? await installMany(entries) : await updateMany(entries.map((entry) => entry.name))
              ok = result.ok
              message = result.text
            }
          } else {
            message = '不支持的批量动作'
          }
        } else {
          message = '没有要执行的动作'
        }
        if (!ok && typeof message === 'string' && !message.includes('失败') && !message.includes('没选中') && !message.includes('还没检查')) message = '失败：' + message
      } catch (error) {
        message = '失败：' + (error === null || error === undefined ? '未知错误' : (error.message ?? String(error)))
      }
      const separator = back.includes('?') ? '&' : '?'
      res.writeHead(303, {
        location: back + separator + 'msg=' + encodeURIComponent(String(message).slice(0, 300)) + (ok ? '&ok=1' : ''),
        'cache-control': 'no-store',
      })
      res.end()
      return
    }

    const query = url.searchParams.get('q') ?? ''
    const checkFlag = url.searchParams.get('check') ?? ''
    const todoOnly = url.searchParams.get('todo') === '1'
    const pickAll = url.searchParams.get('pickall') === '1'
    const message = url.searchParams.get('msg') ?? ''
    const messageOk = url.searchParams.get('ok') === '1'
    // 标签：显式参数优先，其次记住的 cookie，最后默认仓库列表。
    const tabParam = url.searchParams.get('tab') ?? ''
    const repoKey = url.searchParams.get('repo') ?? ''
    const cookieTab = readCookie(req.headers === undefined ? undefined : req.headers.cookie, TAB_COOKIE)
    const tab = TAB_IDS.includes(tabParam)
      ? tabParam
      : (COOKIE_TABS.includes(cookieTab) ? cookieTab : 'repos')
    // 当前视图参数 → 回跳串与开关链接。用 URLSearchParams 统一生成，
    // 免得出现 `?check=1&check=2` 这种重复参数（那会让"检查更新"点了没反应）。
    const params = new URLSearchParams()
    params.set('tab', tab)
    if (tab === 'repo' && repoKey.length > 0) params.set('repo', repoKey)
    if (tab === 'skills') {
      if (query.length > 0) params.set('q', query)
      if (checkFlag === '1' || checkFlag === '2') params.set('check', '1')
      if (todoOnly) params.set('todo', '1')
      if (pickAll) params.set('pickall', '1')
    } else if (tab === 'repos' && (checkFlag === '1' || checkFlag === '2')) {
      params.set('check', '1')
    }
    const back = '?' + params.toString()
    const linkWith = (key, value) => {
      const next = new URLSearchParams(params)
      if (value === null) next.delete(key)
      else next.set(key, value)
      const text = next.toString()
      return pagePath + (text.length === 0 ? '' : '?' + text)
    }
    const links = {
      check: linkWith('check', '2'),
      todo: todoOnly ? linkWith('todo', null) : linkWith('todo', '1'),
      pickAll: pickAll ? linkWith('pickall', null) : linkWith('pickall', '1'),
    }

    // 检查结果：显式 ?check 才重查（点一次发一轮 GitHub 请求）；否则复用同一处理器里已有的缓存，
    // 这样从仓库页切到待办页不会把刚查到的结果丢掉。
    let delta = null
    if (checkFlag === '1' || checkFlag === '2') delta = await deltaOf(checkFlag === '2')
    else if (cachedDelta !== null) delta = cachedDelta
    const checkedAt = delta === null || typeof delta.checkedAt !== 'string' ? '' : delta.checkedAt.slice(11, 19)
    const checkedAgo = cachedDelta === null || typeof cachedDelta.checkedAt !== 'string'
      ? ''
      : formatAgo(cachedDelta.checkedAt, now())
    const overview = await deps.overview()
    // 左栏计数：技能数永远可算（纯本地）；待办数只在已有检查缓存时显示，
    // 免得"打开 Agent 页"这种只读动作偷偷发 5 个 GitHub 请求。
    const counts = {
      skills: Array.isArray(overview.skills) ? overview.skills.length : 0,
      pending: cachedDelta === null || !Array.isArray(cachedDelta.repos)
        ? 0
        : cachedDelta.repos.reduce((sum, repo) => sum + repo.newSkills.length + repo.updatable.length + repo.orphan.length, 0),
    }
    const messageHtml = renderMessage(message, messageOk)

    let html = ''
    if (tab === 'agent') {
      html = renderAgentPage({
        agent: await deps.agentRead(),
        counts,
        pagePath,
        message: messageHtml,
      })
    } else {
      let results = null
      if (tab === 'skills' && query.length > 0) results = await deps.search({ query })
      // 订阅仓库清单：优先问依赖（生产环境直接读清单文件），缺省时从 overview 的合并结果里认——
      // 纯订阅仓的特征是 installed=0、names 空，而派生组至少有一个已装技能。
      let subscriptions = []
      if (typeof deps.subscriptions === 'function') {
        try {
          const value = await deps.subscriptions()
          subscriptions = Array.isArray(value) ? value : []
        } catch { subscriptions = [] }
      } else if (Array.isArray(overview.repos)) {
        subscriptions = overview.repos
          .filter((repo) => repo !== null && typeof repo === 'object' && repo.installed === 0 && Array.isArray(repo.names) && repo.names.length === 0)
          .map((repo) => repo.source)
      }
      const groups = groupSkills(overview.skills, delta, subscriptions)
      const shared = {
        counts,
        pagePath,
        message: messageHtml,
        back,
        links,
        groups,
        delta,
        pickAll,
      }
      if (tab === 'repos') {
        html = renderRepoListPage({ ...shared, checkedAgo })
      } else if (tab === 'repo') {
        html = renderRepoPage({ ...shared, repoKey, group: groups.find((item) => item.key === repoKey) })
      } else if (tab === 'todo') {
        html = renderTodoPage(shared)
      } else {
        html = renderSkillsPage({
          ...shared,
          root: overview.root,
          skills: overview.skills,
          notes: overview.notes,
          checkedAt,
          query,
          results,
          todoOnly,
        })
      }
    }

    // CSP 逐项说明（从「禁一切脚本」放宽到「只放行自己那一个外链文件」，其余不松）：
    //   default-src 'none'          —— 兜底全禁：object / img / media / worker / frame 等
    //                                  没列出的类型全部随它被拒，比逐条列白名单更严。
    //   script-src 'self'           —— 只允许本站自己 serve 的 client/page-ui.js（外链，
    //                                  不是内联）；**不**加 'unsafe-inline'、**不**加 data:/blob:、
    //                                  不引任何 CDN。
    //   connect-src 'self'          —— 交互层的 fetch 要打到本站同一个页面地址；不放开这条，
    //                                  fetch 会因 default-src 'none' 被拦（pjax 直接失效）。
    //   style-src 'unsafe-inline'   —— 页面用内联 <style> 块（维持现状：收紧会让页面白板）。
    //   form-action 'self'          —— 表单只能提交到本站（防注入的表单把数据外发）。
    //   base-uri 'none'             —— 禁止 <base> 改写相对 URL。
    //   frame-ancestors 'none'      —— 不被任何站点 iframe 嵌套（防点击劫持）。
    const headers = {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    }
    // 显式带了合法顶层 tab 才写 cookie（记住上次看的标签）；Path 限定在页面路径下。
    if (COOKIE_TABS.includes(tabParam)) {
      headers['set-cookie'] = TAB_COOKIE + '=' + tab + '; Path=' + pagePath + '; Max-Age=' + String(TAB_COOKIE_MAX_AGE) + '; HttpOnly; SameSite=Strict'
    }
    res.writeHead(200, headers)
    res.end(html)
  }
}
