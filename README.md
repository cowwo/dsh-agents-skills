# dsh-agents-skills

设置 → **Agents&Skills**，两个标签页；标签行右侧另有一个 **独立页面 ↗** 入口（同一套功能，单独一个网址）：

| 入口 | 做什么 |
|---|---|
| **Agent** 标签 | 查看并实时编辑用户全局指令文件 `$DSH_HOME/AGENTS.md`（默认 `~/.dsh/AGENTS.md`） |
| **Skills** 标签 | 列出 `$DSH_AGENTS_HOME/skills`（默认 `~/.agents/skills`）的技能；按来源仓库查出「新增 / 可更新 / 上游已移除」；装、删、更新交给 `npx skills` |
| **Agents&Skills 独立页**（`/dsh-agents-skills`） | 完整管理台：左栏导航（仓库列表 / 所有技能 / 待办 / Agent）+ Agent 编辑器 + 技能管理，服务端渲染的纯 HTML，不依赖聊天界面；门禁与聊天界面同一道 |

## Agent 标签

| 能力 | 说明 |
|---|---|
| 看 | 显示文件绝对路径、是否存在、当前字节数，以及全文 |
| 改 | 一个等宽 Markdown 编辑框，直接改 |
| 存 | 「保存」整文件替换，覆盖前把旧内容备份成同目录的 `AGENTS.md.bak`；Ctrl/Cmd+S 同样保存 |
| 重读 | 「重新读取」丢弃草稿、重新拉取磁盘内容 |
| 防超支 | 实时显示字符数 / UTF-8 字节数 / 加载器上限（65536 字节），超了给黄色警告 |

只写**全局层**这一个文件。项目层 `AGENTS.md` / `CLAUDE.md` / `.local.md` 与预设人格不在范围内。

生效时机：由 `@deepseek-ai/dsh-agent-instructions` 注入，Web profile 在宿主层关掉了它，
但 `standard` / `cordis` / `ptc` 三个预设各自带回来了。**改动不影响当前会话**，新开会话才看得到。

## Skills 标签

整页就是**一张按来源仓库分组的列表**（+ 底部独立的「搜索安装」）：

```
~/.agents/skills · 48 个技能 · 5 个来源仓库 · 新增 25 · 可更新 18 · 已移除 1
[检查更新] [全部更新] [全部展开]   [ ] 仅显示待办            上次检查 11:02:31

▸ mattpocock/skills   已装 37/38  新增 2  可更新 18  已移除 1              [重查]
▸ anthropics/skills   已装 1/20   新增 19                                 [重查]
▸ 本地·未托管         已装 1
```

| 规则 | 说明 |
|---|---|
| 分组 | 一个来源仓库一组；不在 `npx skills` 账本里的技能归入「本地·未托管」（例如软链到开发目录的），**永远排最后** |
| 顺序 | 有待办的排前面（待办多的在前），其余按仓库名字典序 |
| 默认状态 | **全部折叠**；`[全部展开]` / `[全部折叠]` 是同一个按钮，标签随状态变；点组标题行单独展开/收起 |
| 折叠行 | 仓库名 + `已装 x/y` + 新增/可更新/已移除徽章 + `[重查]`（只重查这一个仓库，1 个请求） |
| 组内 | 默认**按技能名排列**；一行一个技能：状态徽章 + 名字 + 说明（截断）+ 安装日期 + 行内操作 |
| 行内状态 | `新增`（仓库里有、本地没装，可装）/ `可更新`（sha 与账本不一致）/ `上游已移除`（你装了但仓库没了，只提示可删）/ 无徽章=已装；另有 `格式不合规`、`模型不可见`、`用户不可见` |
| 行内操作 | 只有单技能操作：`看正文`（只读）、`安装`、`更新`、`删除`。**没有组级批量按钮** |
| 仅显示待办 | 勾上后只留有 新增/可更新/已移除 的仓库，且组内只留这些行；「本地·未托管」随之隐藏 |
| 数据不打架 | 装上的不再显示为「新增」，删掉的「已移除」也消失（动作成功后按名字摘除对应条目，不用重查） |

### 「新增 / 可更新」是怎么算出来的（这是本页的核心）

`npx skills` 装技能时会在 `~/.agents/.skill-lock.json` 记下每个技能的**来源仓库**与
`skillFolderHash`。这个 hash 就是该技能目录在 Git 里的 **tree sha**，于是：

1. 从锁文件取出全部来源仓库（本机当前是 5 个）；
2. 每个仓库发一个请求取整棵文件树，过滤出所有 `SKILL.md`（仓库根或任意层级）；
3. 比对：**树里有、锁里没有 = 新增**；**目录 sha 与锁里的 hash 不一致 = 可更新**；
   **锁里有、树里没有 = 上游已移除**（只提示，不自动删）。

实测：`mattpocock/skills` 仓库 38 个技能、本地装了 37 个 → 新增 `pr`、`chief-of-staff`，
另有 1 个 `resolving-merge-conflicts` 上游已删除。整个检查 5 个仓库约 2.6 秒。

鉴权：装了 `gh` 或设了 `GH_TOKEN` / `GITHUB_TOKEN` 时用你的额度（5000 次/小时，且能读私有仓库）；
都没有就匿名调用（60 次/小时）。网络/限流失败时**回落**到 `npx skills add <仓库> -l`（能判断新增与移除，判断不了更新，页面会标「降级模式」）。

### 装 / 删 / 更新由 `npx skills` 执行

| 动作 | 实际命令 |
|---|---|
| 安装 | `npx skills add <仓库> -a universal -g -y --json -s <技能名>…` |
| 删除 | `npx skills remove -g -y -s <技能名>` |
| 更新 | `npx skills update -g -y [技能名…]` |
| 搜索 | `npx skills find <关键词>` |

安装固定带 `-a universal`：只写 `~/.agents/skills`，不会顺带往 50 多个 agent 目录里建软链；
删除不带 `-a`，让 CLI 按默认行为把可能存在的软链一起清掉。

执行完**回到磁盘与锁文件核对**：`npx skills` 的 `--json` 只在 `add` 上有，而且
`-a universal` 之外的动作可能写入 `status: failed` 却已经把技能落到目录里，
所以「成没成」以磁盘与锁文件为准，页面显示的是核对结论。

坑：本机 `npx` 默认缓存目录（`/root/.npm`）里有 root 归属的缓存文件，直接跑会 `EACCES`，
所以子进程环境里把 `npm_config_cache` 指到临时目录。

### 本页**不做**什么

不做启停（要停就删或直接改文件）、不在页面里编辑技能正文（会被 `npx skills update` 整份覆盖）、
不做分组 / 迁移 / zip 导入、不管项目级 `.agents/skills` 与 `~/.dsh/skills`、
不管插件自带技能、不碰 MCP。**不依赖 `ctx.skills`**：宿主半宁可不引新服务，也不给插件树加加载风险。

## 独立页 Agents&Skills（`/dsh-agents-skills`）

给"不想先打开聊天界面"的场景准备的一个网址，**功能比设置页更全**（设置页保持原样不动）。它是**宿主半自己注册的一条 Web 路由**，不是另一个服务。导航**以仓库为中心**（仓库列表是默认页），技能大表退成「所有技能」这一项：

```
┌─ 左栏 160px ─┬─ 内容列 ─────────────────────────────┐
│ Agents&Skills │                                     │
│ 仓库          │  ?tab=repos            → 仓库列表（默认）  │
│ 所有技能  50  │  ?tab=repo&repo=<key>  → 单仓技能表（7 列） │
│ 待办      24  │  ?tab=todo             → 跨仓待办聚合      │
│ Agent         │  ?tab=agent            → AGENTS.md 编辑器 │
│ ← 回到 DSH 界面│                                     │
└───────────────┴─────────────────────────────────────┘
窄屏（<720px）：左栏自动变成顶部横排（纯 CSS，无 JS）
```

| 项 | 说明 |
|---|---|
| 标签 | `?tab=repos`（默认）/ `?tab=repo&repo=<key>` / `?tab=todo` / `?tab=skills` / `?tab=agent`；四个顶层标签**记住上次看的**（cookie `dsh-agents-skills-tab`，HttpOnly + SameSite=Strict + Path=页面路径 + 1 年），仓库子页需要 `repo` 参数，不进 cookie |
| 左栏计数 | 「所有技能」徽章 = 技能数（本地扫描，零网络）；「待办」徽章（`--amber`）= 新增 ∪ 可更新 ∪ 上游已移除 的总数，**只在已有检查缓存时显示**——打开 Agent 页不会偷偷发 GitHub 请求 |
| 仓库列表 | 页头：`仓库` + `N 个仓库 · M 个订阅 · 待办 x`（有缓存时再带「上次检查 3 分钟前」）+ 右侧 `检查更新`（`links.check`）。页头下是添加表单：`POST action=subscribe`，占位 `owner/repo，例如 anthropics/skills`，成功/失败都走既有 message 回显。表格 5 列（仓库弹性 / 已装 80 / 状态弹性 / 来源 70 / 操作 230）：仓库名 mono 链到 `?tab=repo&repo=<key>`（本地行显示「本地·未托管」）；已装查过写 `x/y`、没查过只有已装数；状态列新增(绿)/可更新(琥珀)/已移除(红) 最多三枚，`订阅但未检查` 写 dim「订阅·未检查」、派生仓写 dim「未检查」、`mode=failed` 或 `error` 非空写红「检查失败」（原因进 `title`）、无事写 dim「已装上最新」；来源列 订阅 / 已装 / 本地；操作列 `检查` + `装全部新增 (n)` + `更新全部 (n)`（本地行无按钮）。排序：待办 desc → 仓库名 asc → 本地恒在最底 |
| 仓库子页 | 面包屑 `← 仓库` 回列表；页头 mono 仓库名 + `已装 x/y · 新增 a · 可更新 b · 已移除 c` + 该仓三个按钮。技能表 **7 列**（选 34 / 技能 170 / 状态 96 / 说明弹性 / 来源路径 170 / 装于 88 / 操作 120）——与「所有技能」共用 `renderItem`（徽章、勾选、行内按钮同一套规则），去掉了仓库列。批量条、`选中全部待办` 与整表单 `row` / `pick` 协议原样复用，仓库位仍填本仓 `source`。订阅但未检查时表格位置给一行「尚未检查，点右上角[检查]看看有什么可装。」`key='__local__'` 的标题是「本地·未托管」，只有已装行与 `删除`，没有检查类按钮 |
| 待办（跨仓聚合） | 页头 `待办` + `新增 a · 可更新 b · 已移除 c` + `更新全部 (n)`（`batch=updateAll`，无则无）。表格是「所有技能」那 8 列（含仓库列，仓库名链到对应子页），只列 `kind !== 'installed'` 的行，按仓库组序。空态两分支：没查过 →「还没检查过，先点 `检查更新`。」（链接 `links.check`）；查过且无待办 →「没有待办：所有盯着的仓库都已装上且最新。」 |
| 所有技能 | 原有技能页**整份平移**（只把标题改成「所有技能」、导航 active 适配）：仓库条 `.repostrip`、批量条、搜索安装与使用说明两个 `<details class="fold">` 全部原样保留 |
| Agent 编辑器 | 纯表单：路径 / 字节数 / `<textarea>` / 保存（整文件替换 + 覆盖前备份 `AGENTS.md.bak`，与设置页**同一条代码路径** `lib/agent.js`）/ 重新读取 |
| 无 JS 的代价（页面上已写明） | 没有实时字符·字节计数、没有 Ctrl+S、**切换标签会丢弃未保存的草稿**、不做并发冲突检测（后写覆盖）。要这些就用设置页那套编辑器 |
| 表单体上限 | 256 KiB（AGENTS.md 上限 65536 字节，中文 URL 编码后最多约 3 倍） |
| 视觉 | **运维台账风**：暖白纸面、等宽数据、细线分隔，唯一彩色是状态色（绿 / 红 / 琥珀）。**纯表格，没有卡片**：仓库列表 5 列、仓库子页 7 列、「所有技能」与「待办」8 列（选 34 / 仓库 140 / 技能 170 / 状态 96 / 说明弹性 / 来源路径 170 / 装于 88 / 操作 120），技能表 `min-width: 900px`、`table-layout: fixed`；**页面全宽**（`max-width: none`） |
| 行 | **纯平铺**：每行都写仓库名，**没有 `rowspan`、没有分组行、表体里没有 `colspan`**（`test/page.test.mjs` 盯着这三条；仓库列表空态不渲染空表，技能/待办空表也按自己的列数补齐 `<td>`） |
| 滚动结构 | 表体自己滚、填满屏幕：`.content.skills-page` 是 flex 列，高度 `calc(100vh - 2 * var(--pad-y))`；`--pad-y: 20px` 只定义一次，body 的 padding 引用它，所以高度公式与纵向 padding 永远同源（当前 = `calc(100vh - 40px)`）——不写互不相干的魔法数字 |
| ⚠️ 粘性约束 | 表头 `position: sticky; top: 0`（高 30px，z-index 2，背景是不透明的 `var(--paper)`），**偏移量必须是 0**。`.table-scroll` 有 `overflow: auto`，粘性元素是相对这个滚动容器定位的：偏移写 38px 会让表头**被往下推 38px 盖住第一行**（真踩过，见下）。**单元格一律不做 sticky**，`rowspan` 与粘性单元格同用还会让每行被撑到 60~150px |
| 仓库条 | 表格上方一条 `.repostrip`：**单行横滚**（`flex-wrap: nowrap; overflow-x: auto`），一个仓库一个 chip（仓库名 mono/--ink/600 + 已装 x/y + 徽章 + `重查` / `装全部新增 (n)` / `更新全部 (n)`）。仓库级操作在这里，所以表格能保持纯平铺 |
| 操作效率 | 批量条（`.batchbar`，`min-height: 34px`、不换行、横滚、`flex: 0 0 auto` 不许被压扁）：`安装选中` / `更新选中` / `删除选中` / `选中全部待办` / `更新全部 (n)`。整张表在**一个表单**里，靠按钮的 `name/value` 携带目标（`row=动作\|仓库\|技能名`、`pick=仓库\|技能名`），所以无 JS 也能多选批量 |
| 降噪 | 状态列**每行最多一个徽章**：优先级 格式不合规(红) > 上游已移除(红) > 可更新(琥珀) > 新增(绿)，无事显示灰色「已装」；并发原因合并进该徽章的 `title`（分号连接）。「模型专用」「仅用户可用」不是状态，渲染成徽章后的小号 dim 后缀文字（`·模型专用`）。上游已移除行的技能名带删除线。操作列只挂有意义的按钮（新增→`安装`；可更新→`更新` `删除`；已装/已移除→`删除`），右对齐、小按钮、只有「安装」是主按钮（墨底纸字） |
| 批量安装 | **按仓库分组**：同一个仓库的多个技能合成一次 `npx skills add … -s a -s b`（否则 19 个技能要克隆 19 次）；删除逐个跑（CLI 的 `remove` 一次只吃一个名字，且是纯本地操作） |
| 表格下方折叠区 | 两个原生 `<details class="fold">`：`搜索安装`（原搜索表单与结果表，有结果时带 `open`）与 `使用说明`（原页脚说明 + 安装根路径 + 每行写仓库名的提示）。头部只留两行，路径与提示都挪进了折叠区；交互层的 pjax 会按 `<summary>` 文本把展开状态带过局部刷新 |

| 项 | 说明 |
|---|---|
| 路径 | 默认 `/dsh-agents-skills`，可用插件行配置 `skillsPagePath` 改（必须是本站绝对路径） |
| 打开方式 | 经反向代理：`https://<你的域名>/dsh-agents-skills`（多一层代理的密码）；本机：`http://127.0.0.1:3081/dsh-agents-skills` |
| 门禁 | 路由自己调 `ctx.connection.requestRejection(req)` —— 宿主原话是"Apply Connection's Host/Origin checks and browser authentication to another Web route"，也就是**和聊天界面同一道门**（同一个浏览器 cookie）。拿不到 `connection` 服务时**拒绝**（fail closed） |
| 为什么必须自己加门禁 | 插件注册的 `exact` 路由**不经过** `/api` 的栅栏。不自己加的话，任何能访问该地址的人都能装/删技能——在"宿主机本地直连"这条路上（不经过反向代理、也就没有代理的密码）尤其危险 |
| 少量 JS | 服务端渲染 + 表单 POST 是事实源与无 JS 兜底；额外一个外链的 `client/page-ui.js`（≤200 行、无框架/无构建/无依赖）做 pjax 薄层：拦截站内 GET 链接与 POST 表单，fetch 后局部替换 `<title>`/`<body>`，POST 保持滚动位置、折叠区按 `<summary>` 文本重开，提交按钮加 `.busy` 防连点。响应头带 `Content-Security-Policy: default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`——脚本只放行本站自己 serve 的这一个文件，**内联脚本仍被禁止**（`script-src` 不含 `'unsafe-inline'`）。决策留痕见 `docs/adr/0001-独立页交互层允许少量JS.md` |
| 转义 | 技能名、说明、正文、搜索关键词全部经 `escapeHtml`；回跳参数只接受本站相对查询串（挡开放重定向） |
| 参数校验 | 表单字段在进 argv 之前过 `parseSource` / `assertSkillNames` / `assertQuery`：以 `-` 开头的值会被 CLI 当开关（例如 `--all`），一律拒掉 |
| 检查缓存 | 「检查更新」的结果在宿主内存里缓存 2 分钟（一次检查是每个仓库 1 个 GitHub 请求）；动作成功后按同一套规则把对应条目摘掉，页面不会自相矛盾 |
| 样式 | 独立页拿不到宿主的主题变量：只用 CSS 变量（`--paper/--ink/--sub/--line/--amber` + 状态色）跟随**系统**深浅色（`@media (prefers-color-scheme: dark)` 覆盖，保留 `color-scheme: light dark`）。≤720px 断点：导航变顶部横排、页面高度 `auto`、表格滚动容器 `max-height: 70vh` |
| 分组规则 | 与设置页共用一份语义：宿主 `lib/skills.js` 的 `groupSkills` 与客户端 `buildGroups` 有一致性对照测试（`test/page.test.mjs`），改一边不改另一边会红 |

## 结构

```
package.json          bundle 清单：dsh.bundle.patch + dsh.client
cordis.patch.yml      插入 agents-skills 这一行
lib/index.js          Host 半：GlobalAgentService（读写 AGENTS.md）+ SkillsPanelService（技能面板）
lib/agent.js          全局 Agent 提示词（$DSH_HOME/AGENTS.md）的读写与备份——设置页与独立页共用
lib/skills.js         技能的全部逻辑（锁文件、目录扫描、GitHub 差异、CLI 封装、分组）——纯模块级函数
lib/page.js           独立页：服务端渲染的 HTML + 左栏导航 + 表单处理 + 门禁 + CSP + serve 交互层资产（SSR 兜底、少量 JS）
lib/typert.host.js    手写 typert 清单：globalAgent/read、write + skillsPanel/overview、check、search、action、read
client/client.js      Client 半：settings.section 页面（id=global-agent，order=25，label=Agents&Skills），页内两个标签
client/page-ui.js     独立页的交互层（pjax 薄层，≤200 行、无依赖、无构建）
docs/adr/             决策留痕（0001：独立页交互层允许少量 JS）
test/                 清单格式护栏 + Host 读写行为 + 技能逻辑 + Client 冒烟 + 独立页
```

Host 与 Client 共用同一条代码路径：页面上的按钮和 Remote 方法调的是同一批函数。

## 四条硬约束（都踩过）

1. **Remote 方法不能用 `#私有成员`。** Typert Gateway 调用时用的是**影子接收者**
   （`receiverContext.extend({invocation}).get(service)`，与实例不是同一个对象），
   V8 的私有品牌检查会在方法执行前抛 `TypeError: Receiver must be an instance of class …`。
   `lib/skills.js` 因此全部是模块级函数，两个 Service 的方法体只做转发。
   `test/skills.test.mjs` 里有一条**影子接收者**回归测试，别删。
2. **第二个 Service 用 `ctx.plugin(...)` 在构造函数里注册**（Cordis 一个插件可以注册多个
   Service，`dsh-api-session-controller` 就是这么做三个服务的）。它是**异步生效**的：
   真实宿主里整棵插件树加载完才开始服务请求，测试里要等它就绪。
3. **`binding.service` 是服务实例（Cordis 代理），不是字符串。** 断言时用
   `binding.serviceKey` / `binding.namespace`；对代理做深比较会让断言库去遍历属性而抛
   `cannot get property "…" without inject`。
4. **宿主半的改动要重启 `dsh web` 才生效。** 加载器用的是裸 `await import(url)`，
   同一个包名解析到同一个 URL，Node 的 ESM 缓存会返回旧模块——禁用/启用这一行、
   改 patch 文件都换不掉已经在跑的代码。客户端半则相反：改完刷新页面即可。

## 开发

```bash
node --check lib/index.js && node --check lib/skills.js && node --check lib/typert.host.js && node --check client/client.js
node test/typert-manifest.test.mjs   # 官方 validateTypertManifest
node test/service.test.mjs           # 临时 DSH_HOME 下跑读/写/备份 + 影子接收者
node test/skills.test.mjs            # frontmatter / CLI 输出解析 / 差异计算 / 命令拼装 / 服务
node test/client.test.mjs            # 用替身 React 冒烟渲染两个标签
node test/page.test.mjs              # 独立页：转义 / 表单 / 门禁 / 缓存 / 标签与 cookie / Agent 页 / 分组一致性
```

清单格式错了会让整个 DSH 起不来，所以改完 `lib/typert.host.js` 必须跑测试。
测试**不联网**：`check` 只跑「空来源」与「写法非法的来源」，`search` 用空关键词提前返回，
`action` 只用非法动作（不启动子进程）。

## 安装

```bash
# 在 profile 里安装本目录（DSH 的 plugin_manager install_bundle，target = 本目录绝对路径）
```

依赖 `zod` 与 `@deepseek-ai/dsh-typert-protocol` 通过本目录 `node_modules` 里的软链
指向 profile 共享目录，与 `dsh-model-fit` 的做法一致。
