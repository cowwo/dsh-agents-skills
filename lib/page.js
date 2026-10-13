// dsh-agents-skills · 独立页（服务端渲染）
//
// 为什么是服务端渲染的纯 HTML：这个插件没有构建步骤，而独立页要在**没有聊天界面**
// 的情况下打开，所以不引前端框架——展开/折叠用原生 `<details>`，操作全部是表单 POST。
// 交互层是 `client/page-ui.js` 一个外链文件（pjax 薄层，≤200 行、无依赖），把整页导航换成
// fetch + 局部替换，免得每次操作整页白闪、丢滚动、丢折叠状态；CSP 用 script-src 'self'
// 只放行这一个文件，内联脚本仍然禁止。没有 JS 时页面照常工作（纯 SSR + 表单是兜底）。
//
// 视觉：整页吃 DSH 设计令牌（页面里那块从 `dsh-client-ui-theme` 提取的 token 副本
// + 本文件自有的样式块），自有样式里不写死任何色值。
// 亮/暗跟的是 **DSH 的主题设置**（Host 用户设置 `ui-theme.preference`），不是操作系统：
// SSR 时读一次偏好，分三路输出（dark 只射暗色一套 / light 只射亮色一套 / system 留
// `@media (prefers-color-scheme: dark)` 交给浏览器）。零脚本、零 CSP 改动。
//
// 门禁：路由自己调 `ctx.connection.requestRejection(req)`（宿主原话："Apply Connection's
// Host/Origin checks and browser authentication to another Web route"），也就是和聊天
// 界面**同一道门**。不这样做的话，exact 路由会绕过 `/api` 的栅栏——在"宿主机本地直连"
// 这条路上（它不经过反向代理）就是一个免密后门。

import { readFileSync } from 'node:fs'
import { groupSkills } from './skills.js'

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
/** 主题偏好的合法取值，与 DSH 用户设置 `ui-theme.preference` 一致。 */
const THEME_PREFERENCES = ['light', 'dark', 'system']
/** 技能页状态筛选（GET `state`）的合法取值；`todo` 这一项沿用既有的 `todo=1` 参数。 */
const STATE_IDS = ['all', 'new', 'upd', 'gone', 'local', 'todo']
/** 技能名筛选（GET `filter`）最长字符数。 */
const FILTER_MAX = 64

/**
 * DSH 设计令牌副本（提取自 dsh-client-ui-theme，可用 scripts/refresh-dsh-tokens.mjs 一键刷新）。
 * 自有样式只引用这些令牌，不写死色值；亮/暗按 DSH 主题偏好由 tokenStyle() 三路择一输出。
 *   base        ← base_css_default（:root 的字体 / 圆角 / 过渡 / 缓动）
 *   lightStatic ← design_platform_css_default 段 1（body{} 静态色板 · 亮）
 *   darkStatic  ← 段 2（body[data-ds-dark-theme]{} 静态色板 · 暗）
 *   lightAlias  ← 段 3（body{} alias 语义色 · 亮）
 *   darkAlias   ← 段 4（body[data-ds-dark-theme]{} alias 语义色 · 暗）
 *   darwinLight ← 段 5（html[data-platform=darwin] body{}）
 *   darwinDark  ← 段 6（html[data-platform=darwin] body[data-ds-dark-theme]{}）
 */
const DSH_TOKENS = {
  base: ":root{--dsw-font-family:-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", \"Helvetica Neue\", Helvetica, Arial, sans-serif;--dsw-font-family-brand:\"Montserrat\", var(--dsw-font-family);--ds-font-family-code:\"SF Mono\", \"JetBrains Mono\", \"Fira Code\", Consolas, \"Liberation Mono\", Menlo, Courier, \"PingFang SC\", \"Microsoft YaHei\";--ds-ease-in-out:cubic-bezier(.4, 0, .2, 1);--ds-transition-duration:.2s;--ds-transition-duration-fast:.1s;--ds-transition-duration-slow:.3s;--dsw-radius-xs:4px;--dsw-radius-sm:8px;--dsw-radius-md:12px;--dsw-radius-lg:16px;--dsw-radius-xl:20px;--dsw-radius-panel:28px}body{--dsw-alias-settings-card-fill:var(--dsw-alias-bg-layer-2);--dsw-alias-settings-card-stroke:var(--dsw-alias-border-l4)}[data-dsh-automatic-focus]:focus,[data-dsh-automatic-focus]:focus:focus-visible{outline:none}",
  lightStatic: "body{--dsw-static-amber-100:#fef5e7;--dsw-static-amber-400:#f7ad31;--dsw-static-amber-500:#f59e0b;--dsw-static-amber-600:#dd8629;--dsw-static-amber-900:#27241f;--dsw-static-blue-100:#dbeafe;--dsw-static-blue-300:#93c5fd;--dsw-static-blue-400:#60a5fa;--dsw-static-blue-450:#4d93f8;--dsw-static-blue-500:#3b82f6;--dsw-static-blue-50:#eff6ff;--dsw-static-blue-50p:#eaf3ff;--dsw-static-blue-600:#2563eb;--dsw-static-blue-75:#e5f0ff;--dsw-static-blue-800:#1e40af;--dsw-static-blue-900:#0e3074;--dsw-static-blue-950:#172554;--dsw-static-deepseek-100:#e4edfd;--dsw-static-deepseek-200:#d3e2ff;--dsw-static-deepseek-300:#b7c8fe;--dsw-static-deepseek-400:#7aaaff;--dsw-static-deepseek-450:#5686fe;--dsw-static-deepseek-500:#4176e6;--dsw-static-deepseek-50:#edf3fe;--dsw-static-deepseek-600:#4868b2;--dsw-static-deepseek-700-delete:#2f4c8f;--dsw-static-deepseek-800:#34415b;--dsw-static-deepseek-900:#283142;--dsw-static-green-100:#e6faed;--dsw-static-green-400:#4ed17e;--dsw-static-green-500:#22c55e;--dsw-static-green-500-a08:#22c55e14;--dsw-static-green-500-a12:#22c55e1f;--dsw-static-green-900:#233c2c;--dsw-static-neutral-00:#fff;--dsw-static-neutral-1000:#000;--dsw-static-neutral-100:#f5f5f5;--dsw-static-neutral-150:#ededed;--dsw-static-neutral-200:#e5e5e5;--dsw-static-neutral-250:#dcdcdc;--dsw-static-neutral-300:#d4d4d4;--dsw-static-neutral-400:#a2a4a6;--dsw-static-neutral-500:#7f8287;--dsw-static-neutral-50:#fafafa;--dsw-static-neutral-550:#65676b;--dsw-static-neutral-600:#545557;--dsw-static-neutral-700:#3c3c3d;--dsw-static-neutral-800:#292929;--dsw-static-neutral-850:#212123;--dsw-static-neutral-900:#0f0f0f;--dsw-static-neutral-bluish-00:#fff;--dsw-static-neutral-bluish-1000:#0f1115;--dsw-static-neutral-bluish-100:#ebeef2;--dsw-static-neutral-bluish-150:#e9ecf2;--dsw-static-neutral-bluish-200:#e1e5ee;--dsw-static-neutral-bluish-300:#cfd3d6;--dsw-static-neutral-bluish-400:#adb2b8;--dsw-static-neutral-bluish-500:#979da6;--dsw-static-neutral-bluish-50:#f9fafb;--dsw-static-neutral-bluish-600:#81858c;--dsw-static-neutral-bluish-60:#f5f6f7;--dsw-static-neutral-bluish-700:#61666b;--dsw-static-neutral-bluish-750:#43454a;--dsw-static-neutral-bluish-75:#f1f3f5;--dsw-static-neutral-bluish-800:#353638;--dsw-static-neutral-bluish-850:#2c2c2e;--dsw-static-neutral-bluish-875:#232324;--dsw-static-neutral-bluish-900:#1b1b1c;--dsw-static-neutral-bluish-950:#151517;--dsw-static-red-100:#fee2e2;--dsw-static-red-400:#f25a5a;--dsw-static-red-400-a12:#f25a5a1f;--dsw-static-red-500:#ef4444;--dsw-static-red-50:#fef2f2;--dsw-static-red-600:#ec1313;--dsw-static-red-600-a08:#ec131314;--dsw-static-red-900:#570c0c}",
  darkStatic: "body[data-ds-dark-theme]{--dsw-static-amber-100:#fef5e7;--dsw-static-amber-400:#f7ad31;--dsw-static-amber-500:#f59e0b;--dsw-static-amber-600:#dd8629;--dsw-static-amber-900:#27241f;--dsw-static-blue-100:#dbeafe;--dsw-static-blue-300:#93c5fd;--dsw-static-blue-400:#60a5fa;--dsw-static-blue-450:#4d93f8;--dsw-static-blue-500:#3b82f6;--dsw-static-blue-50:#eff6ff;--dsw-static-blue-50p:#eaf3ff;--dsw-static-blue-600:#2563eb;--dsw-static-blue-75:#e5f0ff;--dsw-static-blue-800:#1e40af;--dsw-static-blue-900:#0e3074;--dsw-static-blue-950:#172554;--dsw-static-deepseek-100:#e4edfd;--dsw-static-deepseek-200:#d3e2ff;--dsw-static-deepseek-300:#b7c8fe;--dsw-static-deepseek-400:#7aaaff;--dsw-static-deepseek-450:#5686fe;--dsw-static-deepseek-500:#4176e6;--dsw-static-deepseek-50:#edf3fe;--dsw-static-deepseek-600:#4868b2;--dsw-static-deepseek-700-delete:#2f4c8f;--dsw-static-deepseek-800:#34415b;--dsw-static-deepseek-900:#283142;--dsw-static-green-100:#e6faed;--dsw-static-green-400:#4ed17e;--dsw-static-green-500:#22c55e;--dsw-static-green-500-a08:#22c55e14;--dsw-static-green-500-a12:#22c55e1f;--dsw-static-green-900:#233c2c;--dsw-static-neutral-00:#fff;--dsw-static-neutral-1000:#000;--dsw-static-neutral-100:#f5f5f5;--dsw-static-neutral-150:#ededed;--dsw-static-neutral-200:#e5e5e5;--dsw-static-neutral-250:#dcdcdc;--dsw-static-neutral-300:#d4d4d4;--dsw-static-neutral-400:#a2a4a6;--dsw-static-neutral-500:#7f8287;--dsw-static-neutral-50:#fafafa;--dsw-static-neutral-550:#65676b;--dsw-static-neutral-600:#545557;--dsw-static-neutral-700:#3c3c3d;--dsw-static-neutral-800:#292929;--dsw-static-neutral-850:#212123;--dsw-static-neutral-900:#0f0f0f;--dsw-static-neutral-bluish-00:#fff;--dsw-static-neutral-bluish-1000:#0f1115;--dsw-static-neutral-bluish-100:#ebeef2;--dsw-static-neutral-bluish-150:#e9ecf2;--dsw-static-neutral-bluish-200:#e1e5ee;--dsw-static-neutral-bluish-300:#cfd3d6;--dsw-static-neutral-bluish-400:#adb2b8;--dsw-static-neutral-bluish-500:#979da6;--dsw-static-neutral-bluish-50:#f9fafb;--dsw-static-neutral-bluish-600:#81858c;--dsw-static-neutral-bluish-60:#f9fafb;--dsw-static-neutral-bluish-700:#61666b;--dsw-static-neutral-bluish-750:#43454a;--dsw-static-neutral-bluish-75:#f1f3f5;--dsw-static-neutral-bluish-800:#353638;--dsw-static-neutral-bluish-850:#2c2c2e;--dsw-static-neutral-bluish-875:#232324;--dsw-static-neutral-bluish-900:#1b1b1c;--dsw-static-neutral-bluish-950:#151517;--dsw-static-red-100:#fee2e2;--dsw-static-red-400:#f25a5a;--dsw-static-red-400-a12:#f25a5a1f;--dsw-static-red-500:#ef4444;--dsw-static-red-50:#fef2f2;--dsw-static-red-600:#ec1313;--dsw-static-red-600-a08:#ec131314;--dsw-static-red-900:#570c0c}",
  lightAlias: "body{--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-00);--dsw-alias-bg-document-preview:var(--dsw-static-neutral-bluish-100);--dsw-alias-bg-document-selection:color-mix(in srgb, var(--dsw-static-blue-500) 40%, transparent);--dsw-alias-label-document-preview:var(--dsw-static-neutral-bluish-700);--dsw-alias-bg-layer-1:var(--dsw-static-neutral-bluish-00);--dsw-alias-bg-layer-2:var(--dsw-static-neutral-bluish-00);--dsw-alias-bg-layer-3:var(--dsw-static-neutral-bluish-00);--dsw-alias-bg-mask-1:#0000003d;--dsw-alias-bg-mask-2:#0000001f;--dsw-alias-bg-mask-3:#0000007a;--dsw-alias-bg-mask-photo:#000000e0;--dsw-alias-bg-mask-drop:#ffffffb3;--dsw-alias-bg-module-platform:var(--dsw-static-neutral-bluish-60);--dsw-alias-bg-multi-select:var(--dsw-static-neutral-bluish-60);--dsw-alias-bg-overlay:var(--dsw-static-neutral-bluish-150);--dsw-alias-bg-skeleton:#0000000a;--dsw-alias-border-inverted2:#0000;--dsw-alias-border-inverted:#0000;--dsw-alias-border-l1:#0000000a;--dsw-alias-border-l2-darkmode-thin:#0000001a;--dsw-alias-border-l2:#0000001a;--dsw-alias-border-l3:#0000001f;--dsw-alias-border-l4:#00000029;--dsw-alias-brand-primary-invert:var(--dsw-static-neutral-bluish-1000);--dsw-alias-brand-primary-new-colorprimary-new-color:#4176e6;--dsw-alias-brand-primary:var(--dsw-static-neutral-bluish-1000);--dsw-alias-brand-text:var(--dsw-static-neutral-bluish-1000);--dsw-alias-button-contrast-fill:var(--dsw-static-neutral-bluish-700);--dsw-alias-button-elevated-fill:var(--dsw-static-neutral-bluish-00);--dsw-alias-button-floating-fill:var(--dsw-static-neutral-bluish-00);--dsw-alias-button-floating-hover:var(--dsw-static-neutral-bluish-75);--dsw-alias-button-ghost-active-border:var(--dsw-static-neutral-bluish-500);--dsw-alias-button-ghost-active-fill:var(--dsw-static-neutral-bluish-100);--dsw-alias-button-ghost-active-hover:var(--dsw-static-neutral-bluish-150);--dsw-alias-button-info-fill:var(--dsw-static-deepseek-500);--dsw-alias-button-info-hover:var(--dsw-static-deepseek-400);--dsw-alias-button-primary-dimmed:var(--dsw-static-neutral-bluish-100);--dsw-alias-button-primary-fill:var(--dsw-alias-brand-primary);--dsw-alias-button-primary-hover:var(--dsw-static-neutral-bluish-750);--dsw-alias-button-tool-bar-fill-invisible:#1f1f1f5c;--dsw-alias-button-tool-bar-fill:#54555780;--dsw-alias-button-tool-bar-hover:#54555799;--dsw-alias-interactive-bg-active:#2631481a;--dsw-alias-interactive-bg-hover-accent:#26314824;--dsw-alias-interactive-bg-hover-danger:#ec13130d;--dsw-alias-interactive-bg-hover-solid:var(--dsw-static-neutral-bluish-75);--dsw-alias-interactive-bg-hover:#2631480f;--dsw-alias-label-caption:var(--dsw-static-neutral-bluish-400);--dsw-alias-label-deep-diving:color-mix(in srgb, var(--dsw-static-deepseek-500) 70%, var(--dsw-static-blue-950));--dsw-alias-label-deep-diving-shimmer:color-mix(in srgb, var(--dsw-static-deepseek-500) 30%, var(--dsw-static-blue-950));--dsw-alias-label-dimmed:var(--dsw-static-neutral-bluish-200);--dsw-alias-label-primary-bluish:var(--dsw-static-blue-900);--dsw-alias-label-primary-dimmed:var(--dsw-static-neutral-bluish-950);--dsw-alias-label-primary-foreground:var(--dsw-static-neutral-bluish-00);--dsw-alias-label-primary-inverted:var(--dsw-static-neutral-bluish-00);--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-1000);--dsw-alias-label-secondary:var(--dsw-static-neutral-bluish-700);--dsw-alias-label-shimmer:color-mix(in srgb, var(--dsw-static-neutral-1000) 30%, transparent);--dsw-alias-label-tertiary:var(--dsw-static-neutral-bluish-600);--dsw-alias-menu-icon:var(--dsw-static-neutral-bluish-800);--dsw-alias-link:var(--dsw-static-deepseek-500);--dsw-alias-markdown-citation:var(--dsw-static-neutral-bluish-100);--dsw-alias-markdown-code-block-banner:var(--dsw-static-neutral-bluish-50);--dsw-alias-markdown-code-block:var(--dsw-static-neutral-bluish-50);--dsw-alias-markdown-code-segment-selected:var(--dsw-static-neutral-bluish-00);--dsw-alias-markdown-code-segment-unselected:var(--dsw-static-neutral-bluish-75);--dsw-alias-markdown-inline-code:var(--dsw-static-neutral-50);--dsw-alias-markdown-placeholder:var(--dsw-static-neutral-bluish-60);--dsw-alias-markdown-tag:var(--dsw-static-neutral-bluish-75);--dsw-alias-scrollbar-bg-l1:var(--dsw-static-neutral-200);--dsw-alias-scrollbar-bg-l2:var(--dsw-static-neutral-200);--dsw-alias-scrollbar-hover-l1:var(--dsw-static-neutral-300);--dsw-alias-scrollbar-hover-l2:var(--dsw-static-neutral-300);--dsw-alias-state-business-primary:var(--dsw-static-deepseek-500);--dsw-alias-state-business-tertiary:var(--dsw-static-deepseek-100);--dsw-alias-code-diff-added:var(--dsw-static-green-500-a08);--dsw-alias-code-diff-deleted:var(--dsw-static-red-600-a08);--dsw-alias-file-diff-added-bg:#e6f4e7;--dsw-alias-file-diff-added-gutter:#edf7ed;--dsw-alias-file-diff-added-marker:#01a241;--dsw-alias-file-diff-deleted-bg:#fce6e2;--dsw-alias-file-diff-deleted-gutter:#fdece9;--dsw-alias-file-diff-deleted-marker:#ba2723;--dsw-alias-state-error-primary:var(--dsw-static-red-600);--dsw-alias-state-error-secondary:var(--dsw-static-red-400);--dsw-alias-state-idle-primary:var(--dsw-static-neutral-300);--dsw-alias-state-success-primary:var(--dsw-static-green-500);--dsw-alias-state-success-secondary:var(--dsw-static-green-400);--dsw-alias-state-success-tertiary:var(--dsw-static-green-100);--dsw-alias-state-warn-label:var(--dsw-static-amber-600);--dsw-alias-state-warn-primary:var(--dsw-static-amber-500);--dsw-alias-state-warn-secondary:var(--dsw-static-amber-400);--dsw-alias-state-warn-tertiary:var(--dsw-static-amber-100);--dsw-alias-switch-thumb:var(--dsw-static-neutral-bluish-00);--dsw-alias-toast-bg:var(--dsw-static-neutral-bluish-800);--dsw-alias-toast-label:var(--dsw-static-neutral-bluish-00);--dsw-alias-tooltip-bg:var(--dsw-static-neutral-bluish-850);--dsw-alias-tooltip-key-bg:color-mix(in srgb, var(--dsw-alias-tooltip-bg), white 18%);--dsw-alias-turn-trigger-bg:var(--dsw-alias-markdown-code-block);--dsw-alias-turn-trigger-bg-hover:var(--dsw-alias-interactive-bg-hover);--dsw-specific-bubble-highlight:var(--dsw-static-deepseek-200);--dsw-specific-bubble:var(--dsw-static-deepseek-50);--dsw-specific-input-major:var(--dsw-static-neutral-bluish-00);--dsw-specific-login-input:var(--dsw-static-neutral-bluish-50);--dsw-menu-surface-fill:#f8f9fa94;--dsw-alias-menu-group-header-fill:#f8f9faf0;--dsw-specific-menu:var(--dsw-menu-surface-fill);--dsw-specific-selector:var(--dsw-static-neutral-bluish-60);--dsw-specific-sidebar-fill:var(--dsw-static-neutral-bluish-50);--dsw-specific-sidebar-nav-item-active-accent:var(--dsw-static-deepseek-100);--dsw-specific-sidebar-nav-item-active:var(--dsw-static-neutral-bluish-100);--dsw-specific-sidebar-nav-item-hover:var(--dsw-static-neutral-bluish-75);--dsw-specific-tip:var(--dsw-static-neutral-bluish-60);background-color:var(--dsw-alias-bg-base)}",
  darkAlias: "body[data-ds-dark-theme]{--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-950);--dsw-alias-bg-document-preview:var(--dsw-static-neutral-bluish-950);--dsw-alias-bg-document-selection:color-mix(in srgb, var(--dsw-static-blue-500) 40%, transparent);--dsw-alias-label-document-preview:var(--dsw-static-neutral-bluish-300);--dsw-alias-bg-layer-1:var(--dsw-static-neutral-bluish-875);--dsw-alias-bg-layer-2:var(--dsw-static-neutral-bluish-850);--dsw-alias-bg-layer-3:var(--dsw-static-neutral-bluish-800);--dsw-alias-bg-mask-1:#00000080;--dsw-alias-bg-mask-2:#0003;--dsw-alias-bg-mask-3:#0000007a;--dsw-alias-bg-mask-photo:#000000e0;--dsw-alias-bg-mask-drop:#272730b3;--dsw-alias-bg-module-platform:var(--dsw-static-neutral-bluish-800);--dsw-alias-bg-multi-select:var(--dsw-static-neutral-850);--dsw-alias-bg-overlay:var(--dsw-static-neutral-bluish-700);--dsw-alias-bg-skeleton:#ffffff14;--dsw-alias-border-inverted2:#ffffff14;--dsw-alias-border-inverted:#ffffff0f;--dsw-alias-border-l1:#ffffff0f;--dsw-alias-border-l2-darkmode-thin:#ffffff0f;--dsw-alias-border-l2:#ffffff1f;--dsw-alias-border-l3:#ffffff29;--dsw-alias-border-l4:#fff3;--dsw-alias-brand-primary-invert:var(--dsw-static-neutral-bluish-50);--dsw-alias-brand-primary-new-colorprimary-new-color:var(--dsw-static-deepseek-450);--dsw-alias-brand-primary:var(--dsw-static-neutral-bluish-50);--dsw-alias-brand-text:var(--dsw-static-neutral-bluish-50);--dsw-alias-button-contrast-fill:var(--dsw-static-neutral-bluish-50);--dsw-alias-button-elevated-fill:var(--dsw-static-neutral-bluish-750);--dsw-alias-button-floating-fill:var(--dsw-static-neutral-bluish-850);--dsw-alias-button-floating-hover:var(--dsw-static-neutral-bluish-800);--dsw-alias-button-ghost-active-border:var(--dsw-static-neutral-bluish-600);--dsw-alias-button-ghost-active-fill:var(--dsw-static-neutral-bluish-750);--dsw-alias-button-ghost-active-hover:var(--dsw-static-neutral-bluish-700);--dsw-alias-button-info-fill:var(--dsw-static-deepseek-400);--dsw-alias-button-info-hover:var(--dsw-static-deepseek-500);--dsw-alias-button-primary-dimmed:var(--dsw-static-neutral-bluish-750);--dsw-alias-button-primary-fill:var(--dsw-alias-brand-primary);--dsw-alias-button-primary-hover:var(--dsw-static-neutral-bluish-100);--dsw-alias-button-tool-bar-fill-invisible:#1f1f1f5c;--dsw-alias-button-tool-bar-fill:#54555780;--dsw-alias-button-tool-bar-hover:#54555799;--dsw-alias-interactive-bg-active:#ffffff24;--dsw-alias-interactive-bg-hover-accent:#ffffff3d;--dsw-alias-interactive-bg-hover-danger:#f25a5a26;--dsw-alias-interactive-bg-hover-solid:var(--dsw-static-neutral-bluish-800);--dsw-alias-interactive-bg-hover:#ffffff14;--dsw-alias-label-caption:var(--dsw-static-neutral-bluish-600);--dsw-alias-label-deep-diving:color-mix(in srgb, var(--dsw-static-deepseek-450) 55%, var(--dsw-static-neutral-bluish-400));--dsw-alias-label-deep-diving-shimmer:color-mix(in srgb, var(--dsw-static-blue-300) 65%, var(--dsw-static-deepseek-400));--dsw-alias-label-dimmed:var(--dsw-static-neutral-bluish-750);--dsw-alias-label-primary-bluish:var(--dsw-static-neutral-bluish-50);--dsw-alias-label-primary-dimmed:var(--dsw-static-neutral-bluish-100);--dsw-alias-label-primary-foreground:var(--dsw-static-neutral-bluish-1000);--dsw-alias-label-primary-inverted:var(--dsw-static-neutral-bluish-800);--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-50);--dsw-alias-label-secondary:var(--dsw-static-neutral-bluish-300);--dsw-alias-label-shimmer:color-mix(in srgb, var(--dsw-static-neutral-00) 45%, transparent);--dsw-alias-label-tertiary:var(--dsw-static-neutral-bluish-400);--dsw-alias-menu-icon:var(--dsw-alias-label-primary-dimmed);--dsw-alias-link:var(--dsw-static-deepseek-400);--dsw-alias-markdown-citation:var(--dsw-static-neutral-bluish-800);--dsw-alias-markdown-code-block-banner:var(--dsw-static-neutral-bluish-850);--dsw-alias-markdown-code-block:var(--dsw-static-neutral-bluish-900);--dsw-alias-markdown-code-segment-selected:var(--dsw-static-neutral-bluish-800);--dsw-alias-markdown-code-segment-unselected:var(--dsw-static-neutral-bluish-900);--dsw-alias-markdown-inline-code:var(--dsw-static-neutral-800);--dsw-alias-markdown-placeholder:var(--dsw-static-neutral-bluish-850);--dsw-alias-markdown-tag:var(--dsw-static-neutral-bluish-850);--dsw-alias-scrollbar-bg-l1:var(--dsw-static-neutral-700);--dsw-alias-scrollbar-bg-l2:var(--dsw-static-neutral-600);--dsw-alias-scrollbar-hover-l1:var(--dsw-static-neutral-600);--dsw-alias-scrollbar-hover-l2:var(--dsw-static-neutral-550);--dsw-alias-state-business-primary:var(--dsw-static-deepseek-400);--dsw-alias-state-business-tertiary:var(--dsw-static-deepseek-800);--dsw-alias-code-diff-added:var(--dsw-static-green-500-a12);--dsw-alias-code-diff-deleted:var(--dsw-static-red-400-a12);--dsw-alias-file-diff-added-bg:#1f3124;--dsw-alias-file-diff-added-gutter:#132016;--dsw-alias-file-diff-added-marker:#41c977;--dsw-alias-file-diff-deleted-bg:#3c1f1b;--dsw-alias-file-diff-deleted-gutter:#28130e;--dsw-alias-file-diff-deleted-marker:#fa423e;--dsw-alias-state-error-primary:var(--dsw-static-red-400);--dsw-alias-state-error-secondary:var(--dsw-static-red-400);--dsw-alias-state-idle-primary:var(--dsw-static-neutral-600);--dsw-alias-state-success-primary:var(--dsw-static-green-500);--dsw-alias-state-success-secondary:var(--dsw-static-green-400);--dsw-alias-state-success-tertiary:var(--dsw-static-green-900);--dsw-alias-state-warn-label:var(--dsw-static-amber-600);--dsw-alias-state-warn-primary:var(--dsw-static-amber-500);--dsw-alias-state-warn-secondary:var(--dsw-static-amber-400);--dsw-alias-state-warn-tertiary:var(--dsw-static-amber-900);--dsw-alias-switch-thumb:var(--dsw-static-neutral-bluish-400);--dsw-alias-toast-bg:var(--dsw-static-neutral-bluish-750);--dsw-alias-toast-label:var(--dsw-static-neutral-bluish-00);--dsw-alias-turn-trigger-bg:var(--dsw-alias-interactive-bg-hover);--dsw-alias-turn-trigger-bg-hover:var(--dsw-alias-interactive-bg-active);--dsw-alias-tooltip-bg:var(--dsw-static-neutral-bluish-750);--dsw-alias-tooltip-key-bg:color-mix(in srgb, var(--dsw-alias-tooltip-bg), white 18%);--dsw-specific-bubble-highlight:var(--dsw-static-neutral-bluish-750);--dsw-specific-bubble:var(--dsw-static-neutral-bluish-850);--dsw-specific-input-major:var(--dsw-static-neutral-bluish-850);--dsw-specific-login-input:var(--dsw-static-neutral-bluish-900);--dsw-menu-surface-fill:#43454a73;--dsw-alias-menu-group-header-fill:#303136f0;--dsw-specific-menu:var(--dsw-menu-surface-fill);--dsw-specific-selector:var(--dsw-static-neutral-bluish-800);--dsw-specific-sidebar-fill:var(--dsw-static-neutral-bluish-900);--dsw-specific-sidebar-nav-item-active-accent:var(--dsw-static-neutral-bluish-800);--dsw-specific-sidebar-nav-item-active:var(--dsw-static-neutral-bluish-750);--dsw-specific-sidebar-nav-item-hover:var(--dsw-static-neutral-bluish-850);--dsw-specific-tip:var(--dsw-static-neutral-bluish-800)}",
  darwinLight: "html[data-platform=darwin] body{--dsw-specific-menu:#f8f9faf0}",
  darwinDark: "html[data-platform=darwin] body[data-ds-dark-theme]{--dsw-specific-menu:#303136f0}",
}

/**
 * 归一化主题偏好：只认 light / dark / system；其余（undefined、设置读不到、服务缺失）
 * 一律回退 system（由浏览器按系统偏好解），保证页面永远有可用的配色。
 * @param {unknown} value - 原始偏好值。
 * @returns {'light' | 'dark' | 'system'} 归一化后的偏好。
 */
export function normalizeThemePreference(value) {
  return typeof value === 'string' && THEME_PREFERENCES.includes(value) ? value : 'system'
}

/**
 * 生成设计令牌 `<style>` 的内容：按偏好只射需要的那一套（零脚本、零 CSP 改动）。
 * - light：基础段 + 亮静态 + 亮 alias + darwin 亮；
 * - dark：基础段 + 暗静态 + 暗 alias + darwin 暗（选择器沿用宿主的
 *   `body[data-ds-dark-theme]`，由 renderShell 在 body 上烤出同名属性）；
 * - system：亮那套 + `@media (prefers-color-scheme: dark){...}`，暗色规则的选择器
 *   在媒体查询内改写成 `body`（浏览器自己解不了属性选择器）。
 * @param {unknown} preference - 主题偏好。
 * @returns {string} CSS 文本。
 */
function tokenStyle(preference) {
  const theme = normalizeThemePreference(preference)
  const light = DSH_TOKENS.base + DSH_TOKENS.lightStatic + DSH_TOKENS.lightAlias + DSH_TOKENS.darwinLight
  if (theme === 'light') return light
  const dark = DSH_TOKENS.darkStatic + DSH_TOKENS.darkAlias + DSH_TOKENS.darwinDark
  if (theme === 'dark') return DSH_TOKENS.base + dark
  return light + '@media (prefers-color-scheme: dark){' + dark.replace(/body\[data-ds-dark-theme\]/g, 'body') + '}'
}

/**
 * 说明列的清洗。技能的 frontmatter 是行级解析（`lib/skills.js` 只认单行标量），
 * 写成 YAML 块标量（`>` / `|-` / `>-`）时，解析结果就是那个指示符本身——残渣不如空值。
 * @param {unknown} value - 原始说明文本。
 * @returns {string} 可展示的说明；块标量残渣返回空串。
 */
export function cleanDescription(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) return ''
  if (/^[|>][+-]?\d*$/.test(text)) return ''
  return text
}

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
 * 把抛出的值转成人话。
 * @param {unknown} error - 抛出的值。
 * @returns {string} 可读信息。
 */
function messageOf(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  const message = error.message
  return typeof message === 'string' ? message : String(error)
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

/** 自有样式：颜色 / 圆角 / 字体 / 过渡全部引用 DSH 令牌，这里不出现任何字面色值。 */
const STYLE = `
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family); font-size: 13px; line-height: 1.55; -webkit-font-smoothing: antialiased; }
a { color: var(--dsw-alias-link); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.mono { font-family: var(--ds-font-family-code); font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
.dim { color: var(--dsw-alias-label-tertiary); }
.note { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.hint { color: var(--dsw-alias-state-warn-label); font-size: 12px; }
.clip { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 顶栏 */
.topbar { display: flex; align-items: center; gap: 12px; height: 48px; padding: 0 16px;
  background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l2);
  position: sticky; top: 0; z-index: 20; }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; }
.brand .dot { width: 18px; height: 18px; border-radius: var(--dsw-radius-xs); background: var(--dsw-alias-brand-primary); }
.topbar .spacer { flex: 1; }
.topbar .meta { color: var(--dsw-alias-label-tertiary); font-size: 12px; }

/* 左栏 + 内容列（保留旧骨架：左栏导航，≤720px 变顶部横排） */
.shell { display: grid; grid-template-columns: 216px minmax(0, 1fr); min-height: calc(100vh - 48px); }
.side { background: var(--dsw-specific-sidebar-fill); border-right: 1px solid var(--dsw-alias-border-l2);
  padding: 12px 10px; display: flex; flex-direction: column; gap: 2px; }
.side .sec { font-size: 11px; color: var(--dsw-alias-label-caption); padding: 10px 8px 4px; letter-spacing: .04em; }
.nav-item { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: var(--dsw-radius-sm);
  color: var(--dsw-alias-label-secondary); font-weight: 500; }
.nav-item:hover { background: var(--dsw-specific-sidebar-nav-item-hover); color: var(--dsw-alias-label-primary); text-decoration: none; }
.nav-item[aria-current="page"] { background: var(--dsw-specific-sidebar-nav-item-active); color: var(--dsw-alias-label-primary); }
.nav-item .ico { width: 16px; text-align: center; opacity: .75; }
.nav-item .count { margin-left: auto; font-size: 11px; padding: 1px 6px; border-radius: 999px;
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-tertiary); }
.nav-item .count.hot, .nav-item .count.warn { background: var(--dsw-alias-state-warn-tertiary); color: var(--dsw-alias-state-warn-label); }
.side .back { margin-top: auto; border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 8px; }
.side .back .nav-item { color: var(--dsw-alias-label-tertiary); }
.main { min-width: 0; display: flex; flex-direction: column; }
.content { padding: 20px 24px 64px; max-width: 1180px; }

/* 页头 */
.page-head { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 16px; }
.page-head h1 { margin: 0; font-size: 19px; line-height: 1.35; font-weight: 600; }
.page-head .sub { color: var(--dsw-alias-label-tertiary); font-size: 12px; margin-top: 3px; }
.page-head .actions { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; align-items: center; }
.page-head .actions .clip { max-width: 340px; min-width: 0; }
.crumbs { font-size: 12px; color: var(--dsw-alias-label-tertiary); margin-bottom: 8px; }
.crumbs a { color: var(--dsw-alias-label-secondary); }

/* 按钮 */
.btn { appearance: none; cursor: pointer; font: inherit; font-size: 12.5px; font-weight: 500; padding: 6px 12px;
  border-radius: var(--dsw-radius-sm); border: 1px solid var(--dsw-alias-border-l4);
  background: var(--dsw-alias-button-elevated-fill); color: var(--dsw-alias-label-primary); white-space: nowrap;
  transition: background var(--ds-transition-duration-fast) var(--ds-ease-in-out); }
.btn:hover { background: var(--dsw-alias-interactive-bg-hover-solid); text-decoration: none; }
.btn.primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground);
  border-color: var(--dsw-alias-button-primary-fill); }
.btn.primary:hover { background: var(--dsw-alias-button-primary-hover); border-color: var(--dsw-alias-button-primary-hover); }
.btn.ghost { border-color: var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.btn.ghost:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.btn.danger { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-border-l4); }
.btn.danger:hover { background: var(--dsw-alias-interactive-bg-hover-danger); }
.btn.sm { padding: 3px 9px; font-size: 12px; }
.btn[disabled] { cursor: progress; }
/* 提交中：client/page-ui.js 给被点的 submit 按钮加 .busy（变淡 + 禁用），这里再补个转圈。 */
.busy { opacity: .6; cursor: wait; }
button.busy::before, .btn.busy::before { content: ""; display: inline-block; width: 11px; height: 11px; margin-right: 6px;
  vertical-align: -1px; border-radius: 50%; border: 1.5px solid var(--dsw-alias-border-l3); border-top-color: currentColor;
  animation: spin .6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* 工具条 / 输入框 / 筛选 chip */
.toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 12px; margin-bottom: 12px;
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); }
.toolbar .grow { flex: 1; min-width: 8px; }
.field { display: flex; align-items: center; gap: 6px; min-height: 30px; padding: 2px 6px 2px 10px; min-width: 220px;
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); }
.chips { display: flex; gap: 2px; padding: 2px; background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm); }
.chip { padding: 4px 10px; border-radius: 6px; border: 0; font: inherit; font-size: 12px; cursor: pointer;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.chip:hover { background: var(--dsw-alias-interactive-bg-hover); text-decoration: none; color: var(--dsw-alias-label-primary); }
.chip[aria-pressed="true"] { background: var(--dsw-alias-button-ghost-active-fill); color: var(--dsw-alias-label-primary); font-weight: 500; }
.chip .n { opacity: .7; margin-left: 4px; }

/* 折叠卡：一个来源仓库一张卡，卡头是 details 的 summary（原生，无 JS 也能展开） */
.fold { border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1); margin-bottom: 10px; overflow: hidden; }
.fold > summary { cursor: pointer; padding: 10px 14px; font-weight: 600; font-size: 13px; list-style: none;
  display: flex; align-items: center; gap: 8px; }
.fold > summary::-webkit-details-marker { display: none; }
.fold > summary::before { content: "\\203A"; display: inline-block; color: var(--dsw-alias-label-tertiary);
  transition: transform var(--ds-transition-duration) var(--ds-ease-in-out); }
.fold[open] > summary::before { transform: rotate(90deg); }
.fold[open] > summary { border-bottom: 1px solid var(--dsw-alias-border-l1); }
.fold > summary .hint { margin-left: auto; font-weight: 400; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.fold .body { padding: 0; }
.fold .body.pad { padding: 0 14px 14px; }

/* 表格：粘性表头 top:0。.table-scroll 有 overflow:auto，粘性元素相对它定位——
   偏移写成非 0 会把表头往下推、盖住第一行（README 记过这个坑）。表体里一律不许合并单元格。 */
.table-scroll { overflow: auto; max-width: 100%; }
table { width: 100%; border-collapse: separate; border-spacing: 0; }
th { text-align: left; font-size: 11.5px; font-weight: 500; color: var(--dsw-alias-label-tertiary); padding: 7px 12px;
  background: var(--dsw-alias-bg-layer-2); border-bottom: 1px solid var(--dsw-alias-border-l2); white-space: nowrap; }
/* 只有表头粘，且偏移量必须是 0；单元格（td）一律不 sticky。 */
thead th { position: sticky; top: 0; z-index: 5; }
td { padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: middle; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: var(--dsw-alias-interactive-bg-hover); }
table.skills { table-layout: fixed; min-width: 900px; }
table.search { table-layout: auto; min-width: 560px; }
th.pick, td.pick { text-align: center; padding-left: 6px; padding-right: 6px; }
th.actions, td.actions { text-align: right; }
td.nowrap { white-space: nowrap; }
td.mono { font-family: var(--ds-font-family-code); }
td .clip { max-width: 100%; }
.cellname { display: flex; align-items: center; gap: 8px; min-width: 0; }
.cellname .nm { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cellname .lock { font-size: 11px; color: var(--dsw-alias-label-caption); }
tr.orphan .cellname .nm { text-decoration: line-through; color: var(--dsw-alias-label-tertiary); }
.stack { display: inline-flex; align-items: center; gap: 4px; }
.suffix { font-size: 11px; }
.rowacts { display: flex; gap: 4px; justify-content: flex-end; opacity: .55;
  transition: opacity var(--ds-transition-duration-fast) var(--ds-ease-in-out); }
tr:hover .rowacts, tr:focus-within .rowacts { opacity: 1; }
.search-scroll { overflow: auto; max-height: 360px; margin-top: 6px; border-top: 1px solid var(--dsw-alias-border-l1); }

/* 状态徽标：新增 / 可更新 / 上游已移除 / 已装 / 本地·未托管 */
.badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 500; padding: 1px 8px;
  border-radius: 999px; border: 1px solid var(--dsw-alias-border-l3); white-space: nowrap; }
.badge .bdot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.badge.new { background: var(--dsw-alias-state-business-tertiary); color: var(--dsw-alias-state-business-primary);
  border-color: var(--dsw-alias-state-business-tertiary); }
.badge.upd, .badge.warn { background: var(--dsw-alias-state-warn-tertiary); color: var(--dsw-alias-state-warn-label);
  border-color: var(--dsw-alias-state-warn-tertiary); }
.badge.gone, .badge.err { background: var(--dsw-alias-state-error-secondary); color: var(--dsw-alias-label-primary-inverted);
  border-color: var(--dsw-alias-state-error-secondary); }
.badge.ok { background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-tertiary); border-color: var(--dsw-alias-border-l1); }
.badge.local { background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-secondary); }

/* 批量条：默认常驻（无 JS 也能提交批量动作）；勾选任意行时由 CSS :has() 高亮，
   计数与全选/半选由 client/page-ui.js 增强。 */
.batchbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 9px 12px; margin-bottom: 10px;
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); }
.skills-form:has(input[name="pick"]:checked) .batchbar { background: var(--dsw-alias-bg-multi-select); border-color: var(--dsw-alias-border-l3); }
.batchbar .who { font-weight: 600; }
.batchbar .acts { display: flex; gap: 6px; flex-wrap: wrap; }
.batchbar .acts.push { margin-left: auto; }

/* 空态 / 提示 / toast */
.empty { padding: 40px; text-align: center; color: var(--dsw-alias-label-tertiary);
  border: 1px dashed var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md); }
.empty a { color: var(--dsw-alias-link); }
.msg { padding: 9px 14px; margin: 0 0 10px; border-radius: var(--dsw-radius-sm); font-size: 12.5px;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.msg.ok { color: var(--dsw-alias-state-success-primary); }
.msg.err { color: var(--dsw-alias-state-error-primary); }
.toast { position: fixed; right: 20px; top: 62px; z-index: 60; display: flex; flex-direction: column; gap: 8px; }
.toast .t { background: var(--dsw-alias-toast-bg); color: var(--dsw-alias-toast-label); padding: 9px 14px;
  border-radius: var(--dsw-radius-sm); font-size: 12.5px; box-shadow: 0 6px 20px var(--dsw-alias-bg-mask-2);
  animation: tin var(--ds-transition-duration) var(--ds-ease-in-out); }
.toast .t.err { color: var(--dsw-alias-state-warn-label); }
@keyframes tin { from { opacity: 0; transform: translateY(-6px); } }

/* 仓库卡片（仓库列表页） */
.cards { display: flex; flex-direction: column; gap: 10px; }
.card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md); overflow: hidden; }
.card-head { display: flex; align-items: center; gap: 10px; padding: 11px 14px; flex-wrap: wrap; }
.card-head .name { font-weight: 600; font-size: 13.5px; }
.card-head .stat { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.card-head .acts { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; }
.card-head.divided { border-top: 1px solid var(--dsw-alias-border-l1); }
.card-head.divided .mono { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 表单控件 */
input[type=text], input[type=search] { font: inherit; font-size: 13px; padding: 5px 10px; border-radius: var(--dsw-radius-sm);
  border: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-2); color: inherit; min-width: 240px; }
input[type=checkbox] { appearance: none; width: 14px; height: 14px; margin: 0; vertical-align: -2px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l4); border-radius: 4px; background: var(--dsw-alias-bg-layer-2); position: relative;
  transition: background var(--ds-transition-duration-fast) var(--ds-ease-in-out); }
input[type=checkbox]:checked, input[type=checkbox]:indeterminate { background: var(--dsw-alias-button-info-fill);
  border-color: var(--dsw-alias-button-info-fill); }
input[type=checkbox]:checked::after { content: ""; position: absolute; left: 4px; top: 1px; width: 4px; height: 8px;
  border: solid var(--dsw-alias-label-primary-foreground); border-width: 0 2px 2px 0; transform: rotate(45deg); }
input[type=checkbox]:indeterminate::after { content: ""; position: absolute; left: 3px; top: 5.5px; width: 6px; height: 2px;
  background: var(--dsw-alias-label-primary-foreground); border-radius: 1px; }
.agent-edit { width: 100%; min-height: 420px; padding: 14px; resize: vertical; font-family: var(--ds-font-family-code);
  font-size: 12.5px; line-height: 1.7; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-markdown-code-block);
  border: 1px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md); outline: none; }
.agent-edit:focus { border-color: var(--dsw-alias-state-business-primary); }
/* 放在通用输入规则之后：筛选框在 .field 里不要再画一层边框。 */
.field input { border: 0; background: var(--dsw-alias-bg-layer-2); outline: none; font: inherit; color: inherit; width: 100%; min-width: 0; }
.field input::placeholder { color: var(--dsw-alias-label-caption); }

/* ≤720px：左栏变顶部横排（回到 DSH 的入口保留）、内容铺满、宽表在 .table-scroll 里横滚。 */
@media (max-width: 720px) {
  .shell { grid-template-columns: 1fr; }
  .side { flex-direction: row; flex-wrap: wrap; overflow: auto; border-right: 0;
    border-bottom: 1px solid var(--dsw-alias-border-l2); padding: 8px; }
  .side .sec { display: none; }
  .side .back { margin-top: 0; border-top: 0; padding-top: 0; }
  .nav-item .count { margin-left: 0; }
  .content { padding: 14px 12px 64px; }
  .table-scroll { max-height: 70vh; }
  .page-head { flex-direction: column; }
  .page-head .actions { margin-left: 0; justify-content: flex-start; }
}
@media (prefers-reduced-motion: reduce) {
  * { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
`

/** 表体里一行占位（表格骨架不变：列数与表头一致，且一律不用 colspan / rowspan）。 */
function renderEmptyRow(text, showRepo, extraHtml = '') {
  return '<tr><td class="pick"></td>'
    + (showRepo ? '<td class="dim"></td>' : '')
    + '<td class="dim"></td><td class="dim"></td>'
    + '<td class="dim">' + escapeHtml(text) + extraHtml + '</td>'
    + '<td class="dim"></td><td class="dim"></td><td class="actions"></td></tr>'
}

/**
 * 表格外壳（技能页每个仓库一张、仓库子页一张、待办页一张）。
 * @param {{ showRepo?: boolean, withCheckall?: boolean, body: string }} options - 结构选项与 tbody 内容。
 * @returns {string} HTML。
 */
function tableShell(options) {
  const showRepo = options.showRepo === true
  const columns = showRepo
    ? '<colgroup><col style="width:34px"><col style="width:150px"><col style="width:180px"><col style="width:100px"><col><col style="width:180px"><col style="width:96px"><col style="width:130px"></colgroup>'
    : '<colgroup><col style="width:34px"><col style="width:180px"><col style="width:100px"><col><col style="width:180px"><col style="width:96px"><col style="width:130px"></colgroup>'
  const head = '<tr><th class="pick">'
    + (options.withCheckall === true ? '<input type="checkbox" data-checkall aria-label="全选本组">' : '')
    + '</th>' + (showRepo ? '<th>仓库</th>' : '')
    + '<th>技能</th><th>状态</th><th>说明</th><th>来源路径</th><th>装于</th><th class="actions">操作</th></tr>'
  return '<div class="table-scroll"><table class="skills">' + columns
    + '<thead>' + head + '</thead><tbody>' + options.body + '</tbody></table></div>'
}

/**
 * 一行技能。
 * @param {object} group - 分组。
 * @param {object} item - 行（kind/name/row/remote/checked）。
 * @param {{ showRepo?: boolean, repoHref?: string }} [options] - showRepo=true 时渲染「仓库」列（待办页跨仓聚合）；repoHref 非空时仓库名做成子页链接。
 * @returns {string} HTML。
 */
function renderItem(group, item, options = {}) {
  const row = item.row
  const remote = item.remote
  const showRepo = options.showRepo === true
  const repoHref = typeof options.repoHref === 'string' ? options.repoHref : ''
  // 状态列每行最多一个徽章。优先级：格式不合规(红) > 上游已移除(红) > 可更新(琥珀) > 新增(绿)，
  // 无事 → 「已装」（本地未托管另说）。并发原因不叠徽章，而是合并进第一个徽章的 title（分号连接）。
  const reasons = []
  if (row !== undefined && row.valid !== true) reasons.push({ level: 'gone', label: '格式不合规' })
  if (item.kind === 'orphan') reasons.push({ level: 'gone', label: '上游已移除' })
  if (item.kind === 'update') reasons.push({ level: 'upd', label: '可更新' })
  if (item.kind === 'new') reasons.push({ level: 'new', label: '新增' })
  const statusBadge = reasons.length > 0
    ? '<span class="badge ' + reasons[0].level + '"'
      + (reasons.length > 1 ? ' title="' + escapeHtml(reasons.map((reason) => reason.label).join('；')) + '"' : '')
      + '><span class="bdot"></span>' + reasons[0].label + '</span>'
    : (group.local
      ? '<span class="badge local"><span class="bdot"></span>本地·未托管</span>'
      : '<span class="badge ok"><span class="bdot"></span>已装</span>')
  // 「模型专用」「仅用户可用」不是状态：作为徽章后面的小号 dim 后缀文字，不渲染成徽章。
  const suffixes = []
  if (row !== undefined && row.modelInvocable !== true) suffixes.push('仅用户可用')
  if (row !== undefined && row.userInvocable !== true) suffixes.push('模型专用')
  const suffixText = suffixes.length === 0
    ? ''
    : '<span class="dim suffix">' + suffixes.map((text) => '·' + text).join(' ') + '</span>'

  const cleaned = row !== undefined ? cleanDescription(row.description) : ''
  const description = cleaned.length > 0
    ? cleaned
    : (item.kind === 'new' ? '仓库里有、本地没装' : (item.kind === 'orphan' ? '仓库里已经没有这个技能了' : ''))

  // 整张表在**一个** <form> 里（表单不能嵌套），所以每行按钮靠 name/value 带上自己的目标：
  //   row = <动作>|<仓库>|<技能名>；勾选框用 pick = <仓库>|<技能名>。
  const target = escapeHtml(group.source) + '|' + escapeHtml(item.name)
  // 操作列只留"有事可做"的按钮：不给已装且最新的行挂一个没意义的「更新」。
  const buttons = []
  if (item.kind === 'new') {
    buttons.push('<button class="btn primary sm" type="submit" name="row" value="install|' + target + '">安装</button>')
  } else if (item.kind === 'update') {
    buttons.push('<button class="btn sm" type="submit" name="row" value="update|' + target + '">更新</button>')
    buttons.push('<button class="btn danger sm" type="submit" name="row" value="remove|' + target + '">删除</button>')
  } else {
    buttons.push('<button class="btn danger sm" type="submit" name="row" value="remove|' + target + '">删除</button>')
  }
  // 只有能装或能删的行才给勾选框：已装且最新的技能勾了也没事可做。
  const selectable = item.kind === 'new' || item.kind === 'update' || item.kind === 'orphan'
  const checkbox = selectable
    ? '<input type="checkbox" name="pick" value="' + target + '"'
      + (item.checked === true ? ' checked' : '')
      + ' data-rowpick aria-label="选择 ' + escapeHtml(item.name) + '">'
    : ''

  const location = remote !== undefined && typeof remote.path === 'string' && remote.path.length > 0
    ? remote.path
    : (row !== undefined && row.kind === 'bundle' ? item.name + '/SKILL.md' : '')
  const repoTitle = group.local ? '本地·未托管' : group.source
  const repoCell = showRepo
    ? '<td class="mono">' + (repoHref.length > 0 ? '<a href="' + escapeHtml(repoHref) + '">' : '')
      + '<span class="clip" title="' + escapeHtml(repoTitle) + '">' + escapeHtml(repoTitle) + '</span>'
      + (repoHref.length > 0 ? '</a>' : '') + '</td>'
    : ''
  const state = item.kind === 'new' ? 'new' : item.kind === 'update' ? 'upd' : item.kind === 'orphan' ? 'gone' : (group.local ? 'local' : 'ok')
  return '<tr class="' + (item.kind === 'orphan' ? 'orphan' : '') + '" data-state="' + state
    + '" data-name="' + escapeHtml(item.name) + '">'
    + '<td class="pick">' + checkbox + '</td>'
    + repoCell
    + '<td><div class="cellname"><span class="nm">' + escapeHtml(item.name) + '</span>'
      + (item.kind === 'orphan' ? '<span class="lock" title="上游已移除">⚠</span>' : '') + '</div></td>'
    + '<td class="status"><span class="stack">' + statusBadge + suffixText + '</span></td>'
    + '<td><span class="clip" title="' + escapeHtml(description) + '">' + escapeHtml(description) + '</span></td>'
    + '<td class="mono"><span class="clip" title="' + escapeHtml(location) + '">' + escapeHtml(location) + '</span></td>'
    + '<td class="dim nowrap">' + (row !== undefined && typeof row.installedAt === 'string' && row.installedAt.length > 0 ? escapeHtml(row.installedAt.slice(0, 10)) : '') + '</td>'
    + '<td class="actions"><div class="rowacts">' + buttons.join('') + '</div></td>'
    + '</tr>'
}

/**
 * 一张技能表（tbody 用给定的行）。
 * @param {object} group - 分组。
 * @param {object[]} items - 行。
 * @param {object} [options] - showRepo / repoHref / emptyText / showRepo。
 * @returns {string} HTML。
 */
function renderItemsTable(group, items, options = {}) {
  const withCheckall = items.some((item) => item.kind !== 'installed')
  const body = items.length === 0
    ? renderEmptyRow(options.emptyText ?? '', options.showRepo === true)
    : items.map((item) => renderItem(group, item, options)).join('')
  return tableShell({ showRepo: options.showRepo === true, withCheckall, body })
}

/** 顶部提示（toast 内容）：成功 / 失败同一条通道。 */
function renderMessage(text, ok) {
  if (typeof text !== 'string' || text.length === 0) return ''
  return '<div class="t ' + (ok ? 'ok' : 'err') + '" role="status">' + escapeHtml(text) + '</div>'
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
  const item = (id, label, icon, badges) => '<a class="nav-item" href="' + escapeHtml(pagePath) + '?tab=' + id + '"'
    + (active === id ? ' aria-current="page"' : '') + '><span class="ico">' + icon + '</span>' + escapeHtml(label) + badges + '</a>'
  const skillsBadge = counts.skills > 0 ? '<span class="count">' + String(counts.skills) + '</span>' : ''
  const pendingBadge = counts.pending > 0 ? '<span class="count hot">' + String(counts.pending) + '</span>' : ''
  return '<aside class="side"><div class="sec">导航</div>'
    + item('repos', '仓库', '▤', '')
    + item('skills', '所有技能', '◆', skillsBadge)
    + item('todo', '待办', '◔', pendingBadge)
    + item('agent', 'Agent 提示词', '✎', '')
    + '<div class="back"><a class="nav-item" href="/"><span class="ico">↩</span>回到 DSH 界面</a></div>'
    + '</aside>'
}

/**
 * 页面骨架：head（令牌 + 自有样式 + 唯一外链脚本）+ 顶栏 + 左栏 + 内容列 + toast。
 * @param {object} view - tab / fill / theme / counts / pagePath / message / content。
 * @returns {string} HTML。
 */
function renderShell(view) {
  const theme = normalizeThemePreference(view.theme)
  const colorScheme = theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : 'light dark'
  const counts = view.counts ?? { skills: 0, pending: 0 }
  return '<!doctype html><html lang="zh-CN" data-theme-pref="' + theme + '"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>Agents&amp;Skills · dsh-agents-skills</title>'
    + '<style>' + STYLE + ':root{color-scheme:' + colorScheme + '}</style>'
    // 令牌单独一块：自有样式在它前面，顺序无关（自定义属性在使用时解析），
    // 分开的用意是「自有样式里不许写死色值」这条能独立校验。
    + '<style>' + tokenStyle(theme) + '</style>'
    // 唯一允许的脚本：外链本站自己 serve 的 pjax 薄层（CSP script-src 'self'），defer 不阻塞渲染。
    + '<script src="' + escapeHtml(view.pagePath) + '?asset=' + PAGE_UI_ASSET + '" defer></script>'
    + '</head><body' + (theme === 'dark' ? ' data-ds-dark-theme' : '') + '>'
    + '<header class="topbar"><span class="brand"><span class="dot"></span>Agents&nbsp;&amp;&nbsp;Skills</span>'
    + '<span class="meta">独立页 · <span class="mono">' + escapeHtml(view.pagePath) + '</span></span>'
    + '<span class="spacer"></span></header>'
    + '<div class="shell">' + renderNav(view.tab, counts, view.pagePath)
    + '<main class="main"><section class="content' + (view.fill === true ? ' skills-page' : '') + '">' + view.content + '</section></main>'
    + '</div>'
    + '<div class="toast" id="toast" aria-live="polite">' + view.message + '</div>'
    + '</body></html>'
}

/**
 * Agent 页：整份 AGENTS.md 的查看与保存（纯表单，SSR 事实源）。
 * @param {object} view - agent / counts / pagePath / theme / message。
 * @returns {string} HTML。
 */
function renderAgentPage(view) {
  const agent = view.agent
  const status = agent.exists
    ? '已存在 · ' + String(agent.size) + ' 字节 · 上限 ' + String(agent.limitBytes) + ' 字节'
    : '尚未创建 · 保存后自动新建'
  const head = '<div class="page-head"><div><h1>Agent 提示词</h1>'
    + '<div class="sub">' + escapeHtml(status) + '</div></div>'
    + '<div class="actions"><span class="mono clip" title="' + escapeHtml(agent.path) + '">' + escapeHtml(agent.path) + '</span></div>'
    + '</div>'
  const content = head
    + '<form method="post">'
    + '<input type="hidden" name="action" value="saveAgent">'
    + '<input type="hidden" name="back" value="?tab=agent">'
    + '<textarea class="agent-edit" name="content" spellcheck="false" aria-label="全局 Agent 提示词" placeholder="在这里写全局规则，例如：# 全局规则">'
    + escapeHtml(agent.content) + '</textarea>'
    + '<div class="toolbar"><button class="btn primary" type="submit">保存</button>'
    + '<a class="btn ghost" href="' + escapeHtml(view.pagePath) + '?tab=agent">重新读取</a>'
    + '<span class="note">切换标签会丢弃未保存的修改，先点保存。</span></div></form>'
    + (agent.size > agent.limitBytes
      ? '<div class="msg err">已超过 ' + String(agent.limitBytes) + ' 字节预算，超出部分可能被丢弃。</div>'
      : '')
    // 四行说明收进原生折叠区（不依赖 JS）。
    + '<details class="fold"><summary>使用说明</summary><div class="body pad">'
    + '<div class="note">这是「全局层」指令：装了 agent-instructions 的预设（本机是 standard / cordis / ptc）会在每个新会话的第一次请求里把它注入给模型，对所有项目生效。</div>'
    + '<div class="note">保存是整文件替换：覆盖前旧内容会先备份到同目录的 AGENTS.md.bak；保存空内容等于清空规则但文件还在。</div>'
    + '<div class="note">改动不影响当前会话，从下一个新会话开始生效。</div>'
    + '<div class="note">这一页没有实时字数统计、没有 Ctrl+S、也不保护未保存的草稿（本页只加载了一个做局部刷新的小脚本，没有编辑器能力）；要这些就去设置里的 Agents&amp;Skills 面板。</div>'
    + '</div></details>'
  return renderShell({ tab: 'agent', counts: view.counts, theme: view.theme, pagePath: view.pagePath, message: view.message, content })
}

/**
 * 状态筛选是否命中这一行。
 * @param {object} group - 分组。
 * @param {object} item - 行。
 * @param {string} filterKey - all / todo / new / upd / gone / local。
 * @returns {boolean} 是否显示。
 */
function matchesState(group, item, filterKey) {
  if (filterKey === 'all') return true
  if (filterKey === 'todo') return item.kind !== 'installed'
  if (filterKey === 'new') return item.kind === 'new'
  if (filterKey === 'upd') return item.kind === 'update'
  if (filterKey === 'gone') return item.kind === 'orphan'
  if (filterKey === 'local') return group.local
  return true
}

/**
 * 按「状态 chip + 名字筛选」收窄分组：没命中的行与整组都没命中的分组都不渲染。
 * @param {object[]} groups - 全部分组。
 * @param {string} filterKey - 状态。
 * @param {string} nameFilter - 名字子串。
 * @returns {object[]} 可见分组（items 已过滤）。
 */
function filterGroups(groups, filterKey, nameFilter) {
  // 没筛选时原样保留**全部**分组：订阅仓哪怕一个技能都没装（items 空）也要露面，
  // 卡片头给出「已装 0/N · 未检查」，卡内给一行空表行。
  if (filterKey === 'all' && nameFilter.length === 0) return groups.slice()
  const needle = nameFilter.toLowerCase()
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => matchesState(group, item, filterKey)
        && (needle.length === 0 || item.name.toLowerCase().includes(needle))),
    }))
    .filter((group) => group.items.length > 0)
}

/**
 * 一个来源仓库的折叠卡：默认只展开有待办的仓库，其余折起并在卡头显示计数。
 * @param {object} group - 分组（items 已按筛选过滤）。
 * @param {object} view - filterKey / nameFilter。
 * @returns {string} HTML。
 */
function renderFold(group, view) {
  const title = group.local ? '本地 · 未托管' : group.source
  const hints = ['已装 ' + installedTextOf(group)]
  if (group.local) hints.push('手写技能 · 不参与检查/更新')
  else if (!group.checked) hints.push('未检查')
  else {
    if (group.news.length > 0) hints.push('新增 ' + String(group.news.length))
    if (group.updatable.length > 0) hints.push('可更新 ' + String(group.updatable.length))
    if (group.orphans.length > 0) hints.push('上游已移除 ' + String(group.orphans.length))
  }
  // 默认折叠策略：只展开有待办的仓库；一旦用了筛选，命中的组也展开（否则筛选结果看不见）。
  const open = group.pending > 0 || view.filterKey !== 'all' || view.nameFilter.length > 0
  // 「选中全部待办」由 URL 决定（无 JS 也能全选）；已装且最新的行没有勾选框，不参与。
  const items = group.items.map((item) => (view.pickAll === true && item.kind !== 'installed' ? { ...item, checked: true } : item))
  return '<details class="fold"' + (open ? ' open' : '') + ' data-fold="' + escapeHtml(group.key) + '">'
    + '<summary><span class="ttl">' + escapeHtml(title) + '</span><span class="hint">' + escapeHtml(hints.join(' · ')) + '</span></summary>'
    + '<div class="body">' + renderItemsTable(group, items, {}) + '</div>'
    + '</details>'
}

/**
 * 批量条：三个批量动作 + 选中全部待办 + 计数位（默认常驻，无 JS 可用；计数与高亮由交互层增强）。
 * @param {object} view - pickAll / links / updateAll。
 * @returns {string} HTML。
 */
function renderBatchBar(view) {
  const updateAll = Array.isArray(view.updateAll) ? view.updateAll : []
  return '<div class="batchbar" id="batchbar">'
    + '<span class="who" id="pickCount" data-pick-count>勾选行后可批量操作</span>'
    + '<span class="acts">'
    + '<button class="btn primary sm" type="submit" name="batch" value="install">安装选中</button>'
    + '<button class="btn sm" type="submit" name="batch" value="update">更新选中</button>'
    + '<button class="btn danger sm" type="submit" name="batch" value="remove">删除选中</button>'
    + (updateAll.length === 0 ? '' : '<button class="btn sm" type="submit" name="batch" value="updateAll">更新全部 (' + String(updateAll.length) + ')</button>')
    + '</span>'
    + '<span class="acts push"><a class="btn ghost sm" href="' + escapeHtml(view.links.pickAll) + '">' + (view.pickAll ? '取消全选' : '选中全部待办') + '</a></span>'
    + '</div>'
}

/**
 * 技能页：顶部工具条（名字筛选 + 状态 chip）+ 分仓库折叠卡 + 搜索安装 + 使用说明。
 * @param {object} view - 技能视图数据。
 * @returns {string} HTML。
 */
function renderSkillsPage(view) {
  const groups = Array.isArray(view.groups) ? view.groups : []
  const visible = Array.isArray(view.visible) ? view.visible : groups
  const totals = groups.reduce((sum, group) => ({
    news: sum.news + group.news.length,
    updatable: sum.updatable + group.updatable.length,
    orphans: sum.orphans + group.orphans.length,
  }), { news: 0, updatable: 0, orphans: 0 })
  const pending = totals.news + totals.updatable + totals.orphans
  const repoCount = groups.filter((group) => !group.local).length
  const localCount = groups.filter((group) => group.local).reduce((sum, group) => sum + group.items.length, 0)
  const updateAll = groups.flatMap((group) => group.updatable.map((item) => item.name))
  const summary = view.delta === null
    ? '未检查'
    : '新增 ' + String(totals.news) + ' · 可更新 ' + String(totals.updatable) + ' · 已移除 ' + String(totals.orphans)
  const stats = String(view.skills.length) + ' 个技能 · ' + String(repoCount) + ' 个来源仓库 · ' + summary
    + (view.checkedAt.length > 0 ? ' · 上次检查 ' + view.checkedAt : '')
  const head = '<div class="page-head"><div><h1>所有技能</h1><div class="sub">' + escapeHtml(stats) + '</div></div>'
    + '<div class="actions"><a class="btn ghost" href="' + escapeHtml(view.links.todo) + '">'
    + (view.todoOnly ? '显示全部' : '仅显示待办') + '</a>'
    + '<a class="btn" href="' + escapeHtml(view.links.check) + '">检查更新</a></div></div>'
  const notes = view.notes.length === 0 ? '' : '<div class="note">' + view.notes.map((text) => '· ' + escapeHtml(text)).join('<br>') + '</div>'

  // 名字筛选走 GET `filter`（无 JS 也能筛）；chip 是链接（GET），因此会一并带上当前筛选值。
  const filterForm = '<form class="field" method="get" action="' + escapeHtml(view.pagePath) + '">'
    + '<input type="hidden" name="tab" value="skills">'
    + (view.filterKey === 'todo' ? '<input type="hidden" name="todo" value="1">'
      : (view.filterKey === 'all' ? '' : '<input type="hidden" name="state" value="' + escapeHtml(view.filterKey) + '">'))
    + (view.checkFlag ? '<input type="hidden" name="check" value="1">' : '')
    + (view.pickAll ? '<input type="hidden" name="pickall" value="1">' : '')
    + '<input type="search" name="filter" value="' + escapeHtml(view.nameFilter) + '" data-live-filter aria-label="按技能名筛选"'
    + ' placeholder="按技能名筛选（实时）" autocomplete="off">'
    + '<button class="btn sm" type="submit">筛选</button></form>'
  const chip = (id, label, count) => '<a class="chip" href="' + escapeHtml(view.links.states[id]) + '"'
    + ' aria-pressed="' + (view.filterKey === id ? 'true' : 'false') + '">' + escapeHtml(label)
    + '<span class="n">' + String(count) + '</span></a>'
  const chips = '<span class="chips" role="group" aria-label="状态筛选">'
    + chip('all', '全部', view.skills.length)
    + chip('todo', '待办', pending)
    + chip('new', '新增', totals.news)
    + chip('upd', '可更新', totals.updatable)
    + chip('gone', '上游已移除', totals.orphans)
    + chip('local', '本地·未托管', localCount)
    + '</span>'
  const toolbar = '<div class="toolbar">' + filterForm + chips
    + '<span class="grow"></span><span class="note">勾选任意行即可批量操作</span></div>'

  const emptyText = filterKeyIsFiltered(view)
    ? '没有匹配的技能，换个筛选条件试试。'
    : (view.skills.length === 0 ? '这里还没有技能。可以用下面的「搜索安装」。' : '没有可显示的技能。')
  const body = '<form class="skills-form" method="post"><input type="hidden" name="back" value="' + escapeHtml(view.back) + '">'
    + renderBatchBar({ ...view, updateAll })
    + visible.map((group) => renderFold(group, view)).join('')
    + '</form>'
  const empty = visible.length === 0 ? '<div class="empty">' + escapeHtml(emptyText) + '</div>' : ''

  // 表格下方两个原生折叠区（不依赖 JS）：搜索安装 + 使用说明。有搜索结果时搜索区默认展开。
  const search = '<details class="fold"' + (view.results === null ? '' : ' open') + '>'
    + '<summary>搜索安装</summary>'
    + '<div class="body pad">'
    + '<form class="toolbar" method="get" action="' + escapeHtml(view.pagePath) + '">'
    + '<input type="hidden" name="tab" value="skills">'
    + '<div class="field grow"><input type="text" name="q" aria-label="搜索关键词" value="' + escapeHtml(view.query) + '"'
    + ' placeholder="关键词，例如 react / review / changelog"></div>'
    + '<button class="btn primary" type="submit">搜索</button></form>'
    + (view.results === null
      ? '<div class="note">走 npx skills find，安装时用 -a universal，只落到用户级技能目录。</div>'
      : '<div class="note">' + escapeHtml(view.results.note) + '</div>'
        + '<div class="search-scroll"><table class="search"><thead><tr><th>仓库@技能</th><th>安装量</th><th>链接</th><th class="actions"></th></tr></thead><tbody>'
        + view.results.results.map((item) => '<tr><td class="mono">' + escapeHtml(item.repo + '@' + item.skill) + '</td>'
          + '<td><span class="badge">' + escapeHtml(item.installs) + '</span></td>'
          + '<td class="dim">' + (item.url.length > 0 ? '<a href="' + escapeHtml(item.url) + '" rel="noreferrer noopener" target="_blank">' + escapeHtml(item.url) + '</a>' : '') + '</td>'
          + '<td class="actions"><form method="post"><input type="hidden" name="action" value="install">'
          + '<input type="hidden" name="source" value="' + escapeHtml(item.repo) + '">'
          + '<input type="hidden" name="skills" value="' + escapeHtml(item.skill) + '">'
          + '<input type="hidden" name="back" value="' + escapeHtml(view.back) + '">'
          + '<button class="btn primary sm" type="submit">安装</button></form></td></tr>').join('')
        + '</tbody></table></div>')
    + '</div></details>'

  const guide = '<details class="fold"><summary>使用说明</summary><div class="body pad">'
    + '<div class="mono">技能根目录：' + escapeHtml(view.root) + '</div>'
    + '<div class="note">每个折叠卡是一个来源仓库，卡头右侧是「已装 / 新增 / 可更新 / 已移除」计数；默认只展开有待办的仓库。</div>'
    + '<div class="note">技能就是带 frontmatter 的 Markdown：' + escapeHtml(view.root) + '/&lt;名字&gt;/SKILL.md 或平铺 &lt;名字&gt;.md，DSH 只扫这一层，改动由它自带的文件监听热生效——装完不用重启。</div>'
    + '<div class="note">「新增」= 仓库里有、本地没装；「可更新」= 技能目录的 sha 与 npx skills 记的指纹不一致；「上游已移除」= 你装了但仓库里已经没有了（只提示，不自动删）。</div>'
    + '<div class="note">装 / 删 / 更新 / 搜索都由 npx skills（skills.sh 生态）执行：安装加 -a universal，只写用户级目录；删除不加 -a，让 CLI 顺手清掉可能存在的软链。</div>'
    + '<div class="note">这个页面与聊天界面共用同一道登录校验（DSH 的浏览器 cookie），没有登录过只能看到 401；页面脚本仅限本站自身的一个文件（client/page-ui.js，只做局部刷新），内联脚本仍被 CSP 禁止。</div>'
    + '</div></details>'

  return renderShell({
    tab: 'skills',
    fill: true,
    theme: view.theme,
    counts: view.counts,
    pagePath: view.pagePath,
    message: view.message,
    content: head + notes + toolbar + body + empty + search + guide,
  })
}

/**
 * 是否处于「收窄」状态（决定空态文案）。
 * @param {object} view - filterKey / nameFilter。
 * @returns {boolean} 有筛选时 true。
 */
function filterKeyIsFiltered(view) {
  return view.filterKey !== 'all' || view.nameFilter.length > 0
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
 * 仓库列表「状态」格：无事 → dim 文案，有事 → 徽章。
 * @param {object} group - 分组。
 * @returns {string} HTML。
 */
function repoStatusOf(group) {
  if (group.error.length > 0 || group.mode === 'failed') {
    const reason = group.error.length > 0 ? group.error : '检查失败'
    return '<span class="badge gone" title="' + escapeHtml(reason) + '"><span class="bdot"></span>检查失败</span>'
  }
  if (!group.checked) {
    return group.origin === 'subscribed'
      ? '<span class="dim">订阅·未检查</span>'
      : '<span class="dim">未检查</span>'
  }
  const badges = []
  if (group.news.length > 0) badges.push('<span class="badge new"><span class="bdot"></span>新增 ' + String(group.news.length) + '</span>')
  if (group.updatable.length > 0) badges.push('<span class="badge upd"><span class="bdot"></span>可更新 ' + String(group.updatable.length) + '</span>')
  if (group.orphans.length > 0) badges.push('<span class="badge gone"><span class="bdot"></span>已移除 ' + String(group.orphans.length) + '</span>')
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
  const buttons = ['<button class="btn ghost sm" type="submit" name="row" value="check|' + source + '|">检查</button>']
  if (group.news.length > 0) {
    buttons.push('<button class="btn primary sm" type="submit" name="row" value="installAll|' + source + '|">装全部新增 (' + String(group.news.length) + ')</button>')
  }
  if (group.updatable.length > 0) {
    buttons.push('<button class="btn sm" type="submit" name="row" value="updateAll|' + source + '|">更新全部 (' + String(group.updatable.length) + ')</button>')
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
  return pagePath + '?tab=repo&repo=' + encodeURIComponent(group.key)
}

/**
 * 「已装」读数：查过用 x/y，没查过只有已装数。
 * @param {object} group - 分组。
 * @returns {string} 文本。
 */
function installedTextOf(group) {
  return group.available >= 0 ? String(group.installed) + '/' + String(group.available) : String(group.installed)
}

/**
 * 仓库卡片（仓库列表页；技能表仍是表格，卡片只承载仓库级信息与操作）。
 * @param {object} group - 分组。
 * @param {object} view - pagePath。
 * @returns {string} HTML。
 */
function renderRepoCard(group, view) {
  const title = group.local ? '本地 · 未托管' : group.source
  const preview = group.items.slice(0, 3).map((item) => item.name).join(' · ')
    + (group.items.length > 3 ? ' · +' + String(group.items.length - 3) : '')
  return '<article class="card"><div class="card-head">'
    + '<a class="name" href="' + escapeHtml(repoHrefOf(view.pagePath, group)) + '">' + escapeHtml(title) + '</a>'
    + '<span class="stack">' + repoStatusOf(group) + '</span>'
    + '<span class="stat">已装 ' + escapeHtml(installedTextOf(group)) + '</span>'
    + '<span class="acts">' + repoButtons(group) + '</span>'
    + '</div>'
    + '<div class="card-head divided"><span class="mono">' + escapeHtml(preview.length > 0 ? preview : '（没有技能）') + '</span>'
    + '<span class="stat">' + escapeHtml(repoOriginLabel(group)) + '</span></div>'
    + '</article>'
}

/**
 * 视图 1：仓库列表（默认页）。卡片承载仓库级动作，技能明细在子页。
 * @param {object} view - groups / links / back / pagePath / checkedAgo / counts / theme / message。
 * @returns {string} HTML。
 */
function renderRepoListPage(view) {
  const groups = view.groups.slice().sort((left, right) => {
    if (left.local !== right.local) return left.local ? 1 : -1
    if (right.pending !== left.pending) return right.pending - left.pending
    return left.source < right.source ? -1 : left.source > right.source ? 1 : 0
  })
  const subscribed = groups.filter((group) => group.origin === 'subscribed').length
  const todoTotal = groups.reduce((sum, group) => sum + group.pending, 0)
  const stats = String(groups.length) + ' 个仓库 · ' + String(subscribed) + ' 个订阅 · 待办 ' + String(todoTotal)
    + (view.checkedAgo.length > 0 ? ' · 上次检查 ' + view.checkedAgo : '')
  const head = '<div class="page-head"><div><h1>仓库</h1><div class="sub">' + escapeHtml(stats) + '</div></div>'
    + '<div class="actions"><a class="btn" href="' + escapeHtml(view.links.check) + '">检查更新</a></div></div>'
  const addForm = '<form class="toolbar" method="post">'
    + '<input type="hidden" name="action" value="subscribe">'
    + '<input type="hidden" name="back" value="' + escapeHtml(view.back) + '">'
    + '<div class="field grow"><span class="mono">owner/repo</span>'
    + '<input type="text" name="source" aria-label="仓库来源" placeholder="例如 anthropics/skills"></div>'
    + '<button class="btn primary" type="submit">添加</button>'
    + '<span class="note">支持 owner/repo 或完整 URL</span></form>'

  if (groups.length === 0) {
    const guide = '<div class="empty">还没有仓库。在上面输入 owner/repo 添加一个，或去'
      + '<a href="' + escapeHtml(view.pagePath) + '?tab=skills">「所有技能」</a>里搜索安装。</div>'
    return renderShell({
      tab: 'repos',
      fill: true,
      theme: view.theme,
      counts: view.counts,
      pagePath: view.pagePath,
      message: view.message,
      content: head + addForm + guide,
    })
  }

  const body = '<form class="skills-form" method="post"><input type="hidden" name="back" value="' + escapeHtml(view.back) + '">'
    + '<div class="cards">' + groups.map((group) => renderRepoCard(group, view)).join('') + '</div></form>'

  return renderShell({
    tab: 'repos',
    fill: true,
    theme: view.theme,
    counts: view.counts,
    pagePath: view.pagePath,
    message: view.message,
    content: head + addForm + body,
  })
}

/**
 * 视图 2：仓库子页。技能表去掉「仓库」列，其余行渲染 / 批量协议与技能页同一套。
 * @param {object} view - group / groups / links / back / pagePath / pickAll / counts / theme / message。
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
      theme: view.theme,
      counts: view.counts,
      pagePath,
      message: view.message,
      content: crumbs + '<div class="msg err">没有找到这个仓库。</div>',
    })
  }

  const title = group.local ? '本地 · 未托管' : group.source
  let stats = '已装 ' + installedTextOf(group)
  if (group.local) {
    // 本地未托管：没有远端可对比，统计只说已装数。
  } else if (!group.checked) {
    stats += ' · 未检查'
  } else {
    stats += ' · 新增 ' + String(group.news.length) + ' · 可更新 ' + String(group.updatable.length) + ' · 已移除 ' + String(group.orphans.length)
  }
  const head = '<div class="page-head"><div><h1 class="mono">' + escapeHtml(title) + '</h1>'
    + '<div class="sub">' + escapeHtml(stats) + '</div></div>'
    + '<div class="actions">' + repoButtons(group) + '</div></div>'

  const itemRows = group.items.map((item) => {
    const row = view.pickAll === true && item.kind !== 'installed' ? { ...item, checked: true } : item
    return renderItem(group, row, {})
  }).join('')
  let rows = ''
  if (!group.checked && !group.local) {
    // 订阅但还没查过：表格位置先给一行提示，已装的行使照常显示（不藏用户的技能）。
    rows = renderEmptyRow('尚未检查，点右上角[检查]看看有什么可装。', false) + itemRows
  } else if (itemRows.length === 0) {
    rows = renderEmptyRow('这个仓库还没有技能。', false)
  } else {
    rows = itemRows
  }

  const body = '<form class="skills-form" method="post"><input type="hidden" name="back" value="' + escapeHtml(view.back) + '">'
    + crumbs + head + renderBatchBar({ ...view, updateAll: group.updatable.map((item) => item.name) })
    + tableShell({ withCheckall: group.items.some((item) => item.kind !== 'installed'), body: rows })
    + '</form>'

  return renderShell({
    tab: 'repo',
    fill: true,
    theme: view.theme,
    counts: view.counts,
    pagePath,
    message: view.message,
    content: body,
  })
}

/**
 * 视图 3：待办。跨仓聚合所有 kind !== 'installed' 的行，按仓库组序。
 * @param {object} view - groups / links / back / pagePath / pickAll / delta / counts / theme / message。
 * @returns {string} HTML。
 */
function renderTodoPage(view) {
  const groups = Array.isArray(view.groups) ? view.groups : []
  const totals = groups.reduce((sum, group) => ({
    news: sum.news + group.news.length,
    updatable: sum.updatable + group.updatable.length,
    orphans: sum.orphans + group.orphans.length,
  }), { news: 0, updatable: 0, orphans: 0 })
  const pending = totals.news + totals.updatable + totals.orphans
  const updateAll = groups.flatMap((group) => group.updatable.map((item) => item.name))
  const head = '<div class="page-head"><div><h1>待办</h1>'
    + '<div class="sub">新增 ' + String(totals.news) + ' · 可更新 ' + String(totals.updatable) + ' · 上游已移除 ' + String(totals.orphans) + '</div></div>'
    + '<div class="actions"></div></div>'

  const entries = []
  for (const group of groups) {
    for (const item of group.items) {
      if (item.kind === 'installed') continue
      entries.push({ group, item })
    }
  }
  const rows = entries.length === 0
    ? renderEmptyRow(view.delta === null ? '还没检查过，先点右上角「检查更新」。' : '没有待办：所有盯着的仓库都已装上且最新。', true,
      view.delta === null ? ' <a class="btn sm" href="' + escapeHtml(view.links.check) + '">检查更新</a>' : '')
    : entries.map(({ group, item }) => renderItem(group,
      view.pickAll === true ? { ...item, checked: true } : item,
      { showRepo: true, repoHref: repoHrefOf(view.pagePath, group) })).join('')

  const body = '<form class="skills-form" method="post"><input type="hidden" name="back" value="' + escapeHtml(view.back) + '">'
    + renderBatchBar({ ...view, updateAll })
    + tableShell({ showRepo: true, withCheckall: entries.length > 0, body: rows })
    + '</form>'

  return renderShell({
    tab: 'todo',
    fill: true,
    theme: view.theme,
    counts: view.counts,
    pagePath: view.pagePath,
    message: view.message,
    content: head + body,
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
 * @param {() => unknown} [deps.theme] - 读 DSH 主题偏好（light/dark/system）；缺省或读不到时回退 system。
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
        message = '失败：' + messageOf(error)
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
    const nameFilter = (url.searchParams.get('filter') ?? '').trim().slice(0, FILTER_MAX)
    const checkFlag = url.searchParams.get('check') ?? ''
    const stateParam = url.searchParams.get('state') ?? ''
    const state = STATE_IDS.includes(stateParam) ? stateParam : 'all'
    const todoOnly = url.searchParams.get('todo') === '1' || state === 'todo'
    const filterKey = todoOnly ? 'todo' : state
    const pickAll = url.searchParams.get('pickall') === '1'
    const message = url.searchParams.get('msg') ?? ''
    const messageOk = url.searchParams.get('ok') === '1'
    // DSH 主题偏好（Host 用户设置 `ui-theme`）：读不到就回退 system。
    let themeRaw
    try {
      themeRaw = typeof deps.theme === 'function' ? await deps.theme() : undefined
    } catch {
      themeRaw = undefined
    }
    const theme = normalizeThemePreference(themeRaw)
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
      if (nameFilter.length > 0) params.set('filter', nameFilter)
      if (state !== 'all' && state !== 'todo') params.set('state', state)
      if (todoOnly) params.set('todo', '1')
      if (checkFlag === '1' || checkFlag === '2') params.set('check', '1')
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
    // 状态 chip 的链接：`todo` 沿用既有 `todo=1`，其余用 `state=<all|new|upd|gone|local>`。
    const linkState = (value) => {
      const next = new URLSearchParams(params)
      next.delete('state')
      next.delete('todo')
      if (value === 'todo') next.set('todo', '1')
      else if (value !== 'all') next.set('state', value)
      const text = next.toString()
      return pagePath + (text.length === 0 ? '' : '?' + text)
    }
    const links = {
      check: linkWith('check', '2'),
      // 「仅显示待办 / 显示全部」开关沿用既有 `todo=1` 参数（chip 里的「待办」同一个链接）。
      todo: linkState(todoOnly ? 'all' : 'todo'),
      pickAll: pickAll ? linkWith('pickall', null) : linkWith('pickall', '1'),
      states: {
        all: linkState('all'),
        todo: linkState('todo'),
        new: linkState('new'),
        upd: linkState('upd'),
        gone: linkState('gone'),
        local: linkState('local'),
      },
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
        theme,
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
        theme,
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
          visible: filterGroups(groups, filterKey, nameFilter),
          filterKey,
          nameFilter,
          checkFlag: checkFlag === '1' || checkFlag === '2',
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
