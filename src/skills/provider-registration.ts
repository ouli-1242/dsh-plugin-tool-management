// manager provider 接线：以 core 的候选/正文接口接管四个外部来源（含启停策略），并随来源
// 集合变化注册/注销。
//
// 从 skills/service.ts 整段搬来，一行未改。invalidators 由调用方注入，本层不持有状态 ——
// 它是官方 provider 通道的使用方，不改官方包、也不 monkey-patch。
import { getProviderSkill, listProviderCandidates } from './core.js'

const PROVIDER_NAME = 'dsh-plugin-tool-management-external'
const message = (e: unknown): string => String((e && (e as Error).message) || e)

/** manager provider：以 core 的候选/正文接口接管四个来源（含启停策略）。 */
export function externalSkillProvider(control: any, invalidators: Set<() => void>): any {
  if (control && typeof control.invalidate === 'function') invalidators.add(control.invalidate)
  if (control && control.signal && typeof control.signal.addEventListener === 'function') {
    control.signal.addEventListener('abort', () => { invalidators.delete(control.invalidate) }, { once: true })
  }
  return {
    name: PROVIDER_NAME,
    list: async (options: any) => listProviderCandidates(options),
    get: async (candidate: any, options: any) => getProviderSkill(candidate, options),
  }
}

/**
 * 在每个活动 agent 的 scope 内注册同一 provider。
 * 用户级技能由 agent-preset 的 scoped 层解析；只有在 agent 自己的层里注册，
 * 候选 rank 覆盖才能对它们生效（详见上游 registerAgentSkillProviders）。
 */
export function registerAgentSkillProviders(ctx: any, invalidators: Set<() => void>): () => void {
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
      const dispose = skills.registerProvider((control: any) => externalSkillProvider(control, invalidators))
      registrations.set(agent.id, typeof dispose === 'function' ? dispose : () => {})
    } catch (e) {
      console.error('[dsh-plugin-tool-management] agent-scoped skills provider registration failed:', message(e))
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
