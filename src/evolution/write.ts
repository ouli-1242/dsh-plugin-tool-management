// 自动记忆的写入管线：门禁 → 定 id → 写正文 → 写状态 → 写索引 → 写 catalog。
//
// **六步不是事务，所以顺序是设计出来的**（docs 03-flows §6）：
//   先正文、再 state、最后 index。中途崩溃的后果是"有文件无状态"（下次扫描补一条 candidate），
//   而不是"有状态无文件"（注入时指向不存在的记忆，或索引里一条 enabled 的幽灵）。
//   反过来做，只要进程死在中间，用户就会看到一条"已启用但读不出来"的记忆，且没有任何提示。
//
// 为什么不复用 `rules-create`：那条 op 有两条与本功能相冲突的既定语义 ——
//   ① 它要求场景**已存在**（自动记忆可能落在 `_ws/<hash>` / `_session/<sid>` 这类非场景目录）；
//   ② 它新建的条目一律 `enabled: false`（P5 的"新建记忆默认不开启"），而自动记忆要立即生效。
//   改 op 的语义会动到用户手写那条路；所以这里直接做底层六步，共用 `serializeRuleFile`
//   与 `writeFileAtomically`，把差异限制在本文件内。

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hubPath } from '../hub.js'
import { writeFileAtomically, readIndex, writeIndex } from '../memories/index-io.js'
import { catalogEntryOf, catalogPathOf, estimateTokens, normalizeCatalog, oneLineOf, type CatalogFile } from '../memories/catalog.js'
import {
  GLOBAL_SCENE, LAYER_GLOBAL, LAYER_SCENE, LAYER_SESSION, LAYER_WORKSPACE, SHARED_GROUP,
  isValidGroupPath, isValidGroupSegment, layerOfGroup, type MemoryLayer,
} from '../memories/constants.js'
import {
  archiveAutoNote, backfillArchivedTrash, dropAutoTrashEntry, findAutoTrashByNoteId,
  readAutoTrashManifest, restoreAutoNoteFromTrash, trashAutoNote,
} from './notes.js'
import { rewriteFrontmatterFields } from '../skills/frontmatter.js'
import { textWidthOf, truncateToWidth } from '../text-width.js'
import type { EffectiveEvolutionConfig } from './config.js'
import {
  runGates, tombstoneBlocked, type AutoKind, type ExistingEntry, type GateContext, type GateName, type GateOutcome, type ReviewCode,
} from './gates.js'
import { deriveKey } from './gates.js'
import { draftOrganize, type OrganizeAction, type OrganizeDraft } from './organize.js'
import {
  bumpRevision, emptyCounters, pushTransition, textHashOf, tierOf, type EvidenceTier,
  type EntryState, type EvidenceSource, type EvolutionState, type EvolutionStateStore,
} from './state.js'

/**
 * 一条自动记忆的正文上限（显示宽度）。2400 单位 = 1200 汉字 / 2400 字母。
 *
 * 按宽度而不是字符数：1200 个汉字约等于 2400 个英文字母的内容，按字符数设限
 * 会让英文笔记只有中文的一半。与手写记忆的 `MAX_RULE_WIDTH` 同一档 —— 两者注入进
 * 同一个池子，单条上限不该有两套说法。
 */
export const MAX_AUTO_TEXT_WIDTH = 2400
/** 名称上限（显示宽度）：100 单位 = 50 汉字 / 100 字母；列表一行要放得下。 */
export const MAX_AUTO_TITLE_WIDTH = 100
/** `boundary` 上限：合并时会追加，靠它兜住长度。 */
const MAX_BOUNDARY = 500
/**
 * `auto_alias` 上限：合并进来的**另一种说法**。
 *
 * 与 boundary 分开：boundary 回答「什么时候不成立」，alias 回答「同样这件事还说成过什么」。
 * 混在一个字段里，用户读到的边界会变成一列说法，既判断不了适用条件，也看不出哪句是限制。
 */
const MAX_ALIAS = 300

export interface LearnRequest {
  text: string
  /** 展示名：记忆页的行名，注入行也会用它加粗。缺省时列表按正文首句兜底。 */
  title?: string
  kind?: AutoKind
  key?: string
  /**
   * 模型声称的用户原话。门禁会拿它跟本会话真实的用户消息做子串核对：
   * 命中即 `user_explicit` 证据，核不上直接拒，不给就按推断记。
   *
   * 这里**没有 `source`**：证据来源是系统判定的结果，不是可传的参数。
   */
  quote?: string
  layer?: MemoryLayer
  boundary?: string
  ttlDays?: number
  /** 用户在对话卡片上批准了这条原文：直接生效，但用户手写记忆的冲突仍然只进 candidate。 */
  approved?: boolean
  /** 按自动生效策略直接落 active（工作区 + 强证据 + 非做法类）。 */
  autoActive?: boolean
}

export interface LearnEnv {
  sessionId?: string
  workspaceHash?: string
  scene?: string
}

/**
 * 门禁能看到的现有条目：自动条目只留当前作用域内的。
 *
 * 用户记忆没有 workspace / session / scene 字段（它们按场景体系存），照旧全部可见 ——
 * 用户写过的相似记忆在任何场景都该挡住自动覆盖。自动笔记必须按层过滤：别的仓库、
 * 别的会话、别的场景的同 slot 笔记不能被当成本次的合并目标。
 */
export function visibleExistingEntries(entries: ExistingEntry[], env: LearnEnv): ExistingEntry[] {
  return entries.filter((e) => {
    if (e.layer === LAYER_WORKSPACE) return env.workspaceHash !== undefined && e.workspace === env.workspaceHash
    if (e.layer === LAYER_SESSION) return env.sessionId !== undefined && e.session === env.sessionId
    // `_shared` 是恒常注入的公共基线，不属于某一个场景 —— 它在任何场景下都可见。
    if (e.layer === LAYER_SCENE && e.scene !== undefined && e.scene !== SHARED_GROUP) return env.scene === e.scene
    return true
  })
}

export interface LearnSuccess {
  ok: true
  id: string
  layer: MemoryLayer
  status: string
  /** 证据档位：`confirmed`（用户确认过）/ `quoted`（有核对过的原话）/ `inferred`。 */
  tier: EvidenceTier
  merged: boolean
  supersedes: string[]
  /**
   * 最终落盘的类型（模型给了就用它，否则 `inferKind` 按措辞猜）。
   * 工具回执要回显它：类型决定保质期，模型没传时无从知道被猜成了什么。
   */
  kind?: AutoKind
  note?: string
  pendingReason?: string
  /** 按自动生效策略直接落 active（没有用户确认）。 */
  autoActive?: boolean
  /** 卡片批准过这条原文（即使最终因用户记忆冲突仍是 candidate）。 */
  approved?: boolean
  reviewCode?: ReviewCode
}

export interface LearnFailure {
  ok: false
  code: string
  error: string
  gate?: GateName
  detail?: string
}

export type LearnResult = LearnSuccess | LearnFailure

/**
 * 只读预演：同一条请求**如果用户在卡片上选了推荐层并批准**，会落到哪一层、是否生效、
 * 会合并 / 取代谁。调用方据此决定要不要弹卡（门禁拒绝、与用户记忆冲突、锁定目标都不弹）。
 *
 * `allowedLayers` 是卡片可提供的选项：由两个自主记忆开关与工作区身份裁剪；
 * 至少包含 `layer` 本身（拿不到工作区路径时，写入仍会按现有规则回落到全局）。
 */
export interface LearnPreviewSuccess {
  ok: true
  /** 当前生效的自动确认设置：为真时工具不弹卡，直接按模型给的层落盘。 */
  autoConfirm: boolean
  /** 将要保存的正文（已按上限截断）。卡片展示它，而不是模型的原始入参。 */
  text: string
  boundary?: string
  /** 门禁最终判定的类型（模型给了就用它，否则 `inferKind` 兜底）。卡片据此写明保质期。 */
  kind?: 'preference' | 'fact' | 'correction' | 'procedure'
  layer: MemoryLayer
  allowedLayers: MemoryLayer[]
  status: 'active' | 'candidate'
  tier: EvidenceTier
  approved: boolean
  pendingReason?: string
  reviewCode?: ReviewCode
  mergeInto?: string
  supersedes: string[]
  note?: string
  /**
   * 不弹卡、直接落盘的模拟结果。工具据此决定「直接生效 / 弹卡 / 进候选」：
   * `status === 'active' && autoActive` 才可以直接写；其余按 reviewCode 分流。
   */
  direct?: {
    status: 'active' | 'candidate'
    autoActive: boolean
    tier: EvidenceTier
    reviewCode?: ReviewCode
    pendingReason?: string
  }
}

export type LearnPreview = LearnPreviewSuccess | LearnFailure

export interface LearnDeps {
  state: EvolutionStateStore
  /** 现有记忆视图（来自快照）。 */
  existingEntries(): Promise<{ entries: ExistingEntry[]; knownScenes: Set<string> }>
  /** 工作区 hash 是否登记过。 */
  knownWorkspaces(): Promise<Set<string>>
  /** 序列化 frontmatter + 正文（复用记忆域的现成实现）。 */
  serializeRuleFile(fields: Record<string, string | boolean>, body: string): string
  /** 用户记忆根目录（兼容回落；生产应传 `notesRoot`）。 */
  memoriesRoot: string
  /** 自主记忆根目录绝对路径。不传时回落 `memoriesRoot`。 */
  notesRoot?: string
  /** 索引所在目录（hub 根；catalog / 日志仍认它）。 */
  stateDir: string
  /** 自主记忆自己的启停索引目录。不传时回落 `stateDir`。 */
  indexDir?: string
  /** 写后失效快照缓存。 */
  invalidateSnapshot(): void
  /** 串行化写（与记忆域同一把锁）。 */
  withWriteLock<T>(fn: () => Promise<T>): Promise<T>
  message(e: unknown): string
}

// ── 小工具 ─────────────────────────────────────────────────────────────────

/** key → 文件名。保留中文与字母数字，其余压成连字符。 */
export function slugOf(key: string): string {
  const s = String(key ?? '')
    .trim()
    .toLowerCase()
    .replaceAll(/[\s_]+/g, '-')
    .replaceAll(/[^\p{L}\p{N}-]/gu, '')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-|-$/g, '')
  // `replace`（不是 `replaceAll`）：这里只想去掉**末尾一个**连字符，而 `replaceAll` 配
  // 非全局正则会直接抛 TypeError —— 症状是每一次 learn 都失败，回执只有一句 `learn-failed`。
  const clipped = s.slice(0, 48).replace(/-$/, '')
  return clipped === '' ? 'note' : clipped
}

/** 名称：显式给的优先，空白视为没有。 */
export function titleOf(title: string | undefined): string {
  return truncateToWidth(String(title ?? '').trim(), MAX_AUTO_TITLE_WIDTH)
}

const cjkOrWord = (s: string): boolean => /\p{L}/u.test(s)

// ── 主流程 ─────────────────────────────────────────────────────────────────

export function createLearner(deps: LearnDeps) {
  const { state } = deps
  // 正文与启停索引都落在自主记忆自己的库里；两个旧字段只作兼容回落（测试自造 deps 时
  // 仍按原来的临时目录跑），生产装配会把 notesRoot / indexDir 都指到 evolution/notes。
  const notesRoot = deps.notesRoot ?? deps.memoriesRoot
  const indexDir = deps.indexDir ?? deps.stateDir

  /** 会话层目录名：sid 必须是合法段名，否则拒绝（回退会让两个会话共享同一目录）。 */
  function sessionSegmentOk(sid: string): boolean {
    return isValidGroupSegment(sid)
  }

  async function buildGateContext(
    config: EffectiveEvolutionConfig,
    env: LearnEnv,
    st: EvolutionState,
  ): Promise<GateContext> {
    const { entries, knownScenes } = await deps.existingEntries()
    const visible = visibleExistingEntries(entries, env)
    // 频率只数「新建」：state 里第一条 `from: 'absent'` 的迁移就是这条记忆诞生的时刻。
    // 合并 / 更新只追加证据与迁移，不产生 `absent` 起点，所以天然不占名额。
    const cutoff = Date.now() - config.learnWindowMinutes * 60_000
    const recentByLayer: Partial<Record<MemoryLayer, number>> = {}
    for (const [id, entry] of Object.entries(st.entries)) {
      const created = entry.transitions.find((t) => t.from === 'absent')
      if (!created) continue
      const at = Date.parse(created.at)
      if (!Number.isFinite(at) || at < cutoff) continue
      const slash = id.lastIndexOf('/')
      if (slash <= 0) continue
      const layer = layerOfGroup(id.slice(0, slash))
      recentByLayer[layer] = (recentByLayer[layer] ?? 0) + 1
    }
    return {
      ...(env.sessionId !== undefined ? { sessionId: env.sessionId } : {}),
      ...(env.workspaceHash !== undefined ? { workspaceHash: env.workspaceHash } : {}),
      ...(env.scene !== undefined ? { scene: env.scene } : {}),
      allowed: { global: config.learnGlobal, workspace: config.learnWorkspace },
      // `locked` 只在 state 里：快照给的是记忆域的形状，没有这个字段。不补上的话
      // 门禁会把一条用户手改过的条目当成普通合并目标，预览也会说「会合并」，
      // 真正写入时才被 mergeInto 拒掉。
      existing: visible.map((e) => (e.origin === 'auto' && st.entries[e.id]?.locked === true ? { ...e, locked: true } : e)),
      recentByLayer,
      // 全局 / 工作区共用一份频率；两层各自按 `recentByLayer` 计数。
      rate: { notes: config.maxLearnsPerWindow, windowMinutes: config.learnWindowMinutes },
      knownWorkspaces: await deps.knownWorkspaces(),
      knownScenes,
      tombstones: st.tombstones,
      maxTextWidth: MAX_AUTO_TEXT_WIDTH,
    }
  }

  /**
   * 学一条。
   *
   * 返回的 `note` 会进工具回执 —— 它是用户唯一能读到"为什么这条进的是工作区层"的地方。
   */
  async function learn(req: LearnRequest, config: EffectiveEvolutionConfig, env: LearnEnv): Promise<LearnResult> {
    const text = String(req.text ?? '').trim()
    if (text === '') return { ok: false, code: 'empty', error: 'nothing to learn: text is empty' }
    const width = textWidthOf(text)
    if (width > MAX_AUTO_TEXT_WIDTH) {
      return { ok: false, code: 'too-long', error: `refused: this note is ${width} width units; the limit is ${MAX_AUTO_TEXT_WIDTH} (about 1200 Chinese chars or 2400 letters). Split it, or record it as a normal memory.` }
    }

    // 会话层：sid 不合法时不能落（目录即身份，换个名字就等于换了会话）。
    if (req.layer === LAYER_SESSION && env.sessionId && !sessionSegmentOk(env.sessionId)) {
      return { ok: false, code: 'bad-session', error: 'refused: this conversation id cannot be used as a directory name, so it cannot hold conversation-scoped notes. Use layer="workspace" instead.', gate: 'layer' }
    }

    return deps.withWriteLock(async () => {
      const read = await state.readFresh()
      if (!read.ok) return { ok: false, code: 'state-unreadable', error: read.error }
      const st = read.state

      // 墓碑在本轮门禁之前判：删过的东西连"记不下来"的回执都不该给第二次机会 ——
      // 直接说"你删过它，30 天内不复活"，用户才知道怎么真的让它消失。
      const keyForTomb = (req.key ?? '').trim() !== '' ? String(req.key).trim() : deriveKey(text)
      const blocked = tombstoneBlocked({ tombstones: st.tombstones } as GateContext, keyForTomb, text)
      if (blocked) {
        return {
          ok: false,
          code: 'tombstoned',
          error: `not recorded: this was deleted ${blocked.at.slice(0, 10)} and stays deleted until ${blocked.until.slice(0, 10)}. If it should come back, the user has to say so explicitly.`,
          gate: 'conflict',
        }
      }

      const ctx = await buildGateContext(config, env, st)
      const outcome: GateOutcome = runGates(
        {
          text,
          ...(req.kind !== undefined ? { kind: req.kind } : {}),
          ...(req.key !== undefined ? { key: req.key } : {}),
          ...(req.quote !== undefined ? { quote: req.quote } : {}),
          ...(req.layer !== undefined ? { layer: req.layer } : {}),
          ...(req.boundary !== undefined ? { boundary: req.boundary } : {}),
          ...(req.ttlDays !== undefined ? { ttlDays: req.ttlDays } : {}),
          ...(req.approved === true ? { approved: true } : {}),
          ...(req.autoActive === true ? { autoActive: true } : {}),
        },
        ctx,
      )
      if (!outcome.ok) {
        return {
          ok: false,
          code: 'gate',
          error: outcome.error,
          gate: outcome.gate,
          detail: outcome.detail,
        }
      }
      return applyOutcome(outcome, req, st, env, config)
    })
  }

  /**
   * 只读预演（对话卡片弹之前调）。
   *
   * 跑两遍门禁：第一遍按内容 / 环境取路由层；第二遍把该层当成「用户选的层」再跑一次，
   * 这样合并 / 取代信息与用户点第一项（推荐层）时真正会发生的事一致。
   *
   * 不写任何文件、不 bump revision、不拿写锁 —— 用户看卡片可能要看很久，
   * 期间不能把其他写操作卡住。
   */
  async function preview(req: LearnRequest, config: EffectiveEvolutionConfig, env: LearnEnv): Promise<LearnPreview> {
    const text = String(req.text ?? '').trim()
    if (text === '') return { ok: false, code: 'empty', error: 'nothing to learn: text is empty' }
    const width = textWidthOf(text)
    if (width > MAX_AUTO_TEXT_WIDTH) {
      return { ok: false, code: 'too-long', error: `refused: this note is ${width} width units; the limit is ${MAX_AUTO_TEXT_WIDTH} (about 1200 Chinese chars or 2400 letters). Split it, or record it as a normal memory.` }
    }
    if (req.layer === LAYER_SESSION && env.sessionId && !sessionSegmentOk(env.sessionId)) {
      return { ok: false, code: 'bad-session', error: 'refused: this conversation id cannot be used as a directory name, so it cannot hold conversation-scoped notes. Use layer="workspace" instead.', gate: 'layer' }
    }

    const read = await state.readFresh()
    if (!read.ok) return { ok: false, code: 'state-unreadable', error: read.error }
    const st = read.state
    const keyForTomb = (req.key ?? '').trim() !== '' ? String(req.key).trim() : deriveKey(text)
    const blocked = tombstoneBlocked({ tombstones: st.tombstones } as GateContext, keyForTomb, text)
    if (blocked) {
      return {
        ok: false,
        code: 'tombstoned',
        error: `not recorded: this was deleted ${blocked.at.slice(0, 10)} and stays deleted until ${blocked.until.slice(0, 10)}. If it should come back, the user has to say so explicitly.`,
        gate: 'conflict',
      }
    }

    const ctx = await buildGateContext(config, env, st)
    const input = (layer?: MemoryLayer, mode: 'card' | 'direct' = 'card') => ({
      text,
      ...(req.kind !== undefined ? { kind: req.kind } : {}),
      ...(req.key !== undefined ? { key: req.key } : {}),
      ...(req.quote !== undefined ? { quote: req.quote } : {}),
      ...(layer !== undefined ? { layer } : req.layer !== undefined ? { layer: req.layer } : {}),
      ...(req.boundary !== undefined ? { boundary: req.boundary } : {}),
      ...(req.ttlDays !== undefined ? { ttlDays: req.ttlDays } : {}),
      ...(mode === 'card' ? { approved: true } : { autoActive: true }),
    })

    const first = runGates(input(), ctx)
    if (!first.ok) return { ok: false, code: 'gate', error: first.error, gate: first.gate, detail: first.detail }
    // 用户记忆冲突是卡片也解不开的：不必再按推荐层跑一遍。
    const chosen = first.reviewCode === 'user-conflict' ? first : runGates(input(first.layer), ctx)
    if (!chosen.ok) return { ok: false, code: 'gate', error: chosen.error, gate: chosen.gate, detail: chosen.detail }
    // 直接落盘模拟：工具用它判断「不弹卡能不能生效」。与卡片模式分开跑，是因为
    // `approved` 会压掉一些待确认理由（歧义 / 做法类），而自动生效不应该压掉它们。
    const directOutcome = runGates(input(first.layer, 'direct'), ctx)
    const direct = directOutcome.ok ? {
      status: directOutcome.status,
      autoActive: directOutcome.autoActive === true,
      tier: directOutcome.tier,
      ...(directOutcome.reviewCode !== undefined ? { reviewCode: directOutcome.reviewCode } : {}),
      ...(directOutcome.pendingReason !== undefined ? { pendingReason: directOutcome.pendingReason } : {}),
    } : undefined

    const allowed: MemoryLayer[] = []
    if (config.learnGlobal) allowed.push(LAYER_GLOBAL)
    if (config.learnWorkspace && env.workspaceHash !== undefined) allowed.push(LAYER_WORKSPACE)
    // 路由可能因为「只开工作区但拿不到 cwd」之类的原因落到一个不在开关里的层；此时
    // 卡片只能给出实际能落的这一层（否则会给出一个必然被改写的选项）。
    if (!allowed.includes(chosen.layer)) allowed.unshift(chosen.layer)

    const boundary = String(req.boundary ?? '').trim().slice(0, MAX_BOUNDARY)
    return {
      ok: true,
      autoConfirm: config.autoConfirm,
      text: chosen.text,
      ...(boundary !== '' ? { boundary } : {}),
      kind: chosen.kind,
      layer: chosen.layer,
      allowedLayers: allowed,
      status: chosen.status,
      tier: chosen.tier,
      approved: chosen.approved,
      ...(chosen.pendingReason !== undefined ? { pendingReason: chosen.pendingReason } : {}),
      ...(chosen.reviewCode !== undefined ? { reviewCode: chosen.reviewCode } : {}),
      ...(chosen.mergeInto !== undefined ? { mergeInto: chosen.mergeInto } : {}),
      supersedes: chosen.supersedes,
      ...(chosen.note !== undefined ? { note: chosen.note } : {}),
      ...(direct !== undefined ? { direct } : {}),
    }
  }

  /** 门禁通过后的落盘。 */
  async function applyOutcome(
    pass: Extract<GateOutcome, { ok: true }>,
    req: LearnRequest,
    st: EvolutionState,
    env: LearnEnv,
    config: EffectiveEvolutionConfig,
  ): Promise<LearnResult> {
    const now = new Date()
    const nowIso = now.toISOString()
    const root = notesRoot
    const index = await readIndex(indexDir)

    if (!isValidGroupPath(pass.group)) {
      return { ok: false, code: 'bad-group', error: `internal: routed to an invalid directory "${pass.group}"`, gate: 'layer' }
    }

    // ── 合并：同 key 同义 → 追加边界与证据，不新建 ──
    if (pass.mergeInto) {
      const merged = await mergeInto(pass, pass.mergeInto, st, nowIso, env, req)
      if (merged) return merged
      // 合并失败（文件被删 / 读不动）→ 落到下面的新建路径，别把这次学习丢掉。
    }

    // ── 定 id ──
    const base = slugOf(pass.key)
    let name = base
    const taken = async (n: string): Promise<boolean> =>
      (await exists(join(root, pass.group, n + '.md'))) || (await exists(join(root, pass.group, n)))
    for (let i = 2; i <= 20 && (await taken(name)); i++) name = `${base}-${i}`
    if (await taken(name)) name = `${base}-${Date.now().toString(36).slice(-4)}`
    if (!isValidGroupSegment(name)) return { ok: false, code: 'bad-name', error: `internal: "${name}" is not a valid memory name`, gate: 'layer' }
    const id = `${pass.group}/${name}`

    // ── ① 正文 ──
    const ttl = ttlDaysOf(pass.kind, req.ttlDays)
    const title = titleOf(req.title)
    const fields: Record<string, string | boolean> = {
      name,
      ...(title !== '' ? { auto_title: title } : {}),
      origin: 'auto',
      auto_kind: pass.kind,
      auto_key: pass.key,
      auto_status: pass.status,
      auto_basis: req.quote && req.quote.trim() !== '' ? req.quote.trim() : pass.text,
      auto_created: nowIso,
      auto_updated: nowIso,
      auto_ttl_days: String(ttl),
    }
    if (pass.layer === LAYER_WORKSPACE && env.workspaceHash) fields.auto_workspace = env.workspaceHash
    if (pass.layer === LAYER_SCENE && env.scene) fields.auto_scene = env.scene
    if (req.boundary && req.boundary.trim() !== '') fields.auto_boundary = req.boundary.trim().slice(0, MAX_BOUNDARY)
    if (pass.degraded) fields.auto_degraded = pass.degraded

    const body = renderBody(pass.text, req.boundary)
    await mkdir(join(root, pass.group), { recursive: true })
    await writeFileAtomically(join(root, pass.group, name + '.md'), deps.serializeRuleFile(fields, body))

    // ── ② state ──
    const evidence = collectEvidence(pass, env, req, nowIso)
    const prev = st.entries[id]
    st.entries[id] = {
      ...(prev ?? {}),
      evidence: [...(prev?.evidence ?? []), ...evidence].slice(-50),
      counters: prev?.counters ?? emptyCounters(),
      transitions: prev?.transitions ?? [],
      ...(pass.degraded !== undefined ? { degraded: pass.degraded } : {}),
    }
    pushTransition(
      st.entries[id],
      'absent',
      pass.status,
      pass.approved ? 'user' : 'learn',
      pass.approved ? `approved in chat card (tier=${pass.tier} key=${pass.key})` : `tier=${pass.tier} key=${pass.key}`,
      now.getTime(),
    )
    if (pass.pendingReason) st.entries[id].pendingReason = pass.pendingReason

    // ── ③ 索引（enabled=true：自动记忆学完就生效，否则等于没学） ──
    index.rules[id] = {
      ...(index.rules[id] ?? {}),
      order: index.rules[id]?.order ?? 1000,
      enabled: true,
      updatedAt: nowIso,
    }
    await writeIndex(indexDir, index)

    // ── ④ 取代旧的同 key 条目 ──
    const superseded: string[] = []
    for (const oldId of pass.supersedes) {
      const ok = await markSuperseded(oldId, id, st, nowIso, index)
      if (ok) superseded.push(oldId)
    }
    if (superseded.length > 0) await writeIndex(indexDir, index)

    // 卡片批准是用户动作：本会话的自动段要立刻重建（学习写入不加版本号，
    // 因为新学的条目靠对话上下文本身；批准不同，用户期待它马上生效）。
    if (pass.status === 'active') bumpRevision(st)

    // ── ⑤ state 落盘（放在前四步之后：正文与索引都在了，状态最后写才不会被"有状态无文件"毁掉） ──
    const written = await state.write(st)
    if (!written.ok) {
      // 正文已落盘、索引已启用，只是状态没写成。不撤文件（撤了等于这次学习消失），
      // 但要如实报：下次读 state 失败时会重试，而条目会先按 candidate 出现在界面里。
      return {
        ok: false,
        code: 'state-write-failed',
        error: `${written.error}（正文已保存为 ${id}，状态未记上；下次写入会重试）`,
        gate: 'evidence',
      }
    }

    // ── ⑥ catalog（派生数据：失败可忽略，下次重建会补） ──
    await touchCatalog(id, pass, name, req, nowIso).catch(() => {})

    deps.invalidateSnapshot()
    // 日志里不落 `key` 原文：`deriveKey` 取的是正文前三个词，于是这个字段经常就是用户原话的
    // 开头（「ouli 明确要求把自主记忆的全部功能各测试一遍」）。排障要的是「两次写的是不是同一个
    // slot」，哈希足够；原文只在记忆库里，不该在排障日志里再留一份。
    await appendLearnLog(learnLogRowOf({ at: nowIso, id, layer: pass.layer, status: pass.status, tier: pass.tier, key: pass.key, session: env.sessionId ?? '' })).catch(() => {})

    return {
      ok: true,
      id,
      layer: pass.layer,
      status: pass.status,
      tier: tierOf(st.entries[id].evidence),
      merged: false,
      supersedes: superseded,
      // 门禁最终判定的类型（模型给了就用它，否则 `inferKind` 兜底）。回执要回显。
      kind: pass.kind,
      approved: pass.approved,
      ...(pass.autoActive ? { autoActive: true } : {}),
      ...(pass.note !== undefined ? { note: pass.note } : {}),
      ...(pass.pendingReason !== undefined ? { pendingReason: pass.pendingReason } : {}),
      ...(pass.reviewCode !== undefined ? { reviewCode: pass.reviewCode } : {}),
    }
  }

  /** 合并进已有条目：追加证据与边界，正文不动（正文替换会丢掉用户可能已经熟悉的措辞）。 */
  async function mergeInto(
    pass: Extract<GateOutcome, { ok: true }>,
    targetId: string,
    st: EvolutionState,
    nowIso: string,
    env: LearnEnv,
    req: LearnRequest,
  ): Promise<LearnResult | null> {
    const slash = targetId.lastIndexOf('/')
    if (slash <= 0) return null
    const group = targetId.slice(0, slash)
    const name = targetId.slice(slash + 1)
    const docPath = join(notesRoot, group, name + '.md')
    let existing: string
    try {
      existing = await readFile(docPath, 'utf8')
    } catch {
      return null
    }
    const entry = st.entries[targetId] ?? { evidence: [], counters: emptyCounters(), transitions: [] }
    const locked = entry.locked === true
    // 用户锁定过（UI 编辑过）→ 只能提议，不能改。这一条比"追加边界"重要。
    if (locked) {
      return {
        ok: false,
        code: 'locked',
        error: `not recorded: the matching note "${targetId}" was edited by the user and is locked. Ask them whether to update it.`,
        gate: 'conflict',
      }
    }
    // 新说法与旧正文不同 → 记进 `auto_alias`（「同样这件事还说成过什么」）。
    // 不塞 `auto_boundary`：那个字段回答「什么时候不成立」，混进一列说法后，用户读到的
    // 边界既判断不了适用条件，也认不出哪句是限制。
    const extra = String(pass.text ?? '').trim()
    const alreadyKnown = normalizeForCompare(existing).includes(normalizeForCompare(extra).slice(0, 24))
    const prevAlias = pickField(existing, 'auto_alias')
    const nextAlias = alreadyKnown ? prevAlias : dedupeAlias(prevAlias, extra)
    // slot：调用方**显式给了**才跟着改，否则保留目标自己的。
    //
    // 合并可能由相似度跨 key 触发，此时 `pass.key` 往往是 `deriveKey(正文)` 拼出来的词 ——
    // 拿它覆盖会把用户认得的稳定句柄换掉，之后按原 slot 忘掉这条就找不到了。
    // 而显式 slot 是模型给的稳定句柄：它这次用的是新名字，就该让这条跟着新名字，
    // 否则按新 slot 忘不掉（文件与 catalog 必须同源，重建才不会漂回去）。
    const prevKey = pickField(existing, 'auto_key')
    const explicitKey = String(req.key ?? '').trim()
    const nextKey = explicitKey !== '' ? explicitKey : prevKey !== '' ? prevKey : pass.key
    // 合并默认保留目标条目自己的状态：重新学到一条已经确认过的记忆，不该把它打回候选；
    // 反过来，合并进候选也不该凭空生效。卡片批准是例外：用户看过新说法并点了同意，
    // 合并后的这条就该生效（否则「批准了却还是候选」又是一次静默失效）。
    const current = pickField(existing, 'auto_status') || 'candidate'
    const nextStatus = (pass.approved || pass.autoActive) ? 'active' : current
    // 旧条目可能还没有名称：合并时顺手补上，之后列表与注入行都能用。
    const prevTitle = pickField(existing, 'auto_title')
    const nextTitle = prevTitle !== '' ? prevTitle : titleOf(req.title)
    // 新的边界要能写进去：合并说的是「同一件事，换个说法」，而边界是这件事的**例外条件** ——
    // 丢掉它，注入行就不再说明"什么时候不成立"，用户批准时看到的与落盘的不同。
    // 只有新调用方真的给了边界才覆盖；没给时保留旧值（旧值可能比新的更完整）。
    const prevBoundary = pickField(existing, 'auto_boundary')
    const reqBoundary = String(req.boundary ?? '').trim()
    const nextBoundary = reqBoundary !== '' ? reqBoundary : prevBoundary
    // `kind` 跟着合并走：它决定保质期（`ttlDaysOf`），而第一次学错会永久固化 ——
    // 早先这里只改状态与正文相关的字段，`auto_kind` / `auto_ttl_days` 停在第一次的值，
    // 于是「一条做法被误判成 correction（3650 天）」之后无论再合并多少次都改不回来。
    //
    // 只在**真的变了**时改写：`kind` 未变时不动 TTL，用户的显式 `ttlDays` 才不会被覆盖。
    // 显式 ttl 仍以本次调用为准（`req.ttlDays` 给了就用它，与新建路径同一口径）。
    const prevKind = pickField(existing, 'auto_kind')
    const nextKind = pass.kind
    const kindChanged = nextKind !== prevKind
    const prevTtl = pickField(existing, 'auto_ttl_days')
    const nextTtl = kindChanged ? String(ttlDaysOf(nextKind, req.ttlDays)) : prevTtl
    const ttlChanged = nextTtl !== '' && nextTtl !== prevTtl
    const merged = rewriteFrontmatterFields(
      existing,
      {
        auto_status: nextStatus,
        auto_updated: nowIso,
        ...(nextTitle !== prevTitle ? { auto_title: nextTitle } : {}),
        ...(nextKey !== prevKey ? { auto_key: nextKey } : {}),
        ...(nextAlias !== prevAlias ? { auto_alias: nextAlias } : {}),
        ...(nextBoundary !== prevBoundary ? { auto_boundary: nextBoundary === '' ? null : nextBoundary } : {}),
        ...(kindChanged ? { auto_kind: nextKind } : {}),
        ...(ttlChanged ? { auto_ttl_days: nextTtl } : {}),
        // `auto_confidence` 已经没有任何读取方（排序改用证据档位）。它原本只在
        // `setStatus` 里清 —— 可候选条目长期不经过那条路径，于是旧字段一直留在文件里。
        // 合并是另一条常见写路径，一并清掉。
        auto_confidence: null,
      },
    )
    await writeFileAtomically(docPath, merged)

    const evidence = collectEvidence(pass, env, {} as LearnRequest, nowIso)
    entry.evidence = [...entry.evidence, ...evidence].slice(-50)
    entry.counters = entry.counters ?? emptyCounters()
    // 批准与自动确认都算「这条被确认过」：前者用户看过原文，后者由用户授权 agent 判断。
    // 两条都必须升级证据 —— 只改状态不升级，界面显示生效而档位仍停在推断，
    // 排序会把它排到最后，预算紧张时先被让位。
    if (pass.approved || pass.autoActive) activateEvidence(entry, existing, nowIso)
    pushTransition(
      entry,
      current,
      nextStatus,
      pass.approved ? 'user' : 'learn',
      pass.approved ? 'merge: approved in chat card' : pass.autoActive ? 'merge: auto-active (workspace + strong evidence)' : 'merge: same key, new evidence',
      Date.parse(nowIso),
    )
    st.entries[targetId] = entry

    // 批准时可能还带着要取代的旧条目（跨层同 key / 相似说法）。合并目标自己不在其中，
    // 但其余旧条目必须一起让位 —— 否则批准后两条矛盾的事实会同时注入。
    const superseded: string[] = []
    if (pass.approved && pass.supersedes.length > 0) {
      const index = await readIndex(indexDir)
      for (const oldId of pass.supersedes) {
        if (oldId === targetId) continue
        const ok = await markSuperseded(oldId, targetId, st, nowIso, index)
        if (ok) superseded.push(oldId)
      }
      if (superseded.length > 0) await writeIndex(indexDir, index)
    }
    if ((pass.approved || pass.autoActive) && nextStatus === 'active') bumpRevision(st)

    const written = await state.write(st)
    if (!written.ok) return { ok: false, code: 'state-write-failed', error: written.error }

    // slot 传 `nextKey`：catalog 的 `key` 是 `memory_note` 反查 slot 的依据，写 `pass.key`
    // 会与文件里的 `auto_key` 分家 —— 下次全量重建又漂回去，期间按 slot 找不到这条。
    await touchCatalog(targetId, pass, name, req, nowIso, nextStatus, nextKey).catch(() => {})
    deps.invalidateSnapshot()
    return {
      ok: true,
      id: targetId,
      layer: pass.layer,
      status: nextStatus as 'active' | 'candidate',
      tier: tierOf(entry.evidence),
      merged: true,
      supersedes: superseded,
      approved: pass.approved,
      // 合并后的类型是 `nextKind`（可能被这次调用改过），不是目标原来的那个。
      kind: nextKind,
      ...(pass.autoActive ? { autoActive: true } : {}),
      note: alreadyKnown ? '已存在同样的说法，只新增了一条证据' : '同一条记忆，把新说法记成了别名',
      ...(pass.reviewCode !== undefined ? { reviewCode: pass.reviewCode } : {}),
    }
  }

  /** 旧条目改 `auto_status: superseded`。失败只记日志 —— 新条目已经生效，旧的留着也只是多一行。 */
  async function markSuperseded(
    oldId: string,
    newId: string,
    st: EvolutionState,
    nowIso: string,
    index: any,
  ): Promise<boolean> {
    const slash = oldId.lastIndexOf('/')
    if (slash <= 0) return false
    const group = oldId.slice(0, slash)
    const name = oldId.slice(slash + 1)
    const docPath = join(notesRoot, group, name + '.md')
    try {
      const text = await readFile(docPath, 'utf8')
      await writeFileAtomically(
        docPath,
        rewriteFrontmatterFields(text, { auto_status: 'superseded', auto_superseded_by: newId, auto_updated: nowIso }),
      )
    } catch {
      return false
    }
    // 注入不再选它（`auto_status` 已变），但仍要在索引里停用：那一道是给"手改了正文但没改状态"
    // 的兜底，两处都写才不会被单点绕过。
    if (index.rules[oldId]) index.rules[oldId] = { ...index.rules[oldId], enabled: false, updatedAt: nowIso }
    const entry = st.entries[oldId]
    if (entry) {
      pushTransition(entry, entry.transitions.at(-1)?.to ?? 'active', 'superseded', 'learn', `superseded by ${newId}`, Date.parse(nowIso))
    }
    await demoteCatalog(oldId, 'superseded')
    return true
  }

  /**
   * 更新 catalog 的单条卡片（派生数据，失败不影响真相）。
   *
   * `keyOverride`：合并路径要传目标文件里那个 `auto_key`。catalog 的 `key` 与 frontmatter
   * 必须同源 —— 分家之后，界面按 slot 找到的是旧值，而重建一次又漂回来。
   */
  async function touchCatalog(
    id: string,
    pass: Extract<GateOutcome, { ok: true }>,
    name: string,
    req: LearnRequest,
    nowIso: string,
    statusOverride?: string,
    keyOverride?: string,
    boundaryOverride?: string,
  ): Promise<void> {
    const abs = catalogPathOf(deps.stateDir)
    let catalog: CatalogFile
    try {
      const raw = JSON.parse(await readFile(abs, 'utf8'))
      catalog = normalizeCatalog(raw)
    } catch {
      catalog = normalizeCatalog(null)
    }
    const prev = catalog.entries[id]
    // 合并路径保留原来的正文与标题；新建时用本次请求的正文（含边界行，与落盘同源）。
    // `oneLine` 只是列表摘要，注入用的是 `body`。
    const body = prev?.body ?? renderBody(pass.text, boundaryOverride ?? req.boundary)
    const title = prev?.title || titleOf(req.title)
    // 边界：编辑路径显式给（正文里的边界行变了）；否则取本次请求给的；都没给才沿用旧值。
    //
    // 顺序不能反。早先是 `prev?.boundary` 优先，于是合并时**新边界永远进不了 catalog** ——
    // 文件里写了、注入行与列表却还读旧的那句，界面与落盘分家。
    const requestedBoundary = String(req.boundary ?? '').trim().slice(0, MAX_BOUNDARY)
    const boundary = boundaryOverride ?? (requestedBoundary !== '' ? requestedBoundary : (prev?.boundary ?? ''))
    catalog.entries[id] = catalogEntryOf(id, pass.layer, {
      body,
      oneLine: prev?.oneLine ?? oneLineOf(pass.text),
      ...(title !== '' ? { title } : {}),
      ...(boundary !== '' ? { boundary } : {}),
      status: statusOverride ?? pass.status,
      kind: pass.kind,
      key: keyOverride ?? pass.key,
      enabled: true,
      hash: prev?.hash || textHashOf(pass.text),
      mtime: Date.parse(nowIso),
    })
    catalog.builtAt = nowIso
    await mkdir(join(deps.stateDir, 'evolution'), { recursive: true })
    await writeFileAtomically(abs, JSON.stringify(catalog, null, 2) + '\n', { mode: 0o600 })
  }

  /**
   * 派生数据：改一条卡片的局部字段。
   *
   * 为什么 forget / supersede / approve 必须自己改 catalog：注入只读 catalog，而这几条路径
   * 都不经过记忆域的写漏斗（`refresh()` 才会重建索引）。忘了却不改卡片 = **下一轮还在注入它**，
   * 用户删了个寂寞，还看不出为什么。
   */
  async function patchCatalogEntry(id: string, patch: Partial<{
    status: string; enabled: boolean; title: string; boundary: string; kind: AutoKind
    body: string; oneLine: string; bytes: number; estTokens: number; hash: string; mtime: number; size: number
  }>): Promise<void> {
    try {
      const abs = catalogPathOf(deps.stateDir)
      const catalog = normalizeCatalog(JSON.parse(await readFile(abs, 'utf8')))
      const hit = catalog.entries[id]
      if (!hit) return
      const next = { ...hit, ...patch }
      // 空标题 = 删掉这个键（normalizeCatalog 也只在有值时保留），别留一个空串。
      if (patch.title !== undefined) {
        if (patch.title === '') delete next.title
        else next.title = patch.title
      }
      // 边界同理：用户把正文里的边界行删了，这里要跟着消失，否则注入会继续显示旧条件。
      if (patch.boundary !== undefined) {
        if (patch.boundary === '') delete next.boundary
        else next.boundary = patch.boundary
      }
      catalog.entries[id] = next
      catalog.builtAt = new Date().toISOString()
      await writeFileAtomically(abs, JSON.stringify(catalog, null, 2) + '\n', { mode: 0o600 })
    } catch {
      /* 派生数据：改不动就等下一次全量重建校正（服务写路径会重建） */
    }
  }

  const demoteCatalog = (id: string, status: 'archived' | 'superseded'): Promise<void> =>
    patchCatalogEntry(id, { status, enabled: false })

  /** 派生数据：从 catalog 里删掉一条（提升为用户记忆后，它不再归自动段管）。 */
  async function dropCatalogEntry(id: string): Promise<void> {
    try {
      const abs = catalogPathOf(deps.stateDir)
      const catalog = normalizeCatalog(JSON.parse(await readFile(abs, 'utf8')))
      if (!catalog.entries[id]) return
      delete catalog.entries[id]
      catalog.builtAt = new Date().toISOString()
      await writeFileAtomically(abs, JSON.stringify(catalog, null, 2) + '\n', { mode: 0o600 })
    } catch {
      /* 派生数据：下次全量重建会把它清掉（用户记忆不进 catalog） */
    }
  }

  /** 忘掉一条：正文进回收站，状态转 archived，写墓碑。 */
  async function forget(
    id: string,
    opts: { actor?: string; remove?: (id: string) => Promise<boolean> } = {},
  ): Promise<LearnResult | { ok: true; id: string; layer: MemoryLayer; status: 'archived'; tier: EvidenceTier; merged: false; supersedes: string[] }> {
    return deps.withWriteLock(async () => {
      const read = await state.readFresh()
      if (!read.ok) return { ok: false, code: 'state-unreadable', error: read.error }
      const st = read.state
      const slash = id.lastIndexOf('/')
      if (slash <= 0) return { ok: false, code: 'bad-id', error: `not a memory id: ${id}` }
      const group = id.slice(0, slash)
      const name = id.slice(slash + 1)
      const layer = layerOfGroup(group)
      const entry = st.entries[id]
      const docPath = join(notesRoot, group, name + '.md')
      const raw = await safeRead(docPath)
      // 不存在的条目不能返回成功：那会写一条空墓碑、删一条不存在的 state，用户以为忘了、
      // 实际什么都没发生。工具层据此改按 key 反查。
      if (entry === undefined && raw === '') {
        return { ok: false, code: 'not-found', error: `no such learned note: ${id}` }
      }
      const key = pickField(raw, 'auto_key')
      // 墓碑的哈希与原文**只取正文**，不含 frontmatter。
      //
      // 早先这里用整份 `.md` 文件：哈希的是「frontmatter + 正文」，而 `text.slice(0, 400)`
      // 存下的前 400 字符几乎全是 frontmatter。拦截时传进来的是新笔记的纯正文 ——
      // 哈希永不相等，相似度又被 frontmatter 碎片稀释到远低于阈值，于是「换个说法也拦得住」
      // 这条防线整条失效，只剩同 key 那一条在起作用。`promote` 一直用的是正文，这里对齐。
      const body = normalizeForCompare(bodyOf(raw))

      // 先把正文标成 archived，再交给回收站。
      //
      // 为什么非改文件不可：注入只读 catalog，但 catalog 会被**全量重建**（启动 / 任何记忆写
      // 之后），而重建读的是 frontmatter。文件里还写着 `auto_status: active` 的话，删掉的那条
      // 会在下一次重建时原样复活 —— 用户会看到"删了又回来了"，且中间没有任何提示。
      // 顺序也重要：先改后搬，搬走了就再也改不到了。
      if (raw !== '') {
        await writeFileAtomically(
          docPath,
          rewriteFrontmatterFields(raw, { auto_status: 'archived', auto_updated: new Date().toISOString() }),
        ).catch(() => {})
      }

      // 正文进回收站由调用方给（记忆域已有的 `rules-remove` 那条路，它自己会把文件放进
      // 回收站）；给不了就只标状态、文件留着 —— 少删一次好过悄悄真删。
      // 参数名必须与 `EvolutionOpDeps.learner.forget` 一致：叫 `trash` 而调用方传 `remove`
      // 时，严格结构类型**不会报错**（参数双变），症状是"忘了但文件还在"，没有任何提示。
      if (opts.remove) await opts.remove(id).catch(() => false)

      // 墓碑：key、文本指纹与原文都写。原文是给相似度拦截用的 —— 用户删的是
      // 「以后都用 pnpm」，模型换个说法写「包管理器统一 pnpm」时，精确哈希拦不住。
      const tomb = textHashOf(body)
      if (key !== '' || tomb !== '') {
        // 同一个 key 反复删会堆出多条墓碑，而查询侧 `tombstonedBy` 用 `find()` 只认第一条 ——
        // 后面的纯占空间。删之前先把同 key 的旧墓碑清掉，让这张表按 key 唯一。
        if (key !== '') st.tombstones = st.tombstones.filter((t) => t.key !== key)
        st.tombstones.push({
          key,
          textHash: tomb,
          text: body.slice(0, 400),
          at: new Date().toISOString(),
          until: new Date(Date.now() + 30 * 86400_000).toISOString(),
          actor: opts.actor ?? 'model',
        })
      }
      if (entry) pushTransition(entry, entry.transitions.at(-1)?.to ?? 'active', 'archived', 'learn', 'forgotten by user', Date.now())
      else st.entries[id] = { evidence: [], counters: emptyCounters(), transitions: [] }
      delete st.entries[id]
      bumpRevision(st)

      const written = await state.write(st)
      if (!written.ok) return { ok: false, code: 'state-write-failed', error: written.error }
      const index = await readIndex(indexDir)
      if (index.rules[id]) {
        index.rules[id] = { ...index.rules[id], enabled: false, updatedAt: new Date().toISOString() }
        await writeIndex(indexDir, index)
      }
      await demoteCatalog(id, 'archived')
      deps.invalidateSnapshot()
      return { ok: true, id, layer, status: 'archived' as const, tier: 'inferred' as const, merged: false as const, supersedes: [] }
    })
  }

  /**
   * 把一条候选升级为「用户确认过」的证据。
   *
   * 所有激活路径（页面确认、从归档恢复）都必须走这里：只改 `auto_status` 不动证据，
   * 会留下「界面显示生效、注入不选」的静默失效；只清 `pendingReason` 不升级证据，
   * 会停在推断档。这里同时做两件事：升级证据、清待确认理由。
   */
  function activateEvidence(entry: EntryState, text: string, nowIso: string): void {
    entry.evidence = entry.evidence.map((e) => e.source === 'model_inference' ? { ...e, source: 'user_approved' } : e)
    const hasUserEvidence = entry.evidence.some((e) =>
      e.source === 'user_approved' || e.source === 'user_explicit' || e.source === 'user_correction')
    if (!hasUserEvidence) {
      // 迁移条目 / 证据被清过：确认本身就是一份用户证据，补一条，别让它停在最弱档。
      entry.evidence.push({
        session: '', turn: 0, seq: -1, source: 'user_approved',
        quote: normalizeForCompare(text).slice(0, 300), at: nowIso,
      })
    }
    delete entry.pendingReason
    entry.counters = entry.counters ?? emptyCounters()
  }

  /**
   * 用户确认一条候选 → active。
   *
   * 为什么需要这条：候选**不注入**，而九道门的设计是"模糊就降级"，于是候选一定会积累
   * （歧义表述、模型推断、程序化记忆全进候选）。没有这条，用户唯一的出路是删掉或者让模型
   * 再说一遍 —— 前者浪费证据，后者会撞上配额与冲突门。
   *
   * 已 superseded / archived 的不许确认：那不是"待确认"，是历史。给它们复活等于绕过墓碑。
   */
  async function approve(id: string): Promise<LearnResult> {
    return deps.withWriteLock(async () => {
      const read = await state.readFresh()
      if (!read.ok) return { ok: false, code: 'state-unreadable', error: read.error }
      const st = read.state
      const slash = id.lastIndexOf('/')
      if (slash <= 0) return { ok: false, code: 'bad-id', error: `not a memory id: ${id}` }
      const group = id.slice(0, slash)
      const name = id.slice(slash + 1)
      const docPath = join(notesRoot, group, name + '.md')
      let text: string
      try {
        text = await readFile(docPath, 'utf8')
      } catch {
        return { ok: false, code: 'missing', error: `not found: ${id}` }
      }
      const current = pickField(text, 'auto_status') || 'candidate'
      if (current === 'superseded' || current === 'archived') {
        return { ok: false, code: 'not-pending', error: `refused: "${id}" is ${current} — only candidates can be approved.` }
      }
      const nowIso = new Date().toISOString()
      await writeFileAtomically(docPath, rewriteFrontmatterFields(text, { auto_status: 'active', auto_updated: nowIso }))

      const entry = st.entries[id] ?? { evidence: [], counters: emptyCounters(), transitions: [] }
      // 证据升级：用户在页面上确认的是**这条原文**，推断证据随之升为 user_approved。
      // 只升状态不动证据会留下静默失效：界面显示"生效"，注入却选不中它。
      activateEvidence(entry, text, nowIso)
      pushTransition(entry, current, 'active', 'user', 'approved in Memory page', Date.parse(nowIso))
      st.entries[id] = entry

      const index = await readIndex(indexDir)
      index.rules[id] = { ...(index.rules[id] ?? { order: 1000 }), enabled: true, updatedAt: nowIso }
      // 同 key 的旧生效条目：用户确认新说法后，旧的让位 —— 否则两条互相矛盾的事实
      // 会同时注入。候选不在这里处理（gates 已经直接取代候选）。
      const activatedKey = pickField(text, 'auto_key')
      if (activatedKey !== '') {
        const approvedLayer = layerOfGroup(group)
        const approvedWorkspace = group.startsWith('_ws/') ? group.slice('_ws/'.length) : ''
        const approvedSession = group.startsWith('_session/') ? group.slice('_session/'.length) : ''
        try {
          const { entries } = await deps.existingEntries()
          for (const e of entries) {
            if (e.id === id || e.origin !== 'auto' || e.key !== activatedKey) continue
            // 同层还要同作用域：别的仓库 / 会话 / 场景的同 slot 笔记不能被这次确认带走。
            if (e.layer !== approvedLayer) continue
            if (approvedLayer === LAYER_WORKSPACE && e.workspace !== approvedWorkspace) continue
            if (approvedLayer === LAYER_SESSION && e.session !== approvedSession) continue
            if (approvedLayer === LAYER_SCENE && e.scene !== undefined && e.scene !== group && e.scene !== SHARED_GROUP) continue
            if (e.status !== 'active' && e.status !== 'core' && e.status !== 'playbook') continue
            await markSuperseded(e.id, id, st, nowIso, index)
          }
        } catch {
          /* 快照读不到就只确认这一条；旧的仍可由用户手动停用 */
        }
      }
      await writeIndex(indexDir, index)
      bumpRevision(st)
      const written = await state.write(st)
      if (!written.ok) return { ok: false, code: 'state-write-failed', error: written.error }
      await patchCatalogEntry(id, { status: 'active', enabled: true })
      deps.invalidateSnapshot()
      return {
        ok: true,
        id,
        layer: layerOfGroup(group),
        status: 'active',
        tier: tierOf(entry.evidence),
        merged: false,
        supersedes: [],
      }
    })
  }

  /**
   * 改状态：停用 / 恢复 / 降为候选。
   *
   * 停用 = `archived`（文件留着、不写墓碑、可恢复）；它与 `forget` 的区别是"不想再看到"
   * 还是"不想再存在"。恢复只对 `archived` 开放：`superseded` 是被新事实取代的历史，
   * 复活它会让新旧两条同时注入，模型看到矛盾的两句话然后随机选一句。
   *
   * `candidate` 是维护扫描（TTL 到期）用的"降级但保留"：候选不进注入，用户还能在
   * 「待确认」里看到它 —— 直接归档等于替用户决定"过期的事实永远不要了"。
   *
   * 旧数据里的 `core` / `playbook` 仍按可注入状态读取（见 catalog 的 isInjectableStatus），
   * 但已经没有任何路径会把条目提升到这两档。
   */
  async function setStatus(
    id: string,
    status: 'active' | 'archived' | 'candidate',
    actor: 'user' | 'curator' | 'sweep' = 'user',
    opts: { reason?: string; pendingReason?: string | null; reviewDue?: string | null } = {},
  ): Promise<LearnResult | { ok: true; id: string; layer: MemoryLayer; status: 'active' | 'archived' | 'candidate'; tier: EvidenceTier; unchanged?: boolean }> {
    return deps.withWriteLock(async () => {
      const read = await state.readFresh()
      if (!read.ok) return { ok: false, code: 'state-unreadable', error: read.error }
      const st = read.state
      const split = splitId(id)
      if (!split) return { ok: false, code: 'bad-id', error: `not a memory id: ${id}` }
      const { group, name, layer } = split
      const docPath = join(notesRoot, group, name + '.md')
      let text: string
      try {
        text = await readFile(docPath, 'utf8')
      } catch {
        // 停用的条目正文仍在原地（回收站里是副本），所以「文件不在」只可能是：
        // 旧版把正文搬走了，或用户手删了。恢复时先试回收站副本，让维护扫描的
        // 「工作区目录回来 → 恢复记忆」不会因为文件位置变化而失效。
        if (status === 'active') {
          const trashId = await findAutoTrashByNoteId(deps.stateDir, id)
          if (trashId !== null) {
            const restored = await restoreAutoNoteFromTrash(notesRoot, deps.stateDir, trashId)
            if (!restored.ok) return { ok: false, code: restored.code, error: restored.error }
            try {
              text = await readFile(docPath, 'utf8')
            } catch {
              return { ok: false, code: 'missing', error: `not found: ${id}` }
            }
          } else {
            return { ok: false, code: 'missing', error: `not found: ${id}` }
          }
        } else {
          return { ok: false, code: 'missing', error: `not found: ${id}` }
        }
      }
      const current = pickField(text, 'auto_status') || 'active'
      if (current === 'superseded') {
        return { ok: false, code: 'superseded', error: `refused: "${id}" was replaced by a newer memory; restoring it would inject two conflicting facts.` }
      }
      // 降级只给维护扫描：用户点「停用」想的是"别再注入"，归档比候选更符合那个意思，
      // 而且候选会在界面上继续出现（用户刚收起来的东西又冒出来，很像 bug）。
      if (status === 'candidate' && actor !== 'sweep') {
        return { ok: false, code: 'refused', error: 'only the maintenance sweep can demote an entry to candidate' }
      }
      const entry = st.entries[id] ?? { evidence: [], counters: emptyCounters(), transitions: [] }
      const nowIso = new Date().toISOString()
      // 任何回到可注入状态的路径都走同一套证据升级：从「已归档」恢复、从候选恢复都一样。
      const activating = status === 'active'
      if (activating) activateEvidence(entry, text, nowIso)
      if (current === status) {
        // 状态没变也要应用标记补丁：TTL 扫描重复跑时，第一次已经挂上、第二次只补标记。
        // 激活同理：旧数据可能 active 但证据仍是推断档，这里补一次升级。
        let changed = activating
        if (opts.pendingReason !== undefined) {
          if (opts.pendingReason === null) delete entry.pendingReason
          else entry.pendingReason = opts.pendingReason
          changed = true
        }
        if (opts.reviewDue !== undefined) {
          if (opts.reviewDue === null) delete entry.reviewDue
          else entry.reviewDue = opts.reviewDue
          changed = true
        }
        if (changed) {
          st.entries[id] = entry
          bumpRevision(st)
          const w = await state.write(st)
          if (!w.ok) return { ok: false, code: 'state-write-failed', error: w.error }
          // 从回收站还原时正文是新写回来的，旧索引还记着 enabled:false；不补这一笔，
          // 下一次 catalog 重建会按索引把条目重新排除，界面显示生效、注入里却没有。
          const index = await readIndex(indexDir)
          index.rules[id] = { ...(index.rules[id] ?? { order: 1000 }), enabled: status !== 'archived', updatedAt: nowIso }
          await writeIndex(indexDir, index)
          await patchCatalogEntry(id, { status, enabled: status !== 'archived' })
          deps.invalidateSnapshot()
        }
        // 旧版本停用的条目没有回收站副本：这里补一份，让它们也能在统一回收站里恢复。
        if (status === 'archived') await archiveAutoNote(notesRoot, deps.stateDir, id, layer)
        // 恢复时回收站副本的使命结束；状态已经是 active 说明它只是写盘失败留下的孤儿，
        // 删掉副本，别让用户再点一次「恢复」却发现什么都没发生。
        else if (status === 'active') {
          const trashId = await findAutoTrashByNoteId(deps.stateDir, id)
          if (trashId !== null) await dropAutoTrashEntry(deps.stateDir, trashId)
        }
        return { ok: true, id, layer, status, tier: tierOf(entry.evidence), unchanged: true }
      }
      // 停用先复制进统一回收站；复制失败就拒绝这次状态变更，别留下「已归档但回收站里没有」
      // 的半截状态。正文仍在原地（archived），维护扫描的按 id 恢复不受影响。
      if (status === 'archived') {
        const trashId = await archiveAutoNote(notesRoot, deps.stateDir, id, layer)
        if (trashId === null) {
          return { ok: false, code: 'trash-failed', error: 'could not copy this note into the recycle bin; nothing was changed' }
        }
      }
      // `auto_confidence: null` 顺手清掉旧版的置信度键：它已经没有任何读取方（排序改用
      // 证据档位），但 `rewriteFrontmatterFields` 会逐字保留未知键 —— 不显式删掉，它会跟着
      // 这条笔记一直到用户手改为止。合并路径（`mergeInto`）里也清同一份，两条写路径合起来
      // 覆盖绝大多数改写；从不改写的条目（比如一直没人碰的旧 superseded）会留着这行，
      // 但它不注入也不参与任何判据，为此让维护扫描去改文件正文不划算。
      await writeFileAtomically(docPath, rewriteFrontmatterFields(text, { auto_status: status, auto_updated: nowIso, auto_confidence: null }))
      pushTransition(
        entry,
        current,
        status,
        actor,
        opts.reason ?? (status === 'archived' ? 'disabled in Memory page' : status === 'candidate' ? 'demoted to candidate' : 'restored in Memory page'),
        Date.parse(nowIso),
      )
      if (opts.pendingReason === null) delete entry.pendingReason
      else if (opts.pendingReason !== undefined) entry.pendingReason = opts.pendingReason
      if (opts.reviewDue === null) delete entry.reviewDue
      else if (opts.reviewDue !== undefined) entry.reviewDue = opts.reviewDue
      st.entries[id] = entry
      bumpRevision(st)
      const written = await state.write(st)
      if (!written.ok) return { ok: false, code: 'state-write-failed', error: written.error }

      const index = await readIndex(indexDir)
      index.rules[id] = { ...(index.rules[id] ?? { order: 1000 }), enabled: status !== 'archived', updatedAt: nowIso }
      await writeIndex(indexDir, index)
      await patchCatalogEntry(id, { status, enabled: status !== 'archived' })
      // 恢复成功 = 回收站里那份副本完成了使命；不删会在回收站里留下一条「已恢复」的幽灵。
      if (status === 'active') {
        const trashId = await findAutoTrashByNoteId(deps.stateDir, id)
        if (trashId !== null) await dropAutoTrashEntry(deps.stateDir, trashId)
      }
      deps.invalidateSnapshot()
      return { ok: true, id, layer, status, tier: tierOf(entry.evidence) }
    })
  }

  /**
   * 提升为用户记忆：去掉 `auto_*`，`origin` 改 `user`，从自动索引里移出。
   *
   * 为什么值得做：自动记忆的层是"看得见的范围"（这个工作区 / 这个场景），而用户记忆是
   * "我认下的规则"。一条被反复验证有用的自动记忆，用户会希望它跟着自己换项目也在。
   * 提升不是复制：留在原地会变成两份（一份自动、一份手写），改一份另一份不变。
   */
  async function promote(id: string, opts: { actor?: 'user' | 'curator' } = {}): Promise<LearnResult | { ok: true; id: string; layer: MemoryLayer; status: 'active'; tier: EvidenceTier; promoted: true }> {
    return deps.withWriteLock(async () => {
      const read = await state.readFresh()
      if (!read.ok) return { ok: false, code: 'state-unreadable', error: read.error }
      const st = read.state
      const split = splitId(id)
      if (!split) return { ok: false, code: 'bad-id', error: `not a memory id: ${id}` }
      const { group, name, layer } = split
      const docPath = join(notesRoot, group, name + '.md')
      let text: string
      try {
        text = await readFile(docPath, 'utf8')
      } catch {
        return { ok: false, code: 'missing', error: `not found: ${id}` }
      }
      const current = pickField(text, 'auto_status') || 'active'
      if (current === 'superseded') {
        return { ok: false, code: 'superseded', error: `refused: "${id}" was replaced by a newer memory.` }
      }
      if (current === 'archived') {
        return { ok: false, code: 'archived', error: `refused: "${id}" is turned off — restore it first if you want to keep it.` }
      }
      const nowIso = new Date().toISOString()
      // 字段逐个置 null（= 删掉），不是整块重写：正文里可能有用户手改过的措辞，
      // 只动 frontmatter 才保得住。
      const stripped = rewriteFrontmatterFields(text, {
        origin: 'user',
        auto_title: null, auto_status: null, auto_kind: null, auto_key: null,
        auto_basis: null, auto_boundary: null, auto_alias: null, auto_degraded: null, auto_superseded_by: null,
        auto_workspace: null, auto_scene: null, auto_ttl_days: null,
        auto_created: null, auto_updated: null,
      })
      // 自主库与用户记忆是**两个目录**：只在原地改 origin 会让它既不进自动 catalog、
      // 也不在用户记忆段里 —— 症状是"点了提升，这条凭空消失"。所以正文搬进用户的全局场景。
      const destDir = join(deps.memoriesRoot, GLOBAL_SCENE)
      await mkdir(destDir, { recursive: true })
      let destName = name
      for (let i = 2; await exists(join(destDir, destName + '.md')) && i <= 20; i++) destName = `${name}-${i}`
      const userId = `${GLOBAL_SCENE}/${destName}`
      await writeFileAtomically(join(destDir, destName + '.md'), stripped)
      // 原件移进自主回收站（可找回），不留在原地变成幽灵。
      await trashAutoNote(notesRoot, deps.stateDir, id).catch(() => undefined)
      const userIndex = await readIndex(deps.stateDir)
      userIndex.rules[userId] = { ...(userIndex.rules[userId] ?? { order: 1000 }), enabled: true, updatedAt: nowIso }
      await writeIndex(deps.stateDir, userIndex)
      const autoIndex = await readIndex(indexDir)
      delete autoIndex.rules[id]
      await writeIndex(indexDir, autoIndex)
      // 提升后这条内容已经以用户记忆的身份存在，自动路径不该再学一份 —— 写墓碑拦住。
      const promotedKey = pickField(text, 'auto_key')
      const promotedBody = bodyOf(text).trim()
      if (promotedKey !== '' || promotedBody !== '') {
        // 同上：墓碑按 key 唯一，提升过的 key 再被删不该叠第二条。
        if (promotedKey !== '') st.tombstones = st.tombstones.filter((t) => t.key !== promotedKey)
        st.tombstones.push({
          key: promotedKey,
          textHash: textHashOf(promotedBody),
          text: promotedBody.slice(0, 400),
          at: nowIso,
          until: new Date(Date.now() + 30 * 86400_000).toISOString(),
          actor: 'user',
        })
      }
      delete st.entries[id]
      bumpRevision(st)
      const written = await state.write(st)
      if (!written.ok) return { ok: false, code: 'state-write-failed', error: written.error }
      await dropCatalogEntry(id)
      deps.invalidateSnapshot()
      return { ok: true, id, layer, status: 'active' as const, tier: 'confirmed' as const, promoted: true as const }
    })
  }

  /** 算整理草案（只读，不改任何文件）。 */
  async function organize(scope: 'workspace' | 'global' | 'all' = 'workspace'): Promise<{ ok: true; drafts: OrganizeDraft[]; scanned: number } | LearnFailure> {
    try {
      const { entries } = await deps.existingEntries()
      const read = await state.readFresh()
      if (!read.ok) return { ok: false, code: 'state-unreadable', error: read.error }
      const visible = entries.filter((e) => {
        if (scope === 'all') return true
        if (scope === 'global') return e.layer === 'global'
        // 「本工作区」= 非全局层：工作区 / 场景 / 会话都是"在这个环境里学到的"。
        return e.layer !== 'global'
      })
      const drafts = draftOrganize({ entries: visible, states: read.state.entries })
      return { ok: true, drafts, scanned: visible.filter((e) => e.origin === 'auto').length }
    } catch (e) {
      return { ok: false, code: 'organize-failed', error: deps.message(e) }
    }
  }

  /**
   * 应用一条草案。用户点过「应用」才会到这里 —— 草案本身不改任何文件。
   *
   * 不做"整批原子应用"：三条草案里有一条失败时，整批回滚会让用户看不出是哪一条出的问题，
   * 而三条都成功、第四条失败时"全没了"比"前三条生效"更让人意外。逐条应用、逐条报。
   */
  async function applyOrganize(draft: { action?: OrganizeAction; ids?: string[]; keep?: string }): Promise<any> {
    const action = draft?.action
    const ids = Array.isArray(draft?.ids) ? draft!.ids.filter((x) => typeof x === 'string' && x !== '') : []
    if (action !== 'merge' && action !== 'archive' && action !== 'promote') {
      return { ok: false, code: 'bad-args', error: 'action must be merge / archive / promote' }
    }
    if (ids.length === 0) return { ok: false, code: 'bad-args', error: 'missing ids' }
    if (action === 'archive') return setStatus(ids[0]!, 'archived', 'curator')
    if (action === 'promote') return promote(ids[0]!, { actor: 'curator' })
    return mergeDraft(draft!.keep && ids.includes(draft!.keep) ? draft!.keep : ids[0]!, ids.find((x) => x !== (draft!.keep ?? ids[0])) ?? '')
  }

  /** merge 草案的执行：把 drop 的说法并进 keep，drop 转 superseded。 */
  async function mergeDraft(keepId: string, dropId: string): Promise<any> {
    if (dropId === '') return { ok: false, code: 'bad-args', error: 'merge needs two ids' }
    return deps.withWriteLock(async () => {
      const read = await state.readFresh()
      if (!read.ok) return { ok: false, code: 'state-unreadable', error: read.error }
      const st = read.state
      const keepAt = splitId(keepId)
      const dropAt = splitId(dropId)
      if (!keepAt || !dropAt) return { ok: false, code: 'bad-id', error: 'merge targets must be memory ids' }
      let keepText: string
      let dropText: string
      try {
        keepText = await readFile(join(notesRoot, keepAt.group, keepAt.name + '.md'), 'utf8')
        dropText = await readFile(join(notesRoot, dropAt.group, dropAt.name + '.md'), 'utf8')
      } catch {
        return { ok: false, code: 'missing', error: 'one of the memories no longer exists' }
      }
      const keepEntry = st.entries[keepId] ?? { evidence: [], counters: emptyCounters(), transitions: [] }
      if (keepEntry.locked === true) {
        return { ok: false, code: 'locked', error: `refused: "${keepId}" was edited by the user and is locked.` }
      }
      // 类型不同的两条不能合并：`kind` 决定保质期（事实 / 做法 30 天后提醒复核，偏好 /
      // 纠正不过期）。草案阶段已经拦过一次，这里再拦是因为「应用」回传的是客户端手里的
      // 旧草案 —— 期间若有一条被改了类型，两道校验之间就有空档。合错了不会报错，
      // 只会让一条做法悄悄变成永不过期。
      const keepKind = pickField(keepText, 'auto_kind')
      const dropKind = pickField(dropText, 'auto_kind')
      if (keepKind !== '' && dropKind !== '' && keepKind !== dropKind) {
        return {
          ok: false,
          code: 'kind-mismatch',
          error: `refused: "${keepId}" is ${keepKind} but "${dropId}" is ${dropKind} — merging them would drop one of the two lifetimes. Re-run the organize pass to get a fresh draft.`,
        }
      }
      const nowIso = new Date().toISOString()
      // 把 drop 的正文记成 keep 的**别名**：两句话说法不同，但都表达了同一个意思，
      // 用户下次看 keep 时能认出另一句也指这条（与 learn 合并同一口径）。
      const dropBody = bodyOf(dropText).replaceAll(/\s+/g, ' ').trim().slice(0, 160)
      const prevAlias = pickField(keepText, 'auto_alias')
      const nextAlias = dedupeAlias(prevAlias, dropBody)
      await writeFileAtomically(join(notesRoot, keepAt.group, keepAt.name + '.md'), rewriteFrontmatterFields(keepText, {
        ...(nextAlias !== prevAlias ? { auto_alias: nextAlias } : {}),
        auto_updated: nowIso,
      }))

      const dropEntry = st.entries[dropId]
      const seen = new Set(keepEntry.evidence.map((e) => e.session + '\u0000' + e.quote))
      for (const ev of dropEntry?.evidence ?? []) {
        const k = ev.session + '\u0000' + ev.quote
        if (seen.has(k)) continue
        seen.add(k)
        keepEntry.evidence.push(ev)
      }
      keepEntry.evidence = keepEntry.evidence.slice(-50)
      keepEntry.counters = keepEntry.counters ?? emptyCounters()

      st.entries[keepId] = keepEntry

      const index = await readIndex(indexDir)
      await markSuperseded(dropId, keepId, st, nowIso, index)
      await writeIndex(indexDir, index)
      const written = await state.write(st)
      if (!written.ok) return { ok: false, code: 'state-write-failed', error: written.error }
      await patchCatalogEntry(keepId, {})
      deps.invalidateSnapshot()
      return { ok: true, action: 'merge', id: keepId, mergedFrom: dropId }
    })
  }

  /**
   * 读一条自动记忆的详情（正文 + 关键字段 + 证据 / 计数器 / 时间线）。
   *
   * 为什么不复用 `rules-read`：那条给的是"用户记忆"的形态（form / attachments / shadowed），
   * 而自动记忆要回答的是"为什么记它、它现在还成立吗" —— recent evidence、helpful 计数、
   * 状态转移。这些只在 state.json 里，记忆域看不见。
   */
  async function describe(id: string): Promise<any> {
    const split = splitId(id)
    if (!split) return { ok: false, code: 'bad-id', error: `not a memory id: ${id}` }
    let text: string
    try {
      text = await readFile(join(notesRoot, split.group, split.name + '.md'), 'utf8')
    } catch {
      return { ok: false, code: 'missing', error: `not found: ${id}` }
    }
    const read = await state.readFresh()
    const st = read.ok ? read.state.entries[id] : undefined
    return {
      ok: true,
      id,
      layer: split.layer,
      // 编辑弹窗保存时回传：文件在这期间被别处改过就拒绝覆盖。
      hash: createHash('sha256').update(text).digest('hex'),
      origin: pickField(text, 'origin') || 'auto',
      // 用户手改过（locked）的条目，自动路径不会改它 —— 读的时候要能看出来。
      status: pickField(text, 'auto_status') || 'active',
      kind: pickField(text, 'auto_kind') || '',
      key: pickField(text, 'auto_key') || '',
      title: pickField(text, 'auto_title') || '',
      basis: pickField(text, 'auto_basis') || '',
      boundary: pickField(text, 'auto_boundary') || '',
      alias: pickField(text, 'auto_alias') || '',
      body: bodyOf(text),
      ...(pickField(text, 'auto_degraded') ? { degraded: pickField(text, 'auto_degraded') } : {}),
      tier: st ? tierOf(st.evidence) : 'inferred',
      state: st
        ? {
            counters: st.counters ?? emptyCounters(),
            evidence: st.evidence.slice(-5),
            transitions: st.transitions.slice(-5),
            ...(st.procedure !== undefined ? { procedure: st.procedure } : {}),
            ...(st.pendingReason !== undefined ? { pendingReason: st.pendingReason } : {}),
            ...(st.reviewDue !== undefined ? { reviewDue: st.reviewDue } : {}),
            ...(st.locked === true ? { locked: true } : {}),
          }
        : null,
    }
  }

  /**
   * 注入计数：一次会话快照重建时，对真正进入上下文的那几条 +1。
   *
   * 为什么只记「进了快照」而不是每一轮：同一会话里整段文本是冻结的，逐轮 +1 会把
   * 「注入次数」变成「轮数」，衰减与排序都会失真。读坏 state 时静默跳过：计数不是真相源。
   */
  async function noteInjected(ids: readonly string[]): Promise<void> {
    const picked = ids.filter((id) => typeof id === 'string' && id !== '')
    if (picked.length === 0) return
    await deps.withWriteLock(async () => {
      const read = await state.readFresh()
      if (!read.ok) return
      const st = read.state
      const at = new Date().toISOString()
      let changed = false
      for (const id of picked) {
        const entry = st.entries[id]
        if (!entry) continue
        entry.counters = entry.counters ?? emptyCounters()
        entry.counters.injected += 1
        entry.counters.lastInjectedAt = at
        changed = true
      }
      if (changed) await state.write(st)
    })
  }

  /** 模型读过一条自动记忆：`read` + `lastUsedAt`。界面展开详情不走这条。 */
  async function noteRead(id: string): Promise<void> {
    if (id === '') return
    await deps.withWriteLock(async () => {
      const read = await state.readFresh()
      if (!read.ok) return
      const st = read.state
      const entry = st.entries[id]
      if (!entry) return
      entry.counters = entry.counters ?? emptyCounters()
      entry.counters.read += 1
      entry.counters.lastUsedAt = new Date().toISOString()
      await state.write(st)
    })
  }

  /**
   * 编辑一条自动记忆的正文。
   *
   * 改正文与名称，不动 id / 层 / 状态 / 证据：用户改的是措辞，不是这条记忆的身份。
   * superseded 拒绝 —— 历史条目改了也不会注入，只会让人以为改动生效。
   *
   * `kind` 可选：传了就改类型并按 `ttlDaysOf` 重算保质期。它是**唯一**能让用户亲手修正
   * 模型判错类型的入口 —— 否则一条被误判成 `correction` 的做法会永久驻留，用户毫无办法。
   * 改 kind 不改正文，所以与正文编辑走同一条写路径，但两者可以只传一个。
   */
  async function update(id: string, text: string, baseHash = '', title?: string, kind?: AutoKind): Promise<LearnResult> {
    return deps.withWriteLock(async () => {
      const split = splitId(id)
      if (!split) return { ok: false, code: 'bad-id', error: `not a memory id: ${id}` }
      // 只改类型时允许正文留空（调用方不必回传正文）；正文为空且没给 kind 才是错误。
      const body = String(text ?? '').trim()
      if (body === '' && kind === undefined) return { ok: false, code: 'empty', error: 'the note body cannot be empty' }
      if (body.length > 4000) return { ok: false, code: 'too-long', error: 'the note body is limited to 4000 characters' }
      const docPath = join(notesRoot, split.group, split.name + '.md')
      let raw: string
      try {
        raw = await readFile(docPath, 'utf8')
      } catch {
        return { ok: false, code: 'missing', error: `not found: ${id}` }
      }
      // 两个窗口同时编辑同一条时，后保存的会静默盖掉先保存的。带上打开弹窗时的
      // 文件指纹，变了就拒绝并让用户重新加载。
      if (baseHash !== '' && baseHash !== createHash('sha256').update(raw).digest('hex')) {
        return { ok: false, code: 'stale', error: 'this note changed elsewhere; reload it before saving' }
      }
      const current = pickField(raw, 'auto_status') || 'active'
      if (current === 'superseded') {
        return { ok: false, code: 'superseded', error: `refused: "${id}" was replaced by a newer memory; editing it would have no effect.` }
      }
      // 注入用完整正文；`oneLine` 只是列表摘要，跟着正文一起重算。
      // 只改类型时正文留空 = 保留原正文（`bodyOf` 与 `renderBody` 同源，摘掉边界行后
      // 才是纯正文，所以这里必须用它而不是拿整个文件）。
      const nextBody = body === '' ? bodyOf(raw) : body
      const oneLine = oneLineOf(nextBody)
      // `undefined` = 这次不动名称；空串 = 用户清空了名称（删掉字段，列表按首句兜底）。
      const nextTitle = title === undefined ? undefined : titleOf(title)
      // 边界行（`边界：…` / `Boundary: …`）是正文的一部分，注入行另从 `auto_boundary` 读。
      // 两处必须同源：用户在这里删掉 / 改写那一行，frontmatter 不跟着变的话，注入会继续
      // 显示用户刚删掉的条件 —— 而界面的正文里已经没有了。
      const nextBoundary = boundaryOfBody(nextBody)
      // 类型改了要连带重算保质期，否则「改对了类型、过期时间还是错的」—— 与合并路径同口径。
      const prevKind = pickField(raw, 'auto_kind')
      const kindChanged = kind !== undefined && kind !== prevKind
      // 改类型**故意按新类型重算保质期**，不保留旧的显式值：用户改类型的动机通常就是
      // 「这条不该永不过期」。保留旧 TTL 会让这次修正只改标签、不改寿命。
      // `learn` 路径的 `ttlDaysOf(kind, req.ttlDays)` 是另一回事 —— 那里显式 TTL 是本次
      // 调用**新给的**意图，不是旧值。
      // 不写 `description`：它是正文的有损副本，catalog 现在直接从正文生成注入行。
      // 旧文件里残留的那一行读侧已忽略，这里也不顺手删（记忆文件是用户资产）。
      const next = rewriteFrontmatterFields(
        raw,
        {
          auto_updated: new Date().toISOString(),
          auto_boundary: nextBoundary === '' ? null : nextBoundary,
          ...(nextTitle !== undefined ? { auto_title: nextTitle === '' ? null : nextTitle } : {}),
          ...(kindChanged ? { auto_kind: kind, auto_ttl_days: String(ttlDaysOf(kind)) } : {}),
          // 旧版按 `auto_confidence` 排序，现在改用证据档位，这个键没有任何读取方。
          // 合并与状态变更两条路径都会清它，用户编辑这条路径此前漏了 —— 于是候选条目
          // 长期不经过那两条路，旧字段一直留在文件里。留着会让读代码的人以为它还在起作用。
          auto_confidence: null,
        },
        nextBody + '\n',
      )
      // 先 bump revision：注入缓存按它失效。state 写失败就整次拒绝，正文一个字不动。
      //
      // 同时把 `locked` 置上：用户手改过的条目，自动路径从此只能提议、不能覆盖正文。
      // 这个字段一直存在于类型与检查里（合并、取代都会看它），但**从来没有被赋过值** ——
      // 于是「用户改过的笔记不会被自动覆盖」这条契约一直没生效。赋值点就在这儿：
      // 这是唯一一条「人改了正文」的路径。
      const bumped = await state.update((st) => {
        bumpRevision(st)
        const entry = st.entries[id]
        if (entry) entry.locked = true
        return entry ? tierOf(entry.evidence) : 'inferred' as const
      })
      if (!bumped.ok) return { ok: false, code: 'state-write-failed', error: bumped.error }
      await writeFileAtomically(docPath, next)
      const bytes = Buffer.byteLength(nextBody, 'utf8')
      await patchCatalogEntry(id, {
        body: nextBody,
        oneLine,
        bytes,
        estTokens: estimateTokens(bytes),
        hash: createHash('sha256').update(next).digest('hex'),
        mtime: Date.now(),
        size: Buffer.byteLength(next, 'utf8'),
        boundary: nextBoundary,
        ...(nextTitle !== undefined ? { title: nextTitle } : {}),
        ...(kindChanged ? { kind: kind as AutoKind } : {}),
      })
      deps.invalidateSnapshot()
      return {
        ok: true, id, layer: split.layer, status: current, tier: bumped.result,
        merged: false, supersedes: [],
      }
    })
  }

  /**
   * 从统一回收站恢复一条自动记忆。
   *
   * 走 `setStatus(active)`：文件还在原地时直接激活并删掉回收站副本；文件被旧版搬走时
   * `setStatus` 会先按 id 找到副本还原。两条路共用同一套证据升级与 catalog 更新。
   */
  async function restoreFromTrash(trashId: string): Promise<LearnResult> {
    const manifest = await readAutoTrashManifest(deps.stateDir, trashId)
    if (manifest === null) {
      return { ok: false, code: 'missing', error: 'recycle-bin entry not found or not an autonomous note' }
    }
    return (await setStatus(manifest.autoId, 'active', 'user')) as LearnResult
  }

  /**
   * 永久删除一条回收站里的自动记忆。
   *
   * 复用 `forget` 写墓碑、清 state、停索引；再删掉原地那份正文与回收站副本。
   * 不走 `forget` 的 `remove` 回调：那条路会把正文移进 `evolution/trash`，对「永久删除」
   * 只是换了个隐藏位置，用户以为清掉了、磁盘上还留着一份。
   */
  async function purgeTrash(trashId: string): Promise<LearnResult> {
    const manifest = await readAutoTrashManifest(deps.stateDir, trashId)
    if (manifest === null) {
      return { ok: false, code: 'missing', error: 'recycle-bin entry not found or not an autonomous note' }
    }
    const docPath = join(notesRoot, manifest.group, manifest.name + '.md')
    // 归档副本可能是写盘失败留下的孤儿：正文已回到 active 时，永久删除会误删一条
    // 正在注入的记忆。这里只清副本，正文一个字不动。
    const raw = await safeRead(docPath)
    if (raw !== '' && (pickField(raw, 'auto_status') || 'active') !== 'archived') {
      await dropAutoTrashEntry(deps.stateDir, trashId)
      return {
        ok: false,
        code: 'not-archived',
        error: 'this note is active again; the stale recycle-bin copy was removed and the note was left untouched',
      }
    }
    const result = await forget(manifest.autoId, { actor: 'user' })
    if (!result.ok) return result
    try {
      await rm(docPath, { force: true })
    } catch (e) {
      // 墓碑与 state 已落盘；正文删不掉时保留回收站条目，让用户能再点一次，别报成功。
      return { ok: false, code: 'io', error: e instanceof Error ? e.message : String(e) }
    }
    await dropAutoTrashEntry(deps.stateDir, trashId)
    return result as LearnResult
  }

  /**
   * 启动时把旧版本留下的 archived 条目补进统一回收站。
   *
   * 读 catalog 而不是 state：archived 是 frontmatter 派生的状态，catalog 与卡片同一口径。
   * 调用方要在 `rebuildCatalog()` 之后跑，保证刚重建出来的条目也覆盖到；失败不阻断启动。
   *
   * @returns 本次新补进回收站的条目数。
   */
  async function backfillTrash(): Promise<number> {
    let catalog: CatalogFile
    try {
      catalog = normalizeCatalog(JSON.parse(await readFile(catalogPathOf(deps.stateDir), 'utf8')))
    } catch {
      return 0
    }
    const archived = Object.entries(catalog.entries)
      .filter(([, e]) => e.status === 'archived')
      .map(([id, e]) => ({ id, layer: e.layer }))
    if (archived.length === 0) return 0
    return backfillArchivedTrash(notesRoot, deps.stateDir, archived)
  }

  /**
   * 行内开关：只改索引的 enabled 位，不动状态、不搬文件、不写回收站。
   *
   * 与 `setStatus(..., 'archived')` 的区别是「暂时不注入」vs「收起来」：前者要留在列表里，
   * 随时拨回来；后者才是删除的语义。
   */
  async function setEnabled(id: string, enabled: boolean): Promise<LearnResult> {
    return deps.withWriteLock(async () => {
      const split = splitId(id)
      if (!split) return { ok: false, code: 'bad-id', error: `not a memory id: ${id}` }
      const docPath = join(notesRoot, split.group, split.name + '.md')
      let text: string
      try {
        text = await readFile(docPath, 'utf8')
      } catch {
        return { ok: false, code: 'missing', error: `not found: ${id}` }
      }
      const status = pickField(text, 'auto_status') || 'active'
      if (status === 'superseded') {
        return { ok: false, code: 'superseded', error: `refused: "${id}" was replaced by a newer memory.` }
      }
      if (status === 'archived') {
        return { ok: false, code: 'archived', error: `refused: "${id}" is archived; restore it from the recycle bin first.` }
      }
      const read = await state.readFresh()
      if (!read.ok) return { ok: false, code: 'state-unreadable', error: read.error }
      const st = read.state
      // 注入缓存按 revision 失效：只改索引不 bump，下一次对话还会拿到旧快照。
      bumpRevision(st)
      const written = await state.write(st)
      if (!written.ok) return { ok: false, code: 'state-write-failed', error: written.error }
      const nowIso = new Date().toISOString()
      const index = await readIndex(indexDir)
      index.rules[id] = { ...(index.rules[id] ?? { order: 1000 }), enabled, updatedAt: nowIso }
      await writeIndex(indexDir, index)
      await patchCatalogEntry(id, { enabled })
      deps.invalidateSnapshot()
      return {
        ok: true, id, layer: split.layer, status,
        tier: st.entries[id] ? tierOf(st.entries[id].evidence) : 'inferred' as const,
        merged: false, supersedes: [],
      }
    })
  }

  /**
   * 挂一条「待复核」标记，**不改状态、不停注入**。
   *
   * 维护扫描用它代替以前的「降候选」：记忆突然从上下文里消失，比它稍微旧一点危险得多。
   * 用户看到标记自己判断；点「复核」走 `markReviewed` 清掉标记并重置计时。
   */
  async function markReview(id: string, reason: string): Promise<LearnResult> {
    return deps.withWriteLock(async () => {
      const split = splitId(id)
      if (!split) return { ok: false, code: 'bad-id', error: `not a memory id: ${id}` }
      const docPath = join(notesRoot, split.group, split.name + '.md')
      let text: string
      try {
        text = await readFile(docPath, 'utf8')
      } catch {
        return { ok: false, code: 'missing', error: `not found: ${id}` }
      }
      const status = pickField(text, 'auto_status') || 'active'
      if (status === 'archived' || status === 'superseded') {
        return { ok: false, code: 'not-live', error: `refused: "${id}" is ${status}; nothing to review.` }
      }
      const read = await state.readFresh()
      if (!read.ok) return { ok: false, code: 'state-unreadable', error: read.error }
      const st = read.state
      const entry = st.entries[id] ?? { evidence: [], counters: emptyCounters(), transitions: [] }
      if (entry.reviewDue === reason) {
        // 已经挂过同一条理由：不重复写 state，也不重复 bump revision ——
        // 扫描每天跑一次，每次都写一遍会让注入缓存天天失效。
        return { ok: true, id, layer: split.layer, status, tier: tierOf(entry.evidence), merged: false, supersedes: [] }
      }
      entry.reviewDue = reason
      st.entries[id] = entry
      bumpRevision(st)
      const written = await state.write(st)
      if (!written.ok) return { ok: false, code: 'state-write-failed', error: written.error }
      deps.invalidateSnapshot()
      return { ok: true, id, layer: split.layer, status, tier: tierOf(entry.evidence), merged: false, supersedes: [] }
    })
  }

  /**
   * 用户点「复核」：清掉待复核标记，并把 `auto_updated` 重置到现在。
   *
   * 两件事都要做。只清标记的话，下一次扫描会立刻按旧时间再挂一次 —— 用户会觉得
   * "点了没反应"。`auto_updated` 就是扫描的计时起点（它由文件 mtime 兜底），
   * 所以改写它等于把这一轮的 30 天重新起算。
   */
  async function markReviewed(id: string): Promise<LearnResult> {
    return deps.withWriteLock(async () => {
      const split = splitId(id)
      if (!split) return { ok: false, code: 'bad-id', error: `not a memory id: ${id}` }
      const docPath = join(notesRoot, split.group, split.name + '.md')
      let text: string
      try {
        text = await readFile(docPath, 'utf8')
      } catch {
        return { ok: false, code: 'missing', error: `not found: ${id}` }
      }
      const status = pickField(text, 'auto_status') || 'active'
      if (status === 'superseded') {
        return { ok: false, code: 'superseded', error: `refused: "${id}" was replaced by a newer memory.` }
      }
      const nowIso = new Date().toISOString()
      await writeFileAtomically(docPath, rewriteFrontmatterFields(text, { auto_updated: nowIso }))
      const read = await state.readFresh()
      if (!read.ok) return { ok: false, code: 'state-unreadable', error: read.error }
      const st = read.state
      const entry = st.entries[id]
      if (entry) {
        delete entry.reviewDue
        bumpRevision(st)
        const written = await state.write(st)
        if (!written.ok) return { ok: false, code: 'state-write-failed', error: written.error }
      }
      deps.invalidateSnapshot()
      return {
        ok: true, id, layer: split.layer, status,
        tier: entry ? tierOf(entry.evidence) : 'inferred' as const, merged: false, supersedes: [],
      }
    })
  }

  return {
    learn, preview, forget, approve, setStatus, setEnabled, promote, organize, applyOrganize, describe, update,
    restoreFromTrash, purgeTrash, backfillTrash, noteInjected, noteRead, markReview, markReviewed,
  }
}

/**
 * 写入管线的对外类型。
 *
 * 调用方（`ops/evolution.ts`）必须引这个、**别手写一份结构相同的**：手写的那份一旦与实现
 * 分了叉，编译器不会说话（方法参数是双变的），而症状是"某个参数被静默忽略"——
 * `forget` 的 `trash` / `remove` 就是这么错过一次的。
 */
export type Learner = ReturnType<typeof createLearner>

// ── 辅助 ───────────────────────────────────────────────────────────────────

async function exists(path: string): Promise<boolean> {
  const { access } = await import('node:fs/promises')
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

/** 从已有文件里取一个 frontmatter 标量（宽松：取不到就给空串）。 */
export function pickField(text: string, key: string): string {
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(String(text ?? ''))
  if (!m) return ''
  // 捕获组一定存在（正则里写了 `(.*)`），但严格模式不认这条推理。
  const raw = (m[1] ?? '').trim()
  if (raw === '' || raw === '""') return ''
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return String(JSON.parse(raw))
    } catch {
      return raw.slice(1, -1)
    }
  }
  return raw
}

const normalizeForCompare = (s: string): string => String(s ?? '').toLowerCase().replaceAll(/\s+/g, ' ').trim()

/** 默认 TTL：偏好/纠正活得久，事实与做法会过期。 */
export function ttlDaysOf(kind: AutoKind, explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) return Math.min(3650, Math.round(explicit))
  // 与 `maintenance.ts` 的 `REVIEW_DAYS` 同值：写进 frontmatter 的 `auto_ttl_days` 就是
  // 「多久提醒一次复核」。偏好没有保质期（它只会被新偏好取代），这里仍给一个上限值 ——
  // 字段必须有数，而扫描侧对 `kind === 'preference'` 直接跳过。
  if (kind === 'fact' || kind === 'procedure') return 30
  return 3650
}

/**
 * 正文里的边界行 → 边界字段（`renderBody` 的逆操作）。
 *
 * 认两种写法：写入时用的 `边界：…`，以及卡片 / 模型可能写下的 `Boundary: …`。
 * 只取第一处：`renderBody` 只产出这一行，多出来的同形行属于正文本身，不该被吞掉。
 */
function boundaryOfBody(body: string): string {
  for (const line of String(body ?? '').split('\n')) {
    const hit = /^\s*(?:边界|Boundary)\s*[:：]\s*(.*)$/i.exec(line)
    if (hit !== null) return String(hit[1] ?? '').trim().slice(0, MAX_BOUNDARY)
  }
  return ''
}

/** 正文：一句话结论，加一行边界（有的话）。 */
function renderBody(text: string, boundary: string | undefined): string {
  const lines = [String(text ?? '').trim()]
  const b = String(boundary ?? '').trim()
  if (b !== '') lines.push('', `边界：${b}`)
  return lines.join('\n') + '\n'
}

function collectEvidence(
  pass: Extract<GateOutcome, { ok: true }>,
  env: LearnEnv,
  req: LearnRequest,
  nowIso: string,
): Array<{ session: string; turn: number; seq: number; source: EvidenceSource; quote: string; at: string }> {
  return [{
    session: env.sessionId ?? '',
    turn: 0,
    seq: -1,
    source: pass.source,
    // 取**第一个非空**：`??` 只挡 null / undefined，而调用方常传 `quote: ''`（"没有引句"），
    // 空串会一路穿过 `.??` 落到证据里。症状是每条证据的 quote 都是空 —— 看板上"依据"一栏
    // 永远空白，而合并去重按 `session+quote` 判重时会把两条不同的证据当成同一条。
    quote: [req.quote, pass.quote, pass.text]
      .map((x) => String(x ?? '').trim())
      .find((x) => x !== '')?.slice(0, 2000) ?? '',
    at: nowIso,
  }]
}

const harmfulOf = (prev: { counters?: { harmful?: number } } | undefined): number => prev?.counters?.harmful ?? 0

/**
 * 学习日志的一行。
 *
 * **不落 `key` 原文**：`deriveKey` 取的是正文前三个词，于是这个字段经常就是用户原话的开头
 * （真实数据：「ouli 明确要求把自主记忆的全部功能各测试一遍」）。排障要的是「两次写的是不是
 * 同一个 slot」，哈希足够；原文只在记忆库里，不该在排障日志里再留一份。
 *
 * 抽成独立函数是为了让「日志里没有正文字段」这条不变量可测 —— 写在调用点里就只能靠读代码发现。
 */
export function learnLogRowOf(input: {
  at: string; id: string; layer: string; status: string; tier: string; key: string; session: string
}): Record<string, unknown> {
  return {
    at: input.at,
    id: input.id,
    layer: input.layer,
    status: input.status,
    tier: input.tier,
    keyHash: textHashOf(input.key),
    session: input.session,
  }
}

/** 学习日志（append-only jsonl，本地排障用；不是真相源，删了不影响功能）。 */
async function appendLearnLog(row: Record<string, unknown>): Promise<void> {
  const dir = hubPath('evolution/logs')
  await mkdir(dir, { recursive: true })
  const day = new Date().toISOString().slice(0, 10)
  await appendFile(join(dir, `learn-${day}.jsonl`), JSON.stringify(row) + '\n', 'utf8')
}

/** 只在 `_ws` / `_session` 目录里出现的组才算保留组（`isValidGroupPath` 的补充断言）。 */
export const isLayerGroup = (group: string): boolean => layerOfGroup(group) !== LAYER_SCENE || group === 'global'

/**
 * 记忆 id → 磁盘位置与层。
 *
 * `id` 用最后一个 `/` 切开：场景名里不会有 `/`（`isValidGroupPath` 挡了），而保留段的组
 * 是 `_ws/<hash16>` 这种**带斜杠的组名**，所以只能按"最后一段是文件名"来分。
 */
function splitId(id: string): { group: string; name: string; layer: MemoryLayer } | null {
  const slash = id.lastIndexOf('/')
  if (slash <= 0 || slash === id.length - 1) return null
  const group = id.slice(0, slash)
  const name = id.slice(slash + 1)
  return { group, name, layer: layerOfGroup(group) }
}

/** frontmatter 之后的正文（合并时要把对方的说法抄进边界）。 */
function bodyOf(text: string): string {
  const s = String(text ?? '')
  if (!s.startsWith('---')) return s.trim()
  const end = s.indexOf('\n---', 3)
  if (end < 0) return s.trim()
  const nl = s.indexOf('\n', end + 1)
  return nl < 0 ? '' : s.slice(nl + 1).trim()
}

/** 别名追加：同一条的另一种说法；已经包含过的不重复加（合并跑两遍不该长出两份）。 */
function dedupeAlias(prev: string, add: string): string {
  const base = String(prev ?? '').trim()
  const extra = String(add ?? '').trim()
  if (extra === '') return base
  if (base.includes(extra)) return base
  return [base, extra].filter((x) => x !== '').join('；').slice(0, MAX_ALIAS)
}
