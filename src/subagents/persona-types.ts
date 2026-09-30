// 子代理域的公开类型面：人设文档、预设工具规则、工具过滤三态、服务出口。
//
// 从 subagents/service.ts 整段搬来，一行未改。类型在编译期擦除，单独一层只为把「形状」
// 与「实现」分开放 —— service.ts 那 1200 行里，读一个接口要翻过两百行实现。

export interface PersonaDoc {
  name: string
  description: string
  /** 模型路由的 provider 半边（与 model 配对；缺省 = 继承主会话）。 */
  provider?: string
  model?: string
  /**
   * **思考强度档位**（frontmatter `reasoningEffort`；值 = 该模型暴露的某个档位 id；缺省 = 不在这里指定）。
   *
   * 官方契约（都读过源码，见 2026-09-23 的核对）：
   *   · `AgentOptions.reasoningEffort?: ReasoningEffortId` —— `@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:21-30`；
   *   · 档位清单由 **adapter** 给出（`llm.resolveModelInfo(provider, model)` →
   *     `reasoning.efforts[]` / `defaultEffort`，`dsh-llm/lib/types/types.d.ts:295-312`），
   *     所以它跟 provider/model 走，**不是一个全局枚举**；那个调用是异步的、官方注释写明
   *     adapter-owned asynchronous lookup（可能联网）；
   *   · 不支持的值会在 provider I/O **之前**被拒 —— `resolveCallConfig` 注释：
   *     `Unsupported explicit efforts reject before provider I/O; no clamping or aliasing is performed`。
   *     所以我们**不**在这里校验档位合法性（清单可能拉不到），只做字符串归一，让官方那一步去拒。
   *
   * ⚠️ 留空的语义有个坑（`dsh-subagent/lib/index.js:471-483`）：子会话先继承主会话的
   * provider / model / reasoningEffort，再用我们的值覆盖；**但若这次改了 provider 或 model 而
   * 没给 reasoningEffort，继承来的那一档会被删掉**、回落到该模型自己的默认。界面上的 hint
   * 必须按这条写，不能笼统说"留空继承主会话"。
   */
  reasoningEffort?: string
  /** 工具白名单：只保留列出的工具（与 toolsDeny 组合，deny 优先）。**旧格式**：对所有预设生效。 */
  tools?: string[]
  /** 工具黑名单：从子代理可见集合里移除（优先级高于白名单）。**旧格式**：对所有预设生效。 */
  toolsDeny?: string[]
  /** 按 Agent 预设分组的工具限制（新格式）：键 = 预设 id，如 `standard`。 */
  toolsByPreset?: Record<string, PresetToolRule>
  /**
   * **输出契约**（frontmatter `output:`，可重复：一条要求一行；缺省 = 没有人设级硬要求）。
   *
   * 为什么单开一个字段而不是写在正文里：正文是"这个角色是什么"（散文），契约是"产出必须
   * 长什么样"（可检验的硬要求）。两者混在一起时，散文会把硬要求稀释成风格提示 —— 实测里
   * 一句「必须从第一性原理出发，使用对抗性审查」既没有产出形态、也无法判断有没有执行。
   * 独立字段让角色框把它渲染成单独一节（`## 输出要求`，位置在角色定义之后 —— 收尾处
   * 对模型同样显眼），作者也能在人设编辑器里单独维护。
   */
  output?: string
  /**
   * **人设目录注入到哪些会话**（frontmatter `catalogDepth`，默认 1）。
   *
   * ⚠️ 它**不是**递归上限。子代理始终可以继续委派 —— 官方 `dsh-tool-subagent` 工具的
   * `maxDepth` 默认是 **3**（`lib/index.js:269`），provider 只在**传了该值**时才校验
   * （`dsh-subagent-in-process-driver/lib/index.js:165` → `resolveChildDepth` →
   * `SubagentDepthError`）。2026-09-17 用户实测确认了这一点，也推翻了此前"子会话委派
   * 必然失败"的假设：那个假设只对**本插件自己的**工具成立（因为我们当时传了
   * `maxDepth: 1`），官方工具不受影响、照常能嵌套。**同一个子会话里官方工具能委派、
   * 我们的不能**，是那次自相矛盾的根源。
   *
   * 现在这个字段只做一件事：决定常驻的人设目录出现在哪些深度的会话里。
   *   - `1`（默认）= 只在顶层注入（子会话收不到目录）；
   *   - `2` = 顶层和子会话都注入；
   *   - `3` = 到两层子会话；
   *   - `UNLIMITED_PERSONA_CATALOG_DEPTH`（99）= 不限制嵌套，任何深度的会话都注入。
   * 判据是 `深度 < catalogDepth`。每一跳读**被委派那个人设**的字段，不需要跨会话保存状态。
   *
   * 为什么不把它传给官方：`SubagentStartRequest.maxDepth` 是**真的**递归上限，而我们这个
   * 字段的意图只是"目录出现在哪"。绑在一起会让我们的工具比官方严（1 vs 3），而且用户想
   * 禁止嵌套也禁止不了 —— 官方工具照样能。所以现在**不传**，让 provider 用它自己的默认。
   */
  catalogDepth?: number
  body: string
  path: string
  /**
   * 子智能体开关（list() 时由启用集合计算后附加）：`false` = 停用 —— 不注入目录段、
   * subagent_manager_list / subagent_manager_run 不可见；文件本体一个字节不动。
   * 缺省/`true` = 启用。原始解析（parsePersona）不产生这个字段。
   */
  enabled?: boolean
}

/** 一个 Agent 预设下的工具限制：白名单（只留列出的）或黑名单（移除列出的）。 */
export interface PresetToolRule {
  mode: 'allow' | 'deny'
  names: string[]
}

/** 一次委派实际下发的 ToolRestriction（与官方 `SubagentStartRequest.toolFilter` 同形）。 */
export interface ToolFilter {
  allow?: string[]
  deny?: string[]
}

/** `decideToolFilter` 的结论：`null` 表示明确不加限制。 */
export interface ToolFilterDecision {
  filter: ToolFilter | null
  /** 需要如实转告调用方的一句话（预设判断失败、名单里有已失效的工具等）。 */
  note?: string
}

export interface SubagentService {
  list(): Promise<PersonaDoc[]>
  /** 场景绑定校验 + 串行运行一个子代理（结果文本截断 ≤16 KiB）。`inherit` = 用 fork 通道（见 runOnce）。 */
  runSerial(parentAgent: any, persona: PersonaDoc, task: string, signal: AbortSignal | undefined, toolFilter?: ToolFilter | null, inherit?: boolean): Promise<{ text: string; runId: string; stopReason: string }>
  ops: Record<string, (args: any) => Promise<any>>
  /** 写操作 op 名集合（HTTP 端 WRITE_OPS 由它派生）。 */
  writeOps: ReadonlySet<string>
  /**
   * 场景档案引擎专用（非 op，无 HTTP 门禁面）：人设启用集合的读/写通道。
   * 进入模式时启用档案勾选的人设、退出时按快照停回，都走这里。
   */
  enabledStore: {
    /** 指定名单里当前被停用的（进入模式拍快照用：只记将被启用的行）。 */
    disabledAmong(names: string[]): Promise<string[]>
    /** 指定名单里当前**开着**的（进入模式把未勾的关掉时，只记将被关闭的行）。 */
    enabledAmong(names: string[]): Promise<string[]>
    /** 当前开着的人设全名单（档案页把「开关」落成场景绑定时用）。 */
    enabledNames(): Promise<string[]>
    /** 批量启停；只碰给出的名字，人设已不存在的跳过。 */
    setEnabled(names: string[], enabled: boolean): Promise<void>
  }
}