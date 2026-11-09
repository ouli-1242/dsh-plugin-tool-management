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
 * 自动段的**会话快照**。
 *
 * 为什么必须有：注入去重是按正文字节比对的。如果每学一条就重算整段，那么在一次会话里
 * 学三次，整段记忆就会重发三次 —— session 级前缀缓存全废，且模型会看到三份内容略有
 * 差别的同一段提醒。所以本会话一旦算出自动段就固定住：本会话新学的条目靠对话上下文
 * 本身（模型刚写完它，不会忘），下个会话才从注入里拿到。
 *
 * 重建条件（`key`）：会话 / 工作区 / 启用场景 / 开关状态变了。刻意**不含**条目内容 ——
 * 含了就等于"每学一条重建"，快照就没意义了。
 */
export interface AutoSnapshot {
  key: string
  text: string
  count: number
  tokens: number
  budget: number
  dropped: number
  builtAt: number
}

const snapshots = new WeakMap<object, AutoSnapshot>()

export function readAutoSnapshot(agent: object): AutoSnapshot | undefined {
  return snapshots.get(agent)
}

export function writeAutoSnapshot(agent: object, snap: AutoSnapshot): void {
  snapshots.set(agent, snap)
}

/** 强制丢弃（用户在本会话里改了自动记忆 / 切了场景时）。 */
export function dropAutoSnapshot(agent: object): void {
  snapshots.delete(agent)
}

export function autoSnapshotKey(parts: {
  sessionId?: string
  workspaceHash?: string
  scenes: string[]
  enabled: boolean
  inject: boolean
}): string {
  return [
    parts.sessionId ?? '-',
    parts.workspaceHash ?? '-',
    parts.scenes.join(','),
    parts.enabled ? '1' : '0',
    parts.inject ? '1' : '0',
  ].join('|')
}
