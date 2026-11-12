// 注入热路径的**同步**视图。
//
// 为什么需要这一层：`agent/pre-step` 的各域 `text()` 是同步函数（注入器没有 await 的位置，
// 每个 step 都要算六段文本）。而 catalog / state / 三级开关都是异步读的。现有记忆段靠
// `snapshot()` 的同步缓存绕开这个矛盾，自动段同样需要一份。
//
// 为什么自己读文件而不是等异步任务预热：预热会让"会话第一轮没有自动段、第二轮才有"，
// 而 pre-step 的第一轮恰恰是用户最需要它的时刻（新会话开场）。这里用 `readFileSync`：
// catalog 300 条约 60 KB、state 约 30 KB，同步解析不到 2 ms，且有 1 秒 TTL 摊薄。
// 真到条数上千时该换增量索引 —— 那时 `catalog.json` 也早该分片了（见 docs 04-governance §5）。
//
// 读坏怎么办：同步路径**绝不抛**。注入失败会让整段上下文停摆，而自动段是可选内容 ——
// 宁可这一轮不显示，也不能让这一轮发不出去。写路径（`state.read`）的严格是另一回事：
// 那里读坏必须停写，否则会用默认值覆盖证据链。

import { readFileSync } from 'node:fs'
import { hubPath } from '../hub.js'
import { normalizeCatalog, CATALOG_FILE, type CatalogFile } from '../memories/catalog.js'
import {
  DEFAULT_EVOLUTION_SETTINGS,
  EVOLUTION_SESSIONS_FILE,
  EVOLUTION_SETTINGS_FILE,
  EVOLUTION_WORKSPACES_FILE,
  normalizeEvolutionSettings,
  normalizeSessionsFile,
  normalizeWorkspacesFile,
  resolveEffectiveConfig,
  workspaceHashOf,
  type EffectiveEvolutionConfig,
  type EvolutionSettings,
  type SessionsFile,
  type WorkspacesFile,
} from './config.js'
import { emptyState, normalizeState, EVOLUTION_STATE_FILE, type EvolutionState } from './state.js'

/** 视图缓存时长：1 秒。写入后由 `invalidate()` 立即作废，TTL 只对外部改文件生效。 */
const VIEW_TTL_MS = 1000

export interface EvolutionView {
  catalog: CatalogFile
  state: EvolutionState
  settings: EvolutionSettings
  workspaces: WorkspacesFile
  sessions: SessionsFile
  /** 任一份文件读坏（界面据此提示，注入侧静默降级）。 */
  broken: boolean
}

export interface EvolutionRuntime {
  view(): EvolutionView
  /** 会话级生效配置（同步）。`source` 报告最具体的一档，界面用。 */
  effectiveSync(scopeKey: string | undefined, sid: string | undefined): EffectiveEvolutionConfig
  /** 写后作废（下一次 `view()` 重读）。 */
  invalidate(): void
}

function readJsonSync(rel: string): { ok: boolean; value: unknown } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(hubPath(rel), 'utf8')) }
  } catch (e) {
    // ENOENT = 还没建，正常。其余（ENOENT 之外）算坏。
    const code = (e as NodeJS.ErrnoException)?.code
    return { ok: code === 'ENOENT', value: null }
  }
}

export function createEvolutionRuntime(): EvolutionRuntime {
  let cache: { at: number; view: EvolutionView } | null = null

  function build(): EvolutionView {
    let broken = false
    const c = readJsonSync(CATALOG_FILE)
    if (!c.ok) broken = true
    const catalog = normalizeCatalog(c.value)

    const s = readJsonSync(EVOLUTION_STATE_FILE)
    let state: EvolutionState = emptyState()
    if (!s.ok) broken = true
    else {
      const normalized = normalizeState(s.value)
      if (normalized.ok) state = normalized.state
      else broken = true
    }

    const g = readJsonSync(EVOLUTION_SETTINGS_FILE)
    if (!g.ok) broken = true
    const settings = g.value === null ? DEFAULT_EVOLUTION_SETTINGS : normalizeEvolutionSettings(g.value)

    const w = readJsonSync(EVOLUTION_WORKSPACES_FILE)
    if (!w.ok) broken = true
    const workspaces = normalizeWorkspacesFile(w.value)

    const se = readJsonSync(EVOLUTION_SESSIONS_FILE)
    if (!se.ok) broken = true
    const sessions = normalizeSessionsFile(se.value)

    return { catalog, state, settings, workspaces, sessions, broken }
  }

  function view(): EvolutionView {
    if (cache && Date.now() - cache.at < VIEW_TTL_MS) return cache.view
    const built = build()
    cache = { at: Date.now(), view: built }
    return built
  }

  function effectiveSync(scopeKey: string | undefined, sid: string | undefined): EffectiveEvolutionConfig {
    const v = view()
    const hash = scopeKey ? workspaceHashOf(scopeKey) : undefined
    const workspace = hash ? v.workspaces.workspaces[hash]?.evolution : undefined
    const session = sid ? v.sessions.sessions[sid]?.evolution : undefined
    const resolved = resolveEffectiveConfig(v.settings, workspace, session)
    return {
      ...resolved,
      ...(scopeKey !== undefined ? { workspaceKey: scopeKey } : {}),
      ...(hash !== undefined ? { workspaceHash: hash } : {}),
      ...(sid !== undefined ? { sessionId: sid } : {}),
    }
  }

  function invalidate(): void {
    cache = null
  }

  return { view, effectiveSync, invalidate }
}

/**
 * 自动段的**会话快照**：每个 agent 一份，按注入层（全局 / 工作区）分槽。
 *
 * 为什么必须有：注入去重是按正文字节比对的。如果每学一条就重算整段，那么在一次会话里
 * 学三次，整段记忆就会重发三次 —— session 级前缀缓存全废，且模型会看到三份内容略有
 * 差别的同一段提醒。所以本会话一旦算出自动段就固定住：本会话新学的条目靠对话上下文
 * 本身（模型刚写完它，不会忘），下个会话才从注入里拿到。
 *
 * 为什么按层分槽：批准一条全局笔记时，工作区那一层的正文一个字都没变。分槽后它连重渲染
 * 都不必做；即使因为共用 revision 重渲染了，注入器按字节比对也会跳过，token 成本为 0。
 *
 * 重建条件（`key`）：层 / 会话 / 工作区 / 启用场景 / 开关状态 / 风格 / 用户动作版本号 /
 * 用户记忆的预算档位变了。刻意**不含**条目内容 —— 含了就等于"每学一条重建"，快照就没意义了。
 */
export interface AutoSnapshot {
  key: string
  text: string
  /** 不含收尾授权语的正文；合并块与增量注入要用。 */
  body: string
  /** 有条目因预算没进来（决定合并块收尾句与增量回退）。 */
  truncated: boolean
  /** 实际注入的条目与对应行；增量注入按 id 做差集。 */
  picked: Array<{ id: string; line: string }>
  count: number
  tokens: number
  budget: number
  dropped: number
  builtAt: number
}

/** 槽位 = 注入层。两层各存一份，互不覆盖。 */
const snapshots = new WeakMap<object, Map<string, AutoSnapshot>>()

export function readAutoSnapshot(agent: object, layer: 'global' | 'workspace'): AutoSnapshot | undefined {
  return snapshots.get(agent)?.get(layer)
}

export function writeAutoSnapshot(agent: object, layer: 'global' | 'workspace', snap: AutoSnapshot): void {
  let slots = snapshots.get(agent)
  if (slots === undefined) {
    slots = new Map()
    snapshots.set(agent, slots)
  }
  slots.set(layer, snap)
}

export interface AutoSnapshotKeyParts {
  layer: 'global' | 'workspace'
  sessionId?: string
  workspaceHash?: string
  scenes: string[]
  enabled: boolean
  /**
   * 用户动作版本号（确认 / 停用 / 恢复 / 删除 / 提升）。学习写入不加它：
   * 本会话新学的条目靠对话上下文本身，不需要把整段记忆重发一次。
   *
   * 两层共用同一个版本号（不做分层 revision）：跨层取代必须同时失效两域，
   * 分层的版本号反而要记得两边都 bump，漏一边就会让旧说法继续注入。
   */
  revision?: number
  /**
   * 共享注入总盘（字节）。一般不变，但配置可调（`rulesMaxBytes`）—— 变了要重算。
   */
  totalBytes?: number
  /**
   * 更高优先级内容已占掉的字节（手写记忆段 + 全局自主段）。它变了说明余量变了，
   * 该层该按新余量重新决定装哪几条。
   */
  reservedBytes?: number
  /**
   * catalog 的身份（条目数 + `builtAt`）。
   *
   * **必须有**：catalog 是派生数据，启动时由异步的 `rebuildCatalog()` 补齐。第一个
   * `pre-step` 早于它完成时会写入一份**空段**快照；之后 catalog 建好了，但快照键里
   * 没有任何 catalog 维度、revision 也没变，于是 `readAutoSnapshot` 一直返回那份空段 ——
   * 整个会话的自主记忆永久为空（开关开着、笔记在盘上、模型一条都看不到），直到重启。
   *
   * 条目数与 `builtAt` 一起进键：前者管"多了/少了条目"，后者管"条目没变但正文被重写了"。
   */
  catalogKey?: string
  /**
   * 笔记风格（`noteStyle` + 自定义风格的内容）。
   *
   * **必须进键**：风格行是渲染产物的一部分，工作区块把它烤进了缓存的正文。少了这一维，
   * 用户在设置里换了风格，工作区块直到下一次无关的 revision 才会跟着变 —— 而全局块每次
   * 用新算的 `styleLine` 拼正文、被字节比对后重发，于是两段显示的是**两种风格**。
   */
  noteStyle?: string
  /**
   * 压缩代数（见 `compactionEpochOf`）。
   *
   * **必须进键**：压缩后模型上下文里的旧记忆正文已经没了，差集建立在一个它不记得的
   * 基线上。代数一变，下一轮自然回全量重发。
   */
  compactionEpoch?: number
}

export function autoSnapshotKey(parts: AutoSnapshotKeyParts): string {
  return [
    parts.layer,
    parts.sessionId ?? '-',
    parts.workspaceHash ?? '-',
    parts.scenes.join(','),
    parts.enabled ? '1' : '0',
    String(parts.revision ?? 0),
    String(parts.totalBytes ?? 0),
    String(parts.reservedBytes ?? 0),
    parts.catalogKey ?? '-',
    parts.noteStyle ?? '-',
    String(parts.compactionEpoch ?? 0),
  ].join('|')
}

/**
 * 增量注入的**模式键**：与快照键同一组渲染环境，但**不含 revision**。
 *
 * 为什么不能复用快照键：确认 / 停用 / 删除 / 学习都会 bump revision，于是每次条目集合
 * 变化都会被判成"渲染环境变了"而回全量 —— 差集永远没机会发。条目集合的变化由
 * `entries` 差集表达（`+ / ~ / -`）；模式键只保留会改变分组与入选集合的因素
 * （场景 / 预算档 / 工作区 / 开关），这些一变才真的需要整块重发。
 */
/**
 * 每个会话的**压缩代数**：官方 `compaction/summary` 每发生一次就 +1。
 *
 * 为什么需要它：增量注入按 `entries` 差集只发变化的那几条，前提是「模型上下文里已经有
 * 上一版整段」。压缩会把中间那几轮对话折叠成摘要 —— 摘要里**没有**当初注入的那份记忆
 * 正文，差集于是建立在模型已经不记得的内容上：它看到 `+ 1 条`，却不知道原有的是哪些。
 * 所以压缩后必须回全量重发一次。
 *
 * 为什么不直接清会话快照：快照存在以 agent 对象为键的 `WeakMap` 里，而压缩事件只有
 * sessionId —— 拿不到那个对象。代数进模式键就能让下一次渲染自然判"环境变了"。
 *
 * 上限 512 条：键只是会话 id 字符串，丢了最多让那个会话的下一轮多回一次全量。
 *
 * **必须与 `snapshots` 同模块**：热重载会同时丢掉两者。只重置其中一个的话 —— 代数归 0
 * 而快照还在 —— 那个会话会被判成"压缩过又回到 0"，白回一次全量；反过来则永远不回全量。
 */
const COMPACTION_EPOCHS = new Map<string, number>()
const COMPACTION_EPOCHS_MAX = 512

export function compactionEpochOf(sessionId: string | undefined): number {
  if (sessionId === undefined || sessionId === '') return 0
  return COMPACTION_EPOCHS.get(sessionId) ?? 0
}

/**
 * 记一次压缩：该会话的下一轮注入回全量。
 *
 * 幂等性：重复调用只是把代数推得更高，代价是下一次多回一次全量，不会漏发也不会重复发。
 */
export function noteCompaction(sessionId: string | undefined): void {
  if (sessionId === undefined || sessionId === '') return
  if (COMPACTION_EPOCHS.size >= COMPACTION_EPOCHS_MAX && !COMPACTION_EPOCHS.has(sessionId)) {
    const oldest = COMPACTION_EPOCHS.keys().next()
    if (!oldest.done) COMPACTION_EPOCHS.delete(oldest.value)
  }
  COMPACTION_EPOCHS.set(sessionId, (COMPACTION_EPOCHS.get(sessionId) ?? 0) + 1)
}

export function autoIncrementalModeKey(parts: Omit<AutoSnapshotKeyParts, 'revision'>): string {
  // 显式写回 0：类型上 `parts` 没有 revision，但 JS 调用方仍可能带着它进来，
  // 直接透传会让模式键又变回快照键。
  //
  // `reservedBytes` 同样清零。它表示「更高优先级内容已占掉的字节」，也就是**还剩多少余量**。
  // 余量变化确实要重算这一层装哪几条 —— 但那是**缓存键**的职责（`autoSnapshotKey` 仍带着它，
  // 变了就重渲染）。放进模式键的后果是：用户每写一条全局记忆 / 工作区记忆，余量就变一次，
  // 模式键跟着变，`planIncremental` 判「环境变了」回全量 —— 全局记忆与工作区记忆整块重发。
  // 而余量变化的真实后果是「某几条被挤出 / 重新入选」，那正是 entries 差集能表达的 `+ / -`。
  //
  // `scenes` 也清零。自主记忆按**层**分组（全局 / 工作区），不按场景分组 —— 条目与场景
  // 无关，那一段的结构不随场景变。留在模式键里，进入 / 退出场景就会让全局域与工作区域
  // 同时判「环境变了」整块重发。快照键仍带着它（渲染时确实要按场景过滤条目）。
  return autoSnapshotKey({ ...parts, revision: 0, reservedBytes: 0, scenes: [] })
}
