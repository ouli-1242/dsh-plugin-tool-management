// manager provider 接线：以 core 的候选/正文接口接管四个外部来源（含启停策略），并随来源
// 集合变化注册/注销。
//
// 从 skills/service.ts 整段搬来，一行未改。invalidators 由调用方注入，本层不持有状态 ——
// 它是官方 provider 通道的使用方，不改官方包、也不 monkey-patch。
import { getProviderSkill, listProviderCandidates } from './core.js'
import { OFFICIAL_SOURCE_KEY } from './official.js'
import { noteRuntime } from '../compat/runtime-notes.js'

const PROVIDER_NAME = 'dsh-plugin-tool-management-external'
const message = (e: unknown): string => String((e && (e as Error).message) || e)

/**
 * 某一格（单条技能 / 技能来源）在**查看方那一层**的生效值。
 *
 * `false` = 本会话关着、`true` = 本会话开着、`undefined` = 没有意见（按机器级那一份）。
 * 与注入目录（`skills/catalog.ts` 的 `renderSkillCatalog`）**同一份判据**。
 */
export interface SkillProviderSessionView {
  /** 单条技能：键 = `<来源 key>/<声明名>`。 */
  skill: (key: string) => boolean | undefined
  /** 技能来源：键 = 来源 key。 */
  source: (rootKey: string) => boolean | undefined
}

/**
 * 查看方（官方传进来的 `options.scope` = 调用方 agent）→ 它那一层的生效值。
 *
 * 取不到查看方（全局层读、预设的常驻 scope）→ `undefined` = 按机器级那一份。
 */
export type SkillProviderSessionViewOf = (viewer: unknown) => SkillProviderSessionView | undefined

/**
 * 把候选按**查看方那一层**收紧：本会话关着的那几条，标成"不可调用"。
 *
 * 为什么不能干脆不列它：官方注册表按**名字**合并各层的候选（近的层胜出）—— 名字缺席就
 * 轮到全局层那份（机器级的启停）顶上，于是关掉的那条照样出现在清单里（宿主 `/` 菜单的
 * 「技能」段、官方 `skill` 工具的候选都吃这一份）。标成不可调用才能既接管那份、
 * 又让这一层说了算。
 *
 * 判据与注入目录同一条：来源闸**始终**生效（显式关掉的来源，里面那条即便会话层开着
 * 也不加载），单条那格会话说了算、没说才用机器级那一份。
 */
export function narrowToSession(candidates: any[], view: SkillProviderSessionView): any[] {
  return candidates.map((candidate) => {
    const locator = (candidate && candidate.locator) || {}
    const rootKey = String(locator.rootKey || '')
    const name = String((candidate && candidate.name) || locator.entryName || '')
    if (rootKey === '' || name === '') return candidate
    const sourceOn = view.source(rootKey)
    const skillOn = view.skill(rootKey + '/' + name)
    // 两格都没说话 = 这一层没有意见，机器级那一份照旧。
    if (sourceOn === undefined && skillOn === undefined) return candidate
    const allowed = (sourceOn === undefined ? true : sourceOn) && (skillOn === undefined ? true : skillOn)
    if (allowed) return candidate
    return Object.assign({}, candidate, { invocation: { modelInvocable: false, userInvocable: false } })
  })
}

/**
 * manager provider：以 core 的候选/正文接口接管四个外部来源（含启停策略）。
 *
 * @param scope `global` 时**不**返回官方内置技能的候选。那一家由宿主自己的 provider 在
 *   全局层提供；我们在每个 agent 的 scoped 层里再注册一份，靠「最近一层胜出」接管它，
 *   不再依赖数字 rank 与宿主内部常量对齐。全局层若也放一份同名候选，等于把 rank 假设
 *   重新引回来 —— 官方改档位时接管会静默失效。
 * @param sessionViewOf 查看方那一层的生效值。**按查看方算，不按注册时挂在哪个 agent 上** ——
 *   同一个 provider 会被若干查看方问到（子代理的链也经过父会话那一层）。
 */
export function externalSkillProvider(
  control: any,
  invalidators: Set<() => void>,
  scope: 'global' | 'agent' = 'agent',
  sessionViewOf?: SkillProviderSessionViewOf,
): any {
  if (control && typeof control.invalidate === 'function') invalidators.add(control.invalidate)
  if (control && control.signal && typeof control.signal.addEventListener === 'function') {
    control.signal.addEventListener('abort', () => { invalidators.delete(control.invalidate) }, { once: true })
  }
  return {
    name: PROVIDER_NAME,
    list: async (options: any) => {
      const candidates = await listProviderCandidates(options)
      const listed = scope === 'global'
        ? candidates.filter((candidate: any) => candidate?.locator?.rootKey !== OFFICIAL_SOURCE_KEY)
        : candidates
      // 策略表 / 来源状态是**机器级**的：会话 A 开一条全局关着的技能，那条会被临时落进
      // 机器级那张表（官方 `skill` 工具只认那张表），于是**每个**会话的清单里都看得见它。
      // 注入目录早就按会话过滤了，官方那份清单没有 —— 那条串味就留在宿主 `/` 菜单的
      // 「技能」段与官方 `skill` 工具的候选里。这里按查看方那一层收紧它。
      const view = sessionViewOf ? sessionViewOf(options && options.scope) : undefined
      return view ? narrowToSession(listed, view) : listed
    },
    get: async (candidate: any, options: any) => getProviderSkill(candidate, options),
  }
}

/**
 * 在每个活动 agent 的 scope 内注册同一 provider。
 * 用户级技能由 agent-preset 的 scoped 层解析；只有在 agent 自己的层里注册，
 * 候选 rank 覆盖才能对它们生效（详见上游 registerAgentSkillProviders）。
 */
export function registerAgentSkillProviders(
  ctx: any,
  invalidators: Set<() => void>,
  sessionViewOf?: SkillProviderSessionViewOf,
): () => void {
  const on = ctx && ctx.on
  if (typeof on !== 'function') return () => {}
  const registrations = new Map<string, () => void>()
  const skillsOf = (agent: any) => {
    const agentCtx = agent && agent.ctx
    if (!agentCtx) return null
    const skills = typeof agentCtx.get === 'function' ? agentCtx.get('skills') : agentCtx.skills
    return skills && typeof skills.registerProvider === 'function' ? skills : null
  }
  const install = (agent: any) => {
    if (!agent || agent.id == null || registrations.has(agent.id)) return
    const skills = skillsOf(agent)
    if (!skills) return
    try {
      const dispose = skills.registerProvider((control: any) => externalSkillProvider(control, invalidators, 'agent', sessionViewOf))
      registrations.set(agent.id, typeof dispose === 'function' ? dispose : () => {})
    } catch (e) {
      console.error('[dsh-plugin-tool-management] agent-scoped skills provider setup failed:', message(e))
      // 这一层没挂上时，官方内置技能仍由宿主注入，但我们的启停不再生效 ——
      // 界面上看不出差别，留一条降级让兼容页说清。
      noteRuntime({
        id: 'skills-agent-provider',
        label: '技能作用域接管',
        kind: 'read',
        fallback: 'inform-only',
        detail: 'agent 作用域的技能 provider 未挂上（' + message(e) + '）：官方内置技能这一轮由宿主直接注入，启停开关不生效。',
        detailKey: 'skills-agent-provider',
        params: { reason: message(e) },
      })
    }
  }
  const uninstall = (agent: any) => {
    const id = agent && agent.id
    if (id == null) return
    const dispose = registrations.get(id)
    registrations.delete(id)
    if (typeof dispose === 'function') { try { dispose() } catch { /* ignore */ } }
  }
  const stopCreated = on('agent/created', (payload: any) => install(payload && payload.agent))
  const stopDisposed = on('agent/disposed', (payload: any) => uninstall(payload && payload.agent))
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (agents && typeof agents.list === 'function') {
      for (const agent of agents.list()) install(agent)
    }
  } catch { /* agents 服务不可用 → 仅靠事件 */ }
  return () => {
    if (typeof stopCreated === 'function') stopCreated()
    if (typeof stopDisposed === 'function') stopDisposed()
    for (const dispose of registrations.values()) { try { dispose() } catch { /* ignore */ } }
    registrations.clear()
  }
}
