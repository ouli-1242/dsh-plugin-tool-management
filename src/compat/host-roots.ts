// 宿主安装根的发现与「该走哪条恢复路」的判定。
//
// 为什么单独一层：这几件是「宿主装在哪、按什么形状找得到它」的**位置**知识，与 probe.ts 主体
// 那份「宿主版本与能力对不对」的**判定**知识是两件事；混在一起时 probe.ts 里几百行读代码的
// 视线都要先跨过一遍 asar / npx 缓存的路径拼接。
//
// 这一层不读 `import.meta.url` / `createRequire` —— 那两处在 probe.ts 主体里（深度敏感，
// 一挪就改语义），这里只吃已解析好的路径。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

// 类型面照旧从 lib/compat/probe.js 对外可见（`ops/compat.ts` 等按这个路径引它们）。

/**
 * 需要比对**物理模块身份**的官方包。
 *
 * 只收「插件与宿主会同时加载、且是否同一份实现会改变行为」的那几个：cordis 的 symbol、
 * tools 的注册表、工作区的索引、投影缓存、存储域、spill。别的官方包只在能力表里按成员检查。
 */
export const IDENTITY_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-workspace',
  '@deepseek-ai/dsh-session-projection-cache',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-spill-local',
] as const
/** 本插件适配器最后一次对着验证过的宿主版本 —— 改它等于宣布适配了新的一代。 */
export const VERIFIED_HOST_VERSION = '0.2.1-rc.2'
/**
 * 每个操作依赖的能力集合，按「缺成员时插件怎么达到同样结果」分组。
 *
 * 顺序即优先级：`native`（宿主自己就实现了整个操作）能走就不走 `adapter`（受检兼容层，
 * 唯一会碰私有成员的路线）。两组都不可用才算该操作不可用。
 */
export const OPERATION_ROUTES = {
  archive: { native: ['workspace.archive-native'], adapter: ['workspace.enqueue', 'workspace.set-state'] },
  unarchive: { native: ['workspace.unarchive-native'], adapter: ['workspace.enqueue', 'workspace.set-state'] },
  batch: { native: ['workspace.batch-native'], adapter: ['workspace.enqueue', 'workspace.set-state'] },
  delete: {
    native: ['workspace.delete-native'],
    // `projection.delete-native` **刻意不作为**路线要求：宿主缓存没有自己的删除屏障是
    // 常态，`sessions/bridge.ts` 会包一层顶上；连包都包不住时由它自己报拒绝。把它列为
    // 要求，会让本插件适配的那一版宿主反而删不了东西。
    adapter: [
      'workspace.enqueue', 'workspace.set-state', 'workspace.index-header',
      'sessions.detach-live', 'sessions.cold-announce', 'projection.write',
      // `projection.table-delete` 是运行时硬前提，也算一条路由要求 —— 不算进来的话，宿主表
      // 不可删时路由说可用、点下去必拒。batch 的 adapter 路由**有意**只留 enqueue / set-state：
      // 它的逐条失败会在结果里按 sessionId 报出来，此处不放宽也不收紧。
      'projection.table-delete',
    ],
  },
  list: { native: [], adapter: ['workspace.read-state', 'workspace.read-table', 'workspace.index-shape'] },
} as const satisfies Record<string, { native: readonly string[]; adapter: readonly string[] }>
/** 可选的操作名，与 {@link OPERATION_ROUTES} 的键一一对应。 */
export type OperationName = keyof typeof OPERATION_ROUTES
/**
 * 一条能力失败时给用户看的补救说明。
 *
 * 所有能力目前共用同一句：可行动的路只有两条（更新插件 / 改用宿主原生入口），差异在
 * `doctor` 的明细里。参数留着，将来要按能力分叉时不必改调用点。
 *
 * @param _finding 失败的那条能力结论
 * @returns 可直接展示给用户的补救说明
 */
export function recoveryFor(_finding: CapabilityFinding): string {
  return `宿主 ${VERIFIED_HOST_VERSION} 的该项能力未通过探测；请更新本插件到与本机 DSH 匹配的版本，或改用宿主原生入口（先运行 node scripts/doctor.mjs 查看差异）。`
}
/**
 * 宿主 `@deepseek-ai` 目录的候选序列，按优先级排 —— 全仓「宿主装在哪」的唯一口径。
 *
 * 四步，前一步找不到才看下一步：
 *   1. 桌面版的 `resources/app.asar`（见 {@link asarHostPackageRoot}）；
 *   2. `$DSH_HOME/profiles/node_modules/@deepseek-ai`；
 *   3. 从 {@link IDENTITY_PACKAGES} 里每个能解析的锚点向上找 `node_modules/@deepseek-ai`；
 *   4. npx 缓存里的安装（见 {@link npxCacheHostRoots}）。
 *
 * 锚点那一步只认**真实形态**：取不到就跳过 —— 这里没有可比的对象，跳过是如实；而身份
 * 比对那边取不到必须报出来（见 `assessHost` 的 realpath 说明）。
 *
 * @returns 候选目录（可能为空，调用方按顺序试）
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
 * 桌面版 `app.asar` 里的宿主 `@deepseek-ai` 目录。
 *
 * 只认 electron 注入的 `process.resourcesPath`，不按包名或环境变量猜 —— 所以 `dsh web`
 * （普通 node）下一律返回 null。归档内路径由 electron 自己的 fs 修补解析，归档外的普通
 * node 读不到，因此这里失败是正常路径，不报错。
 *
 * @returns 归档内的目录；不是桌面版、或归档里没有 `dsh` 包时为 null
 */
export function asarHostPackageRoot(): string | null {
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
 * npx 缓存里的宿主 `@deepseek-ai` 目录，按目录 mtime 新到旧排。
 *
 * 缓存位置依次看 `npm_config_cache`、`~/.npmrc` 的 `cache=`、`%LOCALAPPDATA%\npm-cache`。
 * 全程同步、不起子进程；一个都读不到就当没有这批候选。
 *
 * @returns 按新旧排好的目录列表（可能为空）
 */
export function npxCacheHostRoots(): string[] {
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
/**
 * 能力 id → 结论的索引，供路由判定反复按 id 查。
 *
 * @param assessment 任意带 `findings` 的评估结果
 * @returns id 到结论的映射；同一个 id 重复出现时后者胜
 */
export function findingsById(assessment: Pick<HostAssessment, 'findings'>): Map<string, CapabilityFinding> {
  return new Map(assessment.findings.map((finding) => [finding.id, finding]))
}
/**
 * 把一组能力 id 里**没通过**的那些翻成拒绝说明，顺序与入参一致。
 *
 * id 在评估里不存在时**不算失败**：宿主根本没暴露这项能力，挡不住一条用不到它的路线。
 *
 * @param assessment 任意带 `findings` 的评估结果
 * @param ids 要检查的能力 id
 * @returns 拒绝说明列表；全部通过时为空数组
 */
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
/** 某个操作的路由结论：原生 / 适配器 / 无路，以及无路时缺什么。 */
export interface RouteDecision {
  /** `native` = 官方入口，`adapter` = 受检兼容层，`none` = 两条都不通（看 `refusals`）。 */
  readonly via: 'native' | 'adapter' | 'none'
  readonly refusals: readonly CapabilityRefusal[]
}
/**
 * 决定一个操作该走哪条路。
 *
 * 从不从「部分可用」悄悄退到破坏性路线：只有它需要的**每一项**能力都 `ok`，那条路才被选中。
 *
 * @param assessment 最新一次宿主评估
 * @param operation 操作名（见 {@link OPERATION_ROUTES}）
 * @returns 选中的路线；`none` 时附上缺什么、为什么
 */
export function routeFor(assessment: Pick<HostAssessment, 'findings'>, operation: OperationName): RouteDecision {
  const routes = OPERATION_ROUTES[operation]
  const index = findingsById(assessment)
  const allOk = (ids: readonly string[]): boolean =>
    ids.every((id) => {
      const finding = index.get(id)
      // 宿主根本没暴露的能力，挡不住一条用不到它的路线；缺席的 id 按满足处理。
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