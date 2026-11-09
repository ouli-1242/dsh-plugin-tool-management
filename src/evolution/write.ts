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

import { mkdir, readFile } from 'node:fs/promises'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hubPath } from '../hub.js'
import { writeFileAtomically, readIndex, writeIndex } from '../memories/index-io.js'
import { catalogEntryOf, catalogPathOf, normalizeCatalog, type CatalogFile } from '../memories/catalog.js'
import {
  LAYER_SCENE, LAYER_SESSION, LAYER_WORKSPACE,
  isValidGroupPath, isValidGroupSegment, type MemoryLayer,
} from '../memories/constants.js'
import { layerOfGroup } from '../memories/constants.js'
import { rewriteFrontmatterFields } from '../skills/frontmatter.js'
import type { EffectiveEvolutionConfig } from './config.js'
import {
  runGates, tombstoneBlocked, type AutoKind, type ExistingEntry, type GateContext, type GateName, type GateOutcome,
} from './gates.js'
import { deriveKey } from './gates.js'
import {
  confidenceOf, emptyCounters, pushTransition, textHashOf, type EvidenceSource, type EvolutionState, type EvolutionStateStore,
} from './state.js'

/** 一条自动记忆的正文上限（字符）。超过说明它该是一份文档或一个技能，不是一条记忆。 */
export const MAX_AUTO_TEXT = 400
/** 描述上限（与 `MAX_DESCRIPTION_LENGTH` 一致，但这里更紧：注入只显示一行）。 */
export const MAX_AUTO_DESCRIPTION = 200
/** `boundary` 上限：合并时会追加，靠它兜住长度。 */
const MAX_BOUNDARY = 500

export interface LearnRequest {
  text: string
  kind?: AutoKind
  key?: string
  source: EvidenceSource
  quote?: string
  layer?: MemoryLayer
  boundary?: string
  ttlDays?: number
  description?: string
}

export interface LearnEnv {
  sessionId?: string
  workspaceHash?: string
  scene?: string
}

export interface LearnSuccess {
  ok: true
  id: string
  layer: MemoryLayer
  status: string
  confidence: number
  merged: boolean
  supersedes: string[]
  note?: string
  needsReview?: string
}

export interface LearnFailure {
  ok: false
  code: string
  error: string
  gate?: GateName
  detail?: string
}

export type LearnResult = LearnSuccess | LearnFailure

export interface LearnDeps {
  state: EvolutionStateStore
  /** 现有记忆视图（来自快照）。 */
  existingEntries(): Promise<{ entries: ExistingEntry[]; knownScenes: Set<string> }>
  /** 工作区 hash 是否登记过。 */
  knownWorkspaces(): Promise<Set<string>>
  /** 序列化 frontmatter + 正文（复用记忆域的现成实现）。 */
  serializeRuleFile(fields: Record<string, string | boolean>, body: string): string
  /** 记忆根目录绝对路径。 */
  memoriesRoot: string
  /** 索引所在目录（hub 根）。 */
  stateDir: string
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

/** 描述：显式给的优先，否则取正文首句（到第一个句号 / 换行）。 */
export function describeOf(text: string, explicit?: string): string {
  const given = String(explicit ?? '').trim()
  if (given !== '') return given.slice(0, MAX_AUTO_DESCRIPTION)
  const cut = String(text ?? '').split(/[。\n]/, 1)[0]?.trim() ?? ''
  const base = cut === '' ? String(text ?? '').trim() : cut
  return base.slice(0, MAX_AUTO_DESCRIPTION)
}

const cjkOrWord = (s: string): boolean => /\p{L}/u.test(s)

// ── 主流程 ─────────────────────────────────────────────────────────────────

export function createLearner(deps: LearnDeps) {
  const { state } = deps

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
    const countByLayer: Partial<Record<MemoryLayer, number>> = {}
    for (const e of entries) {
      if (e.origin !== 'auto') continue
      countByLayer[e.layer] = (countByLayer[e.layer] ?? 0) + 1
    }
    return {
      ...(env.sessionId !== undefined ? { sessionId: env.sessionId } : {}),
      ...(env.workspaceHash !== undefined ? { workspaceHash: env.workspaceHash } : {}),
      ...(env.scene !== undefined ? { scene: env.scene } : {}),
      writeTarget: config.writeTarget,
      existing: entries,
      countByLayer,
      maxEntries: config.maxEntries,
      knownWorkspaces: await deps.knownWorkspaces(),
      knownScenes,
      tombstones: st.tombstones,
      maxTextLength: MAX_AUTO_TEXT,
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
    if (text.length > MAX_AUTO_TEXT * 2) {
      return { ok: false, code: 'too-long', error: `refused: a learned note should be one sentence (limit ${MAX_AUTO_TEXT} chars). Split it, or record it as a normal memory.` }
    }

    // 会话层：sid 不合法时不能落（目录即身份，换个名字就等于换了会话）。
    if (req.layer === LAYER_SESSION && env.sessionId && !sessionSegmentOk(env.sessionId)) {
      return { ok: false, code: 'bad-session', error: 'refused: this conversation id cannot be used as a directory name, so it cannot hold conversation-scoped notes. Use layer="workspace" instead.', gate: 'layer' }
    }

    return deps.withWriteLock(async () => {
      const read = await state.read()
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
          source: req.source,
          ...(req.quote !== undefined ? { quote: req.quote } : {}),
          ...(req.layer !== undefined ? { layer: req.layer } : {}),
          ...(req.boundary !== undefined ? { boundary: req.boundary } : {}),
          ...(req.ttlDays !== undefined ? { ttlDays: req.ttlDays } : {}),
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
    const root = deps.memoriesRoot
    const index = await readIndex(deps.stateDir)

    if (!isValidGroupPath(pass.group)) {
      return { ok: false, code: 'bad-group', error: `internal: routed to an invalid directory "${pass.group}"`, gate: 'layer' }
    }

    // ── 合并：同 key 同义 → 追加边界与证据，不新建 ──
    if (pass.mergeInto) {
      const merged = await mergeInto(pass, pass.mergeInto, st, nowIso)
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
    const fields: Record<string, string | boolean> = {
      name,
      description: describeOf(pass.text, req.description),
      origin: 'auto',
      auto_kind: pass.kind,
      auto_key: pass.key,
      auto_status: pass.status,
      auto_confidence: pass.confidence.toFixed(2),
      auto_basis: req.quote && req.quote.trim() !== '' ? req.quote.trim() : pass.text,
      auto_created: nowIso,
      auto_updated: nowIso,
      auto_ttl_days: String(ttl),
    }
    if (pass.layer === LAYER_WORKSPACE && env.workspaceHash) fields.auto_workspace = env.workspaceHash
    if (pass.layer === LAYER_SCENE && env.scene) fields.auto_scene = env.scene
    if (req.boundary && req.boundary.trim() !== '') fields.auto_boundary = req.boundary.trim().slice(0, MAX_BOUNDARY)
    if (pass.degraded) fields.auto_degraded = pass.degraded

    const body = renderBody(pass.text, req.boundary, pass.kind)
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
    pushTransition(st.entries[id], 'absent', pass.status, 'learn', `source=${pass.source} key=${pass.key}`, now.getTime())
    if (pass.needsReview) st.entries[id].needsReview = pass.needsReview
    // 信心以 state 里的证据为准重算一次：门禁算的是"这次"的，重算的是"全部证据的"。
    st.entries[id].confidence = confidenceOf(st.entries[id].evidence, harmfulOf(prev))

    // ── ③ 索引（enabled=true：自动记忆学完就生效，否则等于没学） ──
    index.rules[id] = {
      ...(index.rules[id] ?? {}),
      order: index.rules[id]?.order ?? 1000,
      enabled: true,
      updatedAt: nowIso,
    }
    await writeIndex(deps.stateDir, index)

    // ── ④ 取代旧的同 key 条目 ──
    const superseded: string[] = []
    for (const oldId of pass.supersedes) {
      const ok = await markSuperseded(oldId, id, st, nowIso, index)
      if (ok) superseded.push(oldId)
    }
    if (superseded.length > 0) await writeIndex(deps.stateDir, index)

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
    await appendLearnLog({ at: nowIso, id, layer: pass.layer, status: pass.status, source: pass.source, key: pass.key, session: env.sessionId ?? '' }).catch(() => {})

    return {
      ok: true,
      id,
      layer: pass.layer,
      status: pass.status,
      confidence: st.entries[id].confidence ?? pass.confidence,
      merged: false,
      supersedes: superseded,
      ...(pass.note !== undefined ? { note: pass.note } : {}),
      ...(pass.needsReview !== undefined ? { needsReview: pass.needsReview } : {}),
    }
  }

  /** 合并进已有条目：追加证据与边界，正文不动（正文替换会丢掉用户可能已经熟悉的措辞）。 */
  async function mergeInto(
    pass: Extract<GateOutcome, { ok: true }>,
    targetId: string,
    st: EvolutionState,
    nowIso: string,
  ): Promise<LearnResult | null> {
    const slash = targetId.lastIndexOf('/')
    if (slash <= 0) return null
    const group = targetId.slice(0, slash)
    const name = targetId.slice(slash + 1)
    const docPath = join(deps.memoriesRoot, group, name + '.md')
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
    // 新说法与旧正文不同 → 追加到 boundary（Day 3 的"补边界，不取代"）。
    const extra = String(pass.text ?? '').trim()
    const alreadyKnown = normalizeForCompare(existing).includes(normalizeForCompare(extra).slice(0, 24))
    const prevBoundary = pickField(existing, 'auto_boundary')
    const nextBoundary = alreadyKnown
      ? prevBoundary
      : [prevBoundary, extra].filter((x) => x !== '').join('；').slice(0, MAX_BOUNDARY)
    const merged = rewriteFrontmatterFields(
      existing,
      {
        auto_status: pass.status,
        auto_updated: nowIso,
        ...(nextBoundary !== prevBoundary ? { auto_boundary: nextBoundary } : {}),
      },
    )
    await writeFileAtomically(docPath, merged)

    const evidence = collectEvidence(pass, { sessionId: undefined, workspaceHash: undefined, scene: undefined }, {} as LearnRequest, nowIso)
    entry.evidence = [...entry.evidence, ...evidence].slice(-50)
    entry.counters = entry.counters ?? emptyCounters()
    entry.confidence = confidenceOf(entry.evidence, entry.counters.harmful)
    pushTransition(entry, entry.transitions.at(-1)?.to ?? 'active', pass.status, 'learn', 'merge: same key, new evidence', Date.parse(nowIso))
    st.entries[targetId] = entry

    const written = await state.write(st)
    if (!written.ok) return { ok: false, code: 'state-write-failed', error: written.error }

    await touchCatalog(targetId, pass, name, {} as LearnRequest, nowIso).catch(() => {})
    deps.invalidateSnapshot()
    return {
      ok: true,
      id: targetId,
      layer: pass.layer,
      status: pass.status,
      confidence: entry.confidence ?? pass.confidence,
      merged: true,
      supersedes: [],
      note: alreadyKnown ? '已存在同样的说法，只新增了一条证据' : '同一条记忆，把新说法补进了边界',
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
    const docPath = join(deps.memoriesRoot, group, name + '.md')
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

  /** 更新 catalog 的单条卡片（派生数据，失败不影响真相）。 */
  async function touchCatalog(
    id: string,
    pass: Extract<GateOutcome, { ok: true }>,
    name: string,
    req: LearnRequest,
    nowIso: string,
  ): Promise<void> {
    const abs = catalogPathOf(deps.stateDir)
    let catalog: CatalogFile
    try {
      const raw = JSON.parse(await readFile(abs, 'utf8'))
      catalog = normalizeCatalog(raw)
    } catch {
      catalog = normalizeCatalog(null)
    }
    const oneLine = describeOf(pass.text, req.description)
    catalog.entries[id] = catalogEntryOf(id, pass.layer, {
      oneLine,
      status: pass.status,
      kind: pass.kind,
      key: pass.key,
      confidence: pass.confidence,
      enabled: true,
      hash: textHashOf(pass.text),
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
  async function patchCatalogEntry(id: string, patch: Partial<{ status: string; enabled: boolean; confidence: number }>): Promise<void> {
    try {
      const abs = catalogPathOf(deps.stateDir)
      const catalog = normalizeCatalog(JSON.parse(await readFile(abs, 'utf8')))
      const hit = catalog.entries[id]
      if (!hit) return
      catalog.entries[id] = { ...hit, ...patch }
      catalog.builtAt = new Date().toISOString()
      await writeFileAtomically(abs, JSON.stringify(catalog, null, 2) + '\n', { mode: 0o600 })
    } catch {
      /* 派生数据：改不动就等下一次全量重建校正（服务写路径会重建） */
    }
  }

  const demoteCatalog = (id: string, status: 'archived' | 'superseded'): Promise<void> =>
    patchCatalogEntry(id, { status, enabled: false })

  /** 忘掉一条：正文进回收站，状态转 archived，写墓碑。 */
  async function forget(
    id: string,
    opts: { actor?: string; remove?: (id: string) => Promise<boolean> } = {},
  ): Promise<LearnResult | { ok: true; id: string; layer: MemoryLayer; status: 'archived'; confidence: number; merged: false; supersedes: string[] }> {
    return deps.withWriteLock(async () => {
      const read = await state.read()
      if (!read.ok) return { ok: false, code: 'state-unreadable', error: read.error }
      const st = read.state
      const slash = id.lastIndexOf('/')
      if (slash <= 0) return { ok: false, code: 'bad-id', error: `not a memory id: ${id}` }
      const group = id.slice(0, slash)
      const name = id.slice(slash + 1)
      const layer = layerOfGroup(group)
      const entry = st.entries[id]
      const docPath = join(deps.memoriesRoot, group, name + '.md')
      const raw = await safeRead(docPath)
      const key = pickField(raw, 'auto_key')
      const body = normalizeForCompare(raw)

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

      // 墓碑：key 与文本指纹都写，任一路径再次申请都能拦住。
      const tomb = textHashOf(body)
      if (key !== '' || tomb !== '') {
        st.tombstones.push({
          key,
          textHash: tomb,
          at: new Date().toISOString(),
          until: new Date(Date.now() + 30 * 86400_000).toISOString(),
          actor: opts.actor ?? 'model',
        })
      }
      if (entry) pushTransition(entry, entry.transitions.at(-1)?.to ?? 'active', 'archived', 'learn', 'forgotten by user', Date.now())
      else st.entries[id] = { evidence: [], counters: emptyCounters(), transitions: [], confidence: 0 }
      delete st.entries[id]

      const written = await state.write(st)
      if (!written.ok) return { ok: false, code: 'state-write-failed', error: written.error }
      const index = await readIndex(deps.stateDir)
      if (index.rules[id]) {
        index.rules[id] = { ...index.rules[id], enabled: false, updatedAt: new Date().toISOString() }
        await writeIndex(deps.stateDir, index)
      }
      await demoteCatalog(id, 'archived')
      deps.invalidateSnapshot()
      return { ok: true, id, layer, status: 'archived' as const, confidence: 0, merged: false as const, supersedes: [] }
    })
  }

  /**
   * 用户确认一条候选 → active。
   *
   * 为什么需要这条：候选**不注入**，而九道门的设计是"模糊就降级"，于是候选一定会积累
   * （歧义表述、模型推断、程序性记忆全进候选）。没有这条，用户唯一的出路是删掉或者让模型
   * 再说一遍 —— 前者浪费证据，后者会撞上配额与冲突门。
   *
   * 已 superseded / archived 的不许确认：那不是"待确认"，是历史。给它们复活等于绕过墓碑。
   */
  async function approve(id: string): Promise<LearnResult> {
    return deps.withWriteLock(async () => {
      const read = await state.read()
      if (!read.ok) return { ok: false, code: 'state-unreadable', error: read.error }
      const st = read.state
      const slash = id.lastIndexOf('/')
      if (slash <= 0) return { ok: false, code: 'bad-id', error: `not a memory id: ${id}` }
      const group = id.slice(0, slash)
      const name = id.slice(slash + 1)
      const docPath = join(deps.memoriesRoot, group, name + '.md')
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

      const entry = st.entries[id] ?? { evidence: [], counters: emptyCounters(), transitions: [], confidence: 0 }
      delete entry.needsReview
      pushTransition(entry, current, 'active', 'user', 'approved in Memory page', Date.parse(nowIso))
      entry.confidence = confidenceOf(entry.evidence, entry.counters.harmful)
      st.entries[id] = entry
      const written = await state.write(st)
      if (!written.ok) return { ok: false, code: 'state-write-failed', error: written.error }

      const index = await readIndex(deps.stateDir)
      index.rules[id] = { ...(index.rules[id] ?? { order: 1000 }), enabled: true, updatedAt: nowIso }
      await writeIndex(deps.stateDir, index)
      await patchCatalogEntry(id, { status: 'active', enabled: true, confidence: entry.confidence })
      deps.invalidateSnapshot()
      return {
        ok: true,
        id,
        layer: layerOfGroup(group),
        status: 'active',
        confidence: entry.confidence ?? 0,
        merged: false,
        supersedes: [],
      }
    })
  }

  return { learn, forget, approve }
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
  const raw = m[1].trim()
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
  if (kind === 'fact') return 180
  if (kind === 'procedure') return 180
  return 365
}

/** 正文：一句话结论，加一行边界（有的话）。 */
function renderBody(text: string, boundary: string | undefined, kind: AutoKind): string {
  const lines = [String(text ?? '').trim()]
  const b = String(boundary ?? '').trim()
  if (b !== '') lines.push('', `边界：${b}`)
  if (kind === 'procedure') lines.push('', '（做法类：验证通过后才会进入注入；未验证前只在记忆页可见。）')
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
    quote: String(req.quote ?? pass.quote ?? pass.text).slice(0, 2000),
    at: nowIso,
  }]
}

const harmfulOf = (prev: { counters?: { harmful?: number } } | undefined): number => prev?.counters?.harmful ?? 0

/** 学习日志（append-only jsonl，本地排障用；不是真相源，删了不影响功能）。 */
async function appendLearnLog(row: Record<string, unknown>): Promise<void> {
  const dir = hubPath('evolution/logs')
  await mkdir(dir, { recursive: true })
  const day = new Date().toISOString().slice(0, 10)
  await appendFile(join(dir, `learn-${day}.jsonl`), JSON.stringify(row) + '\n', 'utf8')
}

/** 读回一条自动记忆的完整状态（界面展开详情用）。 */
export function describeEntry(entry: { evidence?: unknown[]; counters?: any; transitions?: unknown[]; confidence?: number; degraded?: string; locked?: boolean; needsReview?: string }) {
  return {
    confidence: typeof entry.confidence === 'number' ? entry.confidence : 0,
    evidence: Array.isArray(entry.evidence) ? entry.evidence : [],
    counters: entry.counters ?? emptyCounters(),
    transitions: Array.isArray(entry.transitions) ? entry.transitions : [],
    ...(entry.degraded !== undefined ? { degraded: entry.degraded } : {}),
    ...(entry.locked === true ? { locked: true } : {}),
    ...(entry.needsReview !== undefined ? { needsReview: entry.needsReview } : {}),
  }
}

/** 只在 `_ws` / `_session` 目录里出现的组才算保留组（`isValidGroupPath` 的补充断言）。 */
export const isLayerGroup = (group: string): boolean => layerOfGroup(group) !== LAYER_SCENE || group === 'global'
