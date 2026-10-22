// 子代理域的公开类型面：人设文档、预设工具规则、工具过滤三态、服务出口。
//
// 从 subagents/service.ts 整段搬来，一行未改。类型在编译期擦除，单独一层只为把「形状」
// 与「实现」分开放 —— service.ts 那 1200 行里，读一个接口要翻过两百行实现。

/** 一份人设文档：frontmatter 字段 + 正文。 */
export interface PersonaDoc {
  name: string
  description: string
  /** 模型路由的 provider 半边（与 model 配对；缺省 = 继承主会话）。 */
  provider?: string
  model?: string
  /**
   * **思考强度档位**（frontmatter `reasoningEffort`；值 = 该模型暴露的某个档位 id；缺省 = 不在这里指定）。
   *
   * 官方契约（都读过源码，见 的核对）：
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
   * ⚠️ 它**不是**递归上限。子代理能否继续委派由官方配置决定 —— `dsh-subagent` 的
   * `maxDepth` 默认是 **1**（0.2.1 核对 `dsh-subagent/lib/index.js` 的 `Config`：
   * `maxDepth: z.number().step(1).min(0).default(1).volatile()`），provider 只在**传了该值**时
   * 才校验（`resolveChildDepth` → `SubagentDepthError`）；没传就用宿主配置那一档。
   * 工具成立（因为我们当时传了 `maxDepth: 1`），而官方工具用的是它自己的默认值。**同一个
   * 子会话里官方工具能委派、我们的不能**，是那次自相矛盾的根源。
   * 结论不变：这个字段只管"目录出现在哪些会话"，能不能继续委派始终问官方，不在这里判。
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
   * 禁止嵌套也禁止不了 —— 官方工具照样能。所以现在**不传**，让 provider 用它自己的配置
   * （0.2.1 默认 `maxDepth: 1`，即顶层委派一次、子会话本身不能再委派；要放开就在宿主侧调）。
   */
  catalogDepth?: number
  /**
   * **允许追问**（frontmatter `continuable: true`；缺省 = 一次性）。
   *
   * 一次性（默认）：`ctx.subagents.start()` 跑一轮就结算，产出作为**工具返回值**回到父代理，
   * 子会话随即 `dispose()` —— 父代理此后再也找不到它。
   * 可继续：`ctx.subagents.startContinuable()` 建一个**持久子会话**，在**收件箱受理时**即兑现
   * （不是跑完），返回稳定 `childId`，子代理在后台继续跑。父代理之后用宿主自带的全局
   * `send_message` / `interrupt_agent`（`@deepseek-ai/dsh-tool-subagent-control` 注册，与创建它的
   * 工具无关）追问或中止 —— 所以本插件**不新增追问工具**。
   *
   * ⚠️ 三条官方语义决定了这条通道的结果是**异步**的（0.2.1 核实）：
   *   · 启动时（`delivery: 'parent'` 且子代理手里有 `send_message`）会被追加一句返回指引
   *     （`withContinuableReturnGuidance`），要求它**自己**把自包含结果 `send_message` 给父代理
   *     —— 父代理不会自动收到它的转录、工具输出或思考；
   *   · 结算时父代理**一定**收到一条 `subagent-settled` 通知（`notifySettlement` →
   *     `createSettlementMessage`）：收尾一行（按 stopReason 措辞）+ 子代理的收尾正文，
   *     有结构化结果或诊断时一并带上；`delivery: 'caller'` 的那一次不发；
   *   · `interrupt_agent` / `send_message` 是全局工具，与创建它的工具无关。
   * 于是 `subagent_manager_run` 对这类人设只回执一个 id，不再是最终产出。
   *
   * 前置条件（缺任一，官方在启动时抛错，见 `index.js:1986-1997` / `3161`）：
   *   · 宿主加载了 session persistence 与 session query（`CONTINUATION_UNAVAILABLE` / `PERSISTENCE_UNAVAILABLE`）；
   *   · provider 具备 `prepareContinuable`（两个进程内 provider 都有）；
   *   · 未超过容量上限 `maxActiveSubagents`（宿主 `dsh-subagent` 配置，默认 8）。
   */
  continuable?: boolean
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

/** 子智能体服务的对外面：人设 CRUD、启停与委派。 */
export interface SubagentService {
  list(): Promise<PersonaDoc[]>
  /**
   * 场景绑定校验 + 串行运行一个子代理（结果文本截断 ≤16 KiB）。`inherit` = 用 fork 通道（见 runOnce）。
   *
   * `continuable: true` = 这次走的是**允许追问通道**：没有产出文本，`runId` 是持久子会话 id，
   * `stopReason` 固定为 `'started'`，产出稍后由子代理自己 `send_message` 回来（见 PersonaDoc.continuable）。
   */
  runSerial(parentAgent: any, persona: PersonaDoc, task: string, signal: AbortSignal | undefined, toolFilter?: ToolFilter | null, inherit?: boolean): Promise<{ text: string; runId: string; stopReason: string; continuable?: true }>
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
