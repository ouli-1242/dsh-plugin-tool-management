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
//   memory    → scene-memory-manager-catalog（场景和记忆）
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
// 注入永远不能让这一步失败：任何异常都在监听器里吞掉、原样返回 decision。
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { PresetInjectionFacts } from './compat/preset-reach.js'

/** 可注入的域（界面上的五个勾选，顺序即界面与消息顺序）。 */
export type InjectDomainKey = 'memory' | 'mcp' | 'skills' | 'subagents' | 'prompt'

/**
 * 权威域顺序（界面勾选、注入消息先后都按它）。
 * 场景和记忆排第一：它是"当前模式"的框架，先给框架再给内容。
 */
export const INJECT_DOMAIN_KEYS = ['memory', 'mcp', 'skills', 'subagents', 'prompt'] as const

/**
 * 域 → 消息来源 kind（轨迹行标签，也是去重时的身份）。
 *
 * 命名对齐官方 `*-catalog` 风格与本插件的工具族（`*_manager_*`）；改名等于换身份，
 * 旧消息会被当成"不在上下文里"而重发一次，所以这几个字符串是稳定契约。
 */
export const INJECT_KIND_OF: Record<InjectDomainKey, string> = {
  memory: 'scene-memory-manager-catalog',
  mcp: 'mcp-manager-catalog',
  skills: 'skill-manager-catalog',
  subagents: 'subagent-manager-catalog',
  prompt: 'prompt-manager-catalog',
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

/** 一个域的注入声明。 */
export interface InjectDomain {
  key: InjectDomainKey
  /** 段名（进 `source.sections`；snapshot 形态才带上）。 */
  name: string
  /** 短名（模型侧引导语与「已清空」通知里的名字；与界面勾选标签同源）。 */
  label: string
  /** 来源 form。 */
  form: InjectForm
  /** 同步返回域文本；`''` = 该域本次没有内容。 */
  text: () => string
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
  domains: { memory: true, mcp: true, skills: true, subagents: true, prompt: true },
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
 * 纯函数：按设置 + 预设事实挑出本次要注入的域。
 *
 * 规则（设计 2026-09-16）：
 *   - 域开关关掉的、文本为空的，都不进；
 *   - **压制型预设**且没开「仍然注入」→ 一个都不进（跟随预设）；
 *   - 有官方载体的两个域（提示词 / 技能目录）：预设挂得到官方那条行时不进
 *     —— 官方自己会送，再注入一遍只会重复；预设事实读不到（`undefined`）时按"已承载"处理
 *     （宁可与现状一致，也不制造重复）；
 *   - 同一段文本出现两次只保留前一个（跨域保险）。
 */
export function selectInjections(
  domains: readonly InjectDomain[],
  settings: InjectSettings,
  facts: PresetInjectionFacts | undefined,
): InjectSection[] {
  const suppressing = facts !== undefined && facts.suppressing
  if (suppressing && !settings.underSuppressingPresets) return []
  const out: InjectSection[] = []
  const seen = new Set<string>()
  for (const domain of domains) {
    if (settings.domains[domain.key] !== true) continue
    const carrier = CARRIER_FACT_OF[domain.key]
    // 官方载体已挂（或读不到预设、只能按已挂算）→ 不重复送；只有明确"没挂"才兜底。
    if (carrier !== undefined && facts?.[carrier] !== false) continue
    let text = ''
    try { text = String(domain.text() ?? '') } catch { text = '' }
    if (text.trim() === '') continue
    const fingerprint = text.trim()
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    out.push({ key: domain.key, name: domain.name, label: domain.label, form: domain.form, text })
  }
  return out
}

/**
 * 一条注入消息的正文（纯函数）：instructions 域原样送（对齐官方 AGENTS.md 那条行），其余带一行引导语。
 *
 * 引导语只有**一句话**（用户裁定 2026-09-16：五个域各发各的以后，原来那四行说明在每条消息里
 * 重复一遍太冗余）：说清"这是什么 + 取代谁"就够 —— 域的名字、怎么查细节（`*_manager_list`
 * 就在模型自己的工具表里）都不必在这里再说一遍。
 */
export function renderDomainText(section: InjectSection): string {
  if (section.form === 'instructions') return section.text
  return [
    '<system-reminder>',
    `以下是本机插件的${section.label}（取代本次会话中更早的同类内容）。`,
    '</system-reminder>',
  ].join('\n') + '\n\n' + section.text
}

/** 「已清空」通知正文：某个域曾经注入过、现在没有内容时发一条（纯函数，测试用）。 */
export function clearedDomainText(key: InjectDomainKey, label: string): string {
  return [
    '<system-reminder>',
    `dsh-plugin-tool-management：本插件的${label}已清空，本次会话中此前注入的同类内容不再有效。`,
    '</system-reminder>',
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
  /** 诊断用（默认 console.error）。 */
  logger?: (message: string) => void
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
   * unknown = 没有会话。
   */
  state: 'in-context' | 'cleared' | 'official' | 'off' | 'empty' | 'absent' | 'unknown'
  bytes: number
  text: string
}

/** 注入实况快照（`injection-live` 只读 op 的载荷；供兼容页展示"模型现在看到什么"）。 */
export interface LiveInjectionSnapshot {
  /** 是否记住了最近活跃的会话（WeakRef 被回收或从未收到 pre-step → false）。 */
  hasAgent: boolean
  /** 本次进程运行以来的投递统计（不是会话历史；重启后归零）。 */
  delivered: { count: number; lastAt: number | null; byDomain: Record<string, number> }
  domains: LiveInjectionDomain[]
}

const bytesOf = (text: string): number => {
  try { return Buffer.byteLength(text, 'utf8') } catch { return text.length }
}

/**
 * 注册 `agent/pre-step` 注入监听；返回清理函数。
 *
 * 宿主平面注册即可覆盖所有 agent（含子智能体、含任何预设）——dsh-scope 的
 * `scopeTarget` 过滤对没有 scope 标记的 ctx 直接放行，官方 time-context 就是这么挂的。
 */
export function createContextInjector(deps: ContextInjectorDeps): { dispose: () => void; live: () => LiveInjectionSnapshot } {
  const log = (message: string): void => {
    try { (deps.logger ?? ((m: string) => console.error('[dsh-plugin-tool-management] ' + m)))(message) } catch { /* ignore */ }
  }
  // 最近活跃的会话（WeakRef：诊断用，不阻止会话被回收）。每次 pre-step 都刷新 ——
  // 包括"空 turn 提前返回"和"这一步没有内容可发"的分支，页面才能如实说"没投过"。
  let lastAgent: WeakRef<object> | null = null
  const delivered = { count: 0, lastAt: null as number | null, byDomain: {} as Record<string, number> }
  // 最近一步里"每个域为什么发/不发"（官方载体 / 开关关 / 空 / 本插件负责）。
  // 只在没有可见注入时用来解释状态 —— 标准类预设下技能与提示词由官方在送，
  // 插件的实况若只说"未投递"，读起来像出了问题。
  let lastReasons: Partial<Record<InjectDomainKey, 'off' | 'official' | 'empty' | 'sent'>> = {}
  const live = (): LiveInjectionSnapshot => {
    let agent: object | undefined
    try { agent = lastAgent ? lastAgent.deref() : undefined } catch { agent = undefined }
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
          : reason === 'off' ? 'off' : reason === 'official' ? 'official' : reason === 'empty' ? 'empty' : 'absent'
      const text = (state === 'in-context' || state === 'official') && entry !== undefined ? entry.text : ''
      return { key, label: labelOf.get(key) ?? key, kind: INJECT_KIND_OF[key], state, bytes: bytesOf(text), text }
    })
    return {
      hasAgent: agent !== undefined,
      delivered: { count: delivered.count, lastAt: delivered.lastAt, byDomain: { ...delivered.byDomain } },
      domains: rows,
    }
  }
  const ctx = deps.ctx
  if (!ctx || typeof ctx.on !== 'function') return { dispose: () => {}, live }
  const stop: unknown = ctx.on('agent/pre-step', async (payload: any, next: () => Promise<any>) => {
    const decision = await next()
    try {
      if (!decision || decision.kind === 'reject') return decision
      const agent = payload && payload.agent
      if (!agent) return decision
      if (typeof agent === 'object') { try { lastAgent = new WeakRef(agent as object) } catch { /* 环境没有 WeakRef → 实况显示"没有会话" */ } }
      // 空 turn 不注入（官方 dsh-agent-instructions 同款守卫）：step 1 且一条消息都没有时，
      // 这一步本来就该原地结束（宿主随后把 turn 判为 completed）。此时注入会把空 turn
      // 变成一次真实的模型请求 —— 凭空烧一次调用。
      if (Number(payload.step) === 1 && messagesOf(decision).length === 0) return decision
      const domains = deps.domains()
      const settings = deps.settings()
      const facts = await deps.factsFor(agent)
      const sections = selectInjections(domains, settings, facts)
      // 记录每个域这一步"为什么发 / 为什么不发"，供「注入实况」解释状态：
      // off = 开关关了；official = 官方载体在送（技能 / 提示词，标准类预设下的常态）；
      // empty = 本插件负责但没内容；sent = 本插件负责且有内容（上下文里看不到时说明还没补发）。
      const reasons: Partial<Record<InjectDomainKey, 'off' | 'official' | 'empty' | 'sent'>> = {}
      for (const domain of domains) {
        if (settings.domains[domain.key] !== true) { reasons[domain.key] = 'off'; continue }
        const carrier = CARRIER_FACT_OF[domain.key]
        if (carrier !== undefined && facts?.[carrier] !== false) { reasons[domain.key] = 'official'; continue }
        let text = ''
        try { text = String(domain.text() ?? '') } catch { text = '' }
        reasons[domain.key] = text.trim() === '' ? 'empty' : 'sent'
      }
      lastReasons = reasons
      const visible = newestDomainTexts(agent, PLUGIN_KINDS)
      const additions: unknown[] = []
      const appended: InjectDomainKey[] = []
      const published = new Set<InjectDomainKey>()
      for (const section of sections) {
        published.add(section.key)
        const text = renderDomainText(section)
        const current = visible.get(section.key)
        if (current !== undefined && current.text === text) continue
        additions.push(domainMessage(section, text))
        appended.push(section.key)
      }
      // 曾经注入过、这一轮没有内容的域 → 一条「已清空」；从没注入过的域什么都不用说。
      const labelOf = new Map(domains.map((domain) => [domain.key, domain.label] as const))
      for (const key of INJECT_DOMAIN_KEYS) {
        if (published.has(key)) continue
        const previous = visible.get(key)
        if (previous === undefined) continue
        const label = labelOf.get(key) ?? key
        if (previous.form === 'notice') continue
        additions.push(clearedMessage(key, label))
        appended.push(key)
      }
      if (additions.length === 0) return decision
      delivered.count += additions.length
      delivered.lastAt = Date.now()
      for (const key of appended) delivered.byDomain[key] = (delivered.byDomain[key] || 0) + 1
      return { ...decision, messages: [...messagesOf(decision), ...additions] }
    } catch (error) {
      // 注入是尽力而为：任何异常都不能把这一步弄失败。
      log('context injection failed: ' + String((error && (error as Error).message) || error))
      return decision
    }
  })
  return {
    dispose: () => { try { if (typeof stop === 'function') (stop as () => void)() } catch { /* ignore */ } },
    live,
  }
}

function messagesOf(decision: any): readonly unknown[] {
  const messages = decision && decision.messages
  return Array.isArray(messages) ? messages : []
}

function domainMessage(section: InjectSection, text: string): unknown {
  const source: Record<string, unknown> = { kind: INJECT_KIND_OF[section.key], form: section.form }
  if (section.form === 'snapshot') source.sections = [{ name: section.name, text: section.text }]
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
