// 自主记忆的**真源状态**（`evolution/state.json`）：证据链、计数器、状态迁移、墓碑、水位。
//
// 为什么它与 `catalog.json` 分开：catalog 全部可由「磁盘文件 + 本文件」重建，坏了重建即可；
// 本文件里的证据与墓碑**不可重建** —— 它们是"为什么记这条"和"用户已经删过这条"的唯一记录。
// 两者混在一个文件里，一次 catalog 重建就会把墓碑一起冲掉，于是用户删掉的事实会复活。
//
// 为什么证据不放 frontmatter：`parseSkillDoc` 只识别顶层扁平标量（见 skills/frontmatter.ts 的
// 注释），数组与嵌套结构进不了 map。硬塞只能序列化成一行 JSON，那既不可读、也会让
// `description` 这类字段被 500 字符上限截断。所以：frontmatter 只放标量（给发现层与界面读），
// 证据与计数器放这里（给写入管线与维护扫描读）。
//
// 读的纪律（与 `settings-sidecars` 相反，这是有意的）：
//   - 侧车读坏 → 回默认值，因为界面必须能打开；
//   - 本文件读坏 → **拒绝写入并报错**。用默认值覆盖它等于把用户所有的证据链和墓碑一次性清零，
//     之后被删的记忆会静默复活、被纠正过的错误会重新变成"高置信"。宁可停摆，不可静默。
//     坏的原文会先备份到 `evolution/state.json.corrupt-<ts>`，正文文件一个不动。

import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { hubPath } from '../hub.js'
import { writeFileAtomically } from '../memories/index-io.js'
import type { JsonFileRead } from '../mcp/disabled-tools.js'

export const EVOLUTION_STATE_FILE = 'evolution/state.json'
export const STATE_VERSION = 1

/**
 * 证据来源。**由系统判定，不由模型声明** —— 这是本文件最重要的一条契约。
 *
 * 模型自报"我验证过"与自报"我有 0.9 的把握"是同一类问题：写的人顺便当裁判。所以
 * `memory_note` 不再接受 `source` 参数，证据只有三条产生路径：
 *
 *   · `user_explicit` —— 模型给了一句引句，且它逐字出现在本会话真实的用户消息里
 *     （`checkQuote` 做子串核对，模型编不出来）；
 *   · `user_approved` —— 用户在看得到原文的卡片上点了同意；
 *   · `model_inference` —— 其余全部。
 *
 * `user_correction` / `tool_verified` 只存在于旧数据：它们当年也是模型自报的，
 * 无法回溯核对，读取时一律按 `model_inference` 计（宁可低估，不要高估）。
 */
export type EvidenceSource = 'user_explicit' | 'user_correction' | 'tool_verified' | 'model_inference' | 'user_approved'

export const EVIDENCE_SOURCES: readonly EvidenceSource[] = ['user_explicit', 'user_correction', 'tool_verified', 'model_inference', 'user_approved']

/** 可被新写入产生的来源。旧数据里的另外两个只读不写。 */
export const WRITABLE_EVIDENCE_SOURCES: readonly EvidenceSource[] = ['user_explicit', 'model_inference', 'user_approved']

/**
 * 证据档位：排序与展示都用它，取代原来的 `confidence` 小数。
 *
 * 三档而不是一个 0–1 的数：数看起来能权衡，实际上只由 `source` 一张表换算，多出来的
 * 精度是假的。三档能直接读懂，也能直接解释"为什么这条排在前面"。
 */
export type EvidenceTier = 'confirmed' | 'quoted' | 'inferred'

export const EVIDENCE_TIERS: readonly EvidenceTier[] = ['confirmed', 'quoted', 'inferred']

/** 来源 → 档位。旧数据的两档自报来源归入最弱一档，见 `EvidenceSource` 的说明。 */
export function tierOfSource(source: EvidenceSource): EvidenceTier {
  if (source === 'user_approved') return 'confirmed'
  if (source === 'user_explicit') return 'quoted'
  return 'inferred'
}

/** 一组证据里最强的档位。没有证据 = 最弱（`inferred`），不是"没有档位"。 */
export function tierOf(evidence: readonly EvidenceRef[]): EvidenceTier {
  let best: EvidenceTier = 'inferred'
  for (const e of evidence) {
    const t = tierOfSource(e.source)
    if (t === 'confirmed') return 'confirmed'
    if (t === 'quoted') best = 'quoted'
  }
  return best
}

/**
 * 一条证据。
 *
 * `quote` 对 `user_explicit` 是**用户文本的逐字子串**（证据门校验的就是它）；对
 * `user_correction` 尽力逐字，核不上时那条证据会被降级成 `model_inference`（用户纠正时常
 * 只说「不对」，硬拒会让真实纠正记不下来）；对 `tool_verified` 是工具名 + 结果摘要（不必逐字，
 * 但要能定位到 `seq`）；对 `model_inference` 是模型给出的推断依据 —— 这类证据无论多少条都
 * 只能让条目停在 `candidate`。
 */
export interface EvidenceRef {
  session: string
  turn: number
  seq: number
  source: EvidenceSource
  quote: string
  at: string
}

/**
 * 注入与使用计数。
 *
 * 只收**系统能观测到的事实**：进没进过上下文（`injected`）、模型有没有主动拉全文
 * （`read`）。曾经还有 `helpful` / `harmful` 两项，但全仓没有任何写入路径 —— 它们恒为 0，
 * 却参与算分与矛盾惩罚，让排序看起来在权衡、实际只按证据类型排。宁可少两个字段，
 * 也不要一个永远不动的数字冒充信号。
 */
export interface EntryCounters {
  injected: number
  read: number
  lastInjectedAt?: string
  lastUsedAt?: string
}

export interface Transition {
  at: string
  from: string
  to: string
  /** `dream` 只出现在旧数据里（已移除的全库整理），保留是为了原样读回时间线。 */
  actor: 'learn' | 'curator' | 'user' | 'sweep' | 'dream' | 'system'
  reason: string
}

/**
 * 程序性记忆（`auto_kind: procedure`）的步骤与执行记录（P4）。
 *
 * 为什么不放 frontmatter：`parseSkillDoc` 只认顶层 `key: value`，数组进去会被解析成
 * 一个字符串或干脆丢掉。步骤是数组，只能放 `state.json`。正文里的编号列表是**给人读的
 * 投影**，`steps` 才是真值；两边不一致时以这里为准，`parseProcedureSteps` 只用于给
 * 没有状态记录的旧条目兜底。
 *
 * `successes` 是"按这份流程做完且工具没失败"的次数；只有显式回报才计数，不从
 * "这一轮工具都成功了"去猜 —— 猜错一次就会把一条还没验证的做法升成 playbook。
 */
export interface ProcedureState {
  steps: string[]
  successes: number
  failures: number
  lastSucceededAt?: string
  lastFailedAt?: string
}

/** 宽松读 `procedure`：结构不对就当没有，别让一条脏记录拖垮整个 state。 */
export function normalizeProcedure(raw: any): ProcedureState | undefined {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.steps)) return undefined
  const steps = raw.steps
    .filter((x: unknown): x is string => typeof x === 'string')
    .map((x: string) => x.trim().slice(0, 240))
    .filter((x: string) => x !== '')
    .slice(0, 12)
  if (steps.length === 0) return undefined
  return {
    steps,
    successes: Math.max(0, Math.floor(Number(raw.successes) || 0)),
    failures: Math.max(0, Math.floor(Number(raw.failures) || 0)),
    ...(typeof raw.lastSucceededAt === 'string' ? { lastSucceededAt: raw.lastSucceededAt } : {}),
    ...(typeof raw.lastFailedAt === 'string' ? { lastFailedAt: raw.lastFailedAt } : {}),
  }
}

/** 一条自动记忆的状态。键是记忆 id（`_ws/<hash16>/<name>` 这类）。 */
export interface EntryState {
  evidence: EvidenceRef[]
  counters: EntryCounters
  transitions: Transition[]
  /** 路由降级原因：`no-scene` / `no-workspace` / `scope-too-narrow`。界面据此解释"为什么它在工作区层"。 */
  degraded?: string
  /** 用户编辑过 = 锁定：自动路径从此只能提议，不能覆盖正文。 */
  locked?: boolean
  /**
   * 待用户裁决的原因（与用户记忆冲突 / 表述有歧义 / 纯推断还没被确认）。
   * **有值 = 不注入**，等用户确认后才算数。
   */
  pendingReason?: string
  /**
   * 复核提醒（TTL 到期）。**有值仍然照常注入** —— 只是告诉用户"这条有点旧了，看一眼"。
   *
   * 与 `pendingReason` 分开是本文件修掉的一个静默失效：两者曾共用一个 `needsReview`
   * 字段，而注入侧见它非空就跳过，于是维护扫描一挂 TTL 提醒，一条仍在生效的记忆就从
   * 上下文里消失了 —— 界面还显示"生效"、预算还把它算进去。提醒不该等于停用。
   */
  reviewDue?: string
  /**
   * 用户最后一次点「复核」的时间（ISO）。**不写进笔记文件**：复核不改正文，
   * 所以文件里的 `auto_updated` 必须保持"正文最后一次被改写"的原义。
   * 维护扫描拿它与 `auto_updated` 里较晚的一个当老化时钟。
   */
  reviewedAt?: string
  /** 只有 procedure 有：结构化步骤 + 成功/失败计数。 */
  procedure?: ProcedureState
}

/**
 * 墓碑。用户删掉的条目在 `until` 之前不能被自动路径复活 —— 否则"我明明删了它又回来了"
 * 是这个功能最容易失去信任的方式。
 */
export interface Tombstone {
  /** 语义槽位：同 key 的新条目也要拦。 */
  key: string
  /** 归一化正文的哈希：没有 key 的条目靠它拦。 */
  textHash: string
  /**
   * 归一化后的原文（≤400 字符）。只用于**相似度**拦截：用户删掉「以后都用 pnpm」，
   * 模型换个说法写「包管理器统一 pnpm」时，精确哈希拦不住。旧墓碑没有这个字段，
   * 读取时按空串处理，退回 key / 哈希两条精确判据。
   */
  text: string
  at: string
  until: string
  /** 谁删的：`model` / `user` / `dream`。界面显示"你在 3 天前删过它"。 */
  actor: string
}

export interface Watermarks {
  /** 复习进度（P2 用）。 */
  lastReviewedTurn?: number
  lastReviewAt?: string
  lastDreamAt?: string
  /** 上次**尝试**整理的时间。失败也要记：否则模型一直返回坏 JSON 时每轮都会重烧一次钱。 */
  lastDreamTryAt?: string
  /** 最近一次维护扫描（P3）。界面据此显示"上次体检：3 天前"。 */
  lastSweepAt?: string
  /**
   * 用户动作版本号（确认 / 停用 / 恢复 / 删除 / 提升时 +1）。
   *
   * 注入快照按会话冻结，但用户在本会话里做的决定必须立刻生效 —— 快照 key 带上这个版本号，
   * 用户一改就重建；学习写入**不**加它，否则每学一条都会重发整段。
   */
  autoRevision?: number
}

export interface EvolutionState {
  version: 1
  entries: Record<string, EntryState>
  tombstones: Tombstone[]
  watermarks: Watermarks
}

/** 墓碑有效期：30 天。过期的墓碑在下次写盘时清掉（不是读时清 —— 读要无副作用）。 */
export const TOMBSTONE_DAYS = 30

export const emptyState = (): EvolutionState => ({ version: STATE_VERSION, entries: {}, tombstones: [], watermarks: {} })

export const emptyCounters = (): EntryCounters => ({ injected: 0, read: 0 })

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)

function normalizeEvidence(raw: any): EvidenceRef[] {
  if (!Array.isArray(raw)) return []
  const out: EvidenceRef[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const source = EVIDENCE_SOURCES.includes(item.source) ? (item.source as EvidenceSource) : 'model_inference'
    const quote = str(item.quote).slice(0, 2000)
    // 无引句的证据没有价值：它既不能过证据门，也不能在界面里解释"为什么记这条"。
    if (quote === '') continue
    out.push({
      session: str(item.session),
      turn: num(item.turn),
      seq: num(item.seq, -1),
      source,
      quote,
      at: str(item.at),
    })
    // 一个条目的证据超过 50 条时只留**最近的**：再多也不改变档位（档位只看最强的来源）。
    // 这里 `break` 留的是数组最前面那 50 条 —— 那是最旧的。写入侧 `applyOutcome` 已经用
    // `.slice(-50)` 兜住了，所以只有手工编辑 / 旧数据会走到这条；但它必须与注释一致，
    // 否则"留最近的"变成"留最旧的"，证据链会停在最早那几条上。
    if (out.length >= 50) out.shift()
  }
  return out
}

/**
 * 旧 `needsReview` → 两个新字段。
 *
 * 迁移判据只有状态：候选的理由是"等你裁决"（不该注入），其余（生效中 / 已归档）的理由
 * 只能是 TTL 复核提醒（该继续注入）。旧数据里没有别的原因会挂在非候选条目上 ——
 * 冲突与歧义都会把条目压成候选。
 *
 * ⚠️ 状态只能从 state 条目自己的 `auto_status` 读：`normalizeEntry` 拿不到笔记文件。
 * 而**历史 state.json 并不写这个键**，于是实际效果是「旧 `needsReview` 一律归待裁决」。
 * 这与当时的真实数据一致（带旧字段的条目都是候选），但方向上偏保守：把一条生效中的
 * 记忆误判成待裁决会让它不再注入，而反向误判只是多一条复核提醒。真要区分，得让调用方
 * 把笔记状态传进来 —— 那时改这里。
 */
function splitReviewFields(raw: any): { pendingReason?: string; reviewDue?: string } {
  const legacy = typeof raw.needsReview === 'string' && raw.needsReview !== '' ? raw.needsReview : ''
  const pending = typeof raw.pendingReason === 'string' && raw.pendingReason !== '' ? raw.pendingReason : ''
  const due = typeof raw.reviewDue === 'string' && raw.reviewDue !== '' ? raw.reviewDue : ''
  if (pending !== '' || due !== '') {
    return { ...(pending !== '' ? { pendingReason: pending } : {}), ...(due !== '' ? { reviewDue: due } : {}) }
  }
  if (legacy === '') return {}
  // 状态在 `...raw` 里还没归一化，这里直接看原值：`candidate` 才是待裁决。
  return raw.auto_status === undefined || raw.auto_status === 'candidate'
    ? { pendingReason: legacy }
    : { reviewDue: legacy }
}

function normalizeEntry(raw: any): EntryState | null {
  if (!raw || typeof raw !== 'object') return null
  const counters = raw.counters && typeof raw.counters === 'object' ? raw.counters : {}
  const transitions: Transition[] = []
  if (Array.isArray(raw.transitions)) {
    for (const t of raw.transitions.slice(-50)) {
      if (!t || typeof t !== 'object') continue
      transitions.push({
        at: str(t.at),
        from: str(t.from),
        to: str(t.to),
        actor: ['learn', 'curator', 'user', 'sweep', 'dream', 'system'].includes(t.actor) ? t.actor : 'system',
        reason: str(t.reason),
      })
    }
  }
  return {
    // 保留未知字段：未来版本加的键不该被旧版本静默丢掉。
    ...raw,
    evidence: normalizeEvidence(raw.evidence),
    counters: {
      injected: Math.max(0, num(counters.injected)),
      read: Math.max(0, num(counters.read)),
      ...(typeof counters.lastInjectedAt === 'string' ? { lastInjectedAt: counters.lastInjectedAt } : {}),
      ...(typeof counters.lastUsedAt === 'string' ? { lastUsedAt: counters.lastUsedAt } : {}),
    },
    transitions,
    ...(typeof raw.degraded === 'string' && raw.degraded !== '' ? { degraded: raw.degraded } : {}),
    ...(bool(raw.locked) === true ? { locked: true } : {}),
    ...splitReviewFields(raw),
    // 显式归一化：上面的 `...raw` 会把脏的 procedure 原样带进来，界面拿去渲染就会炸。
    ...(normalizeProcedure(raw.procedure) !== undefined ? { procedure: normalizeProcedure(raw.procedure)! } : {}),
  }
}

/**
 * 原型链上的名字不能当条目 id：`entries['__proto__'] = e` 改的是原型，不是落一个
 * 自有属性 —— 写进 state 的条目会凭空消失，读侧还可能在别的对象上看见它。
 */
const UNSAFE_ENTRY_IDS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/** 宽松读：结构不对的**单个条目**丢掉，整体结构不对才报坏。理由见文件头。 */
export function normalizeState(raw: any): { ok: true; state: EvolutionState } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, state: emptyState() }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'state.json 的顶层不是对象' }
  const r = raw as any
  // 版本高于本进程 → 是更新的插件写的。此时"看不懂就覆盖"会丢掉新版本的字段与语义，
  // 所以直接拒绝：让用户先升级插件，而不是悄悄降级他的状态。
  if (typeof r.version === 'number' && r.version > STATE_VERSION) {
    return { ok: false, error: `state.json 版本 ${r.version} 高于本插件支持的 ${STATE_VERSION}（是不是装过更新的版本？）` }
  }
  const entries: Record<string, EntryState> = {}
  if (r.entries && typeof r.entries === 'object') {
    for (const [id, value] of Object.entries<any>(r.entries)) {
      if (UNSAFE_ENTRY_IDS.has(id)) continue
      const e = normalizeEntry(value)
      if (e) entries[id] = e
    }
  }
  const tombstones: Tombstone[] = []
  if (Array.isArray(r.tombstones)) {
    for (const t of r.tombstones) {
      if (!t || typeof t !== 'object') continue
      const key = str(t.key)
      const textHash = str(t.textHash)
      if (key === '' && textHash === '') continue
      tombstones.push({
        key,
        textHash,
        text: str(t.text).slice(0, 400),
        at: str(t.at),
        until: str(t.until),
        actor: str(t.actor, 'unknown'),
      })
    }
  }
  const w = r.watermarks && typeof r.watermarks === 'object' ? r.watermarks : {}
  return {
    ok: true,
    state: {
      version: STATE_VERSION,
      entries,
      tombstones,
      watermarks: {
        ...(typeof w.lastReviewedTurn === 'number' ? { lastReviewedTurn: w.lastReviewedTurn } : {}),
        ...(typeof w.lastReviewAt === 'string' ? { lastReviewAt: w.lastReviewAt } : {}),
        ...(typeof w.lastDreamAt === 'string' ? { lastDreamAt: w.lastDreamAt } : {}),
        ...(typeof w.lastDreamTryAt === 'string' ? { lastDreamTryAt: w.lastDreamTryAt } : {}),
        ...(typeof w.lastSweepAt === 'string' ? { lastSweepAt: w.lastSweepAt } : {}),
        ...(typeof w.autoRevision === 'number' && Number.isFinite(w.autoRevision) ? { autoRevision: w.autoRevision } : {}),
      },
    },
  }
}

// ── 档位与排序 ─────────────────────────────────────────────────────────────

/** 独立证据数 = 不同 session 的条数（同一会话里说两遍不算两次独立验证）。 */
export function independentEvidenceOf(evidence: EvidenceRef[]): number {
  return new Set(evidence.map((e) => e.session || '?')).size
}

/** 档位 → 排序权重。只用于先后，不对外展示成数字。 */
const TIER_RANK: Record<EvidenceTier, number> = { confirmed: 3, quoted: 2, inferred: 1 }

/** 展示用的档位名（界面与工具回执共用一份，避免两处措辞不同）。 */
export const TIER_LABEL: Record<EvidenceTier, string> = {
  confirmed: 'confirmed',
  quoted: 'quoted from the user',
  inferred: 'inferred',
}

/**
 * 一条自动记忆的排序分。**只用可观测的事实**，按优先级分层：
 *
 *   ① 证据档位 —— 用户确认过 > 有核对过的原话 > 纯推断；
 *   ② 命中率 `read / injected` —— 进了上下文之后模型有没有真去拉全文。这是唯一能回答
 *      "这条占着位置到底有没有用"的信号，而且是系统计数，模型伪造不了；
 *   ③ 新鲜度 —— 同档同命中率时，近的优先。
 *
 * 为什么不用模型自报的 confidence：那是把"写的人"和"裁判"合成一个人。为什么不用
 * helpful / harmful：它们没有写入路径，恒为 0 —— 留着只会让公式看起来在权衡。
 *
 * 命中率用 Laplace 平滑（`(read+1)/(injected+2)`）：只注入过一次又没被读，不该被判成
 * 0 分；注入 50 次读 0 次才该沉下去。
 */
export function scoreOf(
  entry: { tier: EvidenceTier; updatedAt?: string },
  counters: EntryCounters,
  now = Date.now(),
): number {
  const tier = TIER_RANK[entry.tier] ?? 1
  const injected = Math.max(0, counters.injected)
  const read = Math.max(0, counters.read)
  const hit = (read + 1) / (injected + 2)
  const updatedAt = entry.updatedAt ? Date.parse(entry.updatedAt) : Number.NaN
  const ageDays = Number.isFinite(updatedAt) ? Math.max(0, (now - updatedAt) / 86400_000) : 0
  // 新鲜度衰减 60 天半衰，权重压到 0.2 —— 它是打破平局用的，不该盖过"有没有被用过"。
  const fresh = 0.2 * Math.exp(-ageDays / 60)
  return tier * 10 + hit + fresh
}

/** 归一化正文 → 墓碑用的指纹。 */
export function textHashOf(text: string): string {
  // 不引入新依赖：这里只需要"稳定且足够短"，用 djb2 变体足够（碰撞只影响墓碑拦截的精度，
  // 而墓碑还有 key 那一道）。真正需要抗碰撞的是工作区目录名，那里用的 sha256。
  let h = 5381
  const norm = String(text ?? '').toLowerCase().replaceAll(/\s+/g, ' ').trim()
  for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) | 0
  return 'djb2:' + (h >>> 0).toString(16)
}

/** 墓碑是否仍然有效（`until` 为空 = 永久）。 */
export function tombstoneActive(t: Tombstone, now = Date.now()): boolean {
  if (t.until === '') return true
  const at = Date.parse(t.until)
  return Number.isFinite(at) ? at > now : true
}

/** 这条（key / 文本）是否被墓碑拦住。任一匹配即拦 —— key 命中比文本命中更可靠，但两者都要判。 */
export function tombstonedBy(state: EvolutionState, key: string, textHash: string, now = Date.now()): Tombstone | undefined {
  return state.tombstones.find((t) => tombstoneActive(t, now) && ((key !== '' && t.key === key) || (textHash !== '' && t.textHash === textHash)))
}

export function makeTombstone(key: string, textHash: string, actor: string, now = Date.now(), text = ''): Tombstone {
  const at = new Date(now)
  const until = new Date(now + TOMBSTONE_DAYS * 86400_000)
  return { key, textHash, text: text.slice(0, 400), at: at.toISOString(), until: until.toISOString(), actor }
}

/** 用户动作版本号 +1。写入方在确认 / 停用 / 恢复 / 删除 / 提升之后调用。 */
export function bumpRevision(state: EvolutionState): void {
  state.watermarks.autoRevision = (state.watermarks.autoRevision ?? 0) + 1
}

/**
 * 清掉过期墓碑、合并同引用重复项；返回是否有变化（调用方据此决定要不要写盘）。
 *
 * 去重是必须的：写入侧已经做到「同 key 只留一条」，但**存量**是历史上反复 forget 同一
 * 个 key 攒下来的 —— 每组只差几十毫秒、`until` 几乎相同，留着纯属让 `state.json` 白白
 * 变大（实测墓碑能占到整份文件的八成以上）。合并时保留**最后一条**：它的 `until` 最晚，
 * 拦截窗口与原来等价。
 */
export function pruneTombstones(state: EvolutionState, now = Date.now()): boolean {
  const kept: Tombstone[] = []
  const at = new Map<string, number>()
  for (const t of state.tombstones) {
    if (!tombstoneActive(t, now)) continue
    // 没有 key 的墓碑按正文哈希去重；两者都没有的（不该存在）各自独立，不合并。
    const slot = t.key !== '' ? 'k:' + t.key : t.textHash !== '' ? 'h:' + t.textHash : ''
    if (slot === '') { kept.push(t); continue }
    const seen = at.get(slot)
    if (seen === undefined) { at.set(slot, kept.length); kept.push(t); continue }
    // 保留 `until` 更晚的那条；`until` 为空 = 永久，优先级最高。
    const prev = kept[seen]!
    const prevForever = prev.until === ''
    const nextForever = t.until === ''
    if (nextForever || (!prevForever && t.until > prev.until)) kept[seen] = t
  }
  if (kept.length === state.tombstones.length) {
    // 长度没变也可能是同组换了保留项：逐项比一次引用，避免把「合并了但条数相同」漏掉。
    let same = true
    for (let i = 0; i < kept.length; i++) if (kept[i] !== state.tombstones[i]) { same = false; break }
    if (same) return false
  }
  state.tombstones = kept
  return true
}

// ── 读写 ───────────────────────────────────────────────────────────────────

export interface EvolutionStateDeps {
  ensurePaths(): Promise<unknown>
  readJsonFileStrict(abs: string): Promise<JsonFileRead>
  message(e: unknown): string
}

export interface EvolutionStateStore {
  /**
   * 读（1 秒缓存）。只给**读侧**用（界面轮询、诊断）—— 写路径一律用 `readFresh`，
   * 否则跨进程会拿着最多 1 秒前的旧快照整份写回，覆盖另一个进程刚写的证据与墓碑。
   * 不写盘：坏文件的副本与隔离标记由**写路径**去留，读侧只报错。
   */
  read(): Promise<{ ok: true; state: EvolutionState } | { ok: false; error: string }>
  /** 读（**无缓存**）。所有写路径都必须从这里起手。默认在解析失败时留存副本并落隔离标记。 */
  readFresh(opts?: { quarantine?: boolean }): Promise<{ ok: true; state: EvolutionState } | { ok: false; error: string }>
  /** 读（同步快照用）：已缓存则给缓存，否则给空 state 并后台刷新。 */
  cachedSync(): EvolutionState
  /**
   * 读-改-写。回调里直接改 state 对象即可，返回值透传。
   *
   * 串行由调用方保证（op 层已过写队列）；本方法只负责"读坏就不写"和原子落盘。
   */
  update<T>(fn: (state: EvolutionState) => T | Promise<T>): Promise<{ ok: true; result: T } | { ok: false; error: string }>
  /** 直接把整份 state 写下去（写入管线用）。隔离期间一律拒绝。 */
  write(state: EvolutionState): Promise<{ ok: true } | { ok: false; error: string }>
  /** 直接丢弃内存缓存（写入后让注入侧立刻读回新值）。 */
  invalidateCache(): void
  /** 损坏文件备份到哪（相对 hub）；界面在报错时显示。 */
  corruptBackupPath(): string
  /** 当前的隔离记录（没有则 null）。界面据此显示"写入已停止"与留存路径。 */
  quarantined(): Promise<StateQuarantine | null>
  /** 清掉隔离标记（用户处理完原文件后的显式修复动作）。 */
  clearQuarantine(): Promise<void>
}

const CACHE_TTL_MS = 1000

/**
 * 隔离标记：坏掉的 `state.json` 被留存后写下它，**在此后的所有写路径上 fail-closed**。
 *
 * 为什么必须有这个持久闸门：只在"读坏的那一次"返回错误是不够的。文件被搬走后，
 * 下一次读得到 `missing`，而 `missing` 是全新用户的正常状态 —— 于是任意一次写
 * （编辑一条笔记、每日维护扫描）都会把一份空状态整份写回，`entries` 与 `tombstones`
 * 一起清零。墓碑丢了，用户删过的内容会被自动路径重新学回来；证据链丢了，已确认的
 * 记忆失去"凭什么记"。两者都不可重建。
 *
 * 标记只能被显式修复动作清掉（用户处理完原文件后删掉它），不随读成功自动消失。
 */
export const STATE_QUARANTINE_FILE = 'evolution/state.quarantine.json'

export interface StateQuarantine {
  at: number
  /** 留存的副本绝对路径；复制失败时是原文件路径。 */
  keptFile: string
  reason: string
}

export function createEvolutionState(deps: EvolutionStateDeps): EvolutionStateStore {
  let cache: { at: number; value: EvolutionState } | null = null
  /** 进程内缓存：持久标记读不到时（磁盘只读等）仍要挡住写入。 */
  let quarantined: StateQuarantine | null = null
  let quarantineChecked = false

  const absState = (): string => hubPath(EVOLUTION_STATE_FILE)

  function quarantinePath(): string {
    return hubPath(STATE_QUARANTINE_FILE)
  }

  async function readQuarantine(): Promise<StateQuarantine | null> {
    if (quarantineChecked) return quarantined
    quarantineChecked = true
    try {
      const raw = JSON.parse(await readFile(quarantinePath(), 'utf8')) as Partial<StateQuarantine>
      if (raw && typeof raw === 'object' && typeof raw.keptFile === 'string') {
        quarantined = {
          at: Number.isFinite(raw.at) ? Number(raw.at) : 0,
          keptFile: raw.keptFile,
          reason: typeof raw.reason === 'string' ? raw.reason : '',
        }
      }
    } catch {
      // 没有标记 / 读不出来：当作没隔离（标记是保护，不是数据源）。
    }
    return quarantined
  }

  async function writeQuarantine(info: StateQuarantine): Promise<void> {
    quarantined = info
    quarantineChecked = true
    try {
      await mkdir(hubPath('evolution'), { recursive: true })
      await writeFileAtomically(quarantinePath(), JSON.stringify({ v: 1, ...info }, null, 2) + '\n', { mode: 0o600 })
    } catch (e) {
      // 写标记失败是"保护降级"（进程内仍挡住），不是本次操作失败。
      console.warn(`[dsh-plugin-tool-management] state 隔离标记写入失败：${deps.message(e)}`)
    }
  }

  /** 隔离态的报错文案：必须带上留存路径，否则用户无从找回。 */
  function quarantineError(q: StateQuarantine): string {
    return `state.json 已被隔离，自动写入已停止，以免用空状态覆盖证据链与墓碑。`
      + `原因：${q.reason || '未知'}。原文件留存在 ${q.keptFile} —— 处理完它并删除 ${STATE_QUARANTINE_FILE} 后重启即可恢复写入。`
  }

  /**
   * 读当前状态。
   *
   * @param opts.quarantine 解析失败时是否留存副本并落隔离标记，默认 `true`。**写路径不许关**：
   *   不留存就等于拿一份空状态去覆盖证据链与墓碑。只有只读 op（`evolution-status` /
   *   `evolution-health` / `evolution-preview`）给 `false` —— 它们声称不写盘，就不能因为
   *   撞上一份坏文件而在 `evolution/` 里留下副本。
   */
  async function readFresh(opts: { quarantine?: boolean } = {}): Promise<{ ok: true; state: EvolutionState } | { ok: false; error: string }> {
    const quarantine = opts.quarantine !== false
    // 只读访问不建目录：目录本身就是一次写盘。
    if (quarantine) await deps.ensurePaths()
    // 隔离标记是**权威闸门**：它存在时连读都不必给成功结果，否则调用方会拿着空状态
    // 去改、再走 write()，而 write() 的 fail-closed 只是最后一道。
    const q = await readQuarantine()
    if (q) return { ok: false, error: quarantineError(q) }
    const read = await deps.readJsonFileStrict(absState())
    if (read.status === 'missing') return { ok: true, state: emptyState() }
    if (read.status === 'unreadable') {
      // **绝不隔离、绝不改名**：读失败可能是杀软 / 索引器瞬时占用，重试就能好。
      // 把"重试即可恢复"升级成"数据被搬走"，正是这条链最早的错误。
      return {
        ok: false,
        error: `state.json 暂时读不出来：${read.error}。已停止自动写入；稍后重试或检查文件权限。`,
      }
    }
    if (read.status === 'corrupt') {
      if (!quarantine) return { ok: false, error: corruptReadOnlyError(read.error) }
      const kept = await keepCorruptCopy(read.error)
      return { ok: false, error: kept }
    }
    const normalized = normalizeState(read.value)
    if (!normalized.ok) {
      if (!quarantine) return { ok: false, error: corruptReadOnlyError(normalized.error) }
      const kept = await keepCorruptCopy(normalized.error)
      return { ok: false, error: kept }
    }
    return normalized
  }

  /** 只读访问撞上坏文件：如实报错，并说清"副本要等写路径来留"。 */
  function corruptReadOnlyError(reason: string): string {
    return `state.json 解析失败：${reason}。本次是只读访问，未改动任何文件；下一次写入前的读取会留存副本并停止自动写入。`
  }

  /**
   * 解析失败：**复制**一份留存（原文件留在原位），写下隔离标记，返回给用户看的文案。
   *
   * 用复制而不是改名：改名之后"原文件在哪"取决于备份是否成功，而复制失败时原文件仍在，
   * 用户至少还能自己看到它。两种情况下正文文件一个都不动。
   */
  async function keepCorruptCopy(reason: string): Promise<string> {
    const dest = corruptBackupPath()
    // 留存副本的**绝对路径**。`corruptBackupPath()` 给的是 hub 相对路径（它同时被界面当
    // 相对标识用），这里必须换成绝对的再记进隔离记录 —— `keptFile` 唯一的用途是写进
    // 给用户看的那句话（「原文件留存在 …」），存相对路径等于让人拿到一个没法直接用的路径。
    const destAbs = hubPath(dest)
    let keptFile = absState()
    try {
      await copyFile(absState(), destAbs)
      keptFile = destAbs
    } catch {
      // 复制不了就指着原文件：绝不 rm，那是用户唯一的证据链。
    }
    const info: StateQuarantine = { at: Date.now(), keptFile, reason }
    await writeQuarantine(info)
    return quarantineError(info)
  }

  async function read(): Promise<{ ok: true; state: EvolutionState } | { ok: false; error: string }> {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return { ok: true, state: cache.value }
    const r = await readFresh({ quarantine: false })
    if (r.ok) cache = { at: Date.now(), value: r.state }
    return r
  }

  function cachedSync(): EvolutionState {
    if (cache) return cache.value
    void read().catch(() => {})
    return emptyState()
  }

  function corruptBackupPath(): string {
    return `evolution/state.json.corrupt-${Date.now()}`
  }

  async function write(state: EvolutionState): Promise<{ ok: true } | { ok: false; error: string }> {
    // 最后一道闸：即便调用方绕过 readFresh 拿到了一份空状态，隔离期间也不许落盘。
    const q = await readQuarantine()
    if (q) return { ok: false, error: quarantineError(q) }
    try {
      await deps.ensurePaths()
      await mkdir(hubPath('evolution'), { recursive: true })
      pruneTombstones(state)
      await writeFileAtomically(absState(), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
      cache = { at: Date.now(), value: state }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: `写 state.json 失败：${deps.message(e)}` }
    }
  }

  async function update<T>(fn: (state: EvolutionState) => T | Promise<T>): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
    const r = await readFresh()
    if (!r.ok) return r
    const result = await fn(r.state)
    const written = await write(r.state)
    if (!written.ok) return written
    return { ok: true, result }
  }

  return {
    read,
    readFresh,
    cachedSync,
    update,
    write,
    corruptBackupPath,
    quarantined: async () => await readQuarantine(),
    clearQuarantine: async () => {
      quarantined = null
      quarantineChecked = true
      await rm(quarantinePath(), { force: true }).catch(() => undefined)
    },
    invalidateCache: () => { cache = null },
  }
}

/** 给条目追加一次迁移记录（保留最近 50 条）。 */
export function pushTransition(entry: EntryState, from: string, to: string, actor: Transition['actor'], reason: string, now = Date.now()): void {
  if (from === to) return
  entry.transitions.push({ at: new Date(now).toISOString(), from, to, actor, reason })
  if (entry.transitions.length > 50) entry.transitions.splice(0, entry.transitions.length - 50)
}

