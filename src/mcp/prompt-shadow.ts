// MCP 跨会话 prompt 隔离：用官方 `systemPrompt` 在 **agent 作用域**注册同名段，
// 遮蔽根作用域注册的 `mcp-resource-servers` 与 `mcp:<server>`。
//
// 为什么必须走同名段：这两类段由 `dsh-mcp-resources` / `dsh-mcp-client` 注册在根作用域，
// 官方只按「全局层 + 作用域链」解析 provider，不看插件的会话可见性。不能 patch 官方包，
// 而 `systemPrompt.section()` 的官方语义是「scoped section shadows a global section with
// the same name」—— 这是唯一能把别的对话的服务器名与 instructions 从本对话提示词里拿掉的
// 接缝。空文本段会在组装阶段被过滤（`dsh-system-prompt` 的 `renderSections` 只保留非空
// 文本），所以隐藏服务器的 instructions 直接消失；资源段则替换成只列本会话可见服务器的
// 等价文本，避免模型被提示去调用已经从工具表里摘掉的三个工具。

/** 官方共享资源段的名称。 */
export const MCP_RESOURCE_SECTION_NAME = 'mcp-resource-servers'

/** 官方 MCP 段使用的排序名（`systemPrompt.getSectionOrder` 的入参）。 */
export const MCP_SERVERS_SECTION_ORDER = 'MCP_SERVERS'

/** 一个 prompt 段的最小结构面（与官方 `systemPrompt.section()` 的入参同形）。 */
export interface McpPromptSection {
  readonly name: string
  readonly order: number
  readonly interpolate?: boolean
  readonly text: string | (() => string)
}

/** agent ctx 上 `systemPrompt` 服务的最小结构面。 */
export interface McpPromptSectionService {
  getSectionOrder(name: string): number | undefined
  section(section: McpPromptSection): (() => void) | void
}

/** 一次同步要做的两件事：替换资源段、遮蔽隐藏服务器的 instructions。 */
export interface McpPromptShadowPlan {
  /** 是否需要替换 `mcp-resource-servers`。 */
  readonly resource: boolean
  /** 需要把 instructions 段设为空文本的服务器名。 */
  readonly hidden: readonly string[]
}

/** 官方 `mcp:<server>` 段的名称。 */
export function mcpServerSectionName(server: string): string {
  return 'mcp:' + server
}

/**
 * 按本会话可见的服务器名，算出要遮蔽哪些 prompt 段。
 *
 * 只有**存在隐藏服务器**时才替换资源段：全部可见时官方段的内容正好等于可见集合，
 * 替换没有收益，反而会丢失官方后续的文案调整。
 */
export function mcpPromptShadowPlan(names: readonly string[], visible: readonly string[]): McpPromptShadowPlan {
  const shown = new Set(visible)
  const hidden = names.filter((name) => !shown.has(name))
  return { resource: names.length > 0 && hidden.length > 0, hidden }
}

/**
 * 资源服务器段的等价文本。
 *
 * 文案与官方保持一致（标题 + 三个工具名 + server 名单），只把名单收窄到本会话可见的那些；
 * 名单为空时返回空串，让组装阶段把整段过滤掉。
 */
export function renderMcpResourceServersSection(visible: readonly string[]): string {
  if (visible.length === 0) return ''
  const names = [...visible].sort()
  return '## MCP resource servers\n\nUse list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with one of these names as the server argument: ' + JSON.stringify(names) + '.'
}

/** prompt 遮蔽器单次同步的可选项。 */
export interface McpPromptShadowOptions {
  /**
   * 官方那三个共享资源工具此刻注册着没有。
   *
   * 为 false 时不合成 `mcp-resource-servers` 的替代文本：官方包不在场时，这段文字会教模型
   * 调用三个不存在的工具。隐藏服务器的 `mcp:<server>` 段照旧遮蔽 —— 那来自另一个官方包。
   */
  readonly resourceAvailable?: boolean
}

/** prompt 遮蔽器的对外句柄。 */
export interface McpPromptShadow {
  /** 按当前名册同步某个 agent 的段；调用方可以高频调用，内部按名字差分。 */
  sync(agent: unknown, names: readonly string[], visible: readonly string[], options?: McpPromptShadowOptions): void
  /** 撤掉某个 agent 注册的全部遮蔽段（agent 下线时调用）。 */
  dispose(agent: unknown): void
  /** 撤掉全部（插件卸载时调用）。 */
  disposeAll(): void
}

/** 一个 agent 已注册的遮蔽段。 */
interface ShadowState {
  /** 当前可见服务器名；资源段的 text 每次组装都读这一份。 */
  visible: string[]
  resource?: () => void
  servers: Map<string, () => void>
}

/**
 * 创建提示词遮蔽器。
 *
 * @param systemPromptOf 从 agent 取 `systemPrompt` 服务；取不到时返回 undefined（该 agent 不遮蔽）。
 * @returns 按 agent 差分注册 / 撤销段的句柄。
 */
export function createMcpPromptShadow(systemPromptOf: (agent: unknown) => McpPromptSectionService | undefined): McpPromptShadow {
  const states = new Map<unknown, ShadowState>()

  function release(dispose: (() => void) | undefined): void {
    if (dispose === undefined) return
    try { dispose() } catch { /* agent 作用域已经释放 */ }
  }

  function sync(agent: unknown, names: readonly string[], visible: readonly string[], options?: McpPromptShadowOptions): void {
    const systemPrompt = systemPromptOf(agent)
    if (systemPrompt === undefined) return
    const order = Number(systemPrompt.getSectionOrder(MCP_SERVERS_SECTION_ORDER))
    if (!Number.isFinite(order)) return
    let state = states.get(agent)
    if (state === undefined) {
      state = { visible: [], servers: new Map() }
      states.set(agent, state)
    }
    const current = state
    current.visible = [...visible]
    const plan = mcpPromptShadowPlan(names, visible)
    const wantResource = plan.resource && options?.resourceAvailable !== false
    if (wantResource) {
      if (current.resource === undefined) {
        try {
          const dispose = systemPrompt.section({
            name: MCP_RESOURCE_SECTION_NAME,
            order,
            interpolate: false,
            text: () => renderMcpResourceServersSection(current.visible),
          })
          current.resource = typeof dispose === 'function' ? dispose : () => { /* 官方返回 void 时无法撤销，保留到 agent 释放 */ }
        } catch { /* 同名段已被别的 scoped 层占用：保留官方段，不把功能弄坏 */ }
      }
    } else if (current.resource !== undefined) {
      release(current.resource)
      current.resource = undefined
    }
    const hidden = new Set(plan.hidden)
    for (const [server, dispose] of [...current.servers]) {
      if (hidden.has(server)) continue
      release(dispose)
      current.servers.delete(server)
    }
    for (const server of plan.hidden) {
      if (current.servers.has(server)) continue
      try {
        const dispose = systemPrompt.section({
          name: mcpServerSectionName(server),
          order,
          interpolate: false,
          text: () => '',
        })
        current.servers.set(server, typeof dispose === 'function' ? dispose : () => { /* 同上 */ })
      } catch { /* 同上 */ }
    }
  }

  function dispose(agent: unknown): void {
    const state = states.get(agent)
    if (state === undefined) return
    release(state.resource)
    for (const disposeSection of state.servers.values()) release(disposeSection)
    states.delete(agent)
  }

  function disposeAll(): void {
    for (const agent of [...states.keys()]) dispose(agent)
  }

  return { sync, dispose, disposeAll }
}
