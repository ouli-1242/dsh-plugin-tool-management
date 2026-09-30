// 注入域的身份契约：六个域、每域对应消息 kind 与工具名前缀、子代理深度探针、设置默认值。
//
// 从 context-inject.ts 整段搬来，一行未改。这一层回答的是「哪个域是哪个域」——界面按它排六行
// 勾选、门禁按它把工具名归域、拦截按它认消息来源，四处读同一份，所以它必须是谁都能引、
// 但自己不依赖任何其它层的那一份。
import type { PresetInjectionFacts } from './compat/preset-reach.js'

/** 可注入的域（界面上的六个勾选，顺序即界面与消息顺序）。 */
export type InjectDomainKey = 'scene' | 'memory' | 'mcp' | 'skills' | 'subagents' | 'prompt'

/**
 * 权威域顺序（界面勾选、注入消息先后都按它）。
 * 场景排第一、记忆紧跟：场景是"当前模式"的**框架**（有哪些场景、各自是什么约定），
 * 记忆是各场景下的**内容** —— 先给框架再给内容。
 */
export const INJECT_DOMAIN_KEYS = ['scene', 'memory', 'mcp', 'skills', 'subagents', 'prompt'] as const

/**
 * 域 → 消息来源 kind（轨迹行标签，也是去重时的身份）。
 *
 * 命名对齐官方 `*-catalog` 风格与本插件的工具族（`*_manager_*`）；改名等于换身份，
 * 旧消息会被当成"不在上下文里"而重发一次，所以这几个字符串是稳定契约。
 *
 * ⚠️ 0.14.0 把 `memory` 的 kind 从 `scene-memory-manager-catalog` 改成
 * `memory-manager-catalog`，并把场景拆成独立的 `scene` 域 —— 升级后每个会话**会重发一次**
 * 这两段（旧消息认不出来）。一次性代价，换来的是两段能各自开关、各自去重。
 */
export const INJECT_KIND_OF: Record<InjectDomainKey, string> = {
  scene: 'scene-manager-catalog',
  memory: 'memory-manager-catalog',
  mcp: 'mcp-manager-catalog',
  skills: 'skill-manager-catalog',
  subagents: 'subagent-manager-catalog',
  prompt: 'prompt-manager-catalog',
}

/**
 * 域 → 该域在模型工具表里的**工具名前缀**（采纳遥测的唯一映射）。
 *
 * 为什么要这张表：注入只解决"内容到没到"，不解决"模型用没用"。「注入实况」此前
 * 只能答前半句 —— 勾了开关、正文也在上下文里，但模型从头到尾没伸手，界面上和
 * 「用了」长得一模一样。有了映射，就能把「投递 N 次 / 调用 M 次」并排摆出来，
 * 措辞与形式的调整才有依据（否则改文案就是猜）。
 *
 * 前缀而不是精确名：`memory_manager_*` 有 list/read/switch/save 等，任何一个
 * 都说明模型确实在读这一域。改工具名等于换身份，这几个字符串是稳定契约。
 *
 * 为什么值是**数组**：工具族与注入域不是一一对应的概念 —— 域是"给模型看的信息分组"
 * （界面上的勾选），族是"操作哪类对象"。0.14.0 里场景与记忆就一度同域两族
 * （`memory_manager_*` + `scene_manager_*`），拆开后现在每个域各一个前缀。留着数组是
 * 为了让"一个域挂多个族"在类型上成立，将来加族不必改类型。顺序不影响判定。
 */
export const DOMAIN_TOOL_PREFIX: Record<InjectDomainKey, readonly string[]> = {
  scene: ['scene_manager_'],
  memory: ['memory_manager_'],
  mcp: ['mcp_manager_'],
  skills: ['skill_manager_'],
  subagents: ['subagent_manager_'],
  prompt: ['prompt_manager_'],
}

/** 工具名 → 域（`undefined` = 不是本插件的域工具）。纯函数，便于单独推理。 */
export function domainOfTool(toolName: string): InjectDomainKey | undefined {
  const name = String(toolName ?? '')
  for (const key of INJECT_DOMAIN_KEYS) {
    for (const prefix of DOMAIN_TOOL_PREFIX[key]) {
      if (name.startsWith(prefix)) return key
    }
  }
  return undefined
}

/**
 * 这个 agent 在委派链上的**深度**（0 = 顶层会话，1 = 子会话，2 = 孙会话…）。
 *
 * 为什么需要它：`agent/pre-step` 挂在宿主平面，天然覆盖所有 agent（含子智能体）——
 * 这是当初选这条通道的代价。而人设目录该不该注入，取决于会话**有多深**（人设的
 * `catalogDepth` 决定"目录注入到几层"，默认 1 = 只在顶层），那是个关于深度的判断，
 * 不是一个布尔的身份标签。
 *
 * 口径照抄官方 `delegationDepthOf()`（`dsh-subagent/lib/index.js:144`）：持久化头
 * `session.header.delegationDepth` 与运行期选项 `agent.options.subagentDepth` 取较大者
 * —— 单看头会让"恢复的子会话"重新变成顶层（官方注释明说这是它要防的事）。
 * `header.origin === 'subagent'` 是"是子会话"的硬信号，深度至少算 1（头里没记深度时
 * 不能退回 0）。任一探针取不到或不是有限数都当它缺席：宁可把深度算浅一次（多注入一域），
 * 也不要把正常会话误判成子会话而静默少一域。
 */
export function subagentDepthOf(agent: unknown): number {
  try {
    const a = agent as {
      session?: { header?: { origin?: unknown; delegationDepth?: unknown } }
      options?: { subagentDepth?: unknown }
    } | null | undefined
    const header = a?.session?.header
    const finite = (value: unknown): number =>
      typeof value === 'number' && Number.isFinite(value) ? value : 0
    const persisted = header !== undefined && header !== null ? finite(header.delegationDepth) : 0
    const runtime = finite(a?.options?.subagentDepth)
    const floor = header !== undefined && header !== null && header.origin === 'subagent' ? 1 : 0
    return Math.max(floor, persisted, runtime)
  } catch {
    return 0
  }
}

/**
 * 这个 agent 是不是**子会话**（子代理派生的会话）。深度判定的布尔投影。
 *
 * ⚠️ 生产代码现在只用 `subagentDepthOf` —— 判据是"目录该不该注入到这么深的会话"，
 * 需要的是**深度数字**，不是一个布尔身份（2026-09-17 方案 A：委派可行性由官方决定，
 * 与"是不是子会话"无关）。这个投影留给真正需要布尔判断的场合，以及测试。
 */
export function isSubagentSession(agent: unknown): boolean {
  return subagentDepthOf(agent) >= 1
}

/**
 * 宿主 `MessageSource.form`（语义轴）：catalog = 本会话可用的条目、随变随重发；
 * snapshot = 当前状态、同源后发取代先发；instructions = 模型应当遵循的指令。
 * 只有 snapshot 形态要求带 `sections`。
 */
export type InjectForm = 'catalog' | 'snapshot' | 'instructions'

/**
 * 「官方已经送得到就别再送」的域 → 对应预设事实的键。
 *
 * 这两个域的内容官方也有：提示词（AGENTS.md 正文；场景期间换成场景提示词）由
 * `dsh-agent-instructions` 连着文件一起送，技能目录由 `dsh-tool-skill` 送。预设挂得到官方
 * 那条行时本插件不重复注入（否则同一段正文进上下文两次）；挂不到（极简两行都没挂）时才
 * 由本插件兜底 —— 于是"极简也能选择是否注入"成立，而普通预设下不会出现两份。
 */
export const CARRIER_FACT_OF: Partial<Record<InjectDomainKey, keyof PresetInjectionFacts>> = {
  prompt: 'carriesAgentsMd',
  skills: 'carriesSkillCatalog',
}

/** 一个来源文件（instructions 形态的 UI 文件清单条目；digest 只作悬停的身份提示）。 */
export interface InjectSourceFile {
  /** 非空路径（UI 的 `changes` 读取是全有全无：路径不合法的条目会让整份清单退回原文渲染）。 */
  path: string
  digest?: string
}

/** 一个域的注入声明。 */
export interface InjectDomain {
  key: InjectDomainKey
  /** 段名（进 `source.sections`；snapshot 形态才带上）。 */
  name: string
  /** 短名（模型侧引导语与「已清空」通知里的名字；与界面勾选标签同源）。 */
  label: string
  /** 来源 form。 */
  form: InjectForm
  /**
   * 同步返回域文本；`''` = 该域本次没有内容。
   *
   * 可以看 agent（2026-09-17 第二版）：人设目录要按**调用方深度**过滤 —— 深度 1 的会话
   * 只能看到"预算还够"的人设，否则就是它刚被修掉的那个陷阱（目录写着可委派、真调用必失败）。
   * 仍然必须同步：注入通道每个 step 同步取文本，域自带 SWR 缓存，这里不能读盘。
   */
  text: (agent?: unknown) => string
  /**
   * 本域正文的**来源文件**（同步；当前只有 instructions 形态用）。
   *
   * 为什么要有它：instructions 形态的界面契约是「文件清单 + 正文」—— 官方
   * `dsh-agent-instructions` 每条消息都带 `changes: [{path, action, digest?}]`，
   * 界面据此显示哪份文件被载入/更新；我们不带，界面就退回"一坨原文"，看不出这段内容
   * 来自哪个文件、是刚载入还是被替换过。
   *
   * 与 `text` 不同，**只在真要发消息时**调用（不是每个 step），所以允许一点算力
   * （提示词域要读一次盘 + sha1）。抛异常 = 本次不带清单，消息照发（清单是锦上添花）。
   */
  files?: () => readonly InjectSourceFile[]
  /**
   * 该域对这个 agent 是否成立（`false` = 本次不注入）。缺省 = 对任何 agent 都成立。
   *
   * 放在域声明上而不是写死在本模块里：这是**域自己的语义**（"人设目录对子会话无意义"），
   * 与通道机制无关；本模块只负责在注入前问一句。判定必须是同步纯函数 —— 注入通道每个
   * step 同步取文本，这里不能读盘。
   */
  applicableTo?: (agent: unknown) => boolean
}

/** 注入设置（插件侧车 `inject-settings.json`；界面在兼容页）。 */
export interface InjectSettings {
  /**
   * 压制型预设（persona `complete: true` 或 `includeRuntimeContext: false`）下是否仍然注入。
   * 默认 `false` = 跟随预设（尊重"这个预设只要它自己的内容"）。
   */
  underSuppressingPresets: boolean
  /** 各域开关（任何预设下都生效；默认全开）。 */
  domains: Record<InjectDomainKey, boolean>
}

export const DEFAULT_INJECT_SETTINGS: InjectSettings = {
  underSuppressingPresets: false,
  domains: { scene: true, memory: true, mcp: true, skills: true, subagents: true, prompt: true },
}