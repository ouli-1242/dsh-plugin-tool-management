// 宿主能力探测的取数原语：解析包路径、读版本、比对实现文本、取原型、用哨兵实调。
//
// 与 probe.ts 的分工：这里只管「怎么探」（怎么把说明符变成一个磁盘路径、怎么读出版本、
// 怎么真调一个方法而不制造副作用），判定与降级口径全在 probe.ts。搬移段的每一行都
// 是从 probe.ts 整段剪切而来，未作任何改写；`safeResolve`/`classPrototypeOf` 用的
// `import.meta.url` 解析基准与本文件原先同在 lib/compat/ 一层，换文件名不改目录，
// 解析链才没有变（本插件按产物目录深度判形态，见 probe.ts 的 SOURCE_INSTALL）。
import { createRequire } from 'node:module'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CapabilityFinding } from './probe-types.js'

/** The slice of a host object a probe inspects. `unknown` keeps callers honest. */
export type Target = Record<string, unknown> | undefined

export const isFn = (value: unknown): value is (...args: unknown[]) => unknown => typeof value === 'function'

/**
 * Resolve a package the way this plugin resolves it, without throwing.
 *
 * `import.meta.resolve` 给的是**URL**：目录里带空格的路径（桌面版装在
 * `D:\DeepSeek Harness\...`）会以 `%20` 形式回来，直接当路径用会得到一个
 * 永远打不开的名字 —— 版本号读不出来（显示 `unknown`）、asar 路径也匹配不上。
 * 用 `fileURLToPath` 老实解码（它同时处理盘符与百分号转义）。
 */
export function safeResolve(specifier: string): string | null {
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
export function isAsarPath(value: string | null): boolean {
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
export function realPathWithReason(value: string | null): { path: string } | { reason: string } {
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
export function versionOf(specifier: string): string | undefined {
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
export function versionOfPackageAt(entry: string): string | null {
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
export function textMatchOf(live: unknown, reference: unknown): boolean | undefined {
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
export const OWNER_CLASSES: Partial<Record<CapabilityFinding['owner'], { readonly pkg: string; readonly target: string }>> = {
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
export const PROBE_SENTINEL = '__dshm_probe_never_exists__'

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
export function callableWithSentinel(target: Target, name: string, ...args: unknown[]): string | undefined {
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
export function referencePrototypes(): {
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