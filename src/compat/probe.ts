/**
 * Host capability probe — the single place that decides what this plugin may
 * do to the running host's data, and why not when it may not.
 *
 * WHY THIS REPLACES THE TEXT-COMPARISON GATE
 * ------------------------------------------
 * The previous gate in `sessions/bridge.ts` compared each host method against
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

/** Peers this plugin was written and verified against（只声明最低版本，无上界）。 */
export const EXPECTED_PEER_RANGE = '>=0.1.5-rc.2'
/** The release this plugin's adapters were last verified against. */
export const VERIFIED_HOST_VERSION = '0.1.5-rc.2'
/**
 * peer range 的下界 —— 界面展示用。
 *
 * 刻意不带 semver 上界：官方持续发版，硬上界会在宿主跨 minor 升级时直接挡住
 * 插件安装（pnpm peer 校验失败）。上界改为由**运行时能力探测**兜底 ——
 * 宿主版本高于已验证范围时，`assessHost` 会逐项探测并把缺失能力降级/禁用，
 * 而不是在安装期拒绝整包。展示时只应把「最低要求版本」当事实。
 * 从 EXPECTED_PEER_RANGE 派生，避免两处手写漂移。
 */
export const EXPECTED_MIN_HOST_VERSION =
  EXPECTED_PEER_RANGE.match(/^>=\s*([^\s]+)/)?.[1] ?? VERIFIED_HOST_VERSION

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
    | 'refuse-operation'  // routeFor() returns `none`: the operation is refused, not degraded
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
  /**
   * 已解析到、但**没能与宿主比对**的包（宿主的解析锚点里找不到它）。
   * 与 `sameAsHost === false`（两份拷贝）性质不同：那是"比过了、不一样"，
   * 这是"压根没比成"。界面据此显式说明，不让它退化成看不懂的「无法比对」。
   */
  readonly unverified: readonly string[]
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

// The official package + class each capability owner's members live on. This is
// the single answer to "which class defines this owner" — both the live
// reference-prototype lookup below and the exported static table read it, so a
// host drift is described in exactly one place.
const WORKSPACE_CLASS = { pkg: '@deepseek-ai/dsh-workspace', target: 'WorkspaceRegistry' } as const
const PROJECTION_CLASS = { pkg: '@deepseek-ai/dsh-session-projection-cache', target: 'SessionProjectionCache' } as const
// `sessions.*` members are host-private members, but they are still declared on
// an official class: `@deepseek-ai/dsh-session` is a peer this plugin declares,
// and `SessionStore` is where `flush`/`liveEntryFor`/`detachEntered`/`enter`/
// `announce` live. Without this entry the doctor could not see the two
// capabilities the delete route depends on.
const SESSIONS_CLASS = { pkg: '@deepseek-ai/dsh-session', target: 'SessionStore' } as const
const OWNER_CLASSES: Partial<Record<CapabilityFinding['owner'], { readonly pkg: string; readonly target: string }>> = {
  workspace: WORKSPACE_CLASS,
  projectionCache: PROJECTION_CLASS,
  sessions: SESSIONS_CLASS,
}

/** The named export's prototype, or undefined when the package is absent/trimmed. */
function classPrototypeOf(ref: { pkg: string; target: string }): Record<string, unknown> | undefined {
  try {
    const mod = createRequire(import.meta.url)(ref.pkg) as Record<string, unknown>
    const klass = mod[ref.target] as { prototype?: Record<string, unknown> } | undefined
    return klass?.prototype
  } catch {
    return undefined // optional in tests and in trimmed deployments
  }
}

/**
 * 哨兵值：不可能命中任何真实会话/工作区（会话 id 由宿主生成，不含此串）。
 * 行为探针真调宿主方法时一律传它 —— 最坏情形是宿主受控拒绝（not found），
 * 而「哨兵输入都能产生意外效果」本身就是要探出来的「不该路由信任」。
 */
const PROBE_SENTINEL = '__dshm_probe_never_exists__'

/**
 * 用哨兵实参**真调**一个宿主方法（2026-09-19 分层探针第二层），验证「存在且可调用」：
 * - 同步抛 `TypeError` → 实现坏了/签名漂移，返回失败详情（shape-mismatch）；
 * - 受控同步拒绝（普通 `Error`，如 not found）或返回值（含 rejected Promise）→ 通过。
 *
 * 只判同步段：探针框架是同步的（`assessHost` 不能 await），异步结果分类留待
 * 异步化改造（见审查 07 跟进项）。返回的 Promise 一律挂 `.catch` 吞掉，探针
 * 不制造 unhandled rejection。调用必须以 `target` 为 receiver —— 私有方法全靠
 * `this.*` 拿内部状态，脱离 receiver 调用会把好实现误判成 TypeError。
 *
 * 副作用口径（按官方源码逐个核过）：liveEntryFor/announce/flush 哨兵输入在
 * 查表处受控抛错，零副作用；detachEntered 传普通对象在未知 id 处早退；
 * deleteSession/archiveSession 等原生入口对未知 id 是读路径校验后受控拒绝。
 * `enter` 不在此列（会往 store 里写哨兵条目），它只做存在性 + 文本比对。
 */
function callableWithSentinel(target: Target, name: string, ...args: unknown[]): string | undefined {
  try {
    const method = (target as Record<string, unknown>)[name]
    if (!isFn(method)) return `${name} 不是函数（methods 检查应已拦下，此处兜底）`
    const returned = method.call(target, ...args)
    if (returned !== null && typeof returned === 'object' && isFn((returned as { then?: unknown }).then)) {
      const settled = returned as { catch?: (onRejected: () => void) => unknown }
      if (isFn(settled.catch)) settled.catch(() => {})
    }
    return undefined
  } catch (error) {
    if (error instanceof TypeError) return `${name} 哨兵真调抛 TypeError：${String((error as Error)?.message ?? error)}`
    return undefined
  }
}

/** Official prototypes this plugin's adapters mirror, when importable. */
function referencePrototypes(): { workspace?: Record<string, unknown>; cache?: Record<string, unknown>; sessions?: Record<string, unknown> } {
  const out: { workspace?: Record<string, unknown>; cache?: Record<string, unknown>; sessions?: Record<string, unknown> } = {}
  const workspace = classPrototypeOf(WORKSPACE_CLASS)
  if (workspace !== undefined) out.workspace = workspace
  const cache = classPrototypeOf(PROJECTION_CLASS)
  if (cache !== undefined) out.cache = cache
  // sessions 的五个私有方法全声明在官方 SessionStore.prototype 上（本插件 peer 依赖
  // 同包同版本），与 workspace/cache 同机制接入文本比对 —— 此前该域只有存在性检查。
  const sessions = classPrototypeOf(SESSIONS_CLASS)
  if (sessions !== undefined) out.sessions = sessions
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
    fallback: 'refuse-operation',
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
    fallback: 'refuse-operation',
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
    fallback: 'refuse-operation',
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
    fallback: 'refuse-operation',
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
    // 分层探针第二层（哨兵真调）：官方实现对未知 id 走读路径校验后受控拒绝
    //（WorkspaceUnknownSessionError）；同步 TypeError 才是「不该路由信任」的信号。
    probe: (t) => callableWithSentinel(t, 'archiveSession', PROBE_SENTINEL),
  },
  {
    id: 'workspace.unarchive-native',
    label: '宿主原生恢复入口',
    kind: 'write',
    owner: 'workspace',
    fallback: 'native-entry',
    methods: ['unarchiveSession'],
    optional: true,
    probe: (t) => callableWithSentinel(t, 'unarchiveSession', PROBE_SENTINEL),
  },
  {
    id: 'workspace.batch-native',
    label: '宿主原生批量入口',
    kind: 'write',
    owner: 'workspace',
    fallback: 'native-entry',
    methods: ['archiveWorkspaceSessions'],
    optional: true,
    probe: (t) => callableWithSentinel(t, 'archiveWorkspaceSessions', [PROBE_SENTINEL]),
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
    // 删除路由的 native 判定此前只看方法存在（07 审查五档问题 2）：宿主升级把同名
    // 方法换成别的签名，路由仍会走 native 裸调。哨兵真调把口径提到「可调用」，
    // 文本比对收紧（见 inspectCapability 的 delete 类分支）负责「实现漂移」那一层。
    probe: (t) => callableWithSentinel(t, 'deleteSession', PROBE_SENTINEL),
  },
  // ---- sessions runtime (private members, used only on the live branch) ---
  {
    id: 'sessions.detach-live',
    label: '实时会话落盘与分离',
    kind: 'delete',
    owner: 'sessions',
    fallback: 'disable-destructive',
    methods: ['flush', 'liveEntryFor', 'detachEntered'],
    // 零副作用真调（按官方源码核对）：liveEntryFor/flush 对哨兵在查表处受控抛错；
    // detachEntered 传普通对象在未知 id 处早退（entry 形状 {id} 即可）。
    probe: (t) =>
      callableWithSentinel(t, 'liveEntryFor', PROBE_SENTINEL)
      ?? callableWithSentinel(t, 'flush', PROBE_SENTINEL)
      ?? callableWithSentinel(t, 'detachEntered', { id: PROBE_SENTINEL }),
  },
  {
    id: 'sessions.cold-announce',
    label: '冷会话移除广播',
    kind: 'delete',
    owner: 'sessions',
    fallback: 'disable-destructive',
    methods: ['enter', 'announce'],
    // announce 哨兵真调：内部先 liveEntryFor 查表，哨兵输入在查表处受控抛错。
    // **enter 不真调**（官方实现对任意输入都会往 store 写入条目），它只有存在性 + 文本比对。
    probe: (t) => callableWithSentinel(t, 'announce', PROBE_SENTINEL),
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
    // Absent on rc.2: `sessions/bridge.ts` installs a checked write barrier
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
    // bridge wraps it (`workspace.js` / `sessions/bridge.ts`) and reports a
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
  // 删除类收紧（2026-09-19，07 审查五档问题 2）：textMatch === false 意味着宿主运行的
  // 不是本插件适配并验证过的实现（参考副本与宿主同源时恒真 —— junction 同物理文件；
  // 只有宿主升级/漂移才会 false）。读/写类维持「按能力使用」的宽口径，但删除不可逆：
  // 漂移的 flush/detachEntered/announce/deleteSession 一律不盲调，路由降级 adapter 或
  // 拒绝，恢复文案引导更新插件。bridge.js 曾因无害重构误报而移除过文本比对 —— 本次
  // 只收紧 delete 类，且参考副本不可解析时 textMatch 为 undefined，不拦截（优雅回退）。
  if (textMatch === false && spec.kind === 'delete') {
    return {
      ...base,
      state: 'shape-mismatch',
      detail: '成员齐备但实现文本与本插件适配的版本不同：删除类能力不盲调漂移实现',
      missing: [],
      textMatch,
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

/** Where a capability's members must live, for a host that is not running. */
export interface CapabilityStaticCheck {
  readonly pkg: string
  readonly target: string
  readonly members: readonly string[]
}

/** One row of the static view of the capability table. */
export interface CapabilityStatic {
  readonly id: string
  readonly label: string
  readonly kind: 'read' | 'write' | 'delete'
  readonly optional: boolean
  /** `null` = checkable only against a live instance (instance fields / behaviour dry-run). */
  readonly check: CapabilityStaticCheck | null
}

/**
 * The capability table as a *static* view: for each spec, the official class
 * whose prototype must carry the required members. This exists so a CLI without
 * a running host (the doctor) can still answer "can this build archive / delete /
 * list?".
 *
 * Derived from {@link CAPABILITY_SPECS} — the previous hand-written second table
 * drifted silently: it carried 9 of the 15 ids and missed every `sessions.*` and
 * native-slot capability the routing actually needs.
 */
export const CAPABILITY_STATIC: readonly CapabilityStatic[] = CAPABILITY_SPECS.map((spec) => {
  const ref = OWNER_CLASSES[spec.owner]
  const methods = spec.methods
  return {
    id: spec.id,
    label: spec.label,
    kind: spec.kind,
    optional: spec.optional === true,
    // A `fields`-only spec (instance Maps) and a spec whose judgement lives in
    // its `probe` have nothing a prototype can answer — they stay runtime-only.
    check: ref !== undefined && methods !== undefined && methods.length > 0
      ? { pkg: ref.pkg, target: ref.target, members: methods }
      : null,
  }
})

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
  // `Symbol.for('cordis.original')` 与 cordis 导出的 `symbols.original` 是**同一个符号**
  // （该包内即 `original: Symbol.for("cordis.original")`）。这里不 import cordis，是为了让
  // 兼容探测在宿主包加载失败时仍能工作 —— 本文件对宿主零硬依赖（见文件头的 createRequire）。
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
    sessions: { target: sessions, reference: references.sessions },
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
  const unverified: string[] = []
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
      unverified.push(name)
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
    // 解析得到、却比不了：宿主锚点里找不到它。不能静默 —— 否则整块身份校验等于没做，
    // 而页头仍报「全部可用」（pnpm 的 .pnpm 隔离目录就是这种情形，见 hostPackageRoot）。
    if (same === null) unverified.push(name)
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
      unverified,
    },
    findings,
    degraded,
    mayDelete: delta,
    generatedAt: Date.now(),
  }
}

/**
 * The `@deepseek-ai` directory of the DSH installation this plugin is attached
 * to, derived from where a shared package physically lives.
 *
 * Anchoring on the resolved entry rather than on `require.resolve('@deepseek-ai/dsh')`
 * matters: the plugin never imports the `dsh` app package, so it need not be
 * resolvable from the plugin at all — only the shared libraries are.
 *
 * 注意 pnpm：这里在 `.pnpm/<name>@<ver>/node_modules/` 布局下会返回**该包的隔离目录**
 * （那也是一个 `node_modules/@deepseek-ai`）。它本身不是问题 —— node 的解析会继续向上走到
 * 顶层 `node_modules`，所以能解析出的包集合与顶层锚点相同（实测确认）。真正的风险在
 * 调用方：从锚点解析不到的包会被判成 `same = null`，见 assessHost 里的 `unverified`。
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
