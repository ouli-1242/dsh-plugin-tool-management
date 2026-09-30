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
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Packages whose physical module identity matters to this plugin. */
export const IDENTITY_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-workspace',
  '@deepseek-ai/dsh-session-projection-cache',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-spill-local',
] as const

/**
 * 本插件是不是从**源码检出**跑起来的（仓库里那份，`scripts/host-deps.mjs` 就躺在旁边）。
 *
 * 用来决定「两份拷贝」那条阻塞项给什么修复指引：`scripts/` 不在 `package.json` 的
 * `files` 里（发布形态本就不该带开发者脚本），所以 npm 装出来的用户照那条指引去跑
 * 只会拿到 `MODULE_NOT_FOUND` —— 这是 issue #1 的次要问题之一。指引必须按实际形态给。
 */
const SOURCE_INSTALL = existsSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'host-deps.mjs'))

/** 供界面决定修复指引：`true` = 源码检出（`scripts/` 就在旁边），`false` = npm 安装形态。 */
export function isSourceInstall(): boolean {
  return SOURCE_INSTALL
}

/**
 * peer range 与已验证版本。
 *
 * 官方全程走 prerelease 渠道（x.y.z-rc.N），而 semver 有一条硬规则：**带 prerelease 标签的
 * 版本，只有在"同 [major,minor,patch] 元组"的比较器也带 prerelease 标签时才能匹配**。所以
 * `>=0.1.5-rc.2` 匹配不了 `0.1.7-rc.2`，`^0.2.0-rc.2` 也匹配不了 `0.2.1-rc.1`（实测：
 * `0.1.8-rc.1` / `0.2.1-rc.1` / `0.3.0-rc.1` 全部 false）—— 范围只能**逐代枚举并集**，
 * 每适配一代新 rc 就补一段（见 README 的升级清单）。
 *
 * 上界刻意不设：宿主跨代升级由**运行时能力探测**兜底（`assessHost` 逐项探测并降级），
 * 而不是在安装期拒绝整包。所以这里用不带上界的 `>=`，**不用** `^`（`^0.2.0` 的隐含上界
 * `<0.3.0` 会在宿主发稳定版 0.3.0 时把插件挡在门外 —— 与"不设上界"自相矛盾）。
 *
 * 2026-09-30 审查 §5 F9 + §5.4：这一段此前与 `package.json` 的 peerDependencies **漂移**成
 * 两种写法（这里是 `^` 三段、那里是 `>=` 两段，且下界不同）。现在两处是**同一个字符串**，
 * 并由 `test/contracts.test.mjs` 的一条断言钉住 —— 漂移会让"界面/doctor 报的范围"与
 * "安装期实际校验的范围"各说各话，而两者都自称是插件的兼容范围。
 *
 * 已知且**无法**用 range 消除的缺口（如实标注）：尚未枚举的新 rc 元组（如 0.2.1-rc.1）
 * 在 npm7+ 下会触发 ERESOLVE 告警。这不是写法问题 —— semver 规则决定了不存在能匹配
 * "任意未来 prerelease"的 range。缓解方式：README 写明宿主升级时同步这段范围，
 * 以及 `--legacy-peer-deps` 这条逃生门。
 *
 * 0.2.0-rc.2（桌面版首发）已实测通过：`assessHost` 全通过，宿主版本读得出来，
 * 归档宿主的身份判定见 `hostPackageRoot` / `isAsarPath`。所以它同时进范围与「已验证」。
 */
export const EXPECTED_PEER_RANGE = '>=0.1.7-rc.2 || >=0.2.0-rc.1'
/** The release this plugin's adapters were last verified against. */
export const VERIFIED_HOST_VERSION = '0.2.0-rc.2'
/**
 * peer range 的下界。
 *
 * 刻意不带 semver 上界：官方持续发版，硬上界会在宿主跨 minor 升级时直接挡住
 * 插件安装（pnpm peer 校验失败）。上界改为由**运行时能力探测**兜底 ——
 * 宿主版本高于已验证范围时，`assessHost` 会逐项探测并把缺失能力降级/禁用，
 * 而不是在安装期拒绝整包。
 * 从 EXPECTED_PEER_RANGE 派生，避免两处手写漂移。
 *
 * 2026-09-29 起**不再出现在界面上**（用户裁定：删掉「最低要求 ≥ …」那一行 —— 它是安装期
 * 门槛，摆在"当前宿主"卡片下面会被读成对当前宿主的断言）。保留此导出是因为它进了
 * `compat-status` 的载荷，doctor 与外部脚本可能仍在读。
 */
export const EXPECTED_MIN_HOST_VERSION =
  EXPECTED_PEER_RANGE.match(/(\d+\.\d+\.\d+(?:-rc\.\d+)?)/)?.[1] ?? VERIFIED_HOST_VERSION

export type CapabilityState = 'ok' | 'missing-member' | 'shape-mismatch' | 'not-available'

export interface CapabilityFinding {
  /** Stable id used by the UI and by logs. */
  readonly id: string
  /** Short human label (Chinese, matching the plugin's other surfaces). */
  readonly label: string
  readonly kind: 'read' | 'write' | 'delete'
  /** Which host service the capability lives on. */
  readonly owner: 'workspace' | 'projectionCache' | 'sessions' | 'persistence' | 'settings' | 'presetRoster' | 'fs' | 'plugin'
  readonly state: CapabilityState
  /** What can be done without this capability. */
  readonly fallback:
    | 'native-entry'      // an official entry point covers it
    | 'refuse-operation'  // routeFor() returns `none`: the operation is refused, not degraded
    | 'disable-destructive' // the button is disabled with an explanation
    /**
     * 只上报、不拦路：功能照常，少的是一道保险（如补丁写入的解析校验不可用）。
     * 界面据此显示「不影响写入」，而不是「相关按钮已禁用」——后者是一句假话。
     */
    | 'inform-only'
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
  /**
   * 身份校验的**说明**，不是阻塞项：讲清楚为什么这一格是「比不了」而不是「坏了」。
   *
   * 目前只有一种来源 —— 桌面版把官方包装进 `resources/app.asar`，宿主与插件物理上
   * 不可能是同一份文件（归档 vs 磁盘）。这种情况按**版本**判定并把插件的实际来源
   * 讲出来，绝不进 `blockers`：那里每一条都会把整块身份标红，并附一句让用户去
   * `host-deps.mjs --fix` 的指令 —— 而在桌面版上，那条指令只会把插件的依赖
   * junction 到 npx 缓存里另一个版本的宿主上（实测：0.2.0-rc.2 → 0.1.7-rc.2）。
   */
  readonly notes: readonly HostIdentityNote[]
}

/**
 * 一条身份说明：`kind` 只是给界面/icons 分类用的稳定标签。
 *
 * 说明里带**已判定的包清单**（不是"所有比不了的包"）：身份校验里「比不了」有多种
 * 成因，界面只有拿到这份清单，才不会把归档宿主那几个包又塞进另一句
 * 「宿主的解析锚点里找不到它」里 —— 那句话对它们不成立（锚点找得到，归档里）。
 */
export type HostIdentityNote = HostIdentityAsarNote | HostIdentityRealpathNote

/** 归档宿主：两侧版本一致、只是打包方式不同（桌面版）。 */
export interface HostIdentityAsarNote {
  readonly kind: 'asar-host'
  /** 归档文件名（如 `app.asar`），从宿主锚点里取，界面不硬编码。 */
  readonly asarName: string
  readonly hostRoot: string
  /** 归档宿主的版本；两侧版本相同才认定「同版本、打包方式不同」。 */
  readonly hostVersion: string | null
  readonly pluginVersion: string | null
  /** 已判定的包：`hostPath`/`pluginPath` 两侧都能解析到。 */
  readonly packages: readonly HostIdentityPackage[]
}

/**
 * 路径**没能取到真实形态**（realpath 失败）时的说明。
 *
 * 这一条来自 issue #1（2026-09-23）：`realPathOf()` 以前 `catch { return value }`
 * 把「这条路径不可解析」静默降级成「拿输入去比较」，于是路径问题看起来就是
 * 「插件与宿主加载的是两份不同拷贝」—— 结论是编的，用户照着它去修只会白费功夫。
 * 现在这类包给 `sameAsHost = null`（比不了），并在这里把原因原样报出来。
 */
export interface HostIdentityRealpathNote {
  readonly kind: 'realpath'
  /** 真实形态取不到的包，连同它们的解析结果与失败原因。 */
  readonly failures: readonly HostIdentityRealpathFailure[]
  /** 宿主侧的失败原因（与该包无关，整轮共用一条，故单独提出来）。 */
  readonly hostReason?: string
  /** 插件侧的失败原因。 */
  readonly pluginReason?: string
}

/** 一条 realpath 失败记录：包名 + 该侧解析到的入口 + 失败原因。 */
export interface HostIdentityRealpathFailure {
  readonly name: string
  /** `plugin`（本插件解析到的）或 `host`（宿主锚点解析到的）。 */
  readonly side: 'host' | 'plugin'
  readonly path: string
  /** `error.code` 或异常消息，原样带给用户 —— 权限与长度限制的原因长在这里。 */
  readonly reason: string
}

/** 归档宿主清单里的一项：包名 + 两侧实际解析到的入口。 */
export interface HostIdentityPackage {
  readonly name: string
  readonly hostPath: string
  readonly pluginPath: string
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

/**
 * Resolve a package the way this plugin resolves it, without throwing.
 *
 * `import.meta.resolve` 给的是**URL**：目录里带空格的路径（桌面版装在
 * `D:\DeepSeek Harness\...`）会以 `%20` 形式回来，直接当路径用会得到一个
 * 永远打不开的名字 —— 版本号读不出来（显示 `unknown`）、asar 路径也匹配不上。
 * 用 `fileURLToPath` 老实解码（它同时处理盘符与百分号转义）。
 */
function safeResolve(specifier: string): string | null {
  try {
    return fileURLToPath(import.meta.resolve(specifier))
  } catch {
    try {
      return createRequire(import.meta.url).resolve(specifier)
    } catch {
      return null
    }
  }
}

/**
 * Whether a path lives inside an electron `app.asar` archive.
 *
 * 桌面版把整个 DSH 装进 `resources/app.asar`：宿主的 `@deepseek-ai/*` 物理上就在
 * 归档里，插件（装在 `$DSH_HOME/profiles/<name>/node_modules`）在外面的磁盘上。
 * 归档里的模块**不可能**与外面的目录是同一个物理文件，`@deepseek-ai/*` 又是
 * peer（官方包由宿主提供），所以「不同路径」是这种打包方式的必然结果，不是安装
 * 故障。判据取 `.asar` 这个路径段（`join` 出来的分隔符在 Windows 上是 `\`）。
 */
function isAsarPath(value: string | null): boolean {
  if (value === null) return false
  return /[\\/][^\\/]+\.asar[\\/]/i.test(value)
}

/**
 * Resolve a path through every junction/symlink to its physical file.
 * Node loads modules by real path, so two different-looking paths that
 * realpath to one file ARE the same module — which is exactly the property
 * this plugin depends on, and the reason `@deepseek-ai/*` is junctioned into
 * the host installation instead of being copied.
 *
 * 取不到真实形态时**不再拿输入去比**（issue #1 要求）：那会把「路径不可解析」
 * 伪装成「两份不同拷贝」，给出一个编出来的结论。改由调用方把原因报成说明。
 */
function realPathWithReason(value: string | null): { path: string } | { reason: string } {
  if (value === null) return { reason: '路径为空' }
  try {
    return { path: realpathSync.native !== undefined ? realpathSync.native(value) : realpathSync(value) }
  } catch (error) {
    const detail = error as { code?: unknown; message?: unknown }
    const code = typeof detail.code === 'string' ? detail.code : ''
    const message = typeof detail.message === 'string' ? detail.message : String(error)
    return { reason: code === '' ? message : `${code} ${message}` }
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
 * Version of the package a resolved entry path belongs to: walk up until a
 * `package.json` whose `name` matches the package directory we came from.
 *
 * 与 `versionOf` 的分工：那个从**说明符**出发（要能解析），这个从**已经拿到的路径**
 * 出发。归档宿主那种「路径不同但版本相同」的判断只能用后者 —— 前者在 `.asar` 里
 * 读得动，但两边路径不同时它无法回答「这两个文件各属于哪个版本」。
 */
function versionOfPackageAt(entry: string): string | null {
  const expected = packageNameOfPath(entry)
  let dir = dirname(entry)
  for (let i = 0; i < 5; i += 1) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string }
      if (typeof parsed.version === 'string' && (expected === null || parsed.name === expected)) return parsed.version
    } catch { /* keep walking up */ }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** `.../node_modules/@scope/name/lib/index.js` -> `@scope/name` (null when the path has no such segment). */
function packageNameOfPath(entry: string): string | null {
  const parts = entry.split(/[\\/]/)
  const at = parts.lastIndexOf('node_modules')
  if (at === -1 || at + 1 >= parts.length) return null
  const first = parts[at + 1]
  if (first === undefined) return null
  if (first.startsWith('@')) {
    const second = parts[at + 2]
    return second === undefined ? null : `${first}/${second}`
  }
  return first
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
// 0.15.0 新增的两块契约面 —— 恰是 0.1.7 升级咬人的两处（prepareDocument 返回语义变了、
// read 改名 readDocument），此前不在表里，故障只能靠用户实测发现。类名按官方安装源码核对
// （dsh-settings 导出 SettingsForms；dsh-agent-preset-registry 导出 AgentPresetRegistry）。
const SETTINGS_CLASS = { pkg: '@deepseek-ai/dsh-settings', target: 'SettingsForms' } as const
const ROSTER_CLASS = { pkg: '@deepseek-ai/dsh-agent-preset-registry', target: 'AgentPresetRegistry' } as const
const OWNER_CLASSES: Partial<Record<CapabilityFinding['owner'], { readonly pkg: string; readonly target: string }>> = {
  workspace: WORKSPACE_CLASS,
  projectionCache: PROJECTION_CLASS,
  sessions: SESSIONS_CLASS,
  settings: SETTINGS_CLASS,
  presetRoster: ROSTER_CLASS,
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
function referencePrototypes(): {
  workspace?: Record<string, unknown>
  cache?: Record<string, unknown>
  sessions?: Record<string, unknown>
  settings?: Record<string, unknown>
  roster?: Record<string, unknown>
} {
  const out: NonNullable<ReturnType<typeof referencePrototypes>> = {}
  const workspace = classPrototypeOf(WORKSPACE_CLASS)
  if (workspace !== undefined) out.workspace = workspace
  const cache = classPrototypeOf(PROJECTION_CLASS)
  if (cache !== undefined) out.cache = cache
  // sessions 的五个私有方法全声明在官方 SessionStore.prototype 上（本插件 peer 依赖
  // 同包同版本），与 workspace/cache 同机制接入文本比对 —— 此前该域只有存在性检查。
  const sessions = classPrototypeOf(SESSIONS_CLASS)
  if (sessions !== undefined) out.sessions = sessions
  // 两块新契约面的参考副本：包不在 devDeps/宿主锚点里时优雅缺省（textMatch 记 undefined），
  // 存在性探测不依赖它们。
  const settings = classPrototypeOf(SETTINGS_CLASS)
  if (settings !== undefined) out.settings = settings
  const roster = classPrototypeOf(ROSTER_CLASS)
  if (roster !== undefined) out.roster = roster
  return out
}

interface CapabilitySpec {
  readonly id: string
  readonly label: string
  readonly kind: 'read' | 'write' | 'delete'
  // 这里不写 `CapabilityFinding['owner']`：那张表的 owner 还允许 `'plugin'`（运行时上报的行，
  // 如补丁写入校验不可用），而宿主能力表只可能挂在宿主对象上 —— 写宽了会让下面的
  // `targets: Record<CapabilitySpec['owner'], …>` 强制多出一个不存在的宿主对象。
  readonly owner: 'workspace' | 'projectionCache' | 'sessions' | 'persistence' | 'settings' | 'presetRoster' | 'fs'
  readonly fallback: CapabilityFinding['fallback']
  /** Required function members on the owning object's prototype. */
  readonly methods?: readonly string[]
  /** Required non-function members, checked for `instanceof` when given. */
  readonly fields?: readonly { readonly name: string; readonly instanceOf?: 'Map' | 'Array' | 'Set' }[]
  /** Extra live behaviour check; returns a failure detail or undefined. */
  readonly probe?: (target: Target) => string | undefined
  /**
   * Optional extra text appended to the ok detail — how a spec shows what it
   * OBSERVED on the live host (e.g. the settings document path). 返回 undefined
   * 就不加后缀。健康行也带观测值：官方下一次改返回语义，页面上那行字一眼见底，
   * 而不必等到哪个功能静默失明（0.15.0 的教训）。
   */
  readonly describe?: (target: Target) => string | undefined
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
    // B2：此前它只是 bridge 运行时那句拒绝里的**临时 id**（`acquireCacheGuard` 里现场拼的），
    // 于是客户端压根不知道它 —— 宿主表不可删时，"路由说可用、点下去必拒"（V13）。提升为
    // 能力表的正式条目后，路由判定与运行时前提同一份依据。
    id: 'projection.table-delete',
    label: '投影缓存行删除',
    kind: 'delete',
    owner: 'projectionCache',
    fallback: 'disable-destructive',
    // 探测内容就是运行时那句硬前提：`requireTable().delete` 在不在。
    probe: (target) => {
      if (typeof target?.requireTable !== 'function') return '宿主投影缓存缺少 requireTable'
      let table: { delete?: unknown } | undefined
      try { table = (target.requireTable as () => { delete?: unknown })() }
      catch (error) { return `宿主投影缓存 requireTable() 抛错：${String(error)}` }
      if (typeof table?.delete !== 'function') return '宿主投影缓存存储不支持安全删除（table.delete 缺失）'
      return undefined
    },
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
  // ---- settings document path（0.1.7 的两处适配面之一）----------------------
  // `prepareDocument()` 在 0.1.7 把返回值从「主目录下的设置文档路径」改成「profile 补丁
  // 路径」（`configEditor.documentPath`）—— 方法一直在、语义变了，方法存在性探测抓不住
  // （0.15.0 的 MCP 页事故就是这么静默发生的）。这一条能拦的是「方法消失 / 签名漂移到
  // 同步抛 TypeError」；**返回值形状**是异步结果，同步探针看不到，那一半由 ensurePaths
  // 的 await 后自检负责（src/index.ts：认 profile 形状上溯 + 主目录不变量检查，异常走
  // noteRuntime）。两半合起来才是这个契约的完整探测。
  {
    id: 'settings.document-path',
    label: '设置文档路径（主目录推导源）',
    kind: 'read',
    owner: 'settings',
    fallback: 'refuse-operation',
    methods: ['prepareDocument'],
    // 零副作用真调：官方实现就是 `Promise.resolve(this.documentPath)`，纯读。拿不到
    // 异步结果没关系 —— 同步 TypeError（签名漂移）才是这一层要拦的。
    probe: (t) => callableWithSentinel(t, 'prepareDocument'),
    // 健康行也常显观测路径（官方 SettingsForms 有同步的 `documentPath` getter，
    // prepareDocument 就是它的 Promise 包装）：语义再变，页面上这行字一眼见底。
    describe: (t) => {
      try {
        const p = (t as { documentPath?: unknown }).documentPath
        return typeof p === 'string' && p !== '' ? `观测路径：${p}` : undefined
      } catch { return undefined }
    },
  },
  // ---- ctx.fs：MCP 域补丁写路径的唯一出口（审查 §5 F5）----------------------
  // 为什么值得单列：补丁文件在插件自己的数据目录**之外**（`~/.dsh/cordis.patch.yml` 与
  // `profiles/<名>/cordis.patch.yml`），读写都得经 `ctx.fs` 显式升级沙箱策略。五个方法里
  // 任何一个改名，19 处补丁写路径会**一起**报错 —— 报错是可见的（不是静默），但要等到用户
  // 点下去才发现；钉在兼容页上就能在升级后第一眼看见。
  //
  // 能探到 / 探不到（如实标注）：成员存在性可探；`writeText` 的**实参个数**可观测（健康行
  // 附注）。「五个位置参数的语义变了」**探不到** —— 真调它会写文件（有副作用），而本探针
  // 的纪律是零副作用（见 callableWithSentinel 的副作用口径）。那半条只能靠宿主升级清单人工核对。
  {
    id: 'fs.patch-io',
    label: '宿主文件读写（补丁文件出口）',
    kind: 'write',
    owner: 'fs',
    fallback: 'refuse-operation',
    methods: ['resolve', 'stat', 'readText', 'writeText', 'listDir'],
    describe: (t) => {
      const w = (t as { writeText?: unknown }).writeText
      return typeof w === 'function' ? `观测 writeText 实参个数=${w.length}` : undefined
    },
  },
  // ---- agent preset roster（0.1.7 的两处适配面之二）-------------------------
  // 0.1.7 把 `read(id)`（直返组合文本）改名成 `readDocument(id)`（返回文档对象，组合
  // YAML 在 `.content`）。读取口是「read 优先、readDocument 兜底」双入口
  // （preset-reach.ts 的 readCompositionText），两个名字**任一在场即可** —— 这正是
  // methods 列表表达不了的 either-or，用 probe 写。list / composedPreset 缺一个，
  // 注入边界矩阵与边界提示就瞎一半，同为必需。
  {
    id: 'preset.roster-surface',
    label: '预设名册读取面',
    kind: 'read',
    owner: 'presetRoster',
    fallback: 'inform-only',
    probe: (t) => {
      const o = t as Record<string, unknown>
      const hasRead = isFn(o.read)
      const hasDoc = isFn(o.readDocument)
      if (!hasRead && !hasDoc) return 'read 与 readDocument 都缺失：组合文本读不到，注入边界矩阵与极简兜底注入失明'
      const missing = ['list', 'composedPreset'].filter((name) => !isFn(o[name]))
      if (missing.length > 0) return `名册缺少 ${missing.join(', ')}：注入边界矩阵不完整`
      return undefined
    },
    // 健康行附注实际走的读取路。0.1.7 起 `read` 改名 `readDocument`，兜底成功是**正常形态**
    // 而非降级 —— 这句话只出现在绿色行上（运行时上报会渲染成问题行，那里不放）。
    describe: (t) => {
      const o = t as Record<string, unknown>
      if (!isFn(o.read) && isFn(o.readDocument)) return '读取走 readDocument（宿主 0.1.7 起的形态）'
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
      // B2：运行时硬前提（`table.delete`）也算一条路由要求 —— 不算进来的话，宿主表不可删时
      // 路由说可用、点下去必拒。batch 的 adapter 路由**有意**保持只有 enqueue/set-state：
      // 它的逐条失败会在结果里按 sessionId 报出来，此处不放宽也不收紧。
      'projection.table-delete',
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
  // describe 是健康行也带的观测值（如 settings 的 documentPath）；只挂 ok 路径，
  // 摸宿主属性一律 try/catch —— 观测失败就少一句后缀，不把好端端的能力报成问题。
  let described = ''
  if (spec.describe !== undefined) {
    try {
      const extra = spec.describe(target)
      if (typeof extra === 'string' && extra !== '') described = `；${extra}`
    } catch { /* 观测值拿不到就算了 */ }
  }
  return {
    ...base,
    state: 'ok',
    detail: (textMatch === false ? '成员齐备（实现文本与本插件适配的版本不同，按能力使用）' : '成员齐备') + described,
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
  settings?: unknown
  fs?: unknown
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
  // settings 走 ctx 属性优先（插件 inject 清单里的正式服务），roster 走服务名查找
  // （'agentPresets' 与 preset-reach.ts 的 presetRosterOf 同名 —— 注入矩阵实际用的就是它）。
  const settings = unwrap(ctx.settings !== undefined ? ctx.settings : get('settings')) as Target
  const roster = unwrap(get('agentPresets')) as Target
  // fs 走 ctx 属性优先（它在插件 inject 清单里），与 settings 同一条取法。
  const fsService = unwrap(ctx.fs !== undefined ? ctx.fs : get('fs')) as Target

  const references = referencePrototypes()
  const targets: Record<CapabilitySpec['owner'], { target: Target; reference?: Record<string, unknown> }> = {
    workspace: { target: registry, reference: references.workspace },
    projectionCache: { target: cache, reference: references.cache },
    sessions: { target: sessions, reference: references.sessions },
    persistence: { target: unwrap(get('sessionPersistence')) as Target, reference: undefined },
    settings: { target: settings, reference: references.settings },
    presetRoster: { target: roster, reference: references.roster },
    fs: { target: fsService, reference: undefined },
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
  const notes: HostIdentityNote[] = []
  const hostRoot = hostPackageRoot()
  const hostIsAsar = isAsarPath(hostRoot)
  // 桌面版（宿主在 app.asar 里）两组「版本」的容器：插件自己解析到的、宿主锚点解析到的。
  const asarHostPackages: HostIdentityPackage[] = []
  // realpath 失败（路径取不到真实形态）：两侧各算一次就够，与是哪个包无关。
  const realpathFailures: HostIdentityRealpathFailure[] = []
  let hostRealpathNote: string | null = null
  let pluginRealpathNote: string | null = null
  let asarHostVersion: string | null = null
  let asarPluginVersion: string | null = null
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
    //
    // 逐包解析、逐包取真实形态。realpath 的**机制**确实整轮不变，但上一版曾把
    // 这句话错写成连**解析结果**一起复用：第一个包（cordis）的宿主侧入口路径被当成
    // 其余五个包的宿主侧路径，于是五条全部比成「与 cordis 不同」→ 假「两份不同拷贝」
    // （官方桌面版 0.2.0-rc.2 实测，2026-09-30；解析本就便宜，节点自身还有缓存）。
    let hostResolved: string | null = null
    let hostRealpath: { path: string } | { reason: string } | null = null
    try {
      hostResolved = createRequire(join(dirname(hostRoot), 'package.json')).resolve(name)
      hostRealpath = realPathWithReason(hostResolved)
    } catch {
      hostResolved = null
    }
    // 真实形态取不到 → 这一格是「比不了」，不是「两份拷贝」。理由如实上报，
    // 绝不把路径问题说成模块问题（issue #1 的次要问题之二）。
    if (hostRealpath !== null && 'reason' in hostRealpath) {
      sameAsHost[name] = null
      hostRealpathNote = hostRealpathNote ?? hostRealpath.reason
      realpathFailures.push({ name, side: 'host', path: hostResolved ?? '(未解析到)', reason: hostRealpath.reason })
      continue
    }
    const pluginRealpath = realPathWithReason(resolved)
    if ('reason' in pluginRealpath) {
      sameAsHost[name] = null
      pluginRealpathNote = pluginRealpathNote ?? pluginRealpath.reason
      realpathFailures.push({ name, side: 'plugin', path: resolved, reason: pluginRealpath.reason })
      continue
    }
    const same = hostResolved === null ? null : (hostRealpath as { path: string }).path === pluginRealpath.path
    // 归档宿主：路径必然不同（归档 vs 磁盘），能比的是版本。相同 → 这一格是
    // 「比不了（同版本、打包方式不同）」，记进说明并从 unverified 里摘出来（那句
    // 「宿主的解析锚点里找不到它」对它不成立 —— 锚点找得到，在归档里）；不同 →
    // 真正的版本错配，`same` 保持 false 照旧进 blockers（那是要修的）。
    if (same === false && hostIsAsar && !isAsarPath(resolved) && hostResolved !== null) {
      const hostVersion = versionOfPackageAt(hostResolved)
      const pluginVersion = versionOfPackageAt(resolved)
      if (hostVersion !== null && hostVersion === pluginVersion) {
        asarHostPackages.push({ name, hostPath: hostResolved, pluginPath: resolved })
        asarHostVersion = asarHostVersion ?? hostVersion
        asarPluginVersion = asarPluginVersion ?? pluginVersion
        sameAsHost[name] = null
        continue
      }
    }
    sameAsHost[name] = same
    if (same === false) {
      // 指引按**实际形态**给：`scripts/host-deps.mjs` 只存在于源码检出里
      // （`files` 不含 `scripts/`，npm 安装形态下没有这个文件），
      // 发布形态照那条指引去跑必然 `MODULE_NOT_FOUND` —— issue #1 的次要问题之一。
      blockers.push(
        SOURCE_INSTALL
          ? `${name}：插件与宿主加载的是两份不同拷贝（在插件源码目录运行 node scripts/host-deps.mjs --fix）`
          : `${name}：插件与宿主加载的是两份不同拷贝（升级或重装本插件后仍然如此再报）`,
      )
    }
    // 解析得到、却比不了：宿主锚点里找不到它。不能静默 —— 否则整块身份校验等于没做，
    // 而页头仍报「全部可用」（pnpm 的 .pnpm 隔离目录就是这种情形，见 hostPackageRoot）。
    if (same === null) unverified.push(name)
  }
  if (realpathFailures.length > 0) {
    notes.push({
      kind: 'realpath',
      failures: realpathFailures,
      ...(hostRealpathNote === null ? {} : { hostReason: hostRealpathNote }),
      ...(pluginRealpathNote === null ? {} : { pluginReason: pluginRealpathNote }),
    })
  }
  if (asarHostPackages.length > 0 && hostRoot !== null) {
    notes.push({
      kind: 'asar-host',
      asarName: hostRoot.split(/[\\/]/).find((segment) => /\.asar$/i.test(segment)) ?? 'app.asar',
      hostRoot,
      hostVersion: asarHostVersion,
      pluginVersion: asarPluginVersion,
      packages: asarHostPackages,
    })
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
      notes,
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
  for (const candidate of hostRootCandidates()) {
    if (existsSync(join(candidate, 'dsh', 'package.json'))) return candidate
  }
  return null
}

/**
 * 宿主 `@deepseek-ai` 目录的**候选序列**（按优先级）—— 全仓"宿主在哪"的唯一口径。
 *
 * 为什么单独导出（2026-09-30 审查 §5 F10）：运行时（本文件）与 `scripts/doctor.mjs` /
 * `scripts/host-deps.mjs` 此前**各写一份**，而且顺序不一样 —— doctor 少了桌面版那一条，
 * 于是在桌面宿主上要么报 "host installation not found"，要么拿 npx 缓存里**另一代宿主**
 * 当锚点比出假 SEPARATE COPY。那正是本文件注释里记过的实测事故，只修了运行时。
 *
 * 顺序是有讲究的：
 *   ① 桌面版归档（`resources/app.asar`）—— 必须排在 npx 缓存**之前**，否则装过 web 版的
 *      机器上会先命中缓存里那个 0.1.7；
 *   ② `$DSH_HOME/profiles/node_modules/@deepseek-ai`（web 版旧布局的 junction 树）；
 *   ③ 从本插件自身解析到的锚点逐级上溯（dev 布局：仓库/安装目录自己的 node_modules）；
 *   ④ npx 缓存（`dsh web` 经 npx 跑时的落点；多命中取最新）。
 *
 * 只列候选、不判存在性：调用方各有自己的"像不像一份安装"的判据（运行时要求
 * `dsh/package.json`，host-deps 还要读出版本号）。
 */
export function hostRootCandidates(): string[] {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  const candidates: string[] = []
  const asarHost = asarHostPackageRoot()
  if (asarHost !== null) candidates.push(asarHost)
  if (home !== '') candidates.push(join(home, 'profiles', 'node_modules', '@deepseek-ai'))
  for (const anchor of IDENTITY_PACKAGES) {
    // 锚点候选只认**真实形态**：取不到就跳过（这里没有可比的对象，如实跳过即可，
    // 与身份比对不同 —— 那边取不到必须报出来，见 assessHost 的 realpath 说明）。
    const real = realPathWithReason(safeResolve(anchor))
    if ('reason' in real) continue
    const resolved = real.path
    let dir = dirname(resolved)
    for (let i = 0; i < 4; i += 1) {
      if (dir.endsWith(join('node_modules', '@deepseek-ai'))) { candidates.push(dir); break }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  candidates.push(...npxCacheHostRoots())
  return candidates
}

/**
 * 正在运行的桌面版 DSH 的 `@deepseek-ai` 目录（在 `resources/app.asar` 里），没有则 null。
 *
 * 判据是 `process.resourcesPath`（electron 才有）指向的归档里确实躺着 `dsh` —— 不靠
 * 包名或环境变量猜，因此在 `dsh web`（node 跑）下一律返回 null。归档内路径由 electron
 * 自己的 fs 修补解析，归档外的普通 node 读不到，所以这一步失败是静默的正常路径。
 */
function asarHostPackageRoot(): string | null {
  const resources = (process as { resourcesPath?: string }).resourcesPath
  if (typeof resources !== 'string' || resources === '') return null
  const dir = join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai')
  try {
    if (!existsSync(join(dir, 'dsh', 'package.json'))) return null
  } catch {
    return null
  }
  return dir
}

/**
 * npx 缓存里的宿主 `@deepseek-ai` 目录，按目录 mtime 新到旧排。npm 缓存位置依次看
 * `npm_config_cache`、`~/.npmrc` 的 `cache=`、`%LOCALAPPDATA%\npm-cache` —— probe 全程同步，
 * 不起子进程，读不到就当没有这批候选。
 */
function npxCacheHostRoots(): string[] {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  let cache = process.env.npm_config_cache || ''
  if (!cache && home) {
    try {
      const rc = readFileSync(join(home, '.npmrc'), 'utf8')
      cache = rc.match(/^\s*cache\s*=\s*(.+?)\s*$/m)?.[1] ?? ''
    } catch { /* no .npmrc — defaults below */ }
  }
  if (!cache && process.env.LOCALAPPDATA) cache = join(process.env.LOCALAPPDATA, 'npm-cache')
  if (!cache) return []
  const roots: Array<{ dir: string; mtime: number }> = []
  const npxRoot = join(cache, '_npx')
  let entries: string[] = []
  try { entries = readdirSync(npxRoot) } catch { return [] }
  for (const entry of entries) {
    const dir = join(npxRoot, entry, 'node_modules', '@deepseek-ai')
    if (!existsSync(join(dir, 'dsh', 'package.json'))) continue
    try { roots.push({ dir, mtime: statSync(dir).mtimeMs }) } catch { /* raced — skip */ }
  }
  return roots.sort((left, right) => right.mtime - left.mtime).map((root) => root.dir)
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
