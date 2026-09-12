// dsh-plugin-tool-management —— 规则「自动在场层」投影（systemPrompt 段注册）。
//
// 变更单 01 的核心：把规则从"投影为 skill 目录条目（模型按需 load）"改为
// **投影为 system prompt 段（自动在场）**。前者即使命中，模型也要自己决定看不看，
// 正是用户抱怨的"每次都要解释"。
//
// 官方接口语义（@deepseek-ai/dsh-system-prompt）：
//   - `section({ name, order, text })` 在**调用者的 scope** 注册；scoped 段遮蔽同名全局段。
//   - `text` 可以是**每次装配时求值的 provider 函数** → 切换启用场景后**下一个请求即生效**，
//     无需重开会话、无需重载插件。
//   - `renderPrompt` 会**删除空段** → 无启用场景/空目录时返回 `''`，不产生空标题。
//
// 为什么注册两处（全局 + per-agent）：
//   全局注册覆盖所有 agent（含子 agent）；per-agent 注册保证即使插件 ctx 自带 scope
//   （全局段对某些 agent 不可见）也能命中 —— 两者同名，scoped 遮蔽全局，不会重复注入。
//
// 缓存契约（§5.2）：段文本是**会话级恒定**的（只由启用场景与文件内容决定），
// 因此前缀逐字节稳定 → 前缀缓存可命中；禁止在段里放时间戳/计数/相对时间。

const SECTION_NAME = 'tool-management:scene-memory'
/**
 * §5.1 硬约束 2：官方 `SECTION_ORDERS` 里 2901–4999 是空档（TOOL_REPORT 2900 →
 * TOOLS_SDK 5000），取 **3000** —— 语义上是"工具能力说明之后、输出与 SDK 约定之前"，
 * 且远离任何既有段。**不要**用官方已有数值（同号按名称排序，虽确定但难读，日后易撞）。
 */
const SECTION_ORDER = 3000
const GLOBAL_KEY = '@global'

export interface RulesProviderFacade {
  /** 同步返回活动场景记忆段文本；无内容返回 `''`（renderPrompt 会删除空段）。 */
  renderActiveScenes: () => string
}

export interface RulesProviderRegistration {
  /** 注销全部段注册。 */
  dispose: () => void
  /** 通知宿主提示词已变化（best-effort；段文本本身每次装配都会重算）。 */
  invalidate: () => void
}

/** 取 scope 上的 systemPrompt 服务（Cordis 的 ctx.get 可能抛错，全部吞掉）。 */
function systemPromptOf(scope: any): any {
  if (!scope) return undefined
  try {
    if (typeof scope.get === 'function') return scope.get('systemPrompt')
    return scope.systemPrompt
  } catch {
    return undefined
  }
}

/** 注册全局 + agent-scope 的场景记忆段。 */
export function createRuleProviderRegistrar(ctx: any, facade: RulesProviderFacade): RulesProviderRegistration {
  const registrations = new Map<string, { scope: any; dispose: () => void }>()

  const install = (scope: any, key: string): void => {
    if (!scope || registrations.has(key)) return
    const systemPrompt = systemPromptOf(scope)
    if (!systemPrompt || typeof systemPrompt.section !== 'function') return
    try {
      const dispose = systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        // 每次装配重读活动场景 → 切换启用状态后下一个请求即生效。
        // ⚠️ 硬约束 1：必须**同步返回 string**（不能是 Promise）——异步读取会破坏 renderPrompt。
        text: () => facade.renderActiveScenes(),
      })
      registrations.set(key, { scope, dispose: typeof dispose === 'function' ? dispose : () => {} })
    } catch (e) {
      // 同层重名注册会抛错：降级为"该 scope 不注入"，不影响其余 scope。
      console.error('[dsh-plugin-tool-management] scene-memory section registration failed:', String((e && (e as Error).message) || e))
    }
  }

  const uninstall = (key: string): void => {
    const entry = registrations.get(key)
    if (!entry) return
    registrations.delete(key)
    try { entry.dispose() } catch { /* ignore */ }
  }

  // ① 全局：插件 ctx 的 scope（覆盖所有 agent）
  install(ctx, GLOBAL_KEY)

  // ② per-agent：与既有 install/uninstall 生命周期一致（agent/created、agent/disposed）
  const on = ctx && ctx.on
  let stopCreated: unknown
  let stopDisposed: unknown
  if (typeof on === 'function') {
    stopCreated = on('agent/created', (payload: any) => {
      const agent = payload && payload.agent
      if (agent && agent.id != null) install(agent.ctx, String(agent.id))
    })
    stopDisposed = on('agent/disposed', (payload: any) => {
      const agent = payload && payload.agent
      if (agent && agent.id != null) uninstall(String(agent.id))
    })
  }
  // 已存在的 agent（插件热加载场景）：补注册。
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (agents && typeof agents.list === 'function') {
      for (const agent of agents.list()) {
        if (agent && agent.id != null) install(agent.ctx, String(agent.id))
      }
    }
  } catch { /* agents 服务不可用 → 仅靠事件 */ }

  return {
    invalidate: () => {
      for (const entry of registrations.values()) {
        try { entry.scope?.emit?.('system-prompt/change') } catch { /* 宿主无该事件 → 忽略 */ }
      }
    },
    dispose: () => {
      if (typeof stopCreated === 'function') (stopCreated as () => void)()
      if (typeof stopDisposed === 'function') (stopDisposed as () => void)()
      for (const key of [...registrations.keys()]) uninstall(key)
    },
  }
}
