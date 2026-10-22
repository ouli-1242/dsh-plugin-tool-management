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

/** 探针要检查的那一片宿主对象。用 `unknown` 逼调用方自己收窄。 */
export type Target = Record<string, unknown> | undefined

/** `typeof` 的函数判定，带上类型收窄 —— 探针里到处要用，别各写一遍。 */
export const isFn = (value: unknown): value is (...args: unknown[]) => unknown => typeof value === 'function'

/**
 * 按本插件自己的方式解析一个包；解析不到返回 null，不抛错。
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
 * 路径是否落在 electron 的 `app.asar` 归档里。
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
 * 把路径穿过所有 junction / symlink 解析成物理文件。
 *
 * node 按真实路径加载模块，所以两个长得不一样的路径只要 realpath 到同一个文件就是同一个
 * 模块 —— 这正是本插件依赖的性质，也是 `@deepseek-ai/*` 用 junction 接进宿主安装、
 * 而不是复制一份的原因。
 *
 * 取不到真实形态时**不再拿输入去比**：那会把「路径不可解析」
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

/** 从可解析的包清单里读版本号。 */
export function versionOf(specifier: string): string | undefined {
  const entry = safeResolve(specifier)
  if (entry === null) return undefined
  let dir = dirname(entry)
  for (let i = 0; i < 4; i += 1) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string }
      if (parsed.name === specifier && typeof parsed.version === 'string') return parsed.version
    } catch {
      /* 这一层没有就继续往上找 */
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * 一个已解析入口路径所属包的版本：向上找 `package.json`，直到 `name` 与入口所在的
 * 包目录对得上。
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
 * 把活成员与本插件那份同实现做文本比对。
 *
 * `undefined` = 比不了：活对象上没有这个成员，或参考副本里也没有。
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
 * 定义活实例成员的那个原型。沿原型链走，代理、子类实例、跨 realm 对象都能问出真话。
 */
function prototypeOf(instance: unknown): Record<string, unknown> | undefined {
  if (instance === null || typeof instance !== 'object') return undefined
  if (typeof instance === 'function') return instance as unknown as Record<string, unknown>
  const proto: unknown = Object.getPrototypeOf(instance)
  return proto !== null && typeof proto === 'object' ? (proto as Record<string, unknown>) : undefined
}

// 每个能力属主的成员落在哪个官方包 / 类上 —— 「谁定义了这个属主」只在这里回答一次：
// 下面的活原型查找与对外的静态表都读它，宿主漂移因此只有一个描述处。
const WORKSPACE_CLASS = { pkg: '@deepseek-ai/dsh-workspace', target: 'WorkspaceRegistry' } as const
const PROJECTION_CLASS = { pkg: '@deepseek-ai/dsh-session-projection-cache', target: 'SessionProjectionCache' } as const
// `sessions.*` 的成员虽然是宿主私有的，但仍声明在官方类上：`@deepseek-ai/dsh-session`
// 是本插件声明的 peer，`SessionStore` 就是 `flush` / `liveEntryFor` / `detachEntered` /
// `enter` / `announce` 的所在。少了这一条，doctor 看不见删除路线依赖的那两项能力。
const SESSIONS_CLASS = { pkg: '@deepseek-ai/dsh-session', target: 'SessionStore' } as const
// 设置与预设名册两块契约面：类名按官方安装源码核对（dsh-settings 导出 SettingsForms；
// dsh-agent-preset-registry 导出 AgentPresetRegistry）。不在表里时，这两处契约一变
// （prepareDocument 返回语义、read 改名 readDocument）只能靠用户实测才发现。
const SETTINGS_CLASS = { pkg: '@deepseek-ai/dsh-settings', target: 'SettingsForms' } as const
const ROSTER_CLASS = { pkg: '@deepseek-ai/dsh-agent-preset-registry', target: 'AgentPresetRegistry' } as const
// tools.restrict / connection.admit 也声明在官方类上，所以同样接入「参考副本 + 文本比对」：
// 官方改了实现，结论就从"一致"变成"漂移"，界面上看得见。
const TOOLS_CLASS = { pkg: '@deepseek-ai/dsh-tools', target: 'ToolRuntime' } as const
const CONNECTION_CLASS = { pkg: '@deepseek-ai/dsh-client-connection', target: 'HostConnectionService' } as const
/** 每类宿主服务由哪个包的哪个导出承载 —— 静态检查要据此拿到官方原型。 */
export const OWNER_CLASSES: Partial<Record<CapabilityFinding['owner'], { readonly pkg: string; readonly target: string }>> = {
  workspace: WORKSPACE_CLASS,
  projectionCache: PROJECTION_CLASS,
  sessions: SESSIONS_CLASS,
  settings: SETTINGS_CLASS,
  presetRoster: ROSTER_CLASS,
  tools: TOOLS_CLASS,
  connection: CONNECTION_CLASS,
}

/** 具名导出的原型；包缺席或被裁剪时为 undefined。 */
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
 * 用哨兵实参**真调**一个宿主方法（分层探针第二层），验证「存在且可调用」：
 * - 同步抛 `TypeError` → 实现坏了/签名漂移，返回失败详情（shape-mismatch）；
 * - 受控同步拒绝（普通 `Error`，如 not found）或返回值（含 rejected Promise）→ 通过。
 *
 * 只判同步段：探针框架是同步的（`assessHost` 不能 await），异步结果分类留待
 * 异步化改造。返回的 Promise 一律挂 `.catch` 吞掉，探针
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

/** 官方原型：本插件的适配器照着它写，能 import 到才给。 */
export function referencePrototypes(): {
  workspace?: Record<string, unknown>
  cache?: Record<string, unknown>
  sessions?: Record<string, unknown>
  settings?: Record<string, unknown>
  roster?: Record<string, unknown>
  tools?: Record<string, unknown>
  connection?: Record<string, unknown>
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
  // 0.2.1 的两块：`dsh-tools` 是本插件的 peerDependency（参考副本拿得到）；
  // `dsh-client-connection` **不在** peerDependencies 里（宿主不要求插件直接依赖它），
  // 所以参考副本常态取不到 —— textMatch 记 undefined，那条能力退化成纯存在性检查。
  // 这是如实的能力边界：能验"admit 在不在"，验不了"实现漂没漂"。
  const tools = classPrototypeOf(TOOLS_CLASS)
  if (tools !== undefined) out.tools = tools
  const connection = classPrototypeOf(CONNECTION_CLASS)
  if (connection !== undefined) out.connection = connection
  return out
}
/**
 * 从**宿主侧**能不能解析到一个包（不 import，只看解析）。
 *
 * 为什么需要它：有一部分官方包**不是**本插件的 peer（宿主不要求插件依赖它们），插件自己的
 * `node_modules` 里就没有 —— `safeResolve`/`classPrototypeOf` 一律取不到。运行时探测不看
 * 插件侧（它看的是 ctx 上的活服务），所以只有 doctor 这种"没有活宿主"的静态视图会被误导：
 * 它从插件锚点解析，解析不到就把一条**运行时确实存在**的能力记成 `missing`
 * （`connection.admit` 就这么误报过：`dsh-client-connection` 不在插件依赖图里，
 * 而它承载的 `admit()` 在 0.2.1 的 Web 组合里一定有）。
 *
 * 判据必须是宿主侧：逐个宿主安装锚点试着解析（纯 `require.resolve`，不 import），只要有
 * **一个**能解析到就算能查。与 `safeResolve` 的分工：那个回答"本插件能不能 import 它"，
 * 这个回答"宿主装不装它" —— 后者才是静态能力表该用的口径。
 */
export function resolvableFromHost(specifier: string): boolean {
  for (const anchor of hostResolveAnchors()) {
    try {
      createRequire(anchor).resolve(specifier)
      return true
    } catch {
      /* 换下一个锚点再试 */
    }
  }
  return false
}

/**
 * 宿主安装的解析锚点（`package.json` 路径，按候选顺序）。
 *
 * 与 probe.ts 的 `hostPackageRoot()` 共用同一份 `hostRootCandidates()`，但这里**不要求**
 * `dsh/package.json` 在场：即使那一层只剩空壳（0.1.5 时代的悬空 junction 树，本机正是如此），
 * 它下面的 `node_modules/@deepseek-ai/<pkg>` 仍可能解析得到。判据各取所需 —— probe.ts 要
 * "像不像一份完整安装"，这里只问"这个包从这里能不能解析到"。
 */
function hostResolveAnchors(): string[] {
  return hostRootCandidatesFn().map((dir) => join(dirname(dir), 'package.json'))
}

// `hostRootCandidates()` 的注入点：由 probe.ts 在模块加载时填进来。不反向 import 是为了
// 不成环（probe.ts → host-probe.ts → probe.ts），而"宿主在哪"的口径仍然只有一份。
let hostRootCandidatesFn: () => string[] = () => []
/** 注入「宿主根候选」的实现。放在这里是为了让 host-probe 不反向依赖 host-roots（避免循环引用）。 */
export function provideHostRootCandidates(fn: () => string[]): void {
  hostRootCandidatesFn = fn
}
