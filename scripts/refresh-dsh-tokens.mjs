#!/usr/bin/env node
// refresh-dsh-tokens.mjs · 从本机 DSH 安装里刷新主题 token（CSS）
//
// 用途：lib/page.js 里内嵌了一份 design-platform 的 token 副本。DSH 升级后副本会过期，
// 用这个脚本一键重新提取，再据此更新副本（脚本不自动改 lib/page.js）。
//
// 数据来源（本机实测）：DSH 客户端主题包
//   @deepseek-ai/dsh-client-ui-theme/lib/client.js
// 里有一个字符串字面量：
//   var design_platform_css_default = "...";
// 内容就是真实 CSS，含 `body{}`（亮色）与 `body[data-ds-dark-theme]{}`（暗色）两套。
//
// 用法：
//   node scripts/refresh-dsh-tokens.mjs                     # 完整 CSS 打到 stdout
//   node scripts/refresh-dsh-tokens.mjs out.css             # 完整 CSS 写入文件（字节级原样，无尾换行）
//   node scripts/refresh-dsh-tokens.mjs --split             # 按段打印（带 /* ==== id ==== */ 标记）
//   node scripts/refresh-dsh-tokens.mjs --split dir/        # 每段一个文件 + manifest.json
//   node scripts/refresh-dsh-tokens.mjs --select light            # 只出亮色那一套（static+alias+platform）
//   node scripts/refresh-dsh-tokens.mjs --select dark             # 只出暗色那一套
//   node scripts/refresh-dsh-tokens.mjs --select static,alias,dark out.css
//   node scripts/refresh-dsh-tokens.mjs --dsh-root /path/to/dsh ...
//   node scripts/refresh-dsh-tokens.mjs --file /path/to/client.js ...
//
// 段（section）分类：kind = static | alias | platform | extra；theme = light | dark。
// 段 id 形如 `01-static-light`；--select 接受 id、或 `kind`、或 `kind-theme`、或 `theme`。
// 若 tokens 里只出现一个 theme（light/dark），则该 theme 作为过滤器叠加在其他 token 上；
// 只写 `--select light` 就等价于“亮色的所有段”。
// 校验信息（字节数 / 变量个数 / 段清单）走 stderr，stdout 只放 CSS，方便 `> x.css` 直接落盘。
//
// 退出码：0 成功；1 定位失败 / 解析失败 / 校验不完整 / 用法错误。
// 幂等：同一份 DSH 安装重复运行输出完全一致。

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const THEME_SPECIFIER = '@deepseek-ai/dsh-client-ui-theme/lib/client.js'
const THEME_PKG = '@deepseek-ai/dsh-client-ui-theme'
const DSH_PKG = '@deepseek-ai/dsh'
const DARK_MARKER = 'body[data-ds-dark-theme]'
// 字面量里除转义序列外不允许出现裸引号，`(?:\\.|[^"\\])*` 正好表达这一点。
const LITERAL_RE = /var\s+design_platform_css_default\s*=\s*("(?:\\.|[^"\\])*")\s*;/

// 给定一个“根”，按几种常见布局拼出 client.js 的可能位置。
// 覆盖：安装根 / @deepseek-ai/dsh 包目录 / 主题包目录 / 直接是文件。
const SUFFIXES = [
  path.join('node_modules', DSH_PKG, 'node_modules', THEME_PKG, 'lib', 'client.js'),
  path.join('node_modules', THEME_PKG, 'lib', 'client.js'),
  path.join(DSH_PKG, 'node_modules', THEME_PKG, 'lib', 'client.js'),
  path.join(THEME_PKG, 'lib', 'client.js'),
  path.join('lib', 'client.js'),
]

// 兜底硬编码路径（任务给定的常见安装位置）。
const COMMON_FILES = [
  path.join('/usr/local/lib/node_modules', DSH_PKG, 'node_modules', THEME_PKG, 'lib', 'client.js'),
  path.join('/usr/local/lib/node_modules', THEME_PKG, 'lib', 'client.js'),
  path.join('/usr/lib/node_modules', DSH_PKG, 'node_modules', THEME_PKG, 'lib', 'client.js'),
  path.join(process.env.HOME || '', '.npm-global', 'lib', 'node_modules', DSH_PKG, 'node_modules', THEME_PKG, 'lib', 'client.js'),
]

function log(message) {
  process.stderr.write(`[dsh-tokens] ${message}\n`)
}

function fail(message, hint) {
  process.stderr.write(`[dsh-tokens] ERROR: ${message}\n`)
  if (hint) process.stderr.write(`[dsh-tokens] 提示: ${hint}\n`)
  process.exit(1)
}

function usage() {
  process.stdout.write([
    '用法: node scripts/refresh-dsh-tokens.mjs [输出文件] [选项]',
    '',
    '选项:',
    '  --split               按段输出（给输出目录则每段一个文件 + manifest.json；给文件/stdout 则带段标记）',
    '  --select <tokens>     只输出选中的段，逗号分隔；token 可为 id / kind / kind-theme / theme',
    '                        kind: static | alias | platform | extra；--select light 即“亮色全部段”',
    '  --file <client.js>    直接指定主题包 client.js',
    '  --dsh-root <dir>      指定 DSH 根目录（安装根、@deepseek-ai/dsh 目录或主题包目录都行）',
    '  -h, --help            显示本帮助',
    '',
    '环境变量: DSH_ROOT 等价于 --dsh-root。',
    '退出码: 0 成功；1 定位/解析/校验/用法出错。',
    '校验信息（字节数、alias 变量数、段清单）走 stderr；stdout 只放 CSS。',
  ].join('\n') + '\n')
}

function parseArgs(argv) {
  const opts = { out: null, split: false, select: null, file: null, dshRoot: process.env.DSH_ROOT || null }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const takeValue = (name) => {
      const eq = arg.indexOf('=')
      if (eq !== -1) return arg.slice(eq + 1)
      if (i + 1 >= argv.length) fail(`${name} 缺少参数值`)
      return argv[++i]
    }
    if (arg === '-h' || arg === '--help') { usage(); process.exit(0) }
    else if (arg === '--split') opts.split = true
    else if (arg === '--select' || arg.startsWith('--select=')) opts.select = takeValue('--select')
    else if (arg === '--file' || arg.startsWith('--file=')) opts.file = takeValue('--file')
    else if (arg === '--dsh-root' || arg === '--dir' || arg.startsWith('--dsh-root=') || arg.startsWith('--dir=')) {
      opts.dshRoot = takeValue('--dsh-root')
    } else if (arg.startsWith('-')) fail(`未知选项 ${arg}`, '运行 --help 查看用法')
    else positional.push(arg)
  }
  if (positional.length > 1) fail(`多余的参数: ${positional.slice(1).join(' ')}`)
  if (positional.length === 1) opts.out = positional[0]
  if (opts.select !== null && !opts.select.trim()) fail('--select 不能为空')
  return opts
}

function asFile(candidate) {
  if (!candidate) return null
  try {
    const stat = fs.statSync(candidate)
    if (stat.isFile()) return fs.realpathSync(candidate)
    if (stat.isDirectory()) {
      for (const suffix of SUFFIXES) {
        const nested = path.join(candidate, suffix)
        try { if (fs.statSync(nested).isFile()) return fs.realpathSync(nested) } catch { /* 继续试 */ }
      }
    }
  } catch { /* 不存在或不可读，交给调用方 */ }
  return null
}

function fromRoot(root) {
  return asFile(root)
}

// 用 import.meta.resolve / createRequire 从若干基线尝试解析主题包入口。
function fromResolver() {
  const tried = []
  try {
    const url = import.meta.resolve(THEME_SPECIFIER)
    if (url) {
      const file = asFile(fileURLToPath(url))
      if (file) return file
      tried.push(String(url))
    }
  } catch (error) { tried.push(`import.meta.resolve: ${error.code || error.message}`) }
  for (const base of [SCRIPT_DIR, process.cwd()]) {
    try {
      const require = createRequire(path.join(base, 'noop.js'))
      const file = asFile(require.resolve(THEME_SPECIFIER))
      if (file) return file
    } catch (error) { tried.push(`require.resolve(${base}): ${error.code || error.message}`) }
  }
  return { tried }
}

// node 的全局根：/usr/local/bin/node -> /usr/local/lib/node_modules
function fromNodePrefix() {
  try {
    const exec = fs.realpathSync(process.execPath)
    const prefix = path.dirname(path.dirname(exec))
    for (const rel of [path.join('lib', 'node_modules'), 'node_modules']) {
      const file = asFile(path.join(prefix, rel))
      if (file) return file
    }
  } catch { /* 忽略 */ }
  return null
}

// 扫 PATH 找 dsh 可执行文件，推导安装根（常见 bin/<pkg> 或 bin 软链）。
function fromPath() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const bin = path.join(dir, 'dsh')
    try {
      if (!fs.statSync(bin).isFile()) continue
      const real = fs.realpathSync(bin)
      const binDir = path.dirname(real)
      const roots = [path.dirname(binDir), binDir]
      for (const root of roots) {
        const file = asFile(root)
        if (file) return file
      }
    } catch { /* 继续 */ }
  }
  return null
}

// 从 cwd / 脚本目录逐级向上找 node_modules 里的主题包。
function fromWalkUp() {
  const starts = [process.cwd(), SCRIPT_DIR]
  for (const start of starts) {
    let dir = start
    for (let depth = 0; depth < 8; depth++) {
      const file = asFile(path.join(dir, 'node_modules'))
      if (file) return file
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return null
}

function locateThemeFile(opts) {
  const searched = []
  if (opts.file) {
    const file = asFile(opts.file)
    if (!file) fail(`--file 指向的主题包入口不存在或不是文件: ${opts.file}`, '确认路径指向 .../dsh-client-ui-theme/lib/client.js')
    return { file, how: '--file' }
  }
  if (opts.dshRoot) {
    const root = path.resolve(opts.dshRoot)
    if (!fs.existsSync(root)) {
      fail(`指定的 DSH 根目录不存在: ${root}`, '用 --dsh-root 指向真实安装目录，或改用 --file 直接指定 client.js')
    }
    const file = fromRoot(root)
    if (!file) {
      fail(`在 DSH 根目录下找不到主题包入口: ${root}`,
        `已尝试: ${SUFFIXES.join(' | ')}；请用 --file 直接指定 ${THEME_PKG}/lib/client.js`)
    }
    return { file, how: `--dsh-root ${root}` }
  }
  const resolver = fromResolver()
  if (typeof resolver === 'string') return { file: resolver, how: 'import.meta.resolve/createRequire' }
  searched.push(...resolver.tried)
  const auto = [
    ['node 全局前缀', fromNodePrefix()],
    ['PATH 上的 dsh', fromPath()],
    ['向上查找 node_modules', fromWalkUp()],
  ]
  for (const [how, file] of auto) {
    if (file) return { file, how }
    searched.push(how)
  }
  for (const candidate of COMMON_FILES) {
    const file = asFile(candidate)
    if (file) return { file, how: `常见安装路径 ${candidate}` }
    searched.push(candidate)
  }
  fail('找不到 DSH 主题包入口 (@deepseek-ai/dsh-client-ui-theme/lib/client.js)',
    `已尝试: ${searched.join(' | ')}；请用 --dsh-root <DSH 根目录> 或 --file <client.js> 指定`)
}

function extractCss(source, file) {
  const match = source.match(LITERAL_RE)
  if (!match) {
    fail(`在 ${file} 里找不到 design_platform_css_default 字符串字面量`, 'DSH 版本可能改过打包格式；检查该文件里 design_platform_css_default 的定义')
  }
  const occurrences = source.split('var design_platform_css_default').length - 1
  if (occurrences > 1) log(`注意: 文件里有 ${occurrences} 处 design_platform_css_default，使用第一处`)
  const literal = match[1]
  let css
  try {
    // 优先 JSON.parse（纯数据、不执行代码）；不兼容的转义才退回 eval 等价解码。
    css = JSON.parse(literal)
  } catch {
    try {
      css = (0, eval)(literal) // eslint-disable-line no-eval
    } catch (error) {
      fail(`解码 design_platform_css_default 失败: ${error.message}`, '该字面量可能不是普通字符串；请人工检查 DSH 版本')
    }
  }
  if (typeof css !== 'string' || css.length === 0) fail('解码结果不是非空字符串，拒绝产出空文件')
  return css
}

function validateCss(css) {
  if (!css.includes('body{')) fail('CSS 里找不到 `body{}` 基础段，可能只提到半份 token')
  if (!css.includes(DARK_MARKER)) {
    fail(`CSS 里找不到 \`${DARK_MARKER}\`，拒绝产出（防止只提到亮色半份）`,
      '确认 DSH 主题包版本，或人工检查 design_platform_css_default 内容')
  }
  if (!/--dsw-alias-[a-z0-9-]+\s*:/.test(css)) fail('CSS 里找不到任何 --dsw-alias-* 变量，疑似结构变化')
}

function uniqueVars(body, prefix) {
  const found = body.match(new RegExp(`--${prefix}-[a-z0-9-]+`, 'g')) || []
  return new Set(found).size
}

// 顶层规则切分：按花括号深度扫描，跳过字符串内的括号（对当前这份压缩 CSS 足够）。
function splitSections(css) {
  const sections = []
  let depth = 0
  let start = 0
  let preludeEnd = -1
  let quote = null
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '{') {
      if (depth === 0) preludeEnd = i
      depth++
      continue
    }
    if (ch === '}') {
      depth--
      if (depth === 0 && preludeEnd !== -1) {
        sections.push(makeSection(css.slice(start, i + 1), css.slice(start, preludeEnd), css.slice(preludeEnd + 1, i), sections.length))
        start = i + 1
        preludeEnd = -1
      }
    }
  }
  const tail = css.slice(start)
  if (tail.trim()) sections.push(makeSection(tail, tail.trim(), '', sections.length))
  return sections
}

function makeSection(raw, prelude, body, index) {
  const selector = prelude.trim()
  const dark = selector.includes(DARK_MARKER)
  const theme = dark ? 'dark' : 'light'
  let kind
  if (selector.includes('data-platform')) kind = 'platform'
  else if (/--dsw-static-[a-z0-9-]+\s*:/.test(body)) kind = 'static'
  else if (/--dsw-alias-[a-z0-9-]+\s*:/.test(body)) kind = 'alias'
  else kind = 'extra'
  return {
    id: `${String(index + 1).padStart(2, '0')}-${kind}-${theme}`,
    kind,
    theme,
    selector,
    bytes: Buffer.byteLength(raw),
    aliasVars: uniqueVars(body, 'dsw-alias'),
    staticVars: uniqueVars(body, 'dsw-static'),
    specificVars: uniqueVars(body, 'dsw-specific'),
    css: raw,
  }
}

function selectMatcher(select) {
  const tokens = select.split(',').map((token) => token.trim()).filter(Boolean)
  if (tokens.length === 0) fail('--select 里没有有效 token')
  const themes = tokens.filter((token) => token === 'light' || token === 'dark')
  const themeFilter = themes.length === 1 ? themes[0] : null
  const kindTokens = tokens.filter((token) => token !== 'light' && token !== 'dark')
  return {
    match(section) {
      if (themeFilter && section.theme !== themeFilter) return false
      if (kindTokens.length === 0) return true // 只给了 theme：该 theme 的所有段
      return kindTokens.some((token) =>
        token === section.id || token === section.kind || token === `${section.kind}-${section.theme}`)
    },
  }
}

function writeFileExact(file, content) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  fs.writeFileSync(file, content)
}

function writeStdout(content) {
  process.stdout.write(content.endsWith('\n') ? content : content + '\n')
}

function report(sections, css) {
  const aliasVars = uniqueVars(css, 'dsw-alias')
  log(`CSS 字节数: ${Buffer.byteLength(css)} | 唯一变量: alias=${aliasVars} static=${uniqueVars(css, 'dsw-static')} specific=${uniqueVars(css, 'dsw-specific')}`)
  log(`段数: ${sections.length}`)
  for (const section of sections) {
    log(`  ${section.id}  selector="${section.selector}"  bytes=${section.bytes}  alias=${section.aliasVars} static=${section.staticVars} specific=${section.specificVars}`)
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const { file, how } = locateThemeFile(opts)
  log(`主题包: ${file}  (定位方式: ${how})`)
  let source
  try {
    source = fs.readFileSync(file, 'utf8')
  } catch (error) {
    fail(`读取主题包失败: ${error.message}`, '检查文件权限，或改用 --file 指定可读路径')
  }
  const css = extractCss(source, file)
  validateCss(css)
  const sections = splitSections(css)
  report(sections, css)

  if (opts.select) {
    const { match } = selectMatcher(opts.select)
    const chosen = sections.filter(match)
    if (chosen.length === 0) {
      fail(`--select ${opts.select} 没有匹配到任何段`, `可用 token: ${sections.map((s) => s.id).join(', ')} 或 kind/theme 组合`)
    }
    log(`--select 命中 ${chosen.length} 段: ${chosen.map((s) => s.id).join(', ')}`)
    const out = chosen.map((s) => s.css).join('')
    if (opts.out) { writeFileExact(opts.out, out); log(`已写入 ${opts.out} (${Buffer.byteLength(out)} 字节，无尾换行)`) }
    else writeStdout(out)
    return
  }

  if (!opts.split) {
    if (opts.out) { writeFileExact(opts.out, css); log(`已写入 ${opts.out} (${Buffer.byteLength(css)} 字节，无尾换行)`) }
    else writeStdout(css)
    return
  }

  // --split：给目录 → 每段一个文件 + manifest；否则带标记打印。
  const looksLikeDir = opts.out && (opts.out.endsWith(path.sep) || fs.existsSync(opts.out) && fs.statSync(opts.out).isDirectory())
  if (opts.out && looksLikeDir) {
    const dir = opts.out
    fs.mkdirSync(dir, { recursive: true })
    for (const section of sections) {
      writeFileExact(path.join(dir, `${section.id}.css`), section.css)
    }
    const manifest = {
      source: file,
      bytes: Buffer.byteLength(css),
      aliasVars: uniqueVars(css, 'dsw-alias'),
      staticVars: uniqueVars(css, 'dsw-static'),
      specificVars: uniqueVars(css, 'dsw-specific'),
      sections: sections.map(({ id, kind, theme, selector, bytes, aliasVars, staticVars, specificVars }) =>
        ({ id, kind, theme, selector, bytes, aliasVars, staticVars, specificVars, file: `${id}.css` })),
    }
    writeFileExact(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    log(`--split 已写入目录 ${dir}: ${sections.map((s) => s.id + '.css').join(', ')}, manifest.json`)
    return
  }
  const marked = sections.map((s) =>
    `/* ==== ${s.id} | selector=${s.selector} | bytes=${s.bytes} | alias=${s.aliasVars} static=${s.staticVars} specific=${s.specificVars} ==== */\n${s.css}`).join('\n')
  if (opts.out) { writeFileExact(opts.out, marked); log(`--split 已写入 ${opts.out}（带段标记，不是可直接内嵌的纯 CSS）`) }
  else writeStdout(marked)
}

main()
