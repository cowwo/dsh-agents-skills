# dsh-agents-skills

全局 Agent 提示词管理：在 **设置 → 全局 Agent** 里查看并实时编辑用户全局指令文件
`$DSH_HOME/AGENTS.md`（默认 `~/.dsh/AGENTS.md`）。

## 做什么

| 能力 | 说明 |
|---|---|
| 看 | 显示文件绝对路径、是否存在、当前字节数，以及全文 |
| 改 | 一个等宽 Markdown 编辑框，直接改 |
| 存 | 「保存」整文件替换，覆盖前把旧内容备份成同目录的 `AGENTS.md.bak`；Ctrl/Cmd+S 同样保存 |
| 重读 | 「重新读取」丢弃草稿、重新拉取磁盘内容 |
| 防超支 | 实时显示字符数 / UTF-8 字节数 / 加载器上限（65536 字节），超了给黄色警告 |

边界：只管**全局层**这一个文件。项目层 `AGENTS.md` / `CLAUDE.md` / `.local.md`、
预设人格、技能与 MCP 管理都不在范围内。

## 生效时机

这个文件由 `@deepseek-ai/dsh-agent-instructions` 注入。Web profile 在宿主层把它关掉了，
但 `standard` / `cordis` / `ptc` 三个预设各自把它带回来了，所以按预设启动的会话会读到它。
**改动不影响当前会话**：注入发生在每个会话的第一次请求，新开一个会话才看得到效果。

## 结构

```
package.json          bundle 清单：dsh.bundle.patch + dsh.client
cordis.patch.yml      插入 agents-skills 这一行
lib/index.js          Host 半：GlobalAgentService（读 / 写，含备份）
lib/typert.host.js    手写 typert 清单：globalAgent/read、globalAgent/write
client/client.js      Client 半：settings.section 页面（id=global-agent，order=25）
test/                 清单格式护栏 + Host 读写行为测试
```

Host 与 Client 共用同一条代码路径：页面上的「保存」和 `globalAgent/write` 是同一个方法。

## 两条硬约束（都踩过）

1. **Remote 方法不能用 `#私有成员`。** Typert Gateway 调用时用的是**影子接收者**
   （`receiverContext.extend({invocation}).get(service)`，与实例不是同一个对象），
   而 V8 的私有品牌检查要求 `this` 恰好是持有该私有成员的实例，于是方法还没跑就抛
   `TypeError: Receiver must be an instance of class GlobalAgentService`。
   所以读写逻辑放在模块级函数里（`currentState()` / `writeState()`），类方法只用 `this` 以外的东西。
   `test/service.test.mjs` 里有一条**影子接收者**回归测试，别删。
2. **宿主半的改动要重启 `dsh web` 才生效。** 加载器用的是裸 `await import(url)`，
   同一个包名解析到同一个 URL，Node 的 ESM 缓存会返回旧模块——禁用/启用这一行、
   改 patch 文件都换不掉已经在跑的代码。客户端半则相反：改完刷新页面即可。

## 开发

```bash
node --check lib/index.js && node --check lib/typert.host.js && node --check client/client.js
node test/typert-manifest.test.mjs   # 官方 validateTypertManifest
node test/service.test.mjs           # 临时 DSH_HOME 下跑读/写/备份 + 影子接收者
```

清单格式错了会让整个 DSH 起不来，所以改完 `lib/typert.host.js` 必须跑测试。

## 安装

```bash
# 在 profile 里安装本目录（DSH 的 plugin_manager install_bundle，target = 本目录绝对路径）
```

依赖 `zod` 与 `@deepseek-ai/dsh-typert-protocol` 通过本目录 `node_modules` 里的软链
指向 profile 共享目录，与 `dsh-model-fit` 的做法一致。
