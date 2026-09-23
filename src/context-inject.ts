// src/context-inject.ts —— 模型可见信息的注入通道（本插件唯一的注入实现）。
//
// 为什么有这条通道（2026-09-16 用户裁定）：
//   插件此前用 `systemPrompt.section()` 把信息送进系统提示词，但那条通道会被 persona
//   `complete: true` 的预设整段压掉（极简等），模型什么都看不到；换成官方的
//   `systemPrompt.context()` 也不行 —— 极简同时写着 `includeRuntimeContext: false`，
//   运行时上下文快照照样被压。
//   官方自己不受影响的三件事走的都是第三条路：**在每一步请求开始前，往本轮消息里插一条
//   合成的 user 消息**（`agent/pre-step` 瀑布）——
//     · skill-catalog（@deepseek-ai/dsh-tool-skill）
//     · ~/.dsh/AGENTS.md（@deepseek-ai/dsh-agent-instructions）
//     · 时间上下文（@deepseek-ai/dsh-time-context）
//   这条通道没有任何预设开关能关掉，是"任何预设都到得了"的唯一选择。
//
// 形态（2026-09-16 第二版，用户裁定）：**每个域一条自己的消息**，不再是一条大快照 ——
// 与官方 skill-catalog 同款：各自的来源 kind（轨迹里各自一行、各显各的名字）、各自的
// form、各自的去重。好处是"只改了一个域就只重发那一条"；代价是进场景这类多域同时变的
// 时刻会一次发几条（每条带一句自己的引导语）。五个域与轨迹行名：
//   scene     → scene-manager-catalog（场景：启用的场景 + 场景说明，约定）
//   memory    → memory-manager-catalog（记忆：各场景下的条目，记录）
//   mcp       → mcp-manager-catalog
//   skills    → skill-manager-catalog（不叫 skill-catalog：那是官方那条行的名字）
//   subagents → subagent-manager-catalog
//   prompt    → prompt-manager-catalog
// 来源**不带 `plugin` 字段**：轨迹行标签的规则是「已知 kind 用自己的名字，插件来源用插件 id，
// 其余用裸 kind」，不带 plugin 才能让每行显示成自己的 kind（官方 agent-instructions /
// skill-catalog 同样只带 kind）。
//
// 本模块的实现口径：
//   - 每个 step 同步算一遍各域文本（各域自带 SWR/stat 缓存，**绝不在这里读盘**）；
//   - 与会话**可见表面上**该域最新的己方消息逐字节比对：一样就不发（零 token、零重复），
//     不一样才追加一条新消息；被压缩移出表面后比对不到 → 自动重发（与 skill-catalog、
//     agent-instructions 同款做法：两者都直接扫 `session.surface.nodes`）；
//   - 某域曾经注入过、现在没有内容（域被关掉或正文清空）→ 发一条该域的「已清空」，
//     免得旧目录继续被当成现状。
//
// 2026-09-17 第二版加的两件事：
//   - **按深度抑制人设目录**：宿主平面注册意味着子代理派生的会话也收到五域。而人设目录
//     要不要出现在某个深度的会话里，由人设的 `catalogDepth`（默认 1 = 只在顶层注入）决定；
//     判定放在域声明的 `applicableTo` 上，通道只负责问一句 —— "哪个域对哪类会话不成立"
//     是域的语义，不是通道的机制。
//     ⚠️ 2026-09-17 方案 A 纠正：这**不是**"子会话不能委派"。官方 `dsh-tool-subagent`
//     默认 `maxDepth: 3`，provider 只在传了该值时才校验 —— 子代理本来就能继续嵌套
//     （用户实测确认）。这个抑制只是让常驻目录不进入子会话、减少噪声；委派能力由官方
//     决定，本插件不干预（我们也不再传 `maxDepth`）。
//   - **采纳遥测**：注入只解决"到没到"，不解决"用没用"。本模块按域统计
//     「投递 N 次 / 调用 M 次 / 调用时正文在眼前 K 次」，工具注册处调 `noteToolUse` 记账。
//     没有这三个数，"模型忽略了注入内容"只是一句感觉，改了措辞也无从验证。
//
// 2026-09-17 第三版（两件事）：
//   - **界面契约对齐**：`source` 上补齐宿主给界面的结构化字段 —— snapshot 形态的 `sections`
//     一直有；instructions 形态现在带 `changes`（+ 首帧 `baseline`，来源文件由域声明的 `files`
//     提供），界面从"一坨原文"升级成官方 AGENTS.md 同款「文件 + 已载入/已更新」。这些字段
//     **只给界面看**：模型侧 content 不受影响，去重比对的也还是 content。
//   - **instructions 形态不再裸送**：模型侧正文改成与其他四域同款的 `<system-reminder>` 框架
//     （此前"原样送"的理由是"对齐官方"，与官方实际行为不符 —— 官方那条是包框架的；详见
//     `renderDomainText` 的第三版说明）。
//（catalog 形态**有意不带** `entries`：界面的条目渲染会整段替换正文，而我们的目录正文带着
//  框架句、未运行标记与"N 个未列出"这类补充行，给条目反而显示得更少。）
//
// 2026-09-18 第四版（用户：注入仍不能很好提醒模型去主动使用 + 该用 md 排版突出重点信息）：
//   - **框架改 md 四级结构**：`## 标题`（标签）+ **加粗动作句**（决策点线索）+ 补充动作行
//     （工具名 / 触发条件）+ 权威声明句（取代哪一份）。写法逐条对照 Claude Code 与 Codex CLI
//     的官方注入（理由见 `DOMAIN_FRAME`）。
//   - **正文也进标记**：此前 `<system-reminder>` 只包引导语、正文裸在外面；官方两条注入行
//     （skill-catalog / agent-instructions）都是整条包住的。正文里混着用户自由文本
//     （AGENTS.md / 记忆 / 备注），来源标记不能只盖住我们写的那一句。
//   - **闭合标记转义**：正文里的 `</system-reminder>` 会被拆开（照抄官方
//     `escapeInstructionFrameBody`），否则用户手写一个闭合标记就能让框架提前结束。
//
// 注入永远不能让这一步失败：任何异常都在监听器里吞掉、原样返回 decision。
// 遥测同理（`noteToolUse` 自己吞异常）：它绝不能影响工具本身。
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { PresetInjectionFacts } from './compat/preset-reach.js'
import { clearRuntimeNote, noteRuntime } from './compat/runtime-notes.js'

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
 * 前缀而不是精确名：`memory_manager_*` 有 list/read/set_enabled/save 等，任何一个
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
const CARRIER_FACT_OF: Partial<Record<InjectDomainKey, keyof PresetInjectionFacts>> = {
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

/** 把任意输入夹成合法设置（缺项/类型不对一律退回默认；默认从不阻止注入）。 */
export function normalizeInjectSettings(raw: unknown): InjectSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const domainsRaw = (obj.domains && typeof obj.domains === 'object' ? obj.domains : {}) as Record<string, unknown>
  const domains = {} as Record<InjectDomainKey, boolean>
  for (const key of INJECT_DOMAIN_KEYS) {
    domains[key] = typeof domainsRaw[key] === 'boolean' ? (domainsRaw[key] as boolean) : DEFAULT_INJECT_SETTINGS.domains[key]
  }
  return {
    underSuppressingPresets: typeof obj.underSuppressingPresets === 'boolean'
      ? obj.underSuppressingPresets
      : DEFAULT_INJECT_SETTINGS.underSuppressingPresets,
    domains,
  }
}

/** 一条待注入的域（纯数据，便于测试）。 */
export interface InjectSection {
  key: InjectDomainKey
  name: string
  label: string
  form: InjectForm
  text: string
}

/**
 * 纯函数：按设置 + 预设事实 + 目标 agent 挑出本次要注入的域。
 *
 * 规则（设计 2026-09-16；目录注入深度 2026-09-17）：
 *   - 域开关关掉的、文本为空的，都不进；
 *   - **压制型预设**且没开「仍然注入」→ 一个都不进（跟随预设）；
 *   - 域声明 `applicableTo` 说不成立的域不进（当前只有人设目录：会话深度超出了人设的
 *     `catalogDepth`，默认 1 = 只在顶层注入。**这不是"子会话不能委派"** —— 委派由官方
 *     决定，见 service.ts 里 `catalogDepth` 的注释）；
 *   - 有官方载体的两个域（提示词 / 技能目录）：预设挂得到官方那条行时不进
 *     —— 官方自己会送，再注入一遍只会重复；预设事实读不到（`undefined`）时按"已承载"处理
 *     （宁可与现状一致，也不制造重复）；
 *   - 同一段文本出现两次只保留前一个（跨域保险）。
 */
export function selectInjections(
  domains: readonly InjectDomain[],
  settings: InjectSettings,
  facts: PresetInjectionFacts | undefined,
  agent?: unknown,
): InjectSection[] {
  const suppressing = facts !== undefined && facts.suppressing
  if (suppressing && !settings.underSuppressingPresets) return []
  const out: InjectSection[] = []
  const seen = new Set<string>()
  for (const domain of domains) {
    if (settings.domains[domain.key] !== true) continue
    // 域自己不成立就不发（如人设目录的 catalogDepth 没覆盖到本会话的深度）。**这里没有开关，是刻意的**：
    // 曾经有个 `suppressInSubagentSessions` 想让这一步可选，但它是个空开关 —— 域不成立时
    // 正文自己也被过滤成空的（见 `subagents/catalog.ts` 的按深度过滤），两道闸条件相同，
    // 开关只控制得了其中一道。留一个点了没反应的勾选框比没有更糟，所以删掉（2026-09-17）。
    if (domain.applicableTo !== undefined && !domain.applicableTo(agent)) continue
    const carrier = CARRIER_FACT_OF[domain.key]
    // 官方载体已挂（或读不到预设、只能按已挂算）→ 不重复送；只有明确"没挂"才兜底。
    if (carrier !== undefined && facts?.[carrier] !== false) continue
    let text = ''
    try { text = String(domain.text(agent) ?? '') } catch { text = '' }
    if (text.trim() === '') continue
    const fingerprint = text.trim()
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    out.push({ key: domain.key, name: domain.name, label: domain.label, form: domain.form, text })
  }
  return out
}

/**
 * 某一步「为什么发 / 为什么不发」。
 *
 * `child` = 该域对本会话不成立（人设目录：会话深度超出了人设的 `catalogDepth`）；`official` = 官方载体在送；
 * `off` = 开关关了；`empty` = 本插件负责但没内容；`sent` = 本插件负责且有内容。
 */
export type InjectReason = 'off' | 'official' | 'empty' | 'sent' | 'child'

/**
 * 纯函数：算出某一步每个域的原因（`selectInjections` 的镜像，供「注入实况」解释状态）。
 *
 * 与 `selectInjections` 分开写是为了让两边各自可读：一个是"发什么"，一个是"为什么"。
 * 口径必须一致 —— 否则界面会把"子会话抑制"报成"未投递"，而界面的既有口径是
 * 「琥珀只留给'该投却没投'」（把用户自己的选择读成故障，正是这条口径要避免的事）。
 *
 * ⚠️ 这里**故意不镜像** `selectInjections` 开头那条"压制型预设一个都不进"的提前返回：
 * 该分支下本函数仍按各域自身的原因作答，于是压制型预设 + 没开「仍然注入」时，
 * 界面看到的是"未投递"（琥珀）而不是"已关闭"（灰）。这是 0.9.1 的既有行为，本次未改，
 * 改动它属于另一个话题（"跟随预设"到底该报成故障还是报成选择）。
 */
export function explainInjections(
  domains: readonly InjectDomain[],
  settings: InjectSettings,
  facts: PresetInjectionFacts | undefined,
  agent?: unknown,
): Partial<Record<InjectDomainKey, InjectReason>> {
  const reasons: Partial<Record<InjectDomainKey, InjectReason>> = {}
  for (const domain of domains) {
    if (settings.domains[domain.key] !== true) { reasons[domain.key] = 'off'; continue }
    if (domain.applicableTo !== undefined && !domain.applicableTo(agent)) { reasons[domain.key] = 'child'; continue }
    const carrier = CARRIER_FACT_OF[domain.key]
    if (carrier !== undefined && facts?.[carrier] !== false) { reasons[domain.key] = 'official'; continue }
    let text = ''
    try { text = String(domain.text(agent) ?? '') } catch { text = '' }
    reasons[domain.key] = text.trim() === '' ? 'empty' : 'sent'
  }
  return reasons
}

/**
 * 每个域的**框架**：标题 + 加粗的动作句 + 补充动作 + 权威声明。
 *
 * 为什么是这四件（2026-09-18 第四版：用户「注入提示词还是不能很好提醒模型去主动使用」+
 * 「应该通过设计 md 格式突出重点信息」，写法参照 Claude Code 与 Codex CLI 两家官方源码）：
 *
 *   1. **动作句单独一行、加粗**。证据是 Claude Code 书里记的一次 eval
 *      （`claude-code-from-source/book/ch11-memory.md:193`）：同一段正文只换标题，
 *      「Before recommending from memory」（落在决策点上的动作线索）得 3/3，
 *      「Trusting what you recall」（抽象主题）得 0/3 —— 引导语的**形式**（决策点的动作）
 *      比**内容**更决定采纳率。所以标题只当标签用（这条讲的是这台机器的什么），
 *      动作另起一行、加粗，写"在哪个决策点该想起它"。
 *   2. **`##` 标题**：md 里最省字符的结构标记；也给工具描述一个能回指的锚点
 *      （Claude Code 的 AgentTool / SkillTool 描述都写 "listed in <system-reminder>
 *      messages in the conversation"，把目录的位置说给模型）。
 *   3. **补充动作用一行给工具名与触发条件**。两家的目录句都把工具名写死在里面
 *      （Claude Code「available for use with the Skill tool」、官方 skill-catalog
 *      「call the `skill` tool with the exact skill name before taking task actions」）——
 *      模型不会凭"应该有个工具"去猜工具名，但会给它一个明确的调用点。
 *   4. **权威声明单独成句**。原来那句「（取代本次会话中更早的同类内容）」是塞在名词短语里的
 *      括注，容易整句略过；Codex 的对应写法是完整陈述句
 *      （`codex-rs/core/src/context/world_state/agents_md.rs:9`："These AGENTS.md instructions
 *      replace all previously provided AGENTS.md instructions."），官方 skill-catalog 的更新帧
 *      同理（"This complete catalog replaces every earlier available-skills list in this
 *      session"）。这句必须留：注入按"内容变了才重发"工作，重发时旧那份还在上下文里，
 *      模型得知道以哪份为准。
 *
 * 各域的 `how` 只写**正文没说过**的事：一处内容一个出处（记忆与提示词两域因此没有 `how`
 * —— 记忆的授权与判据由正文首行那句加粗的「用户为本机写的参考信息：…」承担）。
 */
interface DomainFrame {
  /** 标题（md H2）：这条讲的是这台机器的什么。 */
  title: string
  /** 加粗的动作句：在哪个决策点该想起它。 */
  cue: string
  /** 补充动作（工具名 / 触发条件 / 边界）；正文已经说过的不要写。 */
  how?: string | ((toolHidden: (name: string) => boolean) => string | undefined)
  /** 权威声明：「最新一份才是权威」这条得逐域说清取代的是什么。 */
  supersede: string
}

/**
 * 权威声明的统一句（用户 2026-09-23 看到实际注入后要求精简）。
 *
 * 此前五个域各写一份 —— `本份场景取代…同类场景` / `本份记忆取代…同类记忆` /
 * `本份状态…` / `本份目录…` —— 说的是**同一条规则**却用了四种措辞，模型读到四条不同的句子
 * 还得自己判断它们是不是一条。统一成一句：被取代的是"同类内容"，与域无关。
 *
 * 为什么不能并进 `cue`（那能省下整整一行 ≈16 tok/段）：用户 2026-09-18 定过"权威声明单独
 * 成句" —— 它和动作句是两种东西（一句说"什么时候用它"，一句说"以哪份为准"），合并后容易
 * 被一眼带过。所以这里的收益只有约 6 tok/轮，**主要收益是消除四种措辞**，不是省字节。
 */
const SUPERSEDE_NOTE = '本份取代本次会话中更早注入的同类内容。'

const DOMAIN_FRAME: Partial<Record<InjectDomainKey, DomainFrame>> = {
  scene: {
    // 场景段此前是四个板块里**唯一没有动作句**的 —— 首句只说"场景是什么"，模型读完不知道
    // 该拿它做什么（用户 2026-09-23 看到实际注入后："感觉不对劲，但说不上来"）。
    //
    // 根因是**场景的语义被窄化了**：它其实是"切换六处开关的运行时模式"（`scene-mode-set`
    // 的三步：服务器级/来源级 → 工具级/技能级 → 人设 + 备注），而注入里只呈现了它作为
    // "记忆分组标签"的那一面 —— 四个板块并列，看不出场景是"因"、其余四段是"果"。
    //
    // cue 是动作句（与另三段同形）。模型对场景本身**没有动作可做**（启用与进入在界面上，
    // `scene_manager_save` 只做定义层），所以 cue 指向"它会改变你看到的东西"，而不是
    // "你去操作它"。
    //
    // 因果句（"下面四段都是按它筛过的"）**不放在这里**：① 启用（`active`）与进入
    // （`mode.scene`）是两份状态，只启用没进入时那句就是假话；② 它排在场景名之前，
    // 「它」会没有指代。已挪进 `renderSceneCatalog` 的正文（场景名之后，按 mode 分叉）。
    title: '本机当前的场景',
    cue: '在按默认方式做事之前，先确认当前是这个场景。',
    supersede: SUPERSEDE_NOTE,
  },
  memory: {
    title: '本机当前的记忆',
    cue: '在回答涉及本机的事之前，先核对这里。',
    supersede: SUPERSEDE_NOTE,
  },
  mcp: {
    title: '本机 MCP 服务器的当前状态',
    cue: '要用某个 MCP 工具前，先在这里确认这台服务器在不在、开没开。',
    how: '工具名是 `mcp__<服务器>__<工具>`；带「用户提示：」的行是用户写给这台服务器的决策提示，选服务器之前先看一眼。',
    supersede: SUPERSEDE_NOTE,
  },
  skills: {
    title: '本机技能目录',
    cue: '需要某项能力时，先在这里找。',
    // 两句都只在预设没挂官方 `skill` 工具时出现，差别只在点名不点名那个取正文的工具
    // （工具被用户在兼容页关掉时不点名 —— 点名一个模型手里没有的工具只会让它去猜名字）。
    how: (toolHidden) => toolHidden('skill_manager_read')
      ? '本预设没有官方 `skill` 工具：目录只有摘要，读完再照做。'
      : '本预设没有官方 `skill` 工具：要正文用 `skill_manager_read`（按名字直接给正文与路径）；目录只有摘要，读完再照做。',
    supersede: `${SUPERSEDE_NOTE.slice(0, -1)}；只列当前可调用的技能。`,
  },
  subagents: {
    title: '可委派的子智能体',
    cue: '在决定自己做还是委派之前，先在这里选人设。',
    // 分界规则（2026-09-17 方案 C，本机实测 session-ee722e23 逼出来的）：官方那两个
    // 委派工具（`subagent` / `subagent_fork`）不带人设，而此前没有任何一句话说明何时该
    // 用谁 —— 模型在"审查刚读过的 README"时选了 `subagent_fork`（fork 能继承已读内容、
    // 省一次复述）。现在人设通道也有 `inherit`（同一套 fork 机制），分界只剩"要不要后台跑"。
    // 带人设的委派工具被关掉时改说"本会话没有这条通道"：不说的话，模型看到有人设目录却
    // 找不到对应的工具，会去拿官方那两个凑（它们不接受人设，等于白跑一趟）。
    how: (toolHidden) => toolHidden('subagent_manager_run')
      ? '本会话没有带人设的委派工具；官方 `subagent` / `subagent_fork` 不带人设，只在没有人设贴合、或要后台跑时用。'
      : '贴合人设的任务一律用 `subagent_manager_run`（要它看到本次会话就开 `inherit`）；官方 `subagent` / `subagent_fork` 不带人设，只在没有人设贴合、或要后台跑时用。',
    supersede: SUPERSEDE_NOTE,
  },
  prompt: {
    title: '本机提示词',
    cue: '动手之前先按它对齐，与它冲突的默认做法一律让位。',
    supersede: '本份提示词取代本次会话中更早注入的同类提示词。',
  },
}

/** 域声明里没登记的 key（理论上到不了这里）：给一个不出错的通用框架。 */
const fallbackFrame = (label: string): DomainFrame => ({
  title: `本机的${label}`,
  cue: `需要这台机器的${label}时，先核对这里。`,
  supersede: '本份内容取代本次会话中更早注入的同类内容。',
})

const domainFrame = (key: InjectDomainKey, label: string): DomainFrame => DOMAIN_FRAME[key] ?? fallbackFrame(label)

/**
 * 框架的伪 XML 标记。与官方两条注入行同款：`dsh-tool-skill` 与 `dsh-agent-instructions`
 * 都把**整条正文**包在里面（不是只包引导语）。Claude Code 那边把这对标记叫"可依赖的
 * 判别符"（`messages.ts:1797` 的 `ensureSystemReminderWrap` 保证任何注入文本都不落在外面）：
 * 模型据此把这段读成系统给的上下文，而不是用户刚打的字 —— 本插件的正文里混着用户写的
 * 自由文本（AGENTS.md / 记忆 / 备注），这层来源标记尤其不能少。
 */
const FRAME_OPEN = '<system-reminder>'
const FRAME_CLOSE = '</system-reminder>'

/**
 * 正文里的 `</system-reminder>` 拆掉闭合形态（写成 `<\/system-reminder>`）。
 *
 * 正文含用户自由文本（AGENTS.md、记忆、MCP 备注、技能描述），一句手写的闭合标记就能让框架
 * 提前结束，其后的内容读起来像用户当场说的话。照抄官方 `escapeInstructionFrameBody` 的实现
 * （`dsh-agent-instructions/lib/index.js:128`，同样是替换成带反斜杠的形态 —— 模型看到的
 * 字面量不变，标记不再闭合）。
 */
export function escapeFrameBody(body: string): string {
  return body.replaceAll(FRAME_CLOSE, '<\\/system-reminder>')
}

/**
 * 一条注入消息的正文（纯函数）：`<system-reminder>` 里 = 框架（标题 + 动作 + 补充 + 权威
 * 声明）+ 空行 + 域正文。**五个域一律带框架**，没有例外。
 *
 * 历史（每一版都是被具体毛病逼出来的，别把结论当套话读）：
 *   - 第一版（2026-09-17 前）：五域共用「以下是本机插件的X（取代…）。」——「本机插件」是实现
 *     细节；通篇没有动作；五条消息句式一模一样，雷同的套话退化成背景噪声。
 *   - 第二版（2026-09-17）：动作前置（`**{线索}**：以下是{域}（取代…）。{补充}`），但只改了
 *     用户圈定的两域（记忆 / 子智能体），MCP、技能、提示词继续走老模板。
 *   - 第三版（2026-09-17）：instructions 形态不再裸送 —— 此前"原样送"的理由是"对齐官方
 *     AGENTS.md 那条行"，与官方实际行为不符（官方那条是包 `<system-reminder>` 的，含一句
 *     "这些工作区指令可作参考……"。真正的问题在极简类预设：官方通道被压掉后本插件是唯一
 *     承载者，裸文本没有任何标记，而提示词会因场景切换而变化、新旧两份效力相同、没有判据。
 *     只借官方**包框架**的形式，**不抄**它那句把用户规则降成"仅供参考"的措辞。
 *   - 第四版（2026-09-18，本条）：**动作仍然不够显眼**（用户：「还是不能很好提醒模型去主动
 *     使用」），且整条消息该按 md 排版突出关键信息。改成四级结构：`##` 标题当标签、
 *     加粗动作句单独一行、补充动作给工具名、权威声明单独成句（逐条理由见 `DOMAIN_FRAME`）。
 *     同时把**正文也包进标记里**（此前只有引导语在标记内、正文裸奔）—— 官方两条注入行都是
 *     整条包住的，正文里的用户自由文本更需要这层来源标记。
 */
export function renderDomainText(section: InjectSection, toolHidden: (name: string) => boolean = () => false): string {
  const frame = domainFrame(section.key, section.label)
  // 层级（2026-09-23 用户看到实际注入后指出「记忆内的场景怎么都是 ## 标题」）：**`#` 一级给板块**
  // （场景 / 记忆 / MCP / 技能 / 子智能体 / 提示词），域正文里的 `##` 才是它的下一层
  // （记忆段的 `## 场景：X`、超预算时的 `## 未注入的参考信息`）。此前标题也是 `##`，两者平级，
  // 模型读不出主次 —— 而"哪些内容归在哪个板块/场景下"正是它做判断时要用的结构。
  //
  // 开标签后**必须空一行**：markdown 里 `#` 紧跟在一行文字后面只是**段落续行**，不会被渲染成
  // 标题 —— 用户截图里 `## 本机当前的场景` 就是这么被吞掉的（和 `<system-reminder>` 挤成一段）。
  // 收尾同理：正文末尾先归一成单个空行，免得 `</system-reminder>` 粘在最后一行上。
  const lines = [FRAME_OPEN, '', `# ${frame.title}`, `**${frame.cue}**`]
  const how = typeof frame.how === 'function' ? frame.how(toolHidden) : frame.how
  if (how !== undefined) lines.push(how)
  lines.push(frame.supersede, '', escapeFrameBody(section.text).replace(/\n+$/, ''), '', FRAME_CLOSE)
  return lines.join('\n')
}

/** 「已清空」通知正文：某个域曾经注入过、现在没有内容时发一条（纯函数，测试用）。 */
export function clearedDomainText(key: InjectDomainKey, label: string): string {
  const frame = domainFrame(key, label)
  // 形状与 `renderDomainText` 一致（开标签后空行、板块 `#`、收尾空行）—— 这两条都是同一个
  // 通道发出去的消息，层级与留白不该有两套。
  return [
    FRAME_OPEN,
    '',
    `# ${frame.title}`,
    '**已清空** —— 本次会话中此前注入的同类内容不再有效。',
    '',
    FRAME_CLOSE,
  ].join('\n')
}

/** 取一条消息的正文（只认单 text 块；形如官方 RuntimeContextProjection.textOf）。 */
function textOf(message: unknown): string | undefined {
  const content = (message as { content?: unknown } | null | undefined)?.content
  if (!Array.isArray(content) || content.length !== 1) return undefined
  const block = content[0] as { type?: unknown; text?: unknown } | undefined
  return block && block.type === 'text' && typeof block.text === 'string' ? block.text : undefined
}

/**
 * 会话**可见表面上**每个域最新一条己方注入的正文。
 *
 * 可见表面 = `session.surface.nodes`（dsh-session 的公开面，官方 skill-catalog 与
 * agent-instructions 都直接扫它）：一条注入若已被压缩移出表面，说明它不在模型上下文里
 * → 该域不在 map 里 → 该重发。表面接口整个缺失时退回扫事件流（按"仍可见"处理，
 * 宁可与现状一致，也不制造每步重发）。
 */
/** 消息来源 kind → 本插件域（`official` = 官方载体发的，不是本插件注入的）。 */
interface KindMapping { key: InjectDomainKey; official: boolean }

/** 本插件自己的五个注入 kind（去重比对只用这一份 —— 绝不能让官方正文影响"发不发"的判断）。 */
const PLUGIN_KINDS: ReadonlyMap<string, KindMapping> = new Map(
  INJECT_DOMAIN_KEYS.map((key) => [INJECT_KIND_OF[key], { key, official: false }] as const),
)

/**
 * 官方载体消息的 kind → 本插件域：技能目录（`@deepseek-ai/dsh-tool-skill`）与
 * AGENTS.md（`@deepseek-ai/dsh-agent-instructions`）。仅用于「注入实况」展示 ——
 * 标准类预设下这两个域由官方在送，它同样是"模型看到的内容"，体积要算官方那份。
 * 字符串取自官方包，是宿主侧的稳定契约。
 */
const OFFICIAL_KIND_OF: Readonly<Record<string, InjectDomainKey>> = {
  'skill-catalog': 'skills',
  'agent-instructions': 'prompt',
}

/**
 * 用户**明确关掉**的域 → 该域对应的官方消息 kind（这些 kind 的消息这一步不放行）。
 *
 * 交互事实（用户 2026-09-17 指出）：技能与提示词两域在标准类预设下由官方送（本插件让位），
 * 于是"取消勾选"只停掉了本插件自己，官方那条照样进上下文 —— 用户看到的是"关了没用"。
 * 本函数给出需要**连带拦下**的官方 kind：只有"官方自己会送同份内容"的两个域有这一项；
 * MCP / 记忆 / 人设目录官方不送，没有可拦的对象（它们的开关本来就完全生效）。
 */
export function officialKindsToSuppress(settings: InjectSettings): ReadonlySet<string> {
  const out = new Set<string>()
  for (const [kind, key] of Object.entries(OFFICIAL_KIND_OF)) {
    if (settings.domains[key] === false) out.add(kind)
  }
  return out
}

/** 一条消息的来源 kind（读不到 = `undefined`）。 */
function kindOfMessage(message: unknown): string | undefined {
  const source = (message as { source?: { kind?: unknown } } | null | undefined)?.source
  return source && typeof source.kind === 'string' ? source.kind : undefined
}

// B4：关域拦截的**顺序自检**。官方那两条注入行与本插件同挂在这条瀑布上，拦截成立的剩余前提是
// "本插件排在它们上游"（本插件用 `{ prepend: true }` 把自己钉在钩子表最前，所以真正还依赖的
// 只剩一条：官方那两条仍用**默认 push** 方式注册）。这仍是非契约事实（见 pre-step 监听器里的
// 注释）。官方哪天改成 prepend 抢到更前面，症状就是「关了域、模型还是收到内容」，且**完全没有
// 报错**。这里做最轻的自检：关域生效期间连续 N 个真实 turn 一条都没剔到，就上报一次；
// 剔到过就收掉那条上报。如实写清两种可能（顺序变了 / 官方这一轮本来没内容），
// 不把它说成一定是事故。
const SUPPRESSION_SUSPECT_TURNS = 5

function suppressionVerdict(active: boolean, dropped: number, counter: { turns: number; drops: number }): void {
  if (!active) {
    counter.turns = 0
    counter.drops = 0
    clearRuntimeNote('official-suppression')
    return
  }
  counter.turns += 1
  counter.drops += dropped
  if (counter.drops > 0) {
    counter.turns = 0
    clearRuntimeNote('official-suppression')
    return
  }
  if (counter.turns < SUPPRESSION_SUSPECT_TURNS) return
  noteRuntime({
    id: 'official-suppression',
    label: '官方注入的关域拦截',
    kind: 'read',
    fallback: 'inform-only',
    detail: `关掉的注入域已连续 ${counter.turns} 轮没有拦到任何官方消息（自检）：可能是瀑布注册顺序变了导致拦截失效，也可能是官方那两条注入行这几轮本来就没有内容。可到「注入实况」对照模型实际收到的内容。`,
  })
}

/** 实况展示用的 kind 表：本插件的五条 + 官方两条。 */
const LIVE_KINDS: ReadonlyMap<string, KindMapping> = new Map([
  ...PLUGIN_KINDS,
  ...Object.entries(OFFICIAL_KIND_OF).map(([kind, key]) => [kind, { key, official: true }] as const),
])

function newestDomainTexts(agent: unknown, kinds: ReadonlyMap<string, KindMapping>): Map<InjectDomainKey, { text: string; form: string; official: boolean }> {
  const out = new Map<InjectDomainKey, { text: string; form: string; official: boolean }>()
  const session = (agent as { session?: any } | null | undefined)?.session
  if (!session || typeof session.seq !== 'number' || typeof session.eventAt !== 'function') return out
  const scan = (seq: number): boolean => {
    let event: any
    try { event = session.eventAt(SessionSeq(seq)) } catch { return false }
    if (!event || event.type !== 'user/message') return false
    const source = event.data && event.data.source
    const mapping = source && typeof source.kind === 'string' ? kinds.get(source.kind) : undefined
    if (mapping === undefined || out.has(mapping.key)) return false
    const text = textOf(event.data)
    if (text === undefined) return false
    out.set(mapping.key, { text, form: source && typeof source.form === 'string' ? source.form : '', official: mapping.official })
    return out.size === INJECT_DOMAIN_KEYS.length
  }
  const nodes: unknown = session.surface && Array.isArray(session.surface.nodes) ? session.surface.nodes : undefined
  if (nodes !== undefined) {
    const seqs: number[] = []
    for (const node of nodes as unknown[]) {
      const n = Number(node)
      if (Number.isFinite(n)) seqs.push(n)
    }
    seqs.sort((a, b) => b - a) // 从新到旧（表面自身的顺序不保证）
    for (const seq of seqs) if (scan(seq)) break
    return out
  }
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) if (scan(seq)) break
  return out
}

export interface ContextInjectorDeps {
  /** 插件 ctx（宿主平面：agent 事件天然冒泡到这里）。 */
  ctx: any
  /** 取当前域声明（每次装配重读，热更新也能跟上）。 */
  domains: () => readonly InjectDomain[]
  /** 取当前设置（同步快照；读失败由调用方兜底为默认值）。 */
  settings: () => InjectSettings
  /** 该 agent 所在预设的两条事实；`undefined` = 读不到（按未压制 / 已承载处理）。 */
  factsFor: (agent: unknown) => Promise<PresetInjectionFacts | undefined> | PresetInjectionFacts | undefined
  /**
   * 令牌门禁：返回真 = 这一步**不放行**（令牌在生效、而本次启动还没有人验过）。
   *
   * 为什么拦在这里：客户端那条「锁输入框」的路子在这台宿主上根本不存在 ——
   * `ctx.conversation.blocks` 是官方留的口子，但客户端服务注册表里没有 `conversation`
   * （2026-09-19 真机实测：37 项服务、严格/非严格读都拿不到，宿主自己的
   * ui-model-selection 也拿不到），所以令牌开了也锁不住输入框。`agent/pre-step` 是**宿主
   * 平面**，与客户端无关，返回 `{kind:'reject'}` 会让这一轮直接判 `blocked` —— 这才是
   * "没验令牌就没法对话"的真正落实（宿主原文也承认 composer block 只是 affordance）。
   * 未配置令牌时该回调恒为 false，行为与从前完全一致。
   */
  tokenGateActive?: () => boolean
  /**
   * 兼容页「模型工具表」关掉的工具名（同步快照，读 TTL 缓存）。
   *
   * 只为一件事：`how` 行里点名工具的那几句在工具被关掉后就是假的（"用 `skill_manager_read`
   * 拿正文"—— 模型手里没有这个工具）。关掉的不点名，其余照旧。框架文本变了会当成"内容变了"
   * 重发一次，这是正确行为（模型上下文里那份确实已经不准确了）。
   */
  hiddenTools?: () => ReadonlySet<string>
  /** 诊断用（默认 console.error）。 */
  logger?: (message: string) => void
}

/**
 * 一个域的**采纳**统计（**这一段对话**的，不是进程累计，也不是会话历史）。
 *
 * 为什么要它：「注入实况」此前只能答"内容到没到"，答不了"模型用没用" —— 勾了开关、
 * 正文也在上下文里，但从头到尾没伸手，界面上和"用了"长得一模一样。有了这三个数，
 * "注入 20 次 / 调用 0 次"就是一条可行动的结论，而不是感觉。
 *
 * 三个数的口径（刻意分开，不要合并成一个比率）：
 *   - `injected`：本插件为该域投递过几条注入消息（与 `delivered.byDomain` 同源）；
 *   - `used`：模型调用该域工具的次数 —— **不区分成功失败**。参数写错也算"伸手了"：
 *     我们要测的是"模型知不知道有这个域、会不会去用"，不是"调用写得对不对"；
 *   - `adopted`：其中"调用发生时该域正文正在上下文里"的次数。这才是严格意义的采纳 ——
 *     `used` 高而 `adopted` 低说明模型是凭记忆/猜的，注入没起作用。
 */
export interface LiveAdoption {
  injected: number
  used: number
  adopted: number
  lastUsedAt: number | null
}

/** 一个域在**最近活跃会话**可见表面上的实况。 */
export interface LiveInjectionDomain {
  key: InjectDomainKey
  label: string
  kind: string
  /**
   * in-context = 插件注入的在上下文里；cleared = 已清空；
   * official = 官方载体在送、插件不重复送（提示词 / 技能目录，标准类预设下的常态）；
   * off = 域开关被关掉；empty = 本插件负责但当前没有内容；absent = 该投却没投（含压缩后未补发）；
   * child = 当前是子会话、该域对子会话不成立（人设目录）；
   * unknown = 没有会话。
   */
  state: 'in-context' | 'cleared' | 'official' | 'off' | 'empty' | 'absent' | 'child' | 'unknown'
  bytes: number
  text: string
  /** 采纳统计（这一段对话的；与 `state` 无关，那个是"现在"，这个是"这段对话以来"）。 */
  adoption: LiveAdoption
}

/** 注入实况快照（`injection-live` 只读 op 的载荷；供兼容页展示"模型现在看到什么"）。 */
export interface LiveInjectionSnapshot {
  /** 是否记住了最近活跃的会话（WeakRef 被回收或从未收到 pre-step → false）。 */
  hasAgent: boolean
  /** **最近那一段对话**的投递统计（换会话即换一份；重启后归零）。 */
  delivered: { count: number; lastAt: number | null; byDomain: Record<string, number> }
  /**
   * **最近那一段对话**里观测到的本插件工具调用（采纳遥测的观测面）。
   *
   * 为什么单列：`adoption[*].used` 全是 0 时，必须能分清"模型真的没用"和"遥测没接上"
   * —— 前者是结论，后者是故障。`observed` 记的是"观测到多少次工具调用"，
   * 只要它不为 0，`used = 0` 就是可信的结论。
   */
  observed: { toolCalls: number; lastAt: number | null }
  /**
   * 成本视图（**最近那一段对话**的累计；换会话或重启都归零）。
   *
   * 为什么要它：每域的字节与投递次数此前**分开**报，谁也答不出"钱花在哪"——
   * 一域 200 KB × 投 30 次，与一域 8 KB × 投 30 次，在界面上长得一模一样。
   *
   * 口径是**近似**：`injectedBytes` 拿「该域当前正文 × 该域投递次数」估，中途改过内容的话，
   * 历史那几次投的不是现在这个体积。它答的是"哪个域在吃预算"，不是一张账单。
   */
  cost: {
    /** 当前在上下文里的那几域正文合起来的字节（＝一份的体量）。 */
    liveBytes: number
    /** 这段对话累计投进上下文的字节（近似，见上）。 */
    injectedBytes: number
    /** 累计里占比最大的域；一次都没投过为 `null`。 */
    topDomain: { key: InjectDomainKey; label: string; bytes: number } | null
    /** 投递次数最多的域（"重发最多"）；没投过为 `null`。 */
    mostDelivered: { key: InjectDomainKey; label: string; count: number } | null
  }
  domains: LiveInjectionDomain[]
}

const bytesOf = (text: string): number => {
  try { return Buffer.byteLength(text, 'utf8') } catch { return text.length }
}

/**
 * 注册 `agent/pre-step` 注入监听；返回清理函数与采纳遥测入口。
 *
 * 宿主平面注册即可覆盖所有 agent（含子智能体、含任何预设）——dsh-scope 的
 * `scopeTarget` 过滤对没有 scope 标记的 ctx 直接放行，官方 time-context 就是这么挂的。
 * "覆盖到子智能体"这件事本身是**特性**（子会话同样需要记忆与提示词），只有人设目录
 * 那一域对它不成立，由域声明的 `applicableTo` 单独挡掉 —— 通道不替域做决定。
 */
export function createContextInjector(deps: ContextInjectorDeps): {
  dispose: () => void
  live: () => LiveInjectionSnapshot
  /**
   * 记一笔"模型调了本插件某个域的工具"（采纳遥测；由工具注册处调用）。
   * `toolName` 不是本插件域的 → 静默忽略。任何异常都吞掉：遥测绝不能影响工具本身。
   */
  noteToolUse: (toolName: string, agent: unknown) => void
} {
  const log = (message: string): void => {
    try { (deps.logger ?? ((m: string) => console.error('[dsh-plugin-tool-management] ' + m)))(message) } catch { /* ignore */ }
  }
  // 最近活跃的会话（WeakRef：诊断用，不阻止会话被回收）。每次 pre-step 都刷新 ——
  // 包括"空 turn 提前返回"和"这一步没有内容可发"的分支，页面才能如实说"没投过"。
  let lastAgent: WeakRef<object> | null = null
  /**
   * 一次对话的注入账本（投递 / 采纳 / 观测三组计数）。
   *
   * 为什么按**会话**记而不是按进程累加（2026-09-22 用户裁定）：进程级的那份把今天所有
   * 对话混在一个数字里 —— 「注入 8 次 · 从未调用」说的其实是"这台机器开机以来"，
   * 而用户看这块面板时问的是"我眼前这一段对话里模型用没用"。两个问题差得很远，
   * 前者几乎永远读不出可行动的结论。会话身份本来就有（下面的 `liveDomainsByAgent`
   * 就是按 agent 记的），改的只是把计数也挂上去。
   */
  interface ConversationLedger {
    delivered: { count: number; lastAt: number | null; byDomain: Record<string, number> }
    adoption: Record<InjectDomainKey, LiveAdoption>
    observed: { toolCalls: number; lastAt: number | null }
  }
  const emptyLedger = (): ConversationLedger => {
    const adoption = {} as Record<InjectDomainKey, LiveAdoption>
    for (const key of INJECT_DOMAIN_KEYS) adoption[key] = { injected: 0, used: 0, adopted: 0, lastUsedAt: null }
    return { delivered: { count: 0, lastAt: null, byDomain: {} }, adoption, observed: { toolCalls: 0, lastAt: null } }
  }
  const ledgers = new WeakMap<object, ConversationLedger>()
  /** 取（或新建）这个会话的账本。pre-step 与工具调用两条路都从这里过。 */
  const ledgerFor = (agent: object): ConversationLedger => {
    let ledger = ledgers.get(agent)
    if (ledger === undefined) {
      ledger = emptyLedger()
      ledgers.set(agent, ledger)
    }
    return ledger
  }
  // 每个 agent 最近一步"在上下文里"的域集合 —— 采纳判定要回答的是"调用发生时正文在不在眼前"。
  // WeakMap：不阻止会话被回收（与 lastAgent 同一考虑）。
  const liveDomainsByAgent = new WeakMap<object, Set<InjectDomainKey>>()
  // 最近一步里"每个域为什么发/不发"（官方载体 / 开关关 / 空 / 子会话不适用 / 本插件负责）。
  // 只在没有可见注入时用来解释状态 —— 标准类预设下技能与提示词由官方在送，
  // 插件的实况若只说"未投递"，读起来像出了问题。
  let lastReasons: Partial<Record<InjectDomainKey, InjectReason>> = {}
  const live = (): LiveInjectionSnapshot => {
    let agent: object | undefined
    try { agent = lastAgent ? lastAgent.deref() : undefined } catch { agent = undefined }
    // 面板读的是**这一段对话**的账本；会话已经被回收了就没有账本可读，全零 + `hasAgent:false`。
    const ledger = agent === undefined ? emptyLedger() : ledgerFor(agent)
    const visible = agent === undefined
      ? new Map<InjectDomainKey, { text: string; form: string; official: boolean }>()
      : newestDomainTexts(agent, LIVE_KINDS)
    const labelOf = new Map<InjectDomainKey, string>(deps.domains().map((domain) => [domain.key, domain.label] as const))
    const rows: LiveInjectionDomain[] = INJECT_DOMAIN_KEYS.map((key) => {
      const entry = visible.get(key)
      const reason = lastReasons[key]
      const state: LiveInjectionDomain['state'] = agent === undefined
        ? 'unknown'
        : entry !== undefined
          // 官方载体发的那条也算"模型看到的内容"（只是不是本插件送的）；
          // 本插件发过又清空的，报「已清空」。
          ? (entry.official ? 'official' : entry.form === 'notice' ? 'cleared' : 'in-context')
          // 没在上下文里：用最近一步的原因解释；`sent`（该发）却没看到 = 压缩后还没补发。
          : reason === 'off' ? 'off' : reason === 'official' ? 'official' : reason === 'empty' ? 'empty' : reason === 'child' ? 'child' : 'absent'
      const text = (state === 'in-context' || state === 'official') && entry !== undefined ? entry.text : ''
      return {
        key,
        label: labelOf.get(key) ?? key,
        kind: INJECT_KIND_OF[key],
        state,
        bytes: bytesOf(text),
        text,
        adoption: { ...ledger.adoption[key] },
      }
    })
    // 成本汇总：只做算术，不碰投递语义（这条视图的存在不改任何发送文本，因此不会触发重发）。
    let liveBytes = 0
    let injectedBytes = 0
    let topDomain: LiveInjectionSnapshot['cost']['topDomain'] = null
    let mostDelivered: LiveInjectionSnapshot['cost']['mostDelivered'] = null
    for (const row of rows) {
      liveBytes += row.bytes
      const sends = ledger.delivered.byDomain[row.key] ?? 0
      const spent = row.bytes * sends
      injectedBytes += spent
      if (spent > 0 && (topDomain === null || spent > topDomain.bytes)) topDomain = { key: row.key, label: row.label, bytes: spent }
      if (sends > 0 && (mostDelivered === null || sends > mostDelivered.count)) mostDelivered = { key: row.key, label: row.label, count: sends }
    }
    return {
      hasAgent: agent !== undefined,
      delivered: { count: ledger.delivered.count, lastAt: ledger.delivered.lastAt, byDomain: { ...ledger.delivered.byDomain } },
      observed: { toolCalls: ledger.observed.toolCalls, lastAt: ledger.observed.lastAt },
      cost: { liveBytes, injectedBytes, topDomain, mostDelivered },
      domains: rows,
    }
  }
  const noteToolUse = (toolName: string, agent: unknown): void => {
    try {
      const key = domainOfTool(toolName)
      if (key === undefined) return
      const at = Date.now()
      // 记在**发起这次调用的那个会话**的账上。`exec.agent` 与 pre-step 的 `payload.agent`
      // 是同一个对象（`dsh-scope` 的不变量要求），所以这里
      // 落账的会话与上面 `liveDomainsByAgent` 记现场的会话必然一致。
      let owner = typeof agent === 'object' && agent !== null ? (agent as object) : undefined
      if (owner === undefined) { try { owner = lastAgent ? lastAgent.deref() : undefined } catch { owner = undefined } }
      if (owner === undefined) return
      const ledger = ledgerFor(owner)
      ledger.observed.toolCalls += 1
      ledger.observed.lastAt = at
      const row = ledger.adoption[key]
      row.used += 1
      row.lastUsedAt = at
      // 采纳判定：调用发生时该域正文正在这个会话的上下文里。
      const liveKeys = liveDomainsByAgent.get(owner)
      if (liveKeys !== undefined && liveKeys.has(key)) row.adopted += 1
    } catch { /* 遥测绝不能影响工具本身 */ }
  }
  const ctx = deps.ctx
  if (!ctx || typeof ctx.on !== 'function') return { dispose: () => {}, live, noteToolUse }
  /** B4 自检计数（每个注入器实例各自一份，随实例销毁而消失）。 */
  const suppressionCounter = { turns: 0, drops: 0 }
  // `{ prepend: true }` —— 位置**必须**钉在钩子表最前，理由见 `next()` 之后那段注释
  // （关域拦截只在上游成立）。这里不靠"谁先注册"：cordis 的 Loader 是**并发**挂载条目的
  // （`await Promise.allSettled(config.map((options) => this.create(options)))`，
  // cordis-plugin-loader/lib/index.js），每个官方包 apply 的完成先后由模块导入与 IO 决定，
  // 逐次启动都可能不同；本插件的条目又是补丁层 `insert` 推到条目列表**末尾**的
  // （dsh-app-boot/lib/index.js：顶层 insert 走 `data.push(...insert)`）。
  // 2026-09-20 实测到那次翻转：关掉技能 / 提示词域后，官方注入照旧进上下文。
  // `prepend` 由 cordis `EventsService.register()` 实现（`hooks[options.prepend ? 'unshift' : 'push']`），
  // 于是不论挂载先后，本插件都排在官方那两条**默认 push** 注册的注入行之前 ——
  // 顺序从"竞态"变成"约定"。
  const stop: unknown = ctx.on('agent/pre-step', async (payload: any, next: () => Promise<any>) => {
    // 令牌门禁在**最前面**：没验过令牌时这一轮整个不放行，`next()` 都不必跑（后面那些注入
    // 本来就是给模型看的，模型这一步根本不会被调用）。宿主据此把 turn 收成 `blocked`。
    // 代价（宿主文档写明）：被认领的那条用户消息会被丢弃 —— 这是"拦住"的固有代价，界面侧
    // 的可见提示由兼容页那条「去填令牌」横幅承担。
    try {
      if (deps.tokenGateActive && deps.tokenGateActive()) {
        log('令牌未验证：本轮对话被拒绝（在「工具 → 兼容」页填入访问令牌后恢复）')
        return { kind: 'reject' }
      }
    } catch { /* 门禁判定失败不能反过来卡住对话：当作放行 */ }
    const decision = await next()
    try {
      if (!decision || decision.kind === 'reject') return decision
      const agent = payload && payload.agent
      if (!agent) return decision
      if (typeof agent === 'object') {
        // 账本先建好：下面任何一条提前返回（空 turn / 没内容可发）都要能在实况里读到
        // "这一段对话投了 0 次"，而不是读到上一段对话的数字。
        ledgerFor(agent as object)
        try { lastAgent = new WeakRef(agent as object) } catch { /* 环境没有 WeakRef → 实况显示"没有会话" */ }
      }
      // 空 turn 不注入（官方 dsh-agent-instructions 同款守卫）：step 1 且一条消息都没有时，
      // 这一步本来就该原地结束（宿主随后把 turn 判为 completed）。此时注入会把空 turn
      // 变成一次真实的模型请求 —— 凭空烧一次调用。
      if (Number(payload.step) === 1 && messagesOf(decision).length === 0) return decision
      const domains = deps.domains()
      const settings = deps.settings()
      // 被用户关掉的官方载体域：连官方那条消息一起**不放行**（见 officialKindsToSuppress）。
      // 边界说明：这不是改官方包、也不是改宿主机制 —— pre-step 的 decision 本来就是每个插件
      // 都能改的那条缝（官方自己就在这里追加消息），我们只把它剔出这一步的批次。代价是官方
      // 插件每一步都会重新渲染并尝试注入（它的历史读的是会话事件，读不到被拦下的那条），
      // 模型侧不受影响。
      // **为什么 `prepend` 是必需的**：官方那两条注入行都在 `await next()` **之后**才往
      // `decision.messages` 里追加（dsh-tool-skill 末尾 `[...decision.messages, catalog]`；
      // dsh-agent-instructions `toSpliced(lastClaimedIndex + 1, 0, desired)`），而瀑布的
      // `next()` 只做"取钩子表的下一个"。所以只有排在他们**上游**的监听器，其 `next()`
      // 返回时才看得见这些追加 —— 本插件的过滤在 `next()` 之后，位置必须在上游。
      const suppressedKinds = officialKindsToSuppress(settings)
      let messages: readonly unknown[] = messagesOf(decision)
      if (suppressedKinds.size > 0) {
        let dropped = 0
        const kept = messages.filter((message) => {
          const kind = kindOfMessage(message)
          if (kind !== undefined && suppressedKinds.has(kind)) { dropped += 1; return false }
          return true
        })
        if (kept.length !== messages.length) messages = kept
        // B4 自检：只有"这一步真的在拦"时才有意义（令牌门禁 reject、空 turn 早退都在上面）。
        suppressionVerdict(true, dropped, suppressionCounter)
      } else {
        suppressionVerdict(false, 0, suppressionCounter)
      }
      const facts = await deps.factsFor(agent)
      const sections = selectInjections(domains, settings, facts, agent)
      // 记录每个域这一步"为什么发 / 为什么不发"，供「注入实况」解释状态（口径见 explainInjections）。
      lastReasons = explainInjections(domains, settings, facts, agent)
      const visible = newestDomainTexts(agent, PLUGIN_KINDS)
      const additions: unknown[] = []
      const appended: InjectDomainKey[] = []
      // 本步真正投出去的**域正文**（不含下面的「已清空」通知）：采纳统计的 `injected` 只算它，
      // 「已清空」不是一次"给了模型内容"，算进去会让分母虚高。
      const injectedKeys = new Set<InjectDomainKey>()
      const published = new Set<InjectDomainKey>()
      // 域声明按 key 索引：来源文件（`files`）只在真要发消息时取，所以要能从这里回查声明。
      const domainOf = new Map(domains.map((domain) => [domain.key, domain] as const))
      // 工具表开关本步读一次（同步快照）：`how` 行里点名工具的那几句据此换话术。
      const hiddenNow = deps.hiddenTools !== undefined ? deps.hiddenTools() : null
      const toolHidden = hiddenNow === null ? () => false : (name: string) => hiddenNow.has(name)
      for (const section of sections) {
        published.add(section.key)
        const text = renderDomainText(section, toolHidden)
        const current = visible.get(section.key)
        if (current !== undefined && current.text === text) continue
        // `current !== undefined` = 该域在可见表面上已有一条更早的己方消息 → 这次是**替换**，
        // 界面上的动作标签据此从「已载入」变成「已更新」（见 domainMessage 的 baseline/changes）。
        let files: readonly InjectSourceFile[] | undefined
        try { files = domainOf.get(section.key)?.files?.() } catch { files = undefined }
        additions.push(domainMessage(section, text, files, current !== undefined))
        appended.push(section.key)
        injectedKeys.add(section.key)
      }
      // 曾经注入过、这一轮没有内容的域 → 一条「已清空」；从没注入过的域什么都不用说。
      const labelOf = new Map(domains.map((domain) => [domain.key, domain.label] as const))
      const clearedKeys = new Set<InjectDomainKey>()
      for (const key of INJECT_DOMAIN_KEYS) {
        if (published.has(key)) continue
        const previous = visible.get(key)
        if (previous === undefined) continue
        const label = labelOf.get(key) ?? key
        if (previous.form === 'notice') continue
        additions.push(clearedMessage(key, label))
        appended.push(key)
        clearedKeys.add(key)
      }
      // 采纳判定要用的现场：**含官方载体**，并并入本步刚投出去的域正文（它们就在这一步的
      // 请求里，模型当场看得到）。判断"发不发"只能用本插件自己的 kind —— 官方正文绝不能
      // 影响去重（见 PLUGIN_KINDS 的注释）；判断"模型眼前有没有这份内容"则必须连官方那份
      // 一起算，标准类预设下技能与提示词正是官方在送。两遍扫描，两种口径各自正确。
      // **「已清空」通知要从现场里剔掉**：那条消息也带域标记、也占 `newestDomainTexts` 的键，
      // 但它不是正文。连着它一起算，"用户早把这个域关了、模型凭工具描述去调"的那次调用会被
      // 记成采纳 —— 于是 `adopted` 实际在说"这个域本会话说过话"，界面文案里那句"正文正在上下文
      // 里"就成了假话。剔除之后 `used - adopted` 才第一次有意义：调了、但正文不在眼前。
      // `clearedKeys` 那一步是同一个判据的另一半：通知这会儿还没落到会话表面上，光靠扫表面
      // 会漏掉"就是这一步刚被清空"的那个域。
      // 位置在"提前返回"之前：这一步没东西可发时，现场依然是当前状态，同样要记。
      try {
        if (typeof agent === 'object') {
          const liveKeys = new Set<InjectDomainKey>()
          for (const [key, entry] of newestDomainTexts(agent, LIVE_KINDS)) if (entry.form !== 'notice') liveKeys.add(key)
          for (const key of injectedKeys) liveKeys.add(key)
          for (const key of clearedKeys) liveKeys.delete(key)
          liveDomainsByAgent.set(agent as object, liveKeys)
        }
      } catch { /* 采纳遥测拿不到现场就退化成"只记 used"，绝不影响注入 */ }
      if (additions.length === 0) {
        // 没有新增时，只有"拦下了官方消息"才需要返回改动后的 decision；否则原样返回。
        return messages === messagesOf(decision) ? decision : { ...decision, messages: [...messages] }
      }
      const ledger = ledgerFor(agent as object)
      ledger.delivered.count += additions.length
      ledger.delivered.lastAt = Date.now()
      for (const key of appended) ledger.delivered.byDomain[key] = (ledger.delivered.byDomain[key] || 0) + 1
      for (const key of injectedKeys) ledger.adoption[key].injected += 1
      return { ...decision, messages: [...messages, ...additions] }
    } catch (error) {
      // 注入是尽力而为：任何异常都不能把这一步弄失败。
      log('context injection failed: ' + String((error && (error as Error).message) || error))
      return decision
    }
  }, { prepend: true })
  return {
    dispose: () => {
      try { if (typeof stop === 'function') (stop as () => void)() } catch { /* ignore */ }
      // 注入通道没了，自检结论也失效（B4）——留着会让兼容页报一件不存在的事。
      clearRuntimeNote('official-suppression')
    },
    live,
    noteToolUse,
  }
}

function messagesOf(decision: any): readonly unknown[] {
  const messages = decision && decision.messages
  return Array.isArray(messages) ? messages : []
}

/**
 * 一条域消息。`source` 上带的字段是**给界面的结构化数据**（模型侧只看 content，不受影响）：
 *   - snapshot 形态带 `sections`（界面分节显示，框架句由界面用固定 caption 顶替）；
 *   - instructions 形态带 `changes`（+ 首帧的 `baseline`）—— 官方 `dsh-agent-instructions`
 *     的同款契约（`dsh-client-ui-chat` 读 `path` + `action` ∈ set/replace/remove + 可选 digest），
 *     界面据此把这条渲染成「文件清单 + 正文」而不是一坨原文。
 *     `action` 由**是否替换**决定：本域此前没有可见消息 = 首帧 → `set` + `baseline: true`
 *     （界面显示「已载入」）；有 → `replace`（「已更新」）。`baseline` 只在真时写：界面判
 *     `=== true`，写 false 是噪声。缺 `files`（域没提供、或提供时抛错）→ 两个字段都不写，
 *     界面退回原文渲染，消息内容不变。
 */
function domainMessage(
  section: InjectSection,
  text: string,
  files?: readonly InjectSourceFile[],
  replacing?: boolean,
): unknown {
  const source: Record<string, unknown> = { kind: INJECT_KIND_OF[section.key], form: section.form }
  if (section.form === 'snapshot') source.sections = [{ name: section.name, text: section.text }]
  if (section.form === 'instructions' && files !== undefined && files.length > 0) {
    if (replacing !== true) source.baseline = true
    source.changes = files.map((file) => ({
      action: replacing === true ? 'replace' : 'set',
      path: file.path,
      ...(file.digest !== undefined && file.digest !== '' ? { digest: file.digest } : {}),
    }))
  }
  return createUserMessage({
    content: [{ type: 'text', text }],
    source,
  } as any)
}

function clearedMessage(key: InjectDomainKey, label: string): unknown {
  return createUserMessage({
    content: [{ type: 'text', text: clearedDomainText(key, label) }],
    source: { kind: INJECT_KIND_OF[key], form: 'notice', summary: `${label}已清空` },
  } as any)
}
