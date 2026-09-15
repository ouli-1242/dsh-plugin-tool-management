// dsh-plugin-tool-management —— systemPrompt 段注册（通用骨架）。
//
// 本模块是「把插件状态投影为 system prompt 段（自动在场）」的**唯一实现**。
// 场景记忆段（src/rules/service.ts）、子智能体人设段、MCP 状态段
// （src/index.ts）都经它注册，避免每个域各抄一份 scope 遍历逻辑。
//
// 官方接口语义（@deepseek-ai/dsh-system-prompt）：
//   - `section({ name, order, text })` 在**调用者的 scope** 注册；scoped 段遮蔽同名全局段。
//   - `text` 可以是**每次装配时求值的 provider 函数** → 切换启用状态后**下一个请求即生效**，
//     无需重开会话、无需重载插件。
//   - `renderPrompt` 会**删除空段** → 无内容时返回 `''`，不产生空标题、零 token 成本。
//
// 为什么每个段都注册两处（全局 + per-agent）：
//   全局注册覆盖所有 agent（含子 agent）；per-agent 注册保证即使插件 ctx 自带 scope
//   （全局段对某些 agent 不可见）也能命中 —— 两者同名，scoped 遮蔽全局，不会重复注入。
//
// 缓存契约（§5.2）：段文本必须**会话级恒定**（只由持久化配置与文件内容决定），
// 因此前缀逐字节稳定 → 前缀缓存可命中；**禁止**在段里放时间戳/计数/相对时间。
// 异步数据源（人设目录、MCP 清单）走 stale-while-revalidate：`text()` 同步返回缓存值，
// 由调用方在写操作后触发重算，绝不在 `text()` 里发起 IO。

/** 一个 systemPrompt 段的声明。 */
export interface PromptSectionSpec {
  /**
   * 段名。宿主要求全局唯一；**同名**的 scoped 段遮蔽全局段（这正是我们要的）。
   * 约定前缀 `tool-management:`。
   */
  name: string
  /**
   * 段位。官方 `SECTION_ORDERS` 里 **2901–4999 是空档**（TOOL_REPORT 2900 → TOOLS_SDK 5000），
   * 取该区间内的值：语义上是"工具能力说明之后、输出与 SDK 约定之前"，且远离任何既有段。
   * **不要**用官方已有数值（同号按名称排序，虽确定但难读，日后易撞）。
   */
  order: number
  /**
   * 同步返回段文本；返回 `''` 表示本次不注入（renderPrompt 会删除空段）。
   *
   * ⚠️ 硬约束 1：**必须同步返回 string**（不能是 Promise）——异步读取会破坏 renderPrompt。
   * ⚠️ 硬约束 2：返回值必须**会话级恒定**，否则前缀缓存永远命中不了（见文件头缓存契约）。
   */
  text: () => string
}

export interface PromptSectionRegistrar {
  /** 注销全部段注册。 */
  dispose: () => void
  /** 通知宿主提示词已变化（best-effort；段文本本身每次装配都会重算）。 */
  invalidate: () => void
}

const GLOBAL_KEY = '@global'
/** 复合 key 的分隔符：NUL 不会出现在 agent id 或段名里。 */
const KEY_SEP = '\u0000'

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

/**
 * 注册一组 systemPrompt 段：全局 scope + 每个活动 agent 的 scope。
 *
 * 任一 scope / 任一段注册失败都只降级为"该段不注入"，不影响其余段与其余 scope。
 */
export function createPromptSectionRegistrar(
  ctx: any,
  sections: readonly PromptSectionSpec[],
): PromptSectionRegistrar {
  const registrations = new Map<string, { scope: any; dispose: () => void }>()

  const install = (scope: any, scopeKey: string): void => {
    if (!scope) return
    const systemPrompt = systemPromptOf(scope)
    if (!systemPrompt || typeof systemPrompt.section !== 'function') return
    for (const spec of sections) {
      const key = scopeKey + KEY_SEP + spec.name
      if (registrations.has(key)) continue
      try {
        const dispose = systemPrompt.section({
          name: spec.name,
          order: spec.order,
          // 每次装配重读 → 切换启用状态后下一个请求即生效。
          // 包一层箭头函数：spec.text 自身若被替换（热更新）也能跟上。
          text: () => spec.text(),
        })
        registrations.set(key, { scope, dispose: typeof dispose === 'function' ? dispose : () => {} })
      } catch (e) {
        // 同层重名注册会抛错：降级为"该段不注入"，不影响其余 scope 与其余段。
        console.error(
          `[dsh-plugin-tool-management] ${spec.name} section registration failed:`,
          String((e && (e as Error).message) || e),
        )
      }
    }
  }

  const uninstall = (scopeKey: string): void => {
    const prefix = scopeKey + KEY_SEP
    for (const key of [...registrations.keys()]) {
      if (!key.startsWith(prefix)) continue
      const entry = registrations.get(key)
      registrations.delete(key)
      try { entry?.dispose() } catch { /* ignore */ }
    }
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
      for (const key of [...registrations.keys()]) {
        const entry = registrations.get(key)
        registrations.delete(key)
        try { entry?.dispose() } catch { /* ignore */ }
      }
    },
  }
}

/**
 * 官方 `SECTION_ORDERS` 里 2901–4999 是空档，本插件的段全部落在该区间。
 * 数值本身无外部含义，只决定同一次装配里的相对顺序（小在前）。
 */
export const SECTION_ORDER = {
  /** 场景记忆（rules 服务）。 */
  sceneMemory: 3000,
  /** 子智能体人设目录。 */
  subagents: 3010,
  /** MCP 服务器状态与用户备注。 */
  mcpState: 3020,
} as const
