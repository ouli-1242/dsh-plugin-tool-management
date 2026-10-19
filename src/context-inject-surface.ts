// 会话表面扫描：从一条会话里认出「哪些消息是本插件/官方注入的、属于哪个域、最新那份是哪条」。
//
// 从 context-inject.ts 整段搬来，一行未改（中间的 suppressionVerdict 留在母文件，
// 它写的是跨模块的运行时备注全局态，不属于这一层）。注入实况展示与「内容变了才重发」的
// 判据都读这里，两处必须同一份口径，否则界面说的和模型收到的会分家。
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { INJECT_DOMAIN_KEYS, INJECT_KIND_OF, type InjectDomainKey, type InjectSettings } from './context-inject-contract.js'

/** 取一条消息的正文（只认单 text 块；形如官方 RuntimeContextProjection.textOf）。 */
export function textOf(message: unknown): string | undefined {
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
 *
 * 返回的 `text` 是**整条消息正文**（含 `<system-reminder>` 框架）—— 调用方拿它做两件
 * 不同的事，所以另有 `body` 字段（域正文原文）：
 *   - `body`：与本次渲染出来的正文逐字节比对 → 决定"发不发"（内容没变就不发）；
 *   - `text`：只在「注入实况」里展示给用户看。
 * 为什么要分开：框架层有几行是**按场合**发的（权威声明只在替换时发），于是同一条域正文
 * 有两种合法形态。用整条正文比对会把"首帧没有权威声明"误判成内容变化 → 每个域多重发
 * 一次；用正文比对则两种形态都判为"没变"（2026-10-19 修）。
 *
 * ⚠️ **「已清空」通知与内容分开记**（2026-10-19 修，两轮）：一条 `form === 'notice'` 的消息
 * 只说"这个域现在没内容"，它不是内容。把两者混在一个键位里，两个消费方必然有一个读错：
 *   - 只看通知 → `body` 恒为 `undefined`，"发不发"永远判"内容变了" → 内容恢复后反而正常、
 *     但**内容没变也会每轮重发**（用户实测：场景 / MCP / 子智能体每轮补一条通知）；
 *   - 只看内容 → 通知不占键位了，可"该不该再发一条通知"就没了依据 → 每个空域**每轮都补发
 *     一条通知**（用户实测：T4/T5/T6 三轮各三条「Cleared」）。
 * 所以两个字段各答一个问题：`body`/`form` 答"最后一条**内容**是什么"（决定发不发内容），
 * `cleared` 答"此刻是不是已经通知过清空了"（决定发不发通知）。
 */
/** 消息来源 kind → 本插件域（`official` = 官方载体发的，不是本插件注入的）。 */
export interface KindMapping { key: InjectDomainKey; official: boolean }

/** 本插件自己的五个注入 kind（去重比对只用这一份 —— 绝不能让官方正文影响"发不发"的判断）。 */
export const PLUGIN_KINDS: ReadonlyMap<string, KindMapping> = new Map(
  INJECT_DOMAIN_KEYS.map((key) => [INJECT_KIND_OF[key], { key, official: false }] as const),
)

/**
 * 官方载体消息的 kind → 本插件域：技能目录（`@deepseek-ai/dsh-tool-skill`）与
 * AGENTS.md（`@deepseek-ai/dsh-agent-instructions`）。仅用于「注入实况」展示 ——
 * 标准类预设下这两个域由官方在送，它同样是"模型看到的内容"，体积要算官方那份。
 * 字符串取自官方包，是宿主侧的稳定契约。
 */
export const OFFICIAL_KIND_OF: Readonly<Record<string, InjectDomainKey>> = {
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
export function kindOfMessage(message: unknown): string | undefined {
  const source = (message as { source?: { kind?: unknown } } | null | undefined)?.source
  return source && typeof source.kind === 'string' ? source.kind : undefined
}



/** 实况展示用的 kind 表：本插件的五条 + 官方两条。 */
export const LIVE_KINDS: ReadonlyMap<string, KindMapping> = new Map([
  ...PLUGIN_KINDS,
  ...Object.entries(OFFICIAL_KIND_OF).map(([kind, key]) => [kind, { key, official: true }] as const),
])

/** 扫描结果的一格：见 `newestDomainTexts` 的文档（`body` 与 `cleared` 各答一个问题）。 */
export interface DomainSurfaceEntry {
  /** 最新一条消息的整条正文（含框架）；只在「注入实况」里展示给用户看。 */
  text: string
  /** 该域**最后一条内容**消息的域正文原文；从没注入过内容（或已被压缩出表面）时为 `undefined`。 */
  body?: string
  /** 该域**最后一条内容**消息的 form（`snapshot` / `catalog` / `instructions`）。 */
  form: string
  /** 该域此刻是否**已经**发过一条「已清空」通知（且其后没有新的内容）—— 避免每轮补发同一条通知。 */
  cleared: boolean
  /** 这条是不是官方载体（`skill-catalog` / `agent-instructions`）发的。 */
  official: boolean
}

export function newestDomainTexts(agent: unknown, kinds: ReadonlyMap<string, KindMapping>): Map<InjectDomainKey, DomainSurfaceEntry> {
  const out = new Map<InjectDomainKey, DomainSurfaceEntry>()
  const session = (agent as { session?: any } | null | undefined)?.session
  if (!session || typeof session.seq !== 'number' || typeof session.eventAt !== 'function') return out
  // 每个域只收两条信息：**最后一条内容**（`body` / `form`）与**最新一条是不是通知**（`cleared`）。
  // 自新到旧扫，第一次遇到该域时：
  //   · 是通知 → 记下 `cleared = true`（内容字段留空，等更早那条内容消息来填）；
  //   · 是内容 → 直接填内容字段（`cleared` 保持 false：通知之后已有新内容 = 已经"不清空"了）。
  // 内容字段填好之后就跳过该域更早的消息；只遇到通知、没遇到内容的域停在 `cleared` 上。
  const scan = (seq: number): boolean => {
    let event: any
    try { event = session.eventAt(SessionSeq(seq)) } catch { return false }
    if (!event || event.type !== 'user/message') return false
    const source = event.data && event.data.source
    const mapping = source && typeof source.kind === 'string' ? kinds.get(source.kind) : undefined
    if (mapping === undefined) return false
    const seen = out.get(mapping.key)
    const text = textOf(event.data)
    if (text === undefined) return false
    const form = source && typeof source.form === 'string' ? source.form : ''
    if (form === 'notice') {
      // 通知只回答"此刻已清空"；它绝不提供 `body`（否则内容恢复后会被它挡住）。
      if (seen === undefined) out.set(mapping.key, { text, form: 'notice', cleared: true, official: mapping.official })
      return done()
    }
    // 内容消息：已经记过内容就不再覆盖（自新到旧，先到的那条才是最新内容）。
    if (seen !== undefined && seen.form !== 'notice') return false
    out.set(mapping.key, {
      text,
      body: typeof source.body === 'string' ? source.body : undefined,
      form,
      // **通知比这条内容新** → 仍然是"已清空"：这一格只是补上内容指纹（供"内容恢复后
      // 与旧正文比对"用），不代表内容此刻还在上下文里。反过来，先遇到内容（没遇到通知）
      // 才是"内容就是最新一条"。
      cleared: seen !== undefined && seen.cleared,
      official: mapping.official,
    })
    return done()
  }
  // 提前收工的条件是"六个域都拿到了**内容**"：只有通知的域（`form === 'notice'`）还得继续
  // 往更早找它的正文，否则内容恢复时 `body` 是空的，只能当成"内容变了"多发一条。
  const done = (): boolean =>
    out.size === INJECT_DOMAIN_KEYS.length && [...out.values()].every((entry) => entry.form !== 'notice')
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