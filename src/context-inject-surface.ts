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

export function newestDomainTexts(agent: unknown, kinds: ReadonlyMap<string, KindMapping>): Map<InjectDomainKey, { text: string; form: string; official: boolean }> {
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