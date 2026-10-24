/**
 * 宿主能力探测 —— 唯一决定「本插件可以对运行中的宿主做什么、以及为什么不能」的地方。
 *
 * 为什么不用文本比对做闸门
 * ------------------------
 * `sessions/bridge.ts` 曾经拿每个宿主方法与本插件自己那份官方原型做
 * `Function.prototype.toString()` 比对。它只能回答一个问题 ——「宿主跑的是不是我写代码时
 * 那一版」—— 而且用硬抛错回答，于是一次无害的上游重构就能关掉整片功能。它还默认了插件与
 * 宿主加载的是**两份不同**的同名包。
 *
 * 真正稳定的是另外三个问题：
 *
 *   - 身份：插件与宿主是不是同一个物理模块？是则 `===`、`instanceof`、symbol 查找都跨得过
 *     边界，「是不是同一份实现」这个疑问整体消失。身份不成立是部署缺陷，如实报出来，不绕。
 *   - 存在：活宿主对象上有没有适配器要调的那些成员？按活值与形状检查 —— 宿主可能被升级、
 *     代理或整体替换过。
 *   - 行为：凡是不改宿主状态就能观察的，调一次看结果 —— getter 不再返回 `Map` 是事实，
 *     版本号只是线索。
 *
 * 结论按**能力**逐项报告，不压成一个布尔值：调用方可以只降级失去支持的那一项，其余照常。
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CAPABILITY_SPECS, type CapabilitySpec } from './capability-specs.js'
import { BARE_HOST_MODULE_CONTRACTS } from './host-contracts.js'
import {
  isAsarPath,
  isFn,
  OWNER_CLASSES,
  realPathWithReason,
  referencePrototypes,
  provideHostRootCandidates,
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
  HostContractStatus,
} from './probe-types.js'

// 宿主安装根的发现与「该走哪条恢复路」的判定 整段搬到 ./host-roots.js，正文一字
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

// 「宿主在哪」这份口径只有一份（host-roots.ts 的 hostRootCandidates）。静态能力表里有条目要
// 按宿主侧解析结果决定**这一轮能不能查**（`staticWhen`，见 connection.admit 那条），而
// capability-specs.ts 不能反向 import 本文件（probe → specs → probe 成环）。所以在这里把
// 函数本体注入 host-probe.ts：它只调用、不 import，加载顺序天然正确（本文件先被求值）。
provideHostRootCandidates(hostRootCandidates)

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
  HostContractPackageStatus,
  HostContractStatus,
} from './probe-types.js'

/**
 * 本插件是不是从**源码检出**跑起来的（仓库里那份，`scripts/host-deps.mjs` 就躺在旁边）。
 *
 * 用来决定「两份拷贝」那条阻塞项给什么修复指引：`scripts/` 不在 `package.json` 的
 * `files` 里（发布形态本就不该带开发者脚本），所以 npm 装出来的用户照那条指引去跑
 * 只会拿到 `MODULE_NOT_FOUND`。指引必须按实际形态给。
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
 * `>=0.2.1-rc.3` 匹配不了 `0.2.2-rc.1`，`^0.2.1-rc.3` 也匹配不了它 —— 范围只能**逐段写**，
 * 一代一段。
 *
 * 但「逐段写」不等于「把历史各代累积起来」。累积成 `0.1.7 || 0.2.0 || 0.2.1` 三代并集，
 * 等于向 npm 声明「支持 0.1.7-rc.2 起的每一代」。而本插件的代码只按 0.2.1 的契约写过
 * （SubagentStartRequest、身份比对、`connection.admit` 这几处都动过会静默改行为的语义），
 * 在 0.2.0 / 0.1.7 上从未验证。那种声明最坏的后果不是"装不上"，而是"装上了、大部分能用、
 * 某几个动作悄悄失效"—— 用户无法判断是插件问题还是版本问题。
 *
 * 所以现在**只声明当前适配的这一代**。旧宿主不是没人管：插件的老版本自己带着老范围，用户装
 * 对应版本即可（`dsh plugin add dsh-plugin-tool-management@<老版本号>`）。装上被拒 + 一版新适配，
 * 优于装上然后部分功能悄悄失效。
 *
 * 上界**必须写**（`<0.2.2`）：`^` 不能用，它的隐含上界是 `<0.3.0`，而 `0.2.1-rc.3` 这个已适配
 * 版本自己都满足不了 `^0.2.1-rc.3`（prerelease 只在同元组比较器带 prerelease 时才匹配）。
 *
 * 两种写法（这里是 `^` 三段、那里是 `>=` 两段，且下界不同）。现在两处是**同一个字符串**，
 * 并由 `test/contracts.test.mjs` 的断言钉住 —— 漂移会让"界面/doctor 报的范围"与"安装期实际
 * 校验的范围"各说各话，而两者都自称是插件的兼容范围。同一条断言现在还钉住「只有一段」，
 * 防止范围再被追加成多代并集。
 *
 * 已知且**无法**用 range 消除的缺口（如实标注）：尚未枚举的新 rc 元组（如 0.2.1-rc.1）
 * 在 npm7+ 下会触发 ERESOLVE 告警。这不是写法问题 —— semver 规则决定了不存在能匹配
 * "任意未来 prerelease"的 range。缓解方式：官方每发一代新 rc，同步改这一段（同时改
 * `VERIFIED_HOST_VERSION`），以及 `--legacy-peer-deps` 这条逃生门。
 *
 * 0.2.1-rc.3 的验证依据：rc.2 上 `assessHost` 全量通过（宿主版本读得出来），rc.3 与 rc.2
 * 的逐包比对里受监视的全部包只有版本号变化（改动集中在客户端 UI，cordis 未动）。
 */
export const EXPECTED_PEER_RANGE = '>=0.2.1-rc.3 <0.2.2'
/**
 * peer range 的下界。仍从 EXPECTED_PEER_RANGE 派生，避免两处手写漂移。
 *
 * 范围收窄到一代之后它**与 VERIFIED_HOST_VERSION 重合**（都是 0.2.1-rc.3）—— 这是正确的：
 * 适配的那一代就是唯一允许安装的那一代。保留这个导出是因为它进了 `compat-status` 的载荷，
 * doctor 与外部脚本可能仍在读；语义仍是"最早支持哪一代"，只是现在只有一代。
 */
export const EXPECTED_MIN_HOST_VERSION =
  EXPECTED_PEER_RANGE.match(/(\d+\.\d+\.\d+(?:-rc\.\d+)?)/)?.[1] ?? VERIFIED_HOST_VERSION

/**
 * 单项能力的结论。
 *
 * @param spec 能力规格（要求的方法、字段与额外探针）
 * @param target 活宿主对象
 * @param reference 插件侧同实现的副本；包不可解析时为 undefined
 * @returns 该项能力的结论；探测内部失败记为 finding，不抛错
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
  // 删除类收紧：textMatch === false 意味着宿主运行的
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
 * 「缺失只影响走哪条路、不算故障」的能力 id：插件自己有一份实现顶上。它们既不出现在降级
 * 清单里，也不挡任何路。
 *
 * 同一个事实在 {@link CapabilityFinding.optional} 上也有（界面与 doctor 都读那个标记）；
 * 这里保留导出是为了让调用方问「哪些槽位是插件自己顶的」而不必复制整张表。
 */
export const SUBSTITUTED_CAPABILITIES: readonly string[] = CAPABILITY_SPECS
  .filter((spec) => spec.optional === true)
  .map((spec) => spec.id)

/** 宿主没在跑时，某项能力的成员必须落在哪里。 */
export interface CapabilityStaticCheck {
  readonly pkg: string
  readonly target: string
  readonly members: readonly string[]
}

/** 能力表静态视图的一行。 */
export interface CapabilityStatic {
  readonly id: string
  readonly label: string
  readonly kind: 'read' | 'write' | 'delete'
  readonly optional: boolean
  /** `null` = 只能对活实例查（实例字段 / 行为 dry-run）。 */
  readonly check: CapabilityStaticCheck | null
}

/**
 * 能力表的**静态**视图：每一项给出"必须由哪个官方类的原型承载这些成员"。存在的理由是没有
 * 活宿主的 CLI（doctor）也要能回答「这一份构建能不能归档 / 删除 / 列出」。
 *
 * 全部由 {@link CAPABILITY_SPECS} 派生。手写第二张表必然漂移：漏掉一半 id、漏掉所有
 * `sessions.*` 与路由真正依赖的原生槽位，而它自己不会报错。
 */
export const CAPABILITY_STATIC: readonly CapabilityStatic[] = CAPABILITY_SPECS.map((spec) => {
  const ref = OWNER_CLASSES[spec.owner]
  const methods = spec.methods
  // `staticWhen` 是"这一轮能不能静态检查"的门槛。它说不的时候，`check` 必须是 null ——
   // 否则 doctor 会从插件锚点解析一个本插件不依赖的包，然后把"解析不到"写成"宿主缺失"
   // （`connection.admit` 的误报正是这条路径）。null 让它落到 `runtime-only`：
   // 「只能对活的宿主查」是事实，"missing" 不是。
  const checkableByStaticView = spec.staticWhen === undefined || spec.staticWhen()
  return {
    id: spec.id,
    label: spec.label,
    kind: spec.kind,
    optional: spec.optional === true,
    // 只认 `fields`（实例 Map）的规格、以及判据落在 `probe` 里的规格，原型上问不出东西
    // —— 它们只能留在运行期查。
    check: checkableByStaticView && ref !== undefined && methods !== undefined && methods.length > 0
      ? { pkg: ref.pkg, target: ref.target, members: methods }
      : null,
  }
})

/**
 * 探测一个插件上下文背后的活宿主。
 *
 * 全程只读：只碰 getter 与 `requireState()`/`requireTable()`，而这两类本插件在每次
 * 列表请求里本来就会调。探测内部失败记成 finding，绝不抛错。
 *
 * @param ctx 插件的 cordis 上下文（只用到 `get` 与几个可选服务字段）
 * @returns 交给界面、工具与日志的评估快照
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

  // cordis 暴露的是可追踪代理，比对与检查都要落在原始对象上。
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
  // tools 走 ctx 属性优先（它在插件 inject 清单里）。它有两层取法：宿主平面的 ctx.tools
  // 与**子代理 scope 里**的那个（restrict 在子 scope 上才作用于该子代理，run-provider.ts
  // 就是 `childAgent.ctx.get('tools')` 取的）。探测只能看宿主平面那一层 —— 子 scope 还没建。
  const tools = unwrap((ctx as { tools?: unknown }).tools !== undefined ? (ctx as { tools?: unknown }).tools : get('tools')) as Target
  // agent 作用域：探测对象是 agent 自己的 ctx（`on` 挂在它上面）。这里没有活的 agent 可看，
  // 所以拿宿主平面的 ctx 代答 —— 同一个类实例链上的成员存在性，`on` 改名时两边一起改。
  // 局限如实标注：探得到"on 在不在"，探不到"agent/created 是否仍串行"。
  const agentContext = ctx as Target
  const connection = unwrap(get('connection')) as Target
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
    tools: { target: tools, reference: references.tools },
    agentContext: { target: agentContext, reference: undefined },
    connection: { target: connection, reference: references.connection },
  }

  const findings = CAPABILITY_SPECS.map((spec) => {
    const slot = targets[spec.owner]
    return inspectCapability(spec, slot.target, slot.reference)
  })

  // 身份：插件加载的是不是宿主正在跑的那几个物理模块？
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
  // 宿主非 peer 契约只跟"宿主装在哪"有关，与下面那个逐包 identity 循环无关，先量一次。
  const contracts = hostContractStatus(hostRoot)
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
    // 用宿主安装自己的锚点再解析同一个名字，然后比**物理文件**：junction 是同一个模块，
    // 不是一份拷贝。
    //
    // 逐包解析、逐包取真实形态。**机制**整轮只做一次，但**解析结果**必须逐包算：
    // 复用第一个包（cordis）的宿主侧入口路径，会让其余五个包全被比成「与 cordis 不同」，
    // 得出「两份不同拷贝」的假结论（官方桌面版实测）。解析本身不贵，node 自己也有缓存。
    let hostResolved: string | null = null
    let hostRealpath: { path: string } | { reason: string } | null = null
    try {
      hostResolved = createRequire(join(dirname(hostRoot), 'package.json')).resolve(name)
      hostRealpath = realPathWithReason(hostResolved)
    } catch {
      hostResolved = null
    }
    // 真实形态取不到 → 这一格是「比不了」，不是「两份拷贝」。理由如实上报，
    // 绝不把路径问题说成模块问题。
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
      // 发布形态照那条指引去跑必然 `MODULE_NOT_FOUND`。
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

  // 降级 = 确实用不了。可选槽位不算：它们缺席只是选中适配器路线，功能照常可用；
  // 列进降级会让用户以为好用的功能坏了（再配上"不可用"的措辞，还会以为按钮被禁掉）。
  const degraded = findings.filter((finding) => finding.state !== 'ok' && finding.optional !== true)
  // 只要**有一条**路走得到，删除就是可行的。那几个可选的原生委派槽位
  // （`workspace.delete-native` / `workspace.unarchive-native` /
  // `workspace.batch-native`）在官方 API 没有对应入口的宿主上本就该缺席 ——
  // 缺席只是选中适配器路线，不等于删除做不了。
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
    ...(contracts === null ? {} : { contracts }),
  }
}

/**
 * 宿主**非 peer** 契约的实况：插件按裸模块名 require 的那几个官方包，宿主还暴不暴露、
 * 入口里那几条 canary 还在不在。
 *
 * 为什么在探测里量而不是只在 doctor 里量：doctor 是"没有活宿主"的静态视图，而兼容页看到的是
 * 正在跑的宿主。升级 DSH 后第一眼该看见的正是这一块 —— 官方撤掉某个包时**不抛错**，功能只是
 * 少一半，除此之外没有任何信号。
 *
 * 口径从宿主安装锚点解析（不是插件侧）：这些包**不是**本插件的 peer，插件 `node_modules`
 * 里通常没有，从插件侧解析只会得到一律"解析不到"，那不是一个结论。
 *
 * @param hostRoot - `.../node_modules/@deepseek-ai` 或 `null`（找不到宿主）。
 */
function hostContractStatus(hostRoot: string | null): HostContractStatus | null {
  if (hostRoot === null) return null
  const packages = BARE_HOST_MODULE_CONTRACTS.map((contract) => {
    let resolved: string | null = null
    try {
      resolved = createRequire(join(dirname(hostRoot), 'package.json')).resolve(contract.package)
    } catch {
      resolved = null
    }
    let missingMarkers: string[] = []
    if (resolved !== null && contract.markers.length > 0) {
      try {
        const source = readFileSync(resolved, 'utf8')
        missingMarkers = contract.markers.filter((marker) => !source.includes(marker.needle)).map((marker) => marker.needle)
      } catch { /* 入口读不到时只报"解析不到"，不额外造一条 canary 结论 */ }
    }
    return { package: contract.package, feature: contract.feature, resolved, missingMarkers }
  })
  return {
    packages,
    missing: packages.filter((item) => item.resolved === null).map((item) => item.package),
    drifted: packages
      .filter((item) => item.missingMarkers.length > 0)
      .map((item) => ({ package: item.package, missingMarkers: item.missingMarkers })),
  }
}

/**
 * 本插件所挂的那个 DSH 安装的 `@deepseek-ai` 目录，从某个共享包的物理位置推出来。
 *
 * 锚在**已解析的入口**上而不是 `require.resolve('@deepseek-ai/dsh')` 上：插件从不 import
 * `dsh` 应用包，它本来就不必对插件可解析 —— 可解析的只有那些共享库。
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
 * 为什么单独导出：运行时（本文件）与 `scripts/doctor.mjs` /
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

/** 给日志与设置页标题用的一行摘要。 */
export function summarize(assessment: HostAssessment): string {
  const total = assessment.findings.length
  const ok = total - assessment.degraded.length
  const state = assessment.degraded.length === 0 ? '全部可用' : `降级 ${assessment.degraded.length} 项`
  return `宿主 ${assessment.identity.version} · 能力 ${ok}/${total} · ${state}`
}

/**
 * 被拒绝的操作抛出的错误。单独一个类，是为了让调用方能区分「宿主做不了这件事」与
 * 「操作本身失败了」。
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

/** 评估结果不给路就抛错；给了就返回那条路由决策。 */
export function requireRoute(assessment: Pick<HostAssessment, 'findings'>, operation: OperationName): RouteDecision {
  const decision = routeFor(assessment, operation)
  if (decision.via === 'none') throw new CapabilityRefusalError(operation, decision.refusals)
  return decision
}
