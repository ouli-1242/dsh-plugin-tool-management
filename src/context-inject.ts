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
// 时刻会一次发几条（每条带一句自己的引导语）。各域与轨迹行名（清单见下 INJECT_DOMAIN_KEYS）：
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
//   - **按深度抑制人设目录**：宿主平面注册意味着子代理派生的会话也收到全部域。而人设目录
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
import type { PresetInjectionFacts } from './compat/preset-reach.js'
import { clearRuntimeNote, noteRuntime } from './compat/runtime-notes.js'
import {
  CARRIER_FACT_OF,
  DEFAULT_INJECT_SETTINGS,
  domainOfTool,
  INJECT_DOMAIN_KEYS,
  INJECT_KIND_OF,
  type InjectDomain,
  type InjectDomainKey,
  type InjectForm,
  type InjectSettings,
  type InjectSourceFile,
} from './context-inject-contract.js'
import {
  explainInjections,
  type InjectReason,
  type InjectSection,
  selectInjections,
} from './context-inject-select.js'
import { clearedDomainText, renderDomainText } from './context-inject-frame.js'
import {
  kindOfMessage,
  LIVE_KINDS,
  newestDomainTexts,
  officialKindsToSuppress,
  PLUGIN_KINDS,
} from './context-inject-surface.js'

// 拆出的四层照旧从 context-inject.js 对外可见（index.ts、ops/compat.ts、tools/table.ts、
// subagents/{catalog,service}.ts 与契约测试都按这个路径引）。
export {
  DEFAULT_INJECT_SETTINGS,
  DOMAIN_TOOL_PREFIX,
  INJECT_DOMAIN_KEYS,
  INJECT_KIND_OF,
  domainOfTool,
  isSubagentSession,
  subagentDepthOf,
  type InjectDomain,
  type InjectDomainKey,
  type InjectForm,
  type InjectSettings,
  type InjectSourceFile,
} from './context-inject-contract.js'
export {
  explainInjections,
  normalizeInjectSettings,
  selectInjections,
  type InjectReason,
  type InjectSection,
} from './context-inject-select.js'
export { clearedDomainText, escapeFrameBody, HOW_NAMED_TOOLS, renderDomainText } from './context-inject-frame.js'
export { officialKindsToSuppress } from './context-inject-surface.js'

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
    detailKey: 'official-suppression',
    params: { turns: counter.turns },
  })
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
   * `how` 行里点名过的工具中，**这个 agent 手里没有**的那些（同步快照）。
   *
   * 只为一件事：`how` 行里点名工具的那几句在工具不在手里时就是假的（"用 `skill_manager_read`
   * 拿正文"—— 模型手里没有这个工具）。不在手里的不点名，其余照旧。框架文本变了会当成"内容变了"
   * 重发一次，这是正确行为（模型上下文里那份确实已经不准确了）。
   *
   * ⚠️ **必须带 agent**：两条路都会让工具不在手里 —— 兼容页的全局开关（同一份名单给所有
   * agent），以及**人设的工具限制**（`tools.restrict`，逐 agent 不同）。此前只读全局那份，
   * 于是人设砍掉 `skill_manager_read` 之后，目录照注、`how` 行照样点名它。
   * 名单内容由 `HOW_NAMED_TOOLS` 界定（框架层登记，与 `how` 定义相邻）。
   */
  hiddenTools?: (agent: unknown) => ReadonlySet<string>
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
   * child = 当前是子会话、该域对子会话不成立（场景与记忆只在顶层注入；人设目录看 catalogDepth）；
   * error = 该域这一轮**取数抛异常**（内容仍在，但这一步取不到 —— 是故障，不是"没内容"）；
   * unknown = 没有会话。
   */
  state: 'in-context' | 'cleared' | 'official' | 'off' | 'empty' | 'absent' | 'child' | 'error' | 'unknown'
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
          // `error`（取数抛异常）单列 —— 它和「未投递」不是同一件事，混在一起会把故障读成延迟。
          : reason === 'off' ? 'off' : reason === 'official' ? 'official' : reason === 'empty' ? 'empty' : reason === 'child' ? 'child' : reason === 'error' ? 'error' : 'absent'
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
    // 本步的失败痕迹（2026-09-30，审查 P1-8）：域取数抛异常 / 整段注入抛异常。
    // 两者都必须是**用户看得见**的降级（兼容页 + 「注入实况」），不能只剩控制台一行日志 ——
    // 这条通道整段停掉时，此前唯一的痕迹就是 `console.error`（脆弱性地图 F2）。
    let injectionFailed = false
    let failedKeys: Set<InjectDomainKey> = new Set()
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
      // 域取数抛异常 → 记下来（本步不发它的「已清空」，实况报 error，兼容页留一条降级）。
      failedKeys = new Set()
      const sections = selectInjections(domains, settings, facts, agent, (key, error) => {
        failedKeys.add(key)
        const label = domains.find((domain) => domain.key === key)?.label ?? key
        noteRuntime({
          id: 'context-injection-runtime',
          label: '上下文注入通道',
          kind: 'read',
          fallback: 'inform-only',
          detail: `注入域「${label}」这一轮取数失败（${String((error as Error)?.message || error)}）：该域本轮没有发送任何内容，也不会误发一条「已清空」（保留上一轮内容不动），下一步会自动重试。`,
          detailKey: 'context-injection-runtime.domain',
          params: { domain: label },
        })
      })
      // 记录每个域这一步"为什么发 / 为什么不发"，供「注入实况」解释状态（口径见 explainInjections）。
      lastReasons = explainInjections(domains, settings, facts, agent, failedKeys)
      const visible = newestDomainTexts(agent, PLUGIN_KINDS)
      const additions: unknown[] = []
      const appended: InjectDomainKey[] = []
      // 本步真正投出去的**域正文**（不含下面的「已清空」通知）：采纳统计的 `injected` 只算它，
      // 「已清空」不是一次"给了模型内容"，算进去会让分母虚高。
      const injectedKeys = new Set<InjectDomainKey>()
      const published = new Set<InjectDomainKey>()
      // 域声明按 key 索引：来源文件（`files`）只在真要发消息时取，所以要能从这里回查声明。
      const domainOf = new Map(domains.map((domain) => [domain.key, domain] as const))
      // `how` 行点名工具的那几句据本步的快照换话术。按 agent 取：全局开关之外，
      // 人设的工具限制也会让工具不在手里，而那份名单逐 agent 不同。
      const hiddenNow = deps.hiddenTools !== undefined ? deps.hiddenTools(agent) : null
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
      // **取数失败的域不发「已清空」**：那条通知的字面意思是"这份内容已失效"，而真实情况是
      // "我们这一轮没取到" —— 发出去等于向模型谎报（审查 P1-8）。保留上一轮内容不动更安全。
      const labelOf = new Map(domains.map((domain) => [domain.key, domain.label] as const))
      const clearedKeys = new Set<InjectDomainKey>()
      for (const key of INJECT_DOMAIN_KEYS) {
        if (published.has(key)) continue
        if (failedKeys.has(key)) continue
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
      injectionFailed = true
      log('context injection failed: ' + String((error && (error as Error).message) || error))
      // 但"尽力而为"不等于"无声无息"：这一步整段抛异常时，模型**一个域的内容都没收到**，
      // 而此前唯一的痕迹是上面那行 console.error（审查 P1-8 / 脆弱性地图 F2）。
      // 兼容页据此至少能看到一条降级 —— 否则用户只会觉得"模型怎么不知道我的配置"。
      noteRuntime({
        id: 'context-injection-runtime',
        label: '上下文注入通道',
        kind: 'read',
        fallback: 'inform-only',
        detail: `本步注入抛异常，这一轮全部注入域的内容都没有送进模型（${String((error && (error as Error).message) || error)}）。通道仍在，下一步会自动重试。`,
        detailKey: 'context-injection-runtime.throw',
      })
      return decision
    } finally {
      // 正常走完（含"没东西可发"的早退）→ 收掉上一次的上报，别让已经恢复的故障挂在兼容页上。
      // 只在两个条件都成立时收：本步没抛异常、且本步没有取数失败的域。
      if (!injectionFailed && failedKeys.size === 0) clearRuntimeNote('context-injection-runtime')
    }
  }, { prepend: true })
  return {
    dispose: () => {
      try { if (typeof stop === 'function') (stop as () => void)() } catch { /* ignore */ }
      // 注入通道没了，自检结论也失效（B4）——留着会让兼容页报一件不存在的事。
      clearRuntimeNote('official-suppression')
      // 运行期上报同理：通道都不在了，"这一轮注入抛异常"没有意义（且不会再被刷新）。
      clearRuntimeNote('context-injection-runtime')
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
