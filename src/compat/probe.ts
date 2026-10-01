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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CAPABILITY_SPECS, type CapabilitySpec } from './capability-specs.js'
import {
  isAsarPath,
  isFn,
  OWNER_CLASSES,
  realPathWithReason,
  referencePrototypes,
  safeResolve,
  textMatchOf,
  versionOf,
  versionOfPackageAt,
  type Target,
} from './host-probe.js'
import type {
  CapabilityFinding,
  CapabilityRefusal,
  CapabilityState,
  HostAssessment,
  HostIdentity,
  HostIdentityAsarNote,
  HostIdentityNote,
  HostIdentityPackage,
  HostIdentityRealpathFailure,
  HostIdentityRealpathNote,
} from './probe-types.js'

// 宿主安装根的发现与「该走哪条恢复路」的判定 2026-10-01 整段搬到 ./host-roots.js，正文一字
// 未改（moved-verify 逐字对拍）。probe.js 的公开面照旧：搬走的那 12 件全部从这里再出口 ——
// index.ts / ops/compat.ts / sessions/bridge.ts 都按 ./compat/probe.js 引它们，少一件 equiv
// 对拍就报「导出面丢失」。
export {
  asarHostPackageRoot,
  findingsById,
  hostRootCandidates,
  IDENTITY_PACKAGES,
  npxCacheHostRoots,
  OPERATION_ROUTES,
  recoveryFor,
  refusalsFor,
  routeFor,
  VERIFIED_HOST_VERSION,
} from './host-roots.js'
export type { OperationName, RouteDecision } from './host-roots.js'
import { hostRootCandidates, IDENTITY_PACKAGES, routeFor, VERIFIED_HOST_VERSION } from './host-roots.js'
import type { OperationName, RouteDecision } from './host-roots.js'

// 类型面照旧从 lib/compat/probe.js 对外可见（`ops/compat.ts` 等按这个路径引它们）。
export type {
  CapabilityFinding,
  CapabilityRefusal,
  CapabilityState,
  HostAssessment,
  HostIdentity,
  HostIdentityAsarNote,
  HostIdentityNote,
  HostIdentityPackage,
  HostIdentityRealpathFailure,
  HostIdentityRealpathNote,
} from './probe-types.js'

/** Packages whose physical module identity matters to this plugin. */

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

/**
 * The capability sets each operation depends on, grouped by how the plugin
 * reaches the same outcome when a member is missing. Order matters: the first
 * viable route wins.
 *
 * - `native`: host entry points that already implement the whole operation.
 * - `adapter`: the checked compatibility adapter (the only route that touches
 *   private members), used when the host has no native entry.
 */

/** Texts a user can act on, per capability, when it is the reason for a refusal. */

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

/**
 * 正在运行的桌面版 DSH 的 `@deepseek-ai` 目录（在 `resources/app.asar` 里），没有则 null。
 *
 * 判据是 `process.resourcesPath`（electron 才有）指向的归档里确实躺着 `dsh` —— 不靠
 * 包名或环境变量猜，因此在 `dsh web`（node 跑）下一律返回 null。归档内路径由 electron
 * 自己的 fs 修补解析，归档外的普通 node 读不到，所以这一步失败是静默的正常路径。
 */

/**
 * npx 缓存里的宿主 `@deepseek-ai` 目录，按目录 mtime 新到旧排。npm 缓存位置依次看
 * `npm_config_cache`、`~/.npmrc` 的 `cache=`、`%LOCALAPPDATA%\npm-cache` —— probe 全程同步，
 * 不起子进程，读不到就当没有这批候选。
 */

/** Human-readable summary line for logs and the settings page header. */
export function summarize(assessment: HostAssessment): string {
  const total = assessment.findings.length
  const ok = total - assessment.degraded.length
  const state = assessment.degraded.length === 0 ? '全部可用' : `降级 ${assessment.degraded.length} 项`
  return `宿主 ${assessment.identity.version} · 能力 ${ok}/${total} · ${state}`
}

/** Findings by id, for route decisions. */

/** Refusals for every degraded capability in the list, in list order. */

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
