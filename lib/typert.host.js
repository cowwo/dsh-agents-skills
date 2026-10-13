// dsh-agents-skills · typert Host 清单（手写，非生成）
//
// 本插件没有 TypeScript 构建步骤，而 dsh-typert-loader 只要求包导出 `./typert`
// 且模块带一个 TYPERT 清单对象。
//
// ⚠️ 格式由 loader 在**启动/激活时**校验：任何不合规字段都不会让插件静默失效，
// 而是让整棵插件树加载失败。参数必须写成
// `{ name, wire, source:'json', codec:{ mode:'strict', typeSymbol, create } }`，
// `create` 是**工厂函数**，返回带 `.parse()` 的校验器（zod v4 实例）。
// test/typert-manifest.test.mjs 用官方校验器把这份清单验一遍，改完务必跑测试。
import { z } from 'zod'

/** 读操作没有输入，但 wire 上仍要有一个对象参数。 */
const readRequestSchema = z.object({})

/** 写操作带完整的替换正文。 */
const writeRequestSchema = z.object({
  /** 新的文件全文；空串表示清空内容但保留文件。 */
  content: z.string(),
})

/**
 * 所有操作共用的扁平结果：字段齐全、失败用 ok=false + error 表达，
 * 这样浏览器侧的严格校验不会因为分支形状不同而炸。
 */
const stateSchema = z.object({
  /** 操作是否成功。 */
  ok: z.boolean(),
  /** 被管理的文件绝对路径。 */
  path: z.string(),
  /** 文件当前是否存在。 */
  exists: z.boolean(),
  /** 文件当前字节数。 */
  size: z.number(),
  /** 文件当前全文；不存在时为空串。 */
  content: z.string(),
  /** 本次写入的字节数；读操作为 0。 */
  bytes: z.number(),
  /** 覆盖前备份到的路径；没有备份时为空串。 */
  backup: z.string(),
  /** 指令加载器应用的字节上限。 */
  limitBytes: z.number(),
  /** 失败原因；成功时为空串。 */
  error: z.string(),
})

/** 直连 receiver：调用落在同一个 Service 实例的方法上。 */
const DIRECT = { kind: 'direct' }

// ── 技能面板（service: skillsPanel）────────────────────────────────────────────
//
// 结果一律**字段齐全的扁平对象**：浏览器侧是 strict codec，任何分支缺字段都会
// 让整次调用失败。失败用 ok:false + error 表达，不换形状。

/** overview：无输入。 */
const overviewRequestSchema = z.object({})

/** check：要检查的仓库；空数组表示锁文件里的全部来源。 */
const checkRequestSchema = z.object({
  sources: z.array(z.string()),
})

/** search：skills.sh 关键词。 */
const searchRequestSchema = z.object({
  query: z.string(),
})

/** action：装 / 删 / 更新。 */
const actionRequestSchema = z.object({
  /** install | remove | update。 */
  kind: z.string(),
  /** install 时的仓库（owner/repo）。 */
  source: z.string(),
  /** remove / update 时的技能名。 */
  name: z.string(),
  /** install 时要装的技能名列表。 */
  skills: z.array(z.string()),
})

/** read：本地按名字，远程按仓库 + 路径。 */
const readSkillRequestSchema = z.object({
  name: z.string(),
  source: z.string(),
  path: z.string(),
})

/** 已安装技能的一行。 */
const skillRowSchema = z.object({
  name: z.string(),
  dirName: z.string(),
  kind: z.string(),
  path: z.string(),
  description: z.string(),
  detail: z.string(),
  valid: z.boolean(),
  modelInvocable: z.boolean(),
  userInvocable: z.boolean(),
  managed: z.boolean(),
  source: z.string(),
  installedAt: z.string(),
  updatedAt: z.string(),
})

/** 首屏结果。 */
const overviewResultSchema = z.object({
  ok: z.boolean(),
  agentsHome: z.string(),
  root: z.string(),
  lockPath: z.string(),
  lockExists: z.boolean(),
  npxPath: z.string(),
  tokenSource: z.string(),
  tokenUser: z.string(),
  skills: z.array(skillRowSchema),
  repos: z.array(z.object({
    source: z.string(),
    installed: z.number(),
    names: z.array(z.string()),
  })),
  notes: z.array(z.string()),
  /** 独立页的挂载路径；没挂上时为空串（设置页据此决定要不要显示入口链接）。 */
  pagePath: z.string(),
  error: z.string(),
})

/** 一个仓库的差异行。 */
const repoDeltaSchema = z.object({
  source: z.string(),
  /** api | cli | failed。 */
  mode: z.string(),
  available: z.number(),
  installed: z.number(),
  newSkills: z.array(z.object({
    name: z.string(),
    path: z.string(),
    remoteHash: z.string(),
  })),
  updatable: z.array(z.object({
    name: z.string(),
    path: z.string(),
    installedHash: z.string(),
    remoteHash: z.string(),
  })),
  orphan: z.array(z.object({
    name: z.string(),
    path: z.string(),
  })),
  error: z.string(),
})

/** 检查结果。 */
const checkResultSchema = z.object({
  ok: z.boolean(),
  checkedAt: z.string(),
  tokenSource: z.string(),
  rateLimitText: z.string(),
  repos: z.array(repoDeltaSchema),
  error: z.string(),
})

/** 搜索结果。 */
const searchResultSchema = z.object({
  ok: z.boolean(),
  query: z.string(),
  results: z.array(z.object({
    repo: z.string(),
    skill: z.string(),
    installs: z.string(),
    url: z.string(),
  })),
  command: z.string(),
  note: z.string(),
  error: z.string(),
})

/** 动作结果。 */
const actionResultSchema = z.object({
  ok: z.boolean(),
  kind: z.string(),
  command: z.string(),
  code: z.number(),
  durationMs: z.number(),
  output: z.string(),
  summary: z.string(),
  error: z.string(),
})

/** 技能正文状态。 */
const readSkillResultSchema = z.object({
  ok: z.boolean(),
  /** local | remote。 */
  kind: z.string(),
  name: z.string(),
  source: z.string(),
  path: z.string(),
  content: z.string(),
  bytes: z.number(),
  error: z.string(),
})

/**
 * 造一条 invocation。五个技能方法形状一致，只有 id / 方法名 / 两个 schema 不同，
 * 手写五遍最容易在 id 或 typeSymbol 上抄错。
 * @param {string} method - service 方法名。
 * @param {object} requestSchema - 参数校验器。
 * @param {object} resultSchema - 结果校验器。
 * @param {number} line - lib/index.js 里的方法行号。
 * @returns {object} invocation 条目。
 */
function skillInvocation(method, requestSchema, resultSchema, line) {
  return {
    id: 'dsh-agents-skills#skillsPanel/' + method,
    service: 'skillsPanel',
    namespace: 'skillsPanel',
    method,
    invocation: DIRECT,
    parameters: [
      {
        name: 'request',
        wire: 'request',
        source: 'json',
        codec: {
          mode: 'strict',
          typeSymbol: 'dsh-agents-skills#skillsPanel/' + method + ':request',
          create: () => requestSchema,
        },
      },
    ],
    result: {
      mode: 'strict',
      typeSymbol: 'dsh-agents-skills#skillsPanel/' + method + ':result',
      create: () => resultSchema,
    },
    sourceLocation: { file: 'lib/index.js', line, column: 3 },
  }
}

export const TYPERT = {
  package: 'dsh-agents-skills',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: 'dsh-agents-skills#globalAgent/read',
      service: 'globalAgent',
      namespace: 'globalAgent',
      method: 'read',
      invocation: DIRECT,
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'dsh-agents-skills#globalAgent/read:request',
            create: () => readRequestSchema,
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-agents-skills#globalAgent/read:result',
        create: () => stateSchema,
      },
      sourceLocation: { file: 'lib/index.js', line: 61, column: 3 },
    },
    {
      id: 'dsh-agents-skills#globalAgent/write',
      service: 'globalAgent',
      namespace: 'globalAgent',
      method: 'write',
      invocation: DIRECT,
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'dsh-agents-skills#globalAgent/write:request',
            create: () => writeRequestSchema,
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-agents-skills#globalAgent/write:result',
        create: () => stateSchema,
      },
      sourceLocation: { file: 'lib/index.js', line: 70, column: 3 },
    },
    skillInvocation('overview', overviewRequestSchema, overviewResultSchema, 127),
    skillInvocation('check', checkRequestSchema, checkResultSchema, 136),
    skillInvocation('search', searchRequestSchema, searchResultSchema, 145),
    skillInvocation('action', actionRequestSchema, actionResultSchema, 154),
    skillInvocation('read', readSkillRequestSchema, readSkillResultSchema, 163),
  ],
  model: {
    services: [
      {
        description: '可读写用户全局 Agent 提示词文件（$DSH_HOME/AGENTS.md）。',
        summary: '可读写用户全局 Agent 提示词文件。',
        jsDoc: '/** 可读写用户全局 Agent 提示词文件（$DSH_HOME/AGENTS.md）。 */',
        tags: [],
        key: 'globalAgent',
        exportName: 'GlobalAgentService',
        members: [
          {
            kind: 'method',
            name: 'read',
            signature: 'async read(request: Record<string, never>): Promise<GlobalAgentState>',
            description: '读取全局提示词文件的路径、存在状态、字节数与全文，不创建文件。',
            summary: '读取全局提示词文件。',
            jsDoc: '/** 读取全局提示词文件。 */',
            tags: [],
          },
          {
            kind: 'method',
            name: 'write',
            signature: 'async write(request: { content: string }): Promise<GlobalAgentState>',
            description: '用给定正文整体替换全局提示词文件，覆盖前把旧内容备份为 AGENTS.md.bak。',
            summary: '整体替换全局提示词文件。',
            jsDoc: '/** 整体替换全局提示词文件。 */',
            tags: [],
          },
        ],
        types: [],
      },
      {
        description: '技能面板：列出用户级技能（$DSH_AGENTS_HOME/skills），检查来源仓库的新增与更新，装/删/更新转交 npx skills。',
        summary: '管理用户级技能与来源仓库更新。',
        jsDoc: '/** 技能面板的宿主半：读磁盘与锁文件、算仓库差异、把装/删/更新转交给 npx skills。 */',
        tags: [],
        key: 'skillsPanel',
        exportName: 'SkillsPanelService',
        members: [
          {
            kind: 'method',
            name: 'overview',
            signature: 'async overview(request: Record<string, never>): Promise<SkillsOverview>',
            description: '返回已安装技能、按来源仓库分组与本次环境提示，只读本地磁盘与锁文件，不发网络请求。',
            summary: '列已安装技能与来源仓库。',
            jsDoc: '/** 首屏：已安装技能 + 来源仓库分组 + 环境提示，纯本地零网络。 */',
            tags: [],
          },
          {
            kind: 'method',
            name: 'check',
            signature: 'async check(request: { sources: string[] }): Promise<SkillsCheck>',
            description: '按仓库算新增 / 可更新 / 上游已移除；API 优先，失败回落 npx skills -l。',
            summary: '检查来源仓库的更新。',
            jsDoc: '/** 检查来源仓库的新增 / 可更新 / 已移除，每个仓库一次 GitHub 请求。 */',
            tags: [],
          },
          {
            kind: 'method',
            name: 'search',
            signature: 'async search(request: { query: string }): Promise<SkillsSearch>',
            description: '转发 npx skills find，返回 skills.sh 生态里带安装量的候选技能。',
            summary: '搜索 skills.sh。',
            jsDoc: '/** 搜索 skills.sh 生态（转发 `npx skills find`）。 */',
            tags: [],
          },
          {
            kind: 'method',
            name: 'action',
            signature: 'async action(request: { kind: string, source: string, name: string, skills: string[] }): Promise<SkillsAction>',
            description: '安装 / 卸载 / 更新技能，执行后回磁盘与锁文件核对真实结果；安装固定写到 ~/.agents/skills。',
            summary: '装卸更新技能。',
            jsDoc: '/** 安装 / 卸载 / 更新，并在执行后回磁盘与锁文件核对。 */',
            tags: [],
          },
          {
            kind: 'method',
            name: 'read',
            signature: 'async read(request: { name: string, source: string, path: string }): Promise<SkillsRead>',
            description: '读技能正文：本地技能按名字读文件，未安装的仓库技能按仓库 + 路径读 GitHub 原文。',
            summary: '读技能正文。',
            jsDoc: '/** 读技能正文：本地按名字，远程按仓库 + 路径。 */',
            tags: [],
          },
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
}
