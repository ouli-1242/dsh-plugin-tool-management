// 自主记忆的**真源状态**（`evolution/state.json`）：证据链、计数器、状态迁移、墓碑、水位。
//
// 为什么它与 `catalog.json` 分开：catalog 全部可由「磁盘文件 + 本文件」重建，坏了重建即可；
// 本文件里的证据与墓碑**不可重建** —— 它们是"为什么记这条"和"用户已经删过这条"的唯一记录。
// 两者混在一个文件里，一次 catalog 重建就会把墓碑一起冲掉，于是用户删掉的事实会复活。
//
// 为什么证据不放 frontmatter：`parseSkillDoc` 只识别顶层扁平标量（见 skills/frontmatter.ts 的
// 注释），数组与嵌套结构进不了 map。硬塞只能序列化成一行 JSON，那既不可读、也会让
// `description` 这类字段被 500 字符上限截断。所以：frontmatter 只放标量（给发现层与界面读），
// 证据与计数器放这里（给写入管线与 dream 读）。
//
// 读的纪律（与 `settings-sidecars` 相反，这是有意的）：
//   - 侧车读坏 → 回默认值，因为界面必须能打开；
//   - 本文件读坏 → **拒绝写入并报错**。用默认值覆盖它等于把用户所有的证据链和墓碑一次性清零，
//     之后被删的记忆会静默复活、被纠正过的错误会重新变成"高置信"。宁可停摆，不可静默。
//     坏的原文会先备份到 `evolution/state.json.corrupt-<ts>`，正文文件一个不动。

import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { hubPath } from '../hub.js'
import { writeFileAtomically } from '../memories/index-io.js'
import type { JsonFileRead } from '../mcp/disabled-tools.js'

export const EVOLUTION_STATE_FILE = 'evolution/state.json'
export const STATE_VERSION = 1

/** 证据来源。权重见 `baseConfidenceOf`：不是"谁说的"，而是"可复核到什么程度"。 */
export type EvidenceSource = 'user_explicit' | 'user_correction' | 'tool_verified' | 'model_inference'

export const EVIDENCE_SOURCES: readonly EvidenceSource[] = ['user_explicit', 'user_correction', 'tool_verified', 'model_inference']

/**
 * 一条证据。
 *
 * `quote` 对 `user_explicit` / `user_correction` 是**用户文本的逐字子串**（证据门校验的就是它）；
 * 对 `tool_verified` 是工具名 + 结果摘要（不必逐字，但要能定位到 `seq`）；对 `model_inference`
 * 是模型给出的推断依据 —— 这类证据无论多少条都只能让条目停在 `candidate`。
 */
export interface EvidenceRef {
  session: string
  turn: number
  seq: number
  source: EvidenceSource
  quote: string
  at: string
}

export interface EntryCounters {
  injected: number
  read: number
  helpful: number
  harmful: number
  lastInjectedAt?: string
  lastUsedAt?: string
}

export interface Transition {
  at: string
  from: string
  to: string
  actor: 'learn' | 'curator' | 'user' | 'dream' | 'system'
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
  /**
   * 反规范化的置信度：真值由 `evidence` 算出（`confidenceOf`），这里存一份供界面直读。
   * 两者不一致时**以 evidence 为准** —— 每次写入都会重算，它只是个缓存。
   */
  confidence?: number
  /** 路由降级原因：`no-scene` / `no-workspace` / `scope-too-narrow`。界面据此解释"为什么它在工作区层"。 */
  degraded?: string
  /** 用户编辑过 = 锁定：自动路径从此只能提议，不能覆盖正文。 */
  locked?: boolean
  /** 需要用户裁决的原因（与用户记忆冲突 / 表述有歧义）。有值 = 不注入，等确认。 */
  needsReview?: string
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
  /** 归一化正文的 sha256：没有 key 的条目靠它拦。 */
  textHash: string
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

export const emptyCounters = (): EntryCounters => ({ injected: 0, read: 0, helpful: 0, harmful: 0 })

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
    // 单条证据不设上限，但一个条目的证据超过 50 条时只留最近的：再多也不改变置信度。
    if (out.length >= 50) break
  }
  return out
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
        actor: ['learn', 'curator', 'user', 'dream', 'system'].includes(t.actor) ? t.actor : 'system',
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
      helpful: Math.max(0, num(counters.helpful)),
      harmful: Math.max(0, num(counters.harmful)),
      ...(typeof counters.lastInjectedAt === 'string' ? { lastInjectedAt: counters.lastInjectedAt } : {}),
      ...(typeof counters.lastUsedAt === 'string' ? { lastUsedAt: counters.lastUsedAt } : {}),
    },
    transitions,
    ...(typeof raw.confidence === 'number' ? { confidence: raw.confidence } : {}),
    ...(typeof raw.degraded === 'string' && raw.degraded !== '' ? { degraded: raw.degraded } : {}),
    ...(bool(raw.locked) === true ? { locked: true } : {}),
    ...(typeof raw.needsReview === 'string' && raw.needsReview !== '' ? { needsReview: raw.needsReview } : {}),
    // 显式归一化：上面的 `...raw` 会把脏的 procedure 原样带进来，界面拿去渲染就会炸。
    ...(normalizeProcedure(raw.procedure) !== undefined ? { procedure: normalizeProcedure(raw.procedure)! } : {}),
  }
}

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
      },
    },
  }
}

// ── 置信度 ─────────────────────────────────────────────────────────────────

/**
 * 证据来源的基准分。**不采用模型自报的 confidence** —— 让它自评"我有多确定"等于让写的人
 * 顺便当裁判，实测里 0.9 与 0.6 的区别基本是随机的。这里的分数只看证据类型。
 */
export const BASE_CONFIDENCE: Record<EvidenceSource, number> = {
  user_explicit: 0.95,
  user_correction: 0.9,
  tool_verified: 0.8,
  model_inference: 0.4,
}

/** 独立证据数 = 不同 session 的条数（同一会话里说两遍不算两次独立验证）。 */
export function independentEvidenceOf(evidence: EvidenceRef[]): number {
  return new Set(evidence.map((e) => e.session || '?')).size
}

/**
 * 置信度 = 最强证据的基准 + 独立证据加成 − 矛盾惩罚。
 *
 * 加成 0.03/条、惩罚 0.15/次：一条纠正（−0.15）要比五次独立复述（+0.12）更重 —— 用户说
 * "不是这样"的时候，重复次数不说明任何问题。上限 0.99 而不是 1.0：留一格表示"没有绝对"。
 */
export function confidenceOf(evidence: EvidenceRef[], contradictions = 0): number {
  if (evidence.length === 0) return 0
  const base = Math.max(...evidence.map((e) => BASE_CONFIDENCE[e.source] ?? 0.4))
  const independent = independentEvidenceOf(evidence)
  const raw = base + 0.03 * Math.max(0, independent - 1) - 0.15 * Math.max(0, contradictions)
  return Math.min(0.99, Math.max(0, Number(raw.toFixed(2))))
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

export function makeTombstone(key: string, textHash: string, actor: string, now = Date.now()): Tombstone {
  const at = new Date(now)
  const until = new Date(now + TOMBSTONE_DAYS * 86400_000)
  return { key, textHash, at: at.toISOString(), until: until.toISOString(), actor }
}

/** 清掉过期墓碑；返回是否有变化（调用方据此决定要不要写盘）。 */
export function pruneTombstones(state: EvolutionState, now = Date.now()): boolean {
  const kept = state.tombstones.filter((t) => tombstoneActive(t, now))
  if (kept.length === state.tombstones.length) return false
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
  /** 读。坏文件返回错误（**不**回默认值）。`missing` 是正常状态，返回空 state。 */
  read(): Promise<{ ok: true; state: EvolutionState } | { ok: false; error: string }>
  /** 读（同步快照用）：已缓存则给缓存，否则给空 state 并后台刷新。 */
  cachedSync(): EvolutionState
  /**
   * 读-改-写。回调里直接改 state 对象即可，返回值透传。
   *
   * 串行由调用方保证（op 层已过写队列）；本方法只负责"读坏就不写"和原子落盘。
   */
  update<T>(fn: (state: EvolutionState) => T | Promise<T>): Promise<{ ok: true; result: T } | { ok: false; error: string }>
  /** 直接把整份 state 写下去（dream 应用时用）。 */
  write(state: EvolutionState): Promise<{ ok: true } | { ok: false; error: string }>
  /** 直接丢弃内存缓存（写入后让注入侧立刻读回新值）。 */
  invalidateCache(): void
  /** 损坏文件备份到哪（相对 hub）；界面在报错时显示。 */
  corruptBackupPath(): string
}

const CACHE_TTL_MS = 1000

export function createEvolutionState(deps: EvolutionStateDeps): EvolutionStateStore {
  let cache: { at: number; value: EvolutionState } | null = null

  const absState = (): string => hubPath(EVOLUTION_STATE_FILE)

  async function readFresh(): Promise<{ ok: true; state: EvolutionState } | { ok: false; error: string }> {
    await deps.ensurePaths()
    const read = await deps.readJsonFileStrict(absState())
    if (read.status === 'missing') return { ok: true, state: emptyState() }
    if (read.status === 'corrupt' || read.status === 'unreadable') {
      return {
        ok: false,
        error: `state.json ${read.status === 'corrupt' ? '损坏' : '不可读'}：${read.error}。已停止自动写入以免覆盖证据与墓碑；请检查该文件或从备份恢复。`,
      }
    }
    const normalized = normalizeState(read.value)
    if (!normalized.ok) return { ok: false, error: `state.json 结构不认识：${normalized.error}。已停止自动写入。` }
    return normalized
  }

  async function read(): Promise<{ ok: true; state: EvolutionState } | { ok: false; error: string }> {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return { ok: true, state: cache.value }
    const r = await readFresh()
    if (r.ok) cache = { at: Date.now(), value: r.state }
    return r
  }

  function cachedSync(): EvolutionState {
    if (cache) return cache.value
    void read().catch(() => {})
    return emptyState()
  }

  /** 坏文件先备份：备份失败也要继续（用户至少还能看到原文件）。 */
  async function backupCorrupt(): Promise<void> {
    const dest = corruptBackupPath()
    try {
      await rename(absState(), hubPath(dest))
    } catch {
      // 备份不了就原地留着：绝不 rm，那是用户唯一的证据链。
    }
  }

  function corruptBackupPath(): string {
    return `evolution/state.json.corrupt-${Date.now()}`
  }

  async function write(state: EvolutionState): Promise<{ ok: true } | { ok: false; error: string }> {
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
    if (!r.ok) {
      // 读坏时先备份，让下一次写入有机会从空状态重建（正文文件都还在，会按 candidate 补回）。
      await backupCorrupt()
      return r
    }
    const result = await fn(r.state)
    const written = await write(r.state)
    if (!written.ok) return written
    return { ok: true, result }
  }

  return { read, cachedSync, update, write, corruptBackupPath, invalidateCache: () => { cache = null } }
}

/** 给条目追加一次迁移记录（保留最近 50 条）。 */
export function pushTransition(entry: EntryState, from: string, to: string, actor: Transition['actor'], reason: string, now = Date.now()): void {
  if (from === to) return
  entry.transitions.push({ at: new Date(now).toISOString(), from, to, actor, reason })
  if (entry.transitions.length > 50) entry.transitions.splice(0, entry.transitions.length - 50)
}

/** 清掉磁盘上已不存在的条目的状态（保留墓碑）。返回清掉的 id。 */
export function pruneOrphanEntries(state: EvolutionState, existingIds: Set<string>): string[] {
  const removed: string[] = []
  for (const id of Object.keys(state.entries)) {
    if (existingIds.has(id)) continue
    delete state.entries[id]
    removed.push(id)
  }
  return removed
}

/** 给自动段的候选条目算分（`04-governance §4`）：置信度、新鲜度、有用度、钉住。 */
export function scoreOf(
  entry: { confidence: number; pinned: boolean; updatedAt?: string },
  counters: EntryCounters,
  maxHelpful: number,
  now = Date.now(),
): number {
  const updatedAt = entry.updatedAt ? Date.parse(entry.updatedAt) : Number.NaN
  const ageDays = Number.isFinite(updatedAt) ? Math.max(0, (now - updatedAt) / 86400_000) : 0
  const fresh = 0.25 * Math.exp(-ageDays / 60)
  // log(1+helpful)/log(1+maxHelpful)：第一条 helpful 最值钱，第十条几乎不加分。
  const helpRatio = maxHelpful > 0 ? Math.log(1 + counters.helpful) / Math.log(1 + maxHelpful) : 0
  return 0.45 * entry.confidence + fresh + 0.2 * Math.min(1, helpRatio) + (entry.pinned ? 0.1 : 0)
}

/** 清理临时文件残留（原子写的 `.tmp` 后缀）—— 启动时跑一次即可。 */
export async function sweepTempFiles(dir: string): Promise<void> {
  const { readdir } = await import('node:fs/promises')
  try {
    for (const name of await readdir(dir)) {
      if (!name.startsWith('.') || !name.includes('.dsh-rules-') || !name.endsWith('.tmp')) continue
      await rm(join(dir, name), { force: true }).catch(() => {})
    }
  } catch {
    // 目录还不存在：没有残留可清。
  }
}
