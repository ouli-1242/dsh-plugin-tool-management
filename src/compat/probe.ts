/**
 * Host capability probe — the single place that decides what this plugin may
 * do to the running host's data, and why not when it may not.
 *
 * WHY THIS REPLACES THE TEXT-COMPARISON GATE
 * ------------------------------------------
 * The previous gate in `history/bridge.js` compared each host method against
 * this plugin's own copy of the official prototype with
 * `Function.prototype.toString()`. That only ever answered one question —
 * "is the host running the same release I was written against?" — and it
 * answered it with a hard throw, so a harmless upstream refactor disabled
 * whole features. It also quietly assumed the plugin and the host load two
 * *different* copies of the same package.
 *
 * The durable questions are different:
 *
 *   - IDENTITY: do the plugin and the host share the same physical module?
 *     (If yes, `===`, `instanceof` and symbol lookups cross the boundary and
 *     every "same implementation" concern disappears. Missing identity is a
 *     deployment defect, reported as such, not something to guess around.)
 *   - PRESENCE: does the live host object expose the members the adapter
 *     calls? Members are checked as live values with their shape, because a
 *     host may have been upgraded, proxied, or replaced wholesale.
 *   - BEHAVIOUR: for anything that can be observed without mutating host
 *     state, call it and look at the result — a getter that no longer returns
 *     a Map is a fact, a version string is a hint.
 *
 * Every answer is reported per capability instead of collapsing into one
 * boolean, so a caller can degrade exactly the feature that lost support and
 * leave the rest working.
 */

import { createRequire } from 'node:module'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Packages whose physical module identity matters to this plugin. */
export const IDENTITY_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-workspace',
  '@deepseek-ai/dsh-session-projection-cache',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-spill-local',
] as const

/** Peers this plugin was written and verified against. */
export const EXPECTED_PEER_RANGE = '>=0.1.5-rc.2 <0.2.0-0'
/** The release this plugin's adapters were last verified against. */
export const VERIFIED_HOST_VERSION = '0.1.5-rc.2'

export type CapabilityState = 'ok' | 'missing-member' | 'shape-mismatch' | 'not-available'

export interface CapabilityFinding {
  /** Stable id used by the UI and by logs. */
  readonly id: string
  /** Short human label (Chinese, matching the plugin's other surfaces). */
  readonly label: string
  readonly kind: 'read' | 'write' | 'delete'
  /** Which host service the capability lives on. */
  readonly owner: 'workspace' | 'projectionCache' | 'sessions' | 'persistence'
  readonly state: CapabilityState
  /** What can be done without this capability. */
  readonly fallback:
    | 'native-entry'      // an official entry point covers it
    | 'degrade-read'      // read-only feature returns empty + warns
    | 'disable-destructive' // the button is disabled with an explanation
  /** One line a user can act on. */
  readonly detail: string
  /** Members that were absent, when state is missing-member. */
  readonly missing: readonly string[]
  /**
   * Whether the member's source text still equals this plugin's own copy of
   * the implementation. Diagnostic only: with the packaging fixed the two are
   * the same function object, and where they are not, identity is the thing to
   * repair — never a reason to refuse data operations.
   */
  readonly textMatch?: boolean
  /**
   * True for slots whose ABSENCE is a routing fact rather than a failure: the
   * plugin ships its own implementation for exactly this gap, so a host without
   * the member keeps full functionality through the adapter route.
   *
   * These must never be reported as "degraded": the DSH release this plugin was
   * verified against does not have them, and telling the user that a working
   * feature is degraded (worse: "the affected buttons are disabled") is a
   * factual lie about their installation.
   */
  readonly optional?: boolean
}

export interface HostIdentity {
  readonly version: string
  /** package name -> resolved entry path, or null when unresolvable. */
  readonly modules: Record<string, string | null>
  readonly sameAsHost: Record<string, boolean | null>
  readonly blockers: readonly string[]
}

export interface HostAssessment {
  readonly identity: HostIdentity
  readonly findings: readonly CapabilityFinding[]
  /**
   * Capabilities that are genuinely unavailable — optional slots excluded.
   * `findings` remains the full picture (the UI renders every slot, marking the
   * optional-absent ones as "adapter takes over").
   */
  readonly degraded: readonly CapabilityFinding[]
  /** True when the delete operation has a viable route (native or adapter). */
  readonly mayDelete: boolean
  readonly generatedAt: number
}

/** A capability the current operation needs but the host cannot provide. */
export interface CapabilityRefusal {
  readonly id: string
  readonly label: string
  readonly detail: string
  readonly recovery: string
}

/** The slice of a host object a probe inspects. `unknown` keeps callers honest. */
type Target = Record<string, unknown> | undefined

const isFn = (value: unknown): value is (...args: unknown[]) => unknown => typeof value === 'function'

/** Resolve a package the way this plugin resolves it, without throwing. */
function safeResolve(specifier: string): string | null {
  try {
    return import.meta.resolve(specifier).replace(/^file:\/\/\//, '').replace(/\//g, process.platform === 'win32' ? '\\' : '/')
  } catch {
    try {
      return createRequire(import.meta.url).resolve(specifier)
    } catch {
      return null
    }
  }
}

/**
 * Resolve a path through every junction/symlink to its physical file.
 * Node loads modules by real path, so two different-looking paths that
 * realpath to one file ARE the same module — which is exactly the property
 * this plugin depends on, and the reason `@deepseek-ai/*` is junctioned into
 * the host installation instead of being copied.
 */
function realPathOf(value: string | null): string | null {
  if (value === null) return null
  try {
    return realpathSync.native !== undefined ? realpathSync.native(value) : realpathSync(value)
  } catch {
    return value
  }
}

/** Read a package version from a resolvable manifest. */
function versionOf(specifier: string): string | undefined {
  const entry = safeResolve(specifier)
  if (entry === null) return undefined
  let dir = dirname(entry)
  for (let i = 0; i < 4; i += 1) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string }
      if (parsed.name === specifier && typeof parsed.version === 'string') return parsed.version
    } catch {
      /* keep walking up */
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * Compare a live member with this plugin's copy of the implementation.
 * `undefined` means "not comparable" — the member is absent on the live object
 * or the reference copy does not have it either.
 */
function textMatchOf(live: unknown, reference: unknown): boolean | undefined {
  if (!isFn(live) || !isFn(reference)) return undefined
  if (live === reference) return true
  try {
    return Function.prototype.toString.call(live) === Function.prototype.toString.call(reference)
  } catch {
    return undefined
  }
}

/**
 * The prototype that defines a live instance's members, following the prototype
 * chain so proxies, subclass instances and cross-realm objects all answer
 * honestly.
 */
function prototypeOf(instance: unknown): Record<string, unknown> | undefined {
  if (instance === null || typeof instance !== 'object') return undefined
  if (typeof instance === 'function') return instance as unknown as Record<string, unknown>
  const proto: unknown = Object.getPrototypeOf(instance)
  return proto !== null && typeof proto === 'object' ? (proto as Record<string, unknown>) : undefined
}

/** Official prototypes this plugin's adapters mirror, when importable. */
function referencePrototypes(): { workspace?: Record<string, unknown>; cache?: Record<string, unknown> } {
  const out: { workspace?: Record<string, unknown>; cache?: Record<string, unknown> } = {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ws = createRequire(import.meta.url)('@deepseek-ai/dsh-workspace') as { WorkspaceRegistry?: { prototype?: Record<string, unknown> } }
    if (ws.WorkspaceRegistry?.prototype !== undefined) out.workspace = ws.WorkspaceRegistry.prototype
  } catch { /* optional in tests and in trimmed deployments */ }
  try {
    const pc = createRequire(import.meta.url)('@deepseek-ai/dsh-session-projection-cache') as { SessionProjectionCache?: { prototype?: Record<string, unknown> } }
    if (pc.SessionProjectionCache?.prototype !== undefined) out.cache = pc.SessionProjectionCache.prototype
  } catch { /* optional in tests */ }
  return out
}

interface CapabilitySpec {
  readonly id: string
  readonly label: string
  readonly kind: 'read' | 'write' | 'delete'
  readonly owner: CapabilityFinding['owner']
  readonly fallback: CapabilityFinding['fallback']
  /** Required function members on the owning object's prototype. */
  readonly methods?: readonly string[]
  /** Required non-function members, checked for `instanceof` when given. */
  readonly fields?: readonly { readonly name: string; readonly instanceOf?: 'Map' | 'Array' | 'Set' }[]
  /** Extra live behaviour check; returns a failure detail or undefined. */
  readonly probe?: (target: Target) => string | undefined
  /** Members that must be callable when the capability applies. */
  readonly when?: (target: Target) => boolean
  /** Absence is a routing fact, not a failure — see {@link CapabilityFinding.optional}. */
  readonly optional?: boolean
}

/**
 * The capability table. This IS the contract with the host: everything the
 * adapters reach for is listed here with what happens when it is absent, so a
 * missing member produces a named, visible degradation instead of a throw from
 * somewhere in the middle of a delete sequence.
 */
const CAPABILITY_SPECS: readonly CapabilitySpec[] = [
  // ---- workspace registry: read side -------------------------------------
  {
    id: 'workspace.read-state',
    label: '读取工作区状态',
    kind: 'read',
    owner: 'workspace',
    fallback: 'degrade-read',
    methods: ['requireState'],
    probe: (t) => {
      try {
        const state = (t as { requireState: () => unknown }).requireState()
        if (state === null || typeof state !== 'object') return 'requireState() 未返回对象'
        const value = state as { archivedSessionIds?: unknown; workspaceIds?: unknown }
        if (!Array.isArray(value.archivedSessionIds)) return 'requireState().archivedSessionIds 不是数组'
        if (!Array.isArray(value.workspaceIds)) return 'requireState().workspaceIds 不是数组'
        return undefined
      } catch (error) {
        return `requireState() 抛错：${String((error as Error)?.message ?? error)}`
      }
    },
  },
  {
    id: 'workspace.read-table',
    label: '读取工作区表',
    kind: 'read',
    owner: 'workspace',
    fallback: 'degrade-read',
    methods: ['requireTable'],
    probe: (t) => {
      try {
        const table = (t as { requireTable: () => unknown }).requireTable()
        if (table === null || typeof table !== 'object' || !isFn((table as { get?: unknown }).get)) return 'requireTable() 未返回可 get 的表'
        return undefined
      } catch (error) {
        return `requireTable() 抛错：${String((error as Error)?.message ?? error)}`
      }
    },
  },
  {
    id: 'workspace.index-shape',
    label: '工作区索引结构',
    kind: 'read',
    owner: 'workspace',
    fallback: 'degrade-read',
    fields: [
      { name: 'headers', instanceOf: 'Map' },
      { name: 'sessionPaths', instanceOf: 'Map' },
      { name: 'invalidSessionPaths', instanceOf: 'Map' },
      { name: 'entities', instanceOf: 'Map' },
    ],
  },
  {
    id: 'workspace.read-header',
    label: '读取会话头部',
    kind: 'read',
    owner: 'workspace',
    fallback: 'degrade-read',
    methods: ['readSessionHeader'],
  },
  // ---- workspace registry: write side ------------------------------------
  {
    id: 'workspace.enqueue',
    label: '串行写事务',
    kind: 'write',
    owner: 'workspace',
    fallback: 'disable-destructive',
    methods: ['enqueueOperation'],
  },
  {
    id: 'workspace.set-state',
    label: '写工作区状态',
    kind: 'write',
    owner: 'workspace',
    fallback: 'disable-destructive',
    methods: ['setState'],
  },
  {
    id: 'workspace.index-header',
    label: '索引会话头部',
    kind: 'write',
    owner: 'workspace',
    fallback: 'disable-destructive',
    methods: ['indexHeader'],
  },
  {
    id: 'workspace.archive-native',
    label: '宿主原生归档入口',
    kind: 'write',
    owner: 'workspace',
    fallback: 'native-entry',
    methods: ['archiveSession'],
    optional: true,
  },
  {
    id: 'workspace.unarchive-native',
    label: '宿主原生恢复入口',
    kind: 'write',
    owner: 'workspace',
    fallback: 'native-entry',
    methods: ['unarchiveSession'],
    optional: true,
  },
  {
    id: 'workspace.batch-native',
    label: '宿主原生批量入口',
    kind: 'write',
    owner: 'workspace',
    fallback: 'native-entry',
    methods: ['archiveWorkspaceSessions'],
    optional: true,
  },
  {
    id: 'workspace.delete-native',
    label: '宿主原生删除入口',
    kind: 'delete',
    owner: 'workspace',
    // NOT `disable-destructive`: when this slot is empty the plugin performs the
    // whole delete itself, so nothing is disabled. `native-entry` describes what
    // actually happens (the adapter takes over).
    fallback: 'native-entry',
    methods: ['deleteSession'],
    optional: true,
  },
  // ---- sessions runtime (private members, used only on the live branch) ---
  {
    id: 'sessions.detach-live',
    label: '实时会话落盘与分离',
    kind: 'delete',
    owner: 'sessions',
    fallback: 'disable-destructive',
    methods: ['flush', 'liveEntryFor', 'detachEntered'],
  },
  {
    id: 'sessions.cold-announce',
    label: '冷会话移除广播',
    kind: 'delete',
    owner: 'sessions',
    fallback: 'disable-destructive',
    methods: ['enter', 'announce'],
  },
  // ---- projection cache ---------------------------------------------------
  {
    id: 'projection.write',
    label: '投影缓存写入路径',
    kind: 'write',
    owner: 'projectionCache',
    fallback: 'disable-destructive',
    methods: ['write', 'put', 'requireTable'],
  },
  {
    id: 'projection.delete-native',
    label: '投影缓存删除屏障',
    kind: 'delete',
    owner: 'projectionCache',
    // Absent on rc.2: `history/bridge.js` installs a checked write barrier
    // instead, so absence is a routing fact, not a failure. Only a cache whose
    // write path cannot be wrapped at all is a real problem.
    fallback: 'native-entry',
    optional: true,
    probe: (t) => {
      if (isFn(t?.delete) && isFn(t?.whenIdle)) return undefined
      const wrappable = ['write', 'put'].filter((name) => !isFn(t?.[name]))
      if (wrappable.length > 0) return `宿主缓存无法安全包裹（缺少 ${wrappable.join(', ')}）`
      let table: unknown
      try {
        table = (t as { requireTable: () => unknown }).requireTable()
      } catch (error) {
        return `requireTable() 抛错：${String((error as Error)?.message ?? error)}`
      }
      if (!isFn((table as { delete?: unknown })?.delete)) return '宿主缓存存储不支持行删除（table.delete 缺失）'
      return undefined
    },
  },
]

/**
 * The capability sets each operation depends on, grouped by how the plugin
 * reaches the same outcome when a member is missing. Order matters: the first
 * viable route wins.
 *
 * - `native`: host entry points that already implement the whole operation.
 * - `adapter`: the checked compatibility adapter (the only route that touches
 *   private members), used when the host has no native entry.
 */
export const OPERATION_ROUTES = {
  archive: { native: ['workspace.archive-native'], adapter: ['workspace.enqueue', 'workspace.set-state'] },
  unarchive: { native: ['workspace.unarchive-native'], adapter: ['workspace.enqueue', 'workspace.set-state'] },
  batch: { native: ['workspace.batch-native'], adapter: ['workspace.enqueue', 'workspace.set-state'] },
  delete: {
    native: ['workspace.delete-native'],
    // NOTE: `projection.delete-native` is deliberately NOT a route requirement.
    // A host cache without its own delete barrier is expected on rc.2; the
    // bridge wraps it (`workspace.js` / `history/bridge.js`) and reports a
    // refusal itself when even that is impossible. Requiring the native barrier
    // here would disable deletion on exactly the host this plugin was verified
    // against.
    adapter: [
      'workspace.enqueue', 'workspace.set-state', 'workspace.index-header',
      'sessions.detach-live', 'sessions.cold-announce', 'projection.write',
    ],
  },
  list: { native: [], adapter: ['workspace.read-state', 'workspace.read-table', 'workspace.index-shape'] },
} as const satisfies Record<string, { native: readonly string[]; adapter: readonly string[] }>

export type OperationName = keyof typeof OPERATION_ROUTES

/** Texts a user can act on, per capability, when it is the reason for a refusal. */
function recoveryFor(_finding: CapabilityFinding): string {
  return `宿主 ${VERIFIED_HOST_VERSION} 的该项能力未通过探测；请更新本插件到与本机 DSH 匹配的版本，或改用宿主原生入口（先运行 node scripts/doctor.mjs 查看差异）。`
}

/**
 * One capability's result. `target` is the live host object; `reference` is
 * this plugin's copy of the same implementation when the package is importable.
 */
function inspectCapability(spec: CapabilitySpec, target: Target, reference: Record<string, unknown> | undefined): CapabilityFinding {
  const base = {
    id: spec.id,
    label: spec.label,
    kind: spec.kind,
    owner: spec.owner,
    fallback: spec.fallback,
    ...(spec.optional === true ? { optional: true } : {}),
  }
  if (target === undefined || target === null) {
    return { ...base, state: 'not-available', detail: '宿主未提供该服务（ctx.get 返回 undefined）', missing: [] }
  }
  if (spec.when !== undefined && !spec.when(target)) {
    return { ...base, state: 'ok', detail: '当前分支不需要（按实时/冷会话路径判定）', missing: [] }
  }

  const missing: string[] = []
  let textMatch: boolean | undefined
  for (const name of spec.methods ?? []) {
    const live = (target as Record<string, unknown>)[name]
    if (!isFn(live)) {
      missing.push(name)
      continue
    }
    const match = textMatchOf(live, reference?.[name])
    if (match === false && textMatch !== false) textMatch = false
    else if (match === true && textMatch === undefined) textMatch = true
  }
  for (const field of spec.fields ?? []) {
    const value = (target as Record<string, unknown>)[field.name]
    if (field.instanceOf === 'Map' && !(value instanceof Map)) missing.push(`${field.name}(非 Map)`)
    else if (field.instanceOf === 'Array' && !Array.isArray(value)) missing.push(`${field.name}(非数组)`)
    else if (field.instanceOf === 'Set' && !(value instanceof Set)) missing.push(`${field.name}(非 Set)`)
  }
  if (missing.length > 0) {
    return {
      ...base,
      state: 'missing-member',
      detail: `宿主实现缺少 ${missing.join(', ')}`,
      missing,
      ...(textMatch === undefined ? {} : { textMatch }),
    }
  }
  if (spec.probe !== undefined) {
    const failure = spec.probe(target)
    if (failure !== undefined) {
      return { ...base, state: 'shape-mismatch', detail: failure, missing: [], ...(textMatch === undefined ? {} : { textMatch }) }
    }
  }
  return {
    ...base,
    state: 'ok',
    detail: textMatch === false ? '成员齐备（实现文本与本插件适配的版本不同，按能力使用）' : '成员齐备',
    missing: [],
    ...(textMatch === undefined ? {} : { textMatch }),
  }
}

/**
 * Capability ids whose absence is a routing fact rather than a failure: the
 * plugin substitutes its own implementation. They never appear as degraded and
 * never block a route.
 *
 * Superseded by {@link CapabilityFinding.optional}, which marks the same fact on
 * the finding itself (the UI and the doctor both read that flag). Kept as the
 * exported id list so callers can ask "which slots does the plugin itself back?"
 * without duplicating the table.
 */
export const SUBSTITUTED_CAPABILITIES: readonly string[] = CAPABILITY_SPECS
  .filter((spec) => spec.optional === true)
  .map((spec) => spec.id)

/**
 * Inspect the live host behind one plugin context.
 *
 * Everything is read-only: the only host code paths touched are getters and
 * `requireState()`/`requireTable()`, both of which the plugin already calls on
 * every list request. A failure inside a probe is a finding, never a throw.
 *
 * @param ctx - the plugin's cordis context.
 * @returns the assessment snapshot surfaced to the UI, the tools and the log.
 */
export function assessHost(ctx: {
  get?: (name: string) => unknown
  sessions?: unknown
  sessionPersistence?: unknown
}): HostAssessment {
  const get = (name: string): unknown => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  // Cordis exposes traceable proxies; compare and inspect the original objects.
  const unwrap = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value
    try {
      const original = (value as Record<symbol, unknown>)[Symbol.for('cordis.original')]
      if (original !== undefined) return original
    } catch { /* ignore */ }
    return value
  }

  const registry = unwrap(get('workspaceRegistry')) as Target
  const cache = unwrap(get('sessionProjectionCache')) as Target
  const sessions = unwrap(ctx.sessions !== undefined ? ctx.sessions : get('sessions')) as Target

  const references = referencePrototypes()
  const targets: Record<CapabilitySpec['owner'], { target: Target; reference?: Record<string, unknown> }> = {
    workspace: { target: registry, reference: references.workspace },
    projectionCache: { target: cache, reference: references.cache },
    sessions: { target: sessions, reference: undefined },
    persistence: { target: unwrap(get('sessionPersistence')) as Target, reference: undefined },
  }

  const findings = CAPABILITY_SPECS.map((spec) => {
    const slot = targets[spec.owner]
    return inspectCapability(spec, slot.target, slot.reference)
  })

  // Identity: is the plugin loading the same physical modules the host runs?
  const modules: Record<string, string | null> = {}
  const sameAsHost: Record<string, boolean | null> = {}
  const blockers: string[] = []
  const hostRoot = hostPackageRoot()
  for (const name of IDENTITY_PACKAGES) {
    const resolved = safeResolve(name)
    modules[name] = resolved
    if (resolved === null) {
      sameAsHost[name] = null
      blockers.push(`${name}：无法解析`)
      continue
    }
    if (hostRoot === null) {
      sameAsHost[name] = null
      continue
    }
    // Resolve the same name from the host installation's own anchor, then
    // compare PHYSICAL files: a junction is the same module, not a copy.
    let hostResolved: string | null = null
    try {
      const hostRequire = createRequire(join(dirname(hostRoot), 'package.json'))
      hostResolved = hostRequire.resolve(name)
    } catch {
      hostResolved = null
    }
    const same = hostResolved === null ? null : realPathOf(hostResolved) === realPathOf(resolved)
    sameAsHost[name] = same
    if (same === false) blockers.push(`${name}：插件与宿主加载的是两份不同拷贝（运行 node scripts/host-deps.mjs --fix）`)
  }

  // Degraded = something is genuinely unavailable. Optional slots are excluded:
  // their absence selects the adapter route and leaves the feature fully
  // working, so listing them here would tell the user a working feature is
  // broken (and, with the destructive wording, that its buttons are disabled).
  const degraded = findings.filter((finding) => finding.state !== 'ok' && finding.optional !== true)
  // Deletion is possible when SOME route reaches it. The optional native
  // delegate slots (`workspace.delete-native`, `workspace.unarchive-native`,
  // `workspace.batch-native`) are expected to be ABSENT on hosts whose official
  // API lacks those entry points — that absence selects the adapter route, it
  // does not mean deletion is impossible.
  const delta = routeFor({ findings }, 'delete').via !== 'none'
  return {
    identity: {
      version: versionOf('@deepseek-ai/dsh-workspace') ?? 'unknown',
      modules,
      sameAsHost,
      blockers,
    },
    findings,
    degraded,
    mayDelete: delta,
    generatedAt: Date.now(),
  }
}

/** True when two paths denote the same file; falls back to string equality. */
function samePath(a: string, b: string): boolean {
  const normalize = (value: string): string => value.replace(/\\/g, '/').toLowerCase()
  return normalize(realPathOf(a) ?? a) === normalize(realPathOf(b) ?? b)
}

/**
 * The `@deepseek-ai` directory of the DSH installation this plugin is attached
 * to, derived from where a shared package physically lives.
 *
 * Anchoring on the resolved entry rather than on `require.resolve('@deepseek-ai/dsh')`
 * matters: the plugin never imports the `dsh` app package, so it need not be
 * resolvable from the plugin at all — only the shared libraries are.
 */
function hostPackageRoot(): string | null {
  for (const anchor of IDENTITY_PACKAGES) {
    const resolved = realPathOf(safeResolve(anchor))
    if (resolved === null) continue
    let dir = dirname(resolved)
    for (let i = 0; i < 3; i += 1) {
      if (dir.endsWith(join('node_modules', '@deepseek-ai'))) return dir
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return null
}

/** Human-readable summary line for logs and the settings page header. */
export function summarize(assessment: HostAssessment): string {
  const total = assessment.findings.length
  const ok = total - assessment.degraded.length
  const state = assessment.degraded.length === 0 ? '全部可用' : `降级 ${assessment.degraded.length} 项`
  return `宿主 ${assessment.identity.version} · 能力 ${ok}/${total} · ${state}`
}

/** Findings by id, for route decisions. */
export function findingsById(assessment: Pick<HostAssessment, 'findings'>): Map<string, CapabilityFinding> {
  return new Map(assessment.findings.map((finding) => [finding.id, finding]))
}

/** Refusals for every degraded capability in the list, in list order. */
export function refusalsFor(assessment: Pick<HostAssessment, 'findings'>, ids: readonly string[]): CapabilityRefusal[] {
  const index = findingsById(assessment)
  const out: CapabilityRefusal[] = []
  for (const id of ids) {
    const finding = index.get(id)
    if (finding === undefined || finding.state === 'ok') continue
    out.push({ id: finding.id, label: finding.label, detail: finding.detail, recovery: recoveryFor(finding) })
  }
  return out
}

export interface RouteDecision {
  /** `native` prefers official entry points; `adapter` is the checked adapter. */
  readonly via: 'native' | 'adapter' | 'none'
  readonly refusals: readonly CapabilityRefusal[]
}

/**
 * Choose how one operation should reach the host.
 *
 * Never silently falls back from a partially available route into a destructive
 * one: a route is chosen only when every capability it needs is `ok`.
 *
 * @param assessment - latest host assessment.
 * @param operation - operation name from {@link OPERATION_ROUTES}.
 * @returns the route to take plus, when `none`, what is missing and why.
 */
export function routeFor(assessment: Pick<HostAssessment, 'findings'>, operation: OperationName): RouteDecision {
  const routes = OPERATION_ROUTES[operation]
  const index = findingsById(assessment)
  const allOk = (ids: readonly string[]): boolean =>
    ids.every((id) => {
      const finding = index.get(id)
      // A capability that the host does not expose at all cannot block a route
      // it is not part of; absent ids are treated as satisfied.
      return finding === undefined || finding.state === 'ok'
    })
  if (routes.native.length > 0 && allOk(routes.native)) return { via: 'native', refusals: [] }
  if (allOk(routes.adapter)) return { via: 'adapter', refusals: [] }
  const needed = routes.native.length > 0 ? [...new Set([...routes.native, ...routes.adapter])] : routes.adapter
  const refusals = refusalsFor(assessment, needed)
  if (refusals.length > 0) return { via: 'none', refusals }
  return {
    via: 'none',
    refusals: [{
      id: operation,
      label: operation,
      detail: '宿主未提供该操作的任何可用路径',
      recovery: recoveryFor({ id: operation } as CapabilityFinding),
    }],
  }
}

/**
 * The error a refused operation throws. Kept as a distinct class so callers can
 * tell "the host cannot do this safely" from "the operation failed".
 */
export class CapabilityRefusalError extends Error {
  readonly operation: string
  readonly refusals: readonly CapabilityRefusal[]
  constructor(operation: string, refusals: readonly CapabilityRefusal[]) {
    super(
      `宿主不支持该操作（${operation}）：`
      + refusals.map((item) => `${item.label} — ${item.detail}`).join('；')
      + '。为避免用未知实现改动数据，操作在任何写入之前停止。'
      + (refusals[0]?.recovery !== undefined ? ` ${refusals[0].recovery}` : ''),
    )
    this.name = 'CapabilityRefusalError'
    this.operation = operation
    this.refusals = refusals
  }
}

/** Throw unless the assessment allows the operation through some route. */
export function requireRoute(assessment: Pick<HostAssessment, 'findings'>, operation: OperationName): RouteDecision {
  const decision = routeFor(assessment, operation)
  if (decision.via === 'none') throw new CapabilityRefusalError(operation, decision.refusals)
  return decision
}
