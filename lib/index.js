// dsh-agents-skills · 宿主半入口
//
// 一个插件注册两个 Service（Cordis 允许，`dsh-api-session-controller` 就是三个）：
//   - `globalAgent`：全局 Agent 提示词 `$DSH_HOME/AGENTS.md` 的读 / 写；
//   - `skillsPanel`：技能面板（列表、来源仓库差异、装删更新、搜索），并挂上独立页路由。
//
// 两个 Service 的方法体都只做转发：真正的逻辑在 `lib/agent.js`、`lib/skills.js`、
// `lib/page.js` 的模块级函数里——Remote 方法跑在**影子接收者**上，碰私有成员会在
// 执行前抛 `TypeError: Receiver must be an instance of class ...`。

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { readAgentFile, writeAgentFile } from './agent.js'
import { DEFAULT_PAGE_PATH, createPageHandler } from './page.js'
import { addSubscription, checkRepos, messageOf, readSkill, readSubscriptions, runAction, searchSkills, skillsOverview } from './skills.js'

/**
 * 独立页当前的挂载路径；没挂上（没有 webServer，或注册冲突被吞掉）时为空串。
 *
 * 放模块级而不是服务实例上：Remote 方法跑在**影子接收者**上，读 `this.xxx` 有风险，
 * 而模块级状态两边读到的都是同一份。
 */
let mountedPagePath = ''

/**
 * 解析独立页路径：只接受本站的绝对路径。
 * @param {unknown} config - 插件行配置。
 * @returns {string} 以 `/` 开头、不含空白与 `?` 的路径。
 */
function resolvePagePath(config) {
  const raw = config !== null && typeof config === 'object' && typeof config.skillsPagePath === 'string'
    ? config.skillsPagePath.trim()
    : ''
  if (raw.length === 0) return DEFAULT_PAGE_PATH
  if (!raw.startsWith('/') || raw.length > 100 || /[\s?#]/.test(raw)) return DEFAULT_PAGE_PATH
  return raw
}

/**
 * 读写用户全局 Agent 提示词文件（`$DSH_HOME/AGENTS.md`）——预设会在每个新会话的
 * 第一次请求里把它注入给模型。设置页、独立页与模型共用 `lib/agent.js` 这一条代码路径。
 *
 * 两个方法都不碰 `this`、不用私有成员，所以 Typert Gateway 能在影子接收者上调用。
 */
export class GlobalAgentService extends TypertRemoteService {
  /**
   * @param {object} ctx - owning Cordis context.
   * @param {object} config - plugin row config (unused).
   */
  constructor(ctx, config) {
    super(ctx, 'globalAgent')
    // 技能面板是同一个包的第二个 Service：Cordis 允许一个插件注册多个服务，
    // 与 dsh-api-session-controller 的 SessionController 同一套写法。
    ctx.plugin(SkillsPanelService)
  }

  /**
   * 读取全局提示词文件，不创建它。
   * @param {Record<string, never>} request - unused.
   * @returns {Promise<object>} 当前文件状态。
   */
  async read(request) {
    return await readAgentFile()
  }

  /**
   * 整体替换全局提示词文件，覆盖前先备份旧内容。
   * @param {{ content: string }} request - 新的全文。
   * @returns {Promise<object>} 写入后的状态。
   */
  async write(request) {
    const content = request !== null && typeof request === 'object' ? request.content : undefined
    return await writeAgentFile(content)
  }
}

/**
 * 订阅一个来源仓库：先登记进本地清单（一次文件写，基本不会失败），再**尽力**检查一次
 * 它的新增 / 可更新 / 已移除，把结论并进页面提示里的 summary。
 *
 * 检查是加分项：网络、限流、仓库不存在都不该让「订阅」这个动作失败——清单已经写进去了。
 * @param {unknown} source - 用户输入，形如 `owner/repo` 或 GitHub URL。
 * @returns {Promise<{ ok: boolean, kind: string, source: string, summary: string, error: string }>} 结果。
 */
async function subscribeRepo(source) {
  const added = await addSubscription(source)
  if (!added.ok) return added
  try {
    const delta = await checkRepos({ sources: [added.source] })
    const repo = Array.isArray(delta.repos) ? delta.repos.find((item) => item.source === added.source) : undefined
    if (repo === undefined) return { ...added, summary: added.summary + '；检查没有返回结果' }
    if (repo.mode === 'failed') return { ...added, summary: added.summary + '；检查失败：' + repo.error }
    const count = (list) => (Array.isArray(list) ? list.length : 0)
    const news = count(repo.newSkills)
    const updatable = count(repo.updatable)
    const orphans = count(repo.orphan)
    const pending = news + updatable + orphans
    return {
      ...added,
      summary: added.summary + (pending === 0
        ? '；检查通过：没有待办'
        : '；检查：新增 ' + String(news) + ' · 可更新 ' + String(updatable) + ' · 已移除 ' + String(orphans) + '（点「检查更新」看明细）'),
    }
  } catch (error) {
    return { ...added, summary: added.summary + '；检查失败：' + messageOf(error) }
  }
}

/**
 * 技能面板的宿主半：读磁盘与锁文件、算仓库差异、把装/删/更新转交给 `npx skills`，
 * 并把独立页挂在宿主自己的 Web 路由上。
 *
 * 与 {@link GlobalAgentService} 一样，业务逻辑全在模块级函数里，方法体只做转发。
 */
export class SkillsPanelService extends TypertRemoteService {
  /**
   * @param {object} ctx - owning Cordis context.
   * @param {object} config - plugin row config（`skillsPagePath` 可改独立页路径）。
   */
  constructor(ctx, config) {
    super(ctx, 'skillsPanel')
    const pagePath = resolvePagePath(config)
    // 独立页挂在宿主自己的 Web 路由上。`ctx.inject` 在非 Web 宿主里不会回调，
    // 于是插件照常加载、只是没有这个页面。
    ctx.inject(['webServer'], (webCtx) => {
      const handler = createPageHandler({
        pagePath,
        // 门禁与聊天界面同一道：Host/Origin 栅栏 + 浏览器 cookie。
        // 拿不到 connection 服务时**拒绝**（fail closed）：宁可不给页面，
        // 也不开一个绕过 `/api` 栅栏的免密入口。
        guard: (req) => {
          const connection = webCtx.get('connection')
          if (connection === undefined || typeof connection.requestRejection !== 'function') return 403
          return connection.requestRejection(req)
        },
        overview: () => skillsOverview({ pagePath: mountedPagePath }),
        check: checkRepos,
        search: searchSkills,
        action: runAction,
        subscribe: subscribeRepo,
        subscriptions: readSubscriptions,
        agentRead: readAgentFile,
        agentWrite: writeAgentFile,
      })
      const route = { kind: 'exact', path: pagePath, handler: (req, res) => handler(req, res) }
      webCtx.effect(() => {
        const dispose = webCtx.webServer.register(route)
        mountedPagePath = pagePath
        return () => {
          mountedPagePath = ''
          dispose()
        }
      }, 'dsh-agents-skills: agents&skills page route')
    })
  }

  /**
   * 首屏：已安装技能 + 来源仓库分组 + 环境提示，纯本地零网络。
   * @param {Record<string, never>} request - unused.
   * @returns {Promise<object>} view state.
   */
  async overview(request) {
    return await skillsOverview({ pagePath: mountedPagePath })
  }

  /**
   * 检查来源仓库的新增 / 可更新 / 已移除，每个仓库一次 GitHub 请求。
   * @param {{ sources?: string[] }} request - repos to check; empty means every source in the lock file.
   * @returns {Promise<object>} per-repo delta.
   */
  async check(request) {
    return await checkRepos(request)
  }

  /**
   * 搜索 skills.sh 生态（转发 `npx skills find`）。
   * @param {{ query?: string }} request - keyword.
   * @returns {Promise<object>} search results.
   */
  async search(request) {
    return await searchSkills(request)
  }

  /**
   * 安装 / 卸载 / 更新，并在执行后回磁盘与锁文件核对。
   * @param {{ kind?: string, source?: string, skills?: string[], name?: string }} request - action.
   * @returns {Promise<object>} action result.
   */
  async action(request) {
    return await runAction(request)
  }

  /**
   * 读技能正文：本地按名字，远程按仓库 + 路径。
   * @param {{ name?: string, source?: string, path?: string }} request - locator.
   * @returns {Promise<object>} body state.
   */
  async read(request) {
    return await readSkill(request)
  }
}

export default GlobalAgentService
