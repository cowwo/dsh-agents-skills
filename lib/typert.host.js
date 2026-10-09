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
      sourceLocation: { file: 'lib/index.js', line: 132, column: 3 },
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
      sourceLocation: { file: 'lib/index.js', line: 145, column: 3 },
    },
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
    ],
    events: [],
    objects: [],
  },
}
