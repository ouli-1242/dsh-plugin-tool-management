// 宿主安装根的发现与「该走哪条恢复路」的判定。
//
// 声明从 compat/probe.ts 按行号区间搬来，正文一字未改（唯一的容差是 `--export-top-level`
// 加的 `export ` 前缀，moved-verify 逐字对拍）。
//
// 为什么单独一层：这几件是「宿主装在哪、按什么形状找得到它」的**位置**知识，与 probe.ts 主体
// 那份「宿主版本与能力对不对」的**判定**知识是两件事；混在一起时 probe.ts 里几百行读代码的
// 视线都要先跨过一遍 asar / npx 缓存的路径拼接。
// 搬走的这些行里没有任何一处读 `import.meta.url` / `createRequire` —— 那两处在 probe.ts 主体
// 里（深度敏感，一挪就改语义），这一层不碰。
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

export const IDENTITY_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-workspace',
  '@deepseek-ai/dsh-session-projection-cache',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-spill-local',
] as const
export const VERIFIED_HOST_VERSION = '0.2.0-rc.2'
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
export function recoveryFor(_finding: CapabilityFinding): string {
  return `宿主 ${VERIFIED_HOST_VERSION} 的该项能力未通过探测；请更新本插件到与本机 DSH 匹配的版本，或改用宿主原生入口（先运行 node scripts/doctor.mjs 查看差异）。`
}
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
export function findingsById(assessment: Pick<HostAssessment, 'findings'>): Map<string, CapabilityFinding> {
  return new Map(assessment.findings.map((finding) => [finding.id, finding]))
}
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