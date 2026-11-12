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
import * as semver from 'semver'
import { CAPABILITY_SPECS, type CapabilitySpec } from './capability-specs.js'
import { BARE_HOST_MODULE_CONTRACTS, HOST_BEHAVIOR_CONTRACTS, HOST_CLIENT_UI_CONTRACTS, type HostModuleContract } from './host-contracts.js'
import { manualReviewItems } from './manual-review.js'
import {
  isAsarPath,
  isFn,
  OWNER_CLASSES,
  packageRootOf,
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
  HostContractMarkerNote,
  HostContractStatus,
  HostPackageStatus,
} from './probe-types.js'

// 宿主安装根的发现与「该走哪条恢复路」的判定 整段搬到 ./host-roots.js，正文一字
// 未改（moved-verify 逐字对拍）。probe.js 的公开面照旧：搬走的那 12 件全部从这里再出口 ——
// index.ts / ops/compat.ts / sessions/bridge.ts 都按 ./compat/probe.js 引它们，少一件 equiv
// 对拍就报「导出面丢失」。
export {
  asarHostPackageRoot,
  findingsById,
  globalNpmHostPackageDirs,
  hostPackageDirsFromPath,
  hostRootCandidates,
  hostVersionOf,
  IDENTITY_PACKAGES,
  looksLikeHostPackageDir,
  npxCacheHostRoots,
  OPERATION_ROUTES,
  recoveryFor,
  refusalsFor,
  routeFor,
  VERIFIED_HOST_VERSION,
} from './host-roots.js'
export type { OperationName, RouteDecision } from './host-roots.js'
import { hostRootCandidates, hostVersionOf, IDENTITY_PACKAGES, looksLikeHostPackageDir, routeFor, VERIFIED_HOST_VERSION } from './host-roots.js'
import { DEFAULT_PRESET_ID, presetCompositionWiresPresetSkills, readHostPresetComposition } from '../skills/official.js'
import { presetRosterOf } from './preset-reach.js'

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
  HostContractMarkerNote,
  HostContractPackageStatus,
  HostContractStatus,
  HostPackageStatus,
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
 * `>=0.2.1-rc.5` 匹配不了 `0.2.2-rc.2`，`^0.2.1-rc.5` 也匹配不了它 —— 范围只能**逐段写**，
 * 一代一段。
 *
 * 但「逐段写」不等于「把历史各代累积起来」。累积成 `0.2.0 || 0.2.1 || 0.2.2` 三代并集，
 * 等于向 npm 声明「支持 0.2.0 起的每一代」。而本插件的代码只按 0.2.2 的契约写过
 * （工具准入、Session Projection 注册、子代理创建语义这几处都动过会静默改行为的语义），
 * 在 0.2.1 及更早的宿主上从未验证。那种声明最坏的后果不是"装不上"，而是"装上了、大部分能用、
 * 某几个动作悄悄失效"—— 用户无法判断是插件问题还是版本问题。
 *
 * 所以现在**只声明当前适配的这一代**。旧宿主不是没人管：插件的老版本自己带着老范围，用户装
 * 对应版本即可（`dsh plugin add dsh-plugin-tool-management@<老版本号>`）。装上被拒 + 一版新适配，
 * 优于装上然后部分功能悄悄失效。
 *
 * 上界**必须写**（`<0.2.3`）：`^` 不能用 —— 它把上界放宽到 `<0.3.0`，等于声明 0.2.3 起的下一代
 * 也受支持，而跨 minor 的契约变化正是这个范围要挡的东西。
 *
 * 三处（本文件的常量、`package.json` 的 `engines.dsh`、11 个 peer）是**同一个字符串**，
 * 并由 `test/contracts.test.mjs` 的断言钉住 —— 漂移会让"界面/doctor 报的范围"与"安装期实际
 * 校验的范围"各说各话，而两者都自称是插件的兼容范围。同一条断言现在还钉住「只有一段」，
 * 防止范围再被追加成多代并集。
 *
 * 下界写在 `0.2.2-rc.2`、比这一代最早的 rc 高，是**适配声明**而不是 semver 的要求：同元组内
 * 的 rc 本来就被一个分支覆盖（`docs/HOST-ADAPT.md` §2.2）。本插件只实现 rc.2 的子代理激活
 * 形状（任务字段平铺在顶层，见 `src/subagents/run-provider.ts`），rc.1 要求把它们嵌在
 * `request` 里，装在 rc.1 上会在子代理激活处直接失败。抬下界让安装期就把 rc.1 拒掉，
 * 而不是装上之后部分功能悄悄失效；rc.1 用户留在声明旧范围的已发布插件版本（版本号见 README）。
 *
 * 已知且**无法**用 range 消除的缺口（如实标注）：尚未枚举的新 rc 元组（如 `0.2.3-rc.1`）
 * 在 npm7+ 下会触发 ERESOLVE 告警。这不是写法问题 —— semver 规则决定了不存在能匹配
 * "任意未来 prerelease"的 range。缓解方式：官方跨代时同步改这一段（同时改
 * `VERIFIED_HOST_VERSION`），以及 `--legacy-peer-deps` 这条逃生门。
 *
 * 0.2.2-rc.2 的验证依据：把 rc.1 → rc.2 的包逐份对拍（工作区登记表、会话、投影缓存、设置、
 * 文件服务、预设名册、工具服务、连接准入、子代理 provider），本插件伸手要的成员一个没少。
 * 两处契约变了：子代理运行时撤掉了 provider 名册枚举（只剩按名查），激活请求把任务字段从
 * `request` 挪到顶层 —— 本插件按新形状实现，不再提供 rc.1 的嵌套形状。官方还撤下了 office
 * 的三个**操作**技能（渲染 / 换算 / 重算改由原生工具承担），技能页整目录拷贝官方 assets，
 * 名单随之变化 —— 本插件不写死技能名，无须跟着改。其余契约逐条比对无漂移。
 */
export const EXPECTED_PEER_RANGE = '>=0.2.2-rc.2 <0.2.3'
/**
 * peer range 的下界。仍从 EXPECTED_PEER_RANGE 派生，避免两处手写漂移。
 *
 * 它取的是范围的**下界**，与 `VERIFIED_HOST_VERSION`（最后验证过的那一版）不是同一件事：
 * 下界是「这一代里最早能装的一版」，基准是「最近一次对着验证的一版」。同一代内追加 rc 时
 * 基准前移、范围不动 —— 因为预发布只在同元组内比较，追加的 rc 本来就落在范围里
 * （见 `docs/HOST-ADAPT.md` §2.2 与 §3.4）。保留这个导出是因为它进了 `compat-status`
 * 的载荷，doctor 与外部脚本可能仍在读；语义仍是"最早支持哪一代"。
 */
export const EXPECTED_MIN_HOST_VERSION =
  EXPECTED_PEER_RANGE.match(/(\d+\.\d+\.\d+(?:-rc\.\d+)?)/)?.[1] ?? VERIFIED_HOST_VERSION

/** 一条逐包版本基准：包名、插件声明的 peer 范围、适配时验证过的版本。 */
export interface HostPackageBaseline {
  readonly name: string
  /** `null` = 非 peer 的运行时观测包：只比版本，不参与安装期范围判定。 */
  readonly peerRange: string | null
  readonly baselineVersion: string
  /** 可选 peer：本机未安装 / 宿主不提供是正常形态。 */
  readonly optional?: boolean
  /** 非 peer：插件不依赖它，但运行时契约与它绑定；版本偏离基准仍值得提示。 */
  readonly observed?: true
}

/**
 * 逐包版本基准：cordis 与 11 个 `@deepseek-ai/dsh-*` peer。
 *
 * 官方发版时这些包通常同代；逐包列出来是为了升级后能看见**哪一个包先变了**。
 * 新增 / 撤掉 peer 时这里要同步增删，否则版本表会漏报或多报一个包；某个包独立发版时
 * 直接改对应条目的 `baselineVersion`。宿主与插件两侧的版本在 {@link assessHost} 里逐包现读。
 */
const DSH_PEER_PACKAGES = [
  '@deepseek-ai/dsh-agent-preset-registry',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-projection-cache',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-spill-local',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-subagent-fork-in-process',
  '@deepseek-ai/dsh-subagent-spawn-in-process',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-workspace',
] as const

/** 可选 peer：宿主不提供时由插件自带副本或按需挂载，缺席不是安装故障。 */
const OPTIONAL_PEER_PACKAGES = new Set<string>([
  '@deepseek-ai/dsh-subagent-fork-in-process',
  '@deepseek-ai/dsh-subagent-spawn-in-process',
])

/**
 * 非 peer、但运行时契约与插件绑定的官方包：只观测宿主版本是否偏离适配基准，不判 peer 范围。
 *
 * 为什么不能省：peer 范围只覆盖 11 个 `dsh-*`；宿主可以只升级 `dsh-system-prompt` /
 * `dsh-mcp-client` 这类「宿主不要求插件依赖」的包 —— 这时 peer 全部在范围内，插件却可能
 * 已经按旧契约在跑。逐包列出宿主版本，至少让"这一代没验证过"在页面上有据可查。
 */
const OBSERVED_HOST_PACKAGES = [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-preset',
  '@deepseek-ai/dsh-host-plugin-inventory',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-mcp-resources',
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-sandbox-policy',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-skill-office',
  '@deepseek-ai/dsh-sandbox-windows-acl',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tool-skill',
] as const

export const HOST_PACKAGE_BASELINES: readonly HostPackageBaseline[] = [
  { name: '@deepseek-ai/cordis', peerRange: '^4.0.2', baselineVersion: '4.1.0' },
  ...DSH_PEER_PACKAGES.map((name) => ({
    name,
    peerRange: EXPECTED_PEER_RANGE,
    baselineVersion: VERIFIED_HOST_VERSION,
    ...(OPTIONAL_PEER_PACKAGES.has(name) ? { optional: true } : {}),
  })),
  ...OBSERVED_HOST_PACKAGES.map((name) => ({
    name,
    peerRange: null,
    baselineVersion: VERIFIED_HOST_VERSION,
    observed: true as const,
  })),
  // LibreOffice Kit 跟着宿主运行时走，版本号与 DSH 不同步（0.2.x 一档对应 0.2.2 这一代）。
  { name: '@deepseek-ai/libreoffice-kit', peerRange: null, baselineVersion: '0.2.3', observed: true },
]

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
  webServer?: unknown
  sandboxPolicy?: unknown
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
  // 系统提示词服务：插件在 agent 作用域里用同名段遮蔽官方 MCP 段；这里从宿主平面取一份
  // 只读视图，核对 MCP_SERVERS 排序位仍在（状态页与 doctor 都不该等隔离失效才发现）。
  const systemPrompt = unwrap(get('systemPrompt')) as Target
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
  // 三个不在 inject 清单里的宿主服务：只能用 ctx.get 软取（属性访问在未声明时会抛）。
  const subagents = unwrap(get('subagents')) as Target
  const llm = unwrap(get('llm')) as Target
  const approval = unwrap(get('approval')) as Target
  // 技能 / agent 清单 / Loader 条目：插件按 scope 注册 provider 与等待 loader 时需要它们。
  const skills = unwrap(get('skills')) as Target
  const agents = unwrap(get('agents')) as Target
  const pluginInventory = unwrap(get('pluginInventory')) as Target
  // webServer / sandboxPolicy 在 inject 清单里：属性优先，取不到再按服务名软取。
  const webServer = unwrap(ctx.webServer !== undefined ? ctx.webServer : get('webServer')) as Target
  const sandboxPolicy = unwrap(ctx.sandboxPolicy !== undefined ? ctx.sandboxPolicy : get('sandboxPolicy')) as Target

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
    systemPrompt: { target: systemPrompt, reference: undefined },
    agentContext: { target: agentContext, reference: undefined },
    connection: { target: connection, reference: references.connection },
    subagents: { target: subagents, reference: undefined },
    llm: { target: llm, reference: undefined },
    approval: { target: approval, reference: undefined },
    skills: { target: skills, reference: undefined },
    agents: { target: agents, reference: undefined },
    pluginInventory: { target: pluginInventory, reference: undefined },
    webServer: { target: webServer, reference: undefined },
    sandboxPolicy: { target: sandboxPolicy, reference: undefined },
  }

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
  // 宿主版本优先读宿主应用自己的清单；读不到再退回插件解析到的 workspace 版本。
  // 只读 workspace 会在「插件与宿主两份拷贝」时把插件侧版本当成宿主版本。
  const hostVersion = (hostRoot === null ? null : hostVersionOf(hostRoot)) ?? versionOf('@deepseek-ai/dsh-workspace') ?? 'unknown'
  // 宿主契约只跟"宿主装在哪"有关，与下面那个逐包 identity 循环无关，先各量一次。
  const contracts = hostContractStatus(hostRoot, BARE_HOST_MODULE_CONTRACTS)
  const behaviors = hostContractStatus(hostRoot, HOST_BEHAVIOR_CONTRACTS)
  // 客户端 UI 契约：服务端看不见浏览器，只能核对宿主客户端 bundle 里的模块加载器 / 插槽名。
  const clientUi = hostContractStatus(hostRoot, HOST_CLIENT_UI_CONTRACTS)
  // 只能人工核对的项：能力表 + 三份契约清单里的 `manual` 说明。随诊断 JSON 返回，
  // 页面不展示 —— 保留给排障时逐项核对。
  const manualChecks = manualReviewItems([
    ...BARE_HOST_MODULE_CONTRACTS,
    ...HOST_BEHAVIOR_CONTRACTS,
    ...HOST_CLIENT_UI_CONTRACTS,
  ])
  // 配置 schema 这类"导出对象上的字段名"：canary 只能证明字符串还在，读一次 JSON 表示才能
  // 确认插件写出的键仍被官方接受。解析不到就不出结论（契约清单会报包缺失）。
  const schemaFindings = inspectHostSchemaContracts(hostRoot)
  const assetFindings = inspectOfficialSkillAssets(hostRoot, defaultPresetIdOf(ctx))
  const findings = CAPABILITY_SPECS.map((spec) => {
    const slot = targets[spec.owner]
    return inspectCapability(spec, slot.target, slot.reference)
  }).concat(schemaFindings, assetFindings)
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

  // 逐包版本审计：升级宿主后「哪个包先变了、还在不在适配范围」在这里一次答完。
  const packages = hostPackageStatuses(hostRoot, sameAsHost)
  const outOfRange = packages.filter((item) => item.inPeerRange === false)
  if (outOfRange.length > 0) {
    // 装得上不等于适配：peer 的范围只在安装期校验一次，宿主原地升级后运行时会照跑。
    // 这条阻塞项把「跑着但版本对不上」摆到页头，而不是等某个动作失败才发现。
    blockers.push(
      `这些官方包的版本超出本插件声明的 peer 范围（${EXPECTED_PEER_RANGE}）：`
      + `${outOfRange.map((item) => `${item.name}（宿主 ${item.hostVersion ?? '?'} / 插件 ${item.pluginVersion ?? '?'}）`).join('、')}。`
      + '请安装与本机 DSH 匹配的插件版本。',
    )
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
      version: hostVersion,
      modules,
      sameAsHost,
      packages,
      blockers,
      unverified,
      notes,
    },
    findings,
    degraded,
    mayDelete: delta,
    generatedAt: Date.now(),
    ...(contracts === null ? {} : { contracts }),
    ...(behaviors === null ? {} : { behaviors }),
    ...(clientUi === null ? {} : { clientUi }),
    manualChecks,
  }
}

/**
 * 宿主某份官方包的版本；宿主不暴露该包时为 null。
 *
 * 从宿主自己的解析锚点量，而不是插件侧：插件可能是另一份拷贝，或者根本没有这个包
 * （可选 peer / 宿主专属包）。
 */
function hostPackageVersion(hostRoot: string | null, name: string): string | null {
  if (hostRoot === null) return null
  try {
    const resolved = createRequire(join(dirname(hostRoot), 'package.json')).resolve(name)
    return versionOfPackageAt(resolved)
  } catch {
    return null
  }
}

/**
 * 逐包版本审计：宿主实际装的是哪一版、插件解析到哪一版、是否仍在 peer 范围内。
 *
 * `inPeerRange` 对**两侧都判定**：任一侧解析到且超出范围就是 false。宿主升级后插件
 * 自己的副本通常没变，只看插件版本会把「宿主已经超出范围」藏起来；反过来插件装了一份
 * 越界的私副本时，只看宿主版本同样会漏。
 */
function hostPackageStatuses(hostRoot: string | null, sameAsHost: Record<string, boolean | null>): HostPackageStatus[] {
  return HOST_PACKAGE_BASELINES.map((baseline) => {
    const pluginVersion = versionOf(baseline.name) ?? null
    const hostVersion = hostPackageVersion(hostRoot, baseline.name)
    const satisfiesRange = (version: string | null): boolean | null => {
      if (version === null || baseline.peerRange === null) return null
      try {
        return semver.satisfies(version, baseline.peerRange)
      } catch {
        return null
      }
    }
    const pluginInPeerRange = satisfiesRange(pluginVersion)
    const hostInPeerRange = satisfiesRange(hostVersion)
    const inPeerRange = pluginInPeerRange === false || hostInPeerRange === false
      ? false
      : (pluginInPeerRange === true || hostInPeerRange === true ? true : null)
    return {
      name: baseline.name,
      peerRange: baseline.peerRange,
      baselineVersion: baseline.baselineVersion,
      pluginVersion,
      hostVersion,
      sameModule: sameAsHost[baseline.name] ?? null,
      inPeerRange,
      versionDrift: (hostVersion !== null && hostVersion !== baseline.baselineVersion)
        || (pluginVersion !== null && pluginVersion !== baseline.baselineVersion),
      ...(baseline.optional === true ? { optional: true } : {}),
      ...(baseline.observed === true ? { observed: true } : {}),
    }
  })
}

/**
 * 宿主默认预设的 id：名册里的默认值（用户选过的优先）。
 *
 * 判定「宿主注入的预设技能」要看这份预设的组合文件；名册取不到时用官方部署的默认值。
 */
function defaultPresetIdOf(ctx: { get?: (name: string) => unknown }): string {
  try {
    const roster = presetRosterOf(ctx)
    const id = roster?.defaultId
    return typeof id === 'string' && id.trim() !== '' ? id.trim() : DEFAULT_PRESET_ID
  } catch {
    return DEFAULT_PRESET_ID
  }
}

/**
 * 官方技能资产：技能页把宿主安装里的 office / sandbox / 预设技能整目录物化到插件自家目录。
 * 包还在、`assets/<技能>/SKILL.md` 的形态变了，技能页只会少几个来源（或来源为空），
 * 而能力表全绿 —— 所以单独探测一次。
 *
 * 三个来源分开报：office、sandbox 与预设技能是不同包、不同宿主形态（sandbox 只在 win32
 * 注入，预设技能按预设注入），合成一行会让「其中一个没了」看起来像「整个技能页坏了」。
 *
 * @param hostRoot - `.../node_modules/@deepseek-ai` 或 `null`。
 * @param presetId - 宿主默认预设 id；决定预设技能目录被不被注入。
 */
function inspectOfficialSkillAssets(
  hostRoot: string | null,
  presetId: string = DEFAULT_PRESET_ID,
): CapabilityFinding[] {
  if (hostRoot === null) return []
  const requireFromHost = createRequire(join(dirname(hostRoot), 'package.json'))
  const resolvePackage = (name: string): string | null => {
    try { return packageRootOf(requireFromHost.resolve(name)) } catch { return null }
  }
  const out: CapabilityFinding[] = []
  const officeRoot = resolvePackage('@deepseek-ai/dsh-skill-office')
  if (officeRoot === null) {
    out.push({
      id: 'official-skill-assets', label: '官方 office 技能资产', kind: 'read',
      owner: 'plugin', fallback: 'inform-only', state: 'not-available', missing: [], optional: true,
      detail: '宿主未安装 office 技能资源包：技能页不会出现官方 office 技能（本部署形态，不是故障）',
    })
  } else {
    const assets = join(officeRoot, 'assets')
    let names: string[] = []
    try {
      names = readdirSync(assets, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(assets, entry.name, 'SKILL.md')))
        .map((entry) => entry.name)
    } catch { names = [] }
    if (names.length === 0) {
      out.push({
        id: 'official-skill-assets', label: '官方 office 技能资产', kind: 'read',
        owner: 'plugin', fallback: 'inform-only', state: 'shape-mismatch', missing: ['assets/*/SKILL.md'],
        detail: 'office 技能包还在，但 assets 下找不到任何带 SKILL.md 的技能目录：技能页这一来源会是空的。',
      })
    } else {
      out.push({
        id: 'official-skill-assets', label: '官方 office 技能资产', kind: 'read',
        owner: 'plugin', fallback: 'inform-only', state: 'ok', missing: [],
        detail: `office 技能源在位（${names.length} 个技能目录）`,
      })
    }
  }
  const sandboxRoot = resolvePackage('@deepseek-ai/dsh-sandbox-windows-acl')
  if (sandboxRoot === null) {
    out.push({
      id: 'official-sandbox-asset', label: '官方沙盒诊断技能资产', kind: 'read',
      owner: 'plugin', fallback: 'inform-only', state: 'not-available', missing: [], optional: true,
      detail: process.platform === 'win32'
        ? '宿主未安装 Windows ACL 沙盒包：技能页不会出现沙盒诊断技能（宿主可能使用其他沙盒后端）'
        : '非 Windows 宿主不注入沙盒诊断技能（本部署形态，不是故障）',
    })
  } else {
    // 技能正文会指引模型执行这个脚本；只查 SKILL.md 会漏掉「文档在、脚本被裁掉」。
    const assetDir = 'assets/diagnose-windows-sandbox-acl'
    const required = ['SKILL.md', 'scripts/diagnose-windows-sandbox-acl.ps1']
    const missing = required
      .filter((rel) => !existsSync(join(sandboxRoot, assetDir, rel)))
      .map((rel) => `${assetDir}/${rel}`)
    out.push(missing.length === 0
      ? {
          id: 'official-sandbox-asset', label: '官方沙盒诊断技能资产', kind: 'read',
          owner: 'plugin', fallback: 'inform-only', state: 'ok', missing: [],
          detail: '沙盒诊断技能源在位（SKILL.md 与 PowerShell 脚本都可读）',
        }
      : {
          id: 'official-sandbox-asset', label: '官方沙盒诊断技能资产', kind: 'read',
          owner: 'plugin', fallback: 'inform-only', state: 'shape-mismatch', missing,
          detail: `沙盒包还在，但 ${missing.join('、')} 不存在：技能页即使列出该技能也跑不起来。`,
        })
  }
  const presetRoot = resolvePackage('@deepseek-ai/dsh-agent-preset')
  if (presetRoot === null) {
    out.push({
      id: 'official-preset-skills', label: '官方预设技能资产', kind: 'read',
      owner: 'plugin', fallback: 'inform-only', state: 'not-available', missing: [], optional: true,
      detail: '宿主未安装 agent-preset 包：技能页不会出现预设技能（如 dsh-doc）（本部署形态，不是故障）',
    })
  } else {
    const skills = join(presetRoot, 'skills')
    if (!existsSync(skills)) {
      out.push({
        id: 'official-preset-skills', label: '官方预设技能资产', kind: 'read',
        owner: 'plugin', fallback: 'inform-only', state: 'shape-mismatch', missing: ['skills/*/SKILL.md'],
        detail: 'agent-preset 包还在，但 skills 目录不见了：预设技能这一来源会是空的。',
      })
    } else {
      let names: string[] = []
      try {
        names = readdirSync(skills, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && existsSync(join(skills, entry.name, 'SKILL.md')))
          .map((entry) => entry.name)
      } catch { names = [] }
      // 宿主把预设技能目录接进会话上下文与否，看默认预设的组合文件（官方部署的默认
      // 预设 id 是 standard）：接了才注入，没接的预设不注入 —— 这一行据此说人话。
      // 读不到组合文件时 `wired` 保持 `null`，这一行按 `ok` 报（无法判定，不谎报缺陷）。
      // 物化侧（`skills/official.ts` 的 `presetInjectsPresetSkills`）此时返回 `false`：
      // 两边取舍不同是有意的 —— 兼容页是"检测报告"，判定不了就不下结论；技能页要**列条目**，
      // 列一个不存在的技能比少列更糟。
      // 与技能页**同一份**读取口径（`readHostPresetComposition` 会按两个包来源依次找）。
      // 早先这里自己拼 `join(hostRoot, 'dsh-web-app', ...)`：同一台机器上可能读到另一个副本，
      // 于是「技能页列了、兼容页说没接」两边矛盾，谁也说不清哪个对。
      const composition = readHostPresetComposition(presetId)
      const wired: boolean | null = composition === null ? null : presetCompositionWiresPresetSkills(composition)
      out.push(names.length === 0
        ? {
            id: 'official-preset-skills', label: '官方预设技能资产', kind: 'read',
            owner: 'plugin', fallback: 'inform-only', state: 'not-available', missing: [], optional: true,
            detail: 'agent-preset 包在，但 skills 下没有技能目录：这份宿主不带预设技能。',
          }
        : wired === false
          ? {
              id: 'official-preset-skills', label: '官方预设技能资产', kind: 'read',
              owner: 'plugin', fallback: 'inform-only', state: 'not-available', missing: [], optional: true,
              detail: `宿主默认预设（${presetId}）没有接预设技能目录：这份宿主不注入预设技能，技能页也不列它们。`,
            }
          : {
              id: 'official-preset-skills', label: '官方预设技能资产', kind: 'read',
              owner: 'plugin', fallback: 'inform-only', state: 'ok', missing: [],
              detail: `预设技能源在位（${names.length} 个技能目录）`,
            })
    }
  }
  return out
}

/**
 * 供 CLI（doctor）复用同一份官方技能资产判定。
 *
 * @param hostRoot - `.../node_modules/@deepseek-ai` 或 `null`。
 */
export function inspectStaticSkillAssets(hostRoot: string | null): CapabilityFinding[] {
  return inspectOfficialSkillAssets(hostRoot)
}

/**
 * 官方包**导出的 schema 对象**上的字段名：canary 只能证明字符串还在，读一次 JSON 表示
 * 才能确认插件写出的键仍被宿主接受。目前只有 MCP 客户端配置一份（插件写补丁的唯一出口）。
 *
 * 解析不到包 / 没有 `Config` 导出时不返回结论 —— 那是契约清单（`BARE_HOST_MODULE_CONTRACTS`）
 * 的职责，不在这里重复报一次。
 *
 * @param hostRoot - `.../node_modules/@deepseek-ai` 或 `null`。
 */
function inspectHostSchemaContracts(hostRoot: string | null): CapabilityFinding[] {
  if (hostRoot === null) return []
  const finding = inspectMcpClientConfig(hostRoot)
  return finding === null ? [] : [finding]
}

/**
 * 供 CLI（doctor）复用同一份 schema 契约判定：页面在活宿主里跑 `assessHost`，没有活宿主时
 * 只能由这里读宿主安装的导出对象。行为与页面完全同源。
 *
 * @param hostRoot - `.../node_modules/@deepseek-ai` 或 `null`。
 */
export function inspectStaticSchemaContracts(hostRoot: string | null): CapabilityFinding[] {
  return inspectHostSchemaContracts(hostRoot)
}

/** 插件写 MCP 补丁时用到的全部配置键（`patch-yaml.ts` 的 buildInsertBlock）。 */
const MCP_CLIENT_CONFIG_KEYS = [
  'transport', 'serverName', 'command', 'args', 'env', 'headers', 'url', 'toolCallTimeoutMs',
] as const

/**
 * 从宿主安装锚点 require `dsh-mcp-client` 的 `Config`，收集 schema JSON 里所有对象字段名，
 * 核对插件写出的键还在不在。
 *
 * 为什么读 `Config.toJSON()` 而不是拿样例跑一遍：schemastery 对未知键是"原样保留"，
 * 改名后的旧键会作为未知字段留在结果里 —— 样例校验会给出假绿；schema 的 `dict` 键表
 * 才是权威字段名。
 */
function inspectMcpClientConfig(hostRoot: string): CapabilityFinding | null {
  let mod: Record<string, unknown>
  try {
    mod = createRequire(join(dirname(hostRoot), 'package.json'))('@deepseek-ai/dsh-mcp-client') as Record<string, unknown>
  } catch {
    return null
  }
  const Config = mod.Config as { toJSON?: () => unknown } | undefined
  if (Config === undefined || typeof Config.toJSON !== 'function') return null
  let json: unknown
  try { json = Config.toJSON() } catch (error) {
    return {
      id: 'mcp-client.config-schema',
      label: 'MCP 客户端配置 schema',
      kind: 'read',
      owner: 'plugin',
      fallback: 'inform-only',
      state: 'not-available',
      missing: [],
      detail: `无法读取 dsh-mcp-client 的 Config.toJSON()：${String((error as Error)?.message ?? error)}`,
    }
  }
  const keys = new Set<string>()
  collectSchemaDictKeys(json, keys, new Set(), 0)
  if (keys.size === 0) {
    return {
      id: 'mcp-client.config-schema',
      label: 'MCP 客户端配置 schema',
      kind: 'read',
      owner: 'plugin',
      fallback: 'inform-only',
      state: 'not-available',
      missing: [],
      detail: '无法从 Config 的 JSON 表示里读出字段名：官方换了 schema 的表示方式，MCP 配置键需要人工复核',
    }
  }
  const missing = MCP_CLIENT_CONFIG_KEYS.filter((key) => !keys.has(key))
  if (missing.length > 0) {
    return {
      id: 'mcp-client.config-schema',
      label: 'MCP 客户端配置 schema',
      kind: 'read',
      owner: 'plugin',
      fallback: 'inform-only',
      state: 'shape-mismatch',
      missing,
      detail: `官方 MCP 客户端 schema 里找不到配置键 ${missing.join('、')}：插件写出的补丁会被宿主忽略，MCP 页仍会显示「已配置」`,
    }
  }
  return {
    id: 'mcp-client.config-schema',
    label: 'MCP 客户端配置 schema',
    kind: 'read',
    owner: 'plugin',
    fallback: 'inform-only',
    state: 'ok',
    missing: [],
    detail: `插件写出的 ${MCP_CLIENT_CONFIG_KEYS.length} 个配置键都在官方 schema 里`,
  }
}

/** 递归收集 schema JSON 里 `dict` 的键（对象字段名）；限深并防环。 */
function collectSchemaDictKeys(node: unknown, out: Set<string>, seen: Set<object>, depth: number): void {
  if (depth > 12 || node === null || typeof node !== 'object') return
  if (seen.has(node)) return
  seen.add(node)
  const record = node as Record<string, unknown>
  const dict = record.dict
  if (dict !== null && typeof dict === 'object') {
    for (const key of Object.keys(dict as Record<string, unknown>)) out.add(key)
  }
  for (const value of Object.values(record)) collectSchemaDictKeys(value, out, seen, depth + 1)
}

/**
 * 一组宿主契约的实况：插件依赖的官方包还暴不暴露、入口里那几条 canary 还在不在。
 *
 * 为什么在探测里量而不是只在 doctor 里量：doctor 是"没有活宿主"的静态视图，而兼容页看到的是
 * 正在跑的宿主。升级 DSH 后第一眼该看见的正是这一块 —— 官方撤掉某个包 / 改掉一个事件名时
 * **不抛错**，功能只是少一半，除此之外没有任何信号。
 *
 * 口径统一从宿主安装锚点解析（不是插件侧）：这一块回答的是「宿主这一份现在怎样」，
 * 而插件可能是另一份拷贝；宿主专属包从插件侧解析更只会得到一律"解析不到"，那不是结论。
 *
 * @param hostRoot - `.../node_modules/@deepseek-ai` 或 `null`（找不到宿主）。
 * @param contracts - 要检查的契约清单（裸模块 / 行为契约各一份）。
 */
export function hostContractStatus(hostRoot: string | null, contracts: readonly HostModuleContract[]): HostContractStatus | null {
  if (hostRoot === null) return null
  const packages = contracts.map((contract) => {
    let resolved: string | null = null
    try {
      resolved = createRequire(join(dirname(hostRoot), 'package.json')).resolve(contract.package)
    } catch {
      resolved = null
    }
    let missingMarkers: string[] = []
    let missingMarkerNotes: HostContractMarkerNote[] = []
    if (resolved !== null && contract.markers.length > 0) {
      const root = packageRootOf(resolved)
      const cache = new Map<string, string | null>()
      const read = (file: string | undefined): string | null => {
        const key = file ?? ''
        if (cache.has(key)) return cache.get(key) ?? null
        let source: string | null = null
        try {
          const target = file === undefined ? resolved : (root === null ? null : join(root, ...file.split('/')))
          source = target === null ? null : readFileSync(target, 'utf8')
        } catch { source = null }
        cache.set(key, source)
        return source
      }
      const missing = contract.markers.filter((marker) => {
        const source = read(marker.file)
        return source === null || !source.includes(marker.needle)
      })
      missingMarkers = missing.map((marker) => marker.needle)
      missingMarkerNotes = missing.map((marker) => ({
        needle: marker.needle,
        why: marker.why,
        ...(marker.file === undefined ? {} : { file: marker.file }),
      }))
    }
    return {
      package: contract.package,
      feature: contract.feature,
      ...(contract.impact === undefined ? {} : { impact: contract.impact }),
      ...(contract.optional === true ? { optional: true } : {}),
      resolved,
      missingMarkers,
      missingMarkerNotes,
    }
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
 * 本插件所挂的那个 DSH 安装的 `@deepseek-ai` 目录。
 *
 * 判据是「这个目录里确实装着宿主包」（`looksLikeHostPackageDir`），不是「有没有
 * `@deepseek-ai/dsh` 同级包」：全局 npm 安装把依赖放在 `dsh/node_modules/@deepseek-ai`，
 * 那一层没有 `dsh` 自己；按同级包判会把全局安装整体跳过，退到 npx 缓存里另一代宿主上
 * 比出假的「两份不同拷贝」。
 */
function hostPackageRoot(): string | null {
  for (const candidate of hostRootCandidates()) {
    if (looksLikeHostPackageDir(candidate)) return candidate
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

