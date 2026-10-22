// 更新检查（0.21.2 Phase 5.1）—— 只读、可缓存、绝不自动更新。
//
// 判据只有一条：**每个候选版本自己的 `engines.dsh`**。插件版本号与宿主版本号之间没有可推导的
// 对应关系（本仓库的版本约定是人工映射），拿 `latest` 或"版本号更大"当兼容结论都会把人带到
// 一个装不上的版本上。所以：
//   · 只从 registry 的 `versions` 里挑 `engines.dsh` 满足当前宿主的；
//   · 挑不出来就说 `no-compatible-version`，不给"最新版"这种没有意义的答案；
//   · 命令固定 `dsh plugin --profile <p> add <pkg>@<version>`，**绝不出现 `@latest`**。
//
// 网络策略：只请求 npm registry；3 秒硬超时；检测到代理环境变量直接返回 `proxy-unsupported`，
// 不尝试穿透（穿透失败会挂住启动流程，而这件事本来就不该阻塞任何东西）。
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as semver from 'semver'
import { writeFileAtomically } from './memories/index-io.js'

export const UPDATE_CHECK_FILE = 'update-check.json'
export const PACKAGE_NAME = 'dsh-plugin-tool-management'
export const REGISTRY_URL = 'https://registry.npmjs.org/' + PACKAGE_NAME

export type UpdateStatus =
  | 'update-available'
  | 'up-to-date'
  | 'no-compatible-version'
  | 'current-incompatible'
  | 'local-ahead'
  | 'host-unknown'
  | 'proxy-unsupported'
  | 'unknown'

export interface UpdateCheckResult {
  ok: boolean
  status: UpdateStatus
  /** 本插件当前版本。 */
  current: string
  /** 宿主版本（取不到 = null）。 */
  host: string | null
  /** registry 上的最新版本（不保证兼容）。 */
  newest: string | null
  /** 与当前宿主兼容的最高版本。 */
  bestCompatible: string | null
  /** 可直接复制的安装命令（`bestCompatible` 为空时是 null）。 */
  command: string | null
  checkedAt: string
  fromCache: boolean
  error?: string
}

export interface UpdateCheckerOptions {
  /** 缓存落点目录（插件 hub）。 */
  stateDir: string
  /** 本插件版本（`PKG_VERSION`）。 */
  current: string
  /** 宿主版本读取器；返回空 = 取不到。用函数而不是值：探测在请求时才做。 */
  hostVersion: () => string | null
  /** 本插件自己的 `engines.dsh`，用来判 `current-incompatible`。 */
  currentEngines?: string | null
  /** 安装命令里的 profile 名；未知时命令里写 `<profile>`。 */
  profile?: string | (() => string | undefined)
  /** 成功结果的缓存时长（默认 12h）。 */
  ttlMs?: number
  /** 失败结果的缓存时长（默认 1h）。 */
  failureTtlMs?: number
  /** 请求超时（默认 3s）。 */
  timeoutMs?: number
  /** 便于测试注入；默认 `process.env`。 */
  env?: Record<string, string | undefined>
  /** 便于测试注入；默认全局 fetch。 */
  fetchImpl?: typeof fetch
  /** 便于测试注入；默认 `Date.now`。 */
  now?: () => number
}

export interface UpdateChecker {
  /** 读缓存（或发一次请求），不抛错。 */
  check(force?: boolean): Promise<UpdateCheckResult>
  /** 启动时的预热：不 await，失败只留在结果里。 */
  start(): void
  /** 最近一次结果（未跑过 = null），供只读 op 立即回答。 */
  peek(): UpdateCheckResult | null
}

interface RegistryVersion {
  engines?: { dsh?: unknown }
  deprecated?: unknown
}

interface RegistryMeta {
  'dist-tags'?: { latest?: string }
  versions?: Record<string, RegistryVersion>
}

/** 代理环境变量：命中任意一个就当作"网络路径不确定"，不尝试请求。 */
export function proxyDetected(env: Record<string, string | undefined>): boolean {
  return ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']
    .some((key) => String(env[key] || '').trim() !== '')
}

/**
 * 从 registry 的 `versions` 里挑与 `host` 兼容的最高版本。
 *
 * 兼容判据是**每个版本自己的** `engines.dsh`：没有该字段、不是合法 range、或不满足 → 跳过。
 * `host` 为空 / 非法 → `null`（调用方报 `host-unknown`）。
 */
export function pickBestCompatible(versions: RegistryVersion[] | Record<string, RegistryVersion>, host: string | null): string | null {
  if (!host || !semver.valid(host)) return null
  const list = Array.isArray(versions)
    ? versions.map((v, i) => ({ version: (v as any)?.version || String(i), meta: v }))
    : Object.entries(versions).map(([version, meta]) => ({ version, meta }))
  const compatible: string[] = []
  for (const { version, meta } of list) {
    if (!semver.valid(version)) continue
    const range = meta && meta.engines && typeof meta.engines.dsh === 'string' ? meta.engines.dsh.trim() : ''
    if (range === '') continue
    let ok = false
    try { ok = semver.satisfies(host, range, { includePrerelease: true }) } catch { ok = false }
    if (ok) compatible.push(version)
  }
  if (!compatible.length) return null
  return semver.rsort(compatible)[0]
}

/** 由"当前 / 宿主 / 最高兼容版本"三个事实得出状态（纯函数，便于测试）。 */
export function updateStatusOf(input: {
  current: string
  host: string | null
  bestCompatible: string | null
  currentEngines?: string | null
}): UpdateStatus {
  const { current, host, bestCompatible } = input
  if (!host || !semver.valid(host)) return 'host-unknown'
  if (!bestCompatible) {
    const own = String(input.currentEngines || '').trim()
    if (own !== '') {
      try { if (!semver.satisfies(host, own, { includePrerelease: true })) return 'current-incompatible' } catch { /* range 写错按未知处理 */ }
    }
    return 'no-compatible-version'
  }
  if (!semver.valid(current)) return 'unknown'
  if (semver.gt(bestCompatible, current)) return 'update-available'
  if (semver.gt(current, bestCompatible)) return 'local-ahead'
  return 'up-to-date'
}

/** 安装命令：永远 pin 到具体版本，不出现 `@latest`。 */
export function installCommand(profile: string | undefined, version: string): string {
  return 'dsh plugin --profile ' + (profile && profile.trim() !== '' ? profile.trim() : '<profile>') +
    ' add ' + PACKAGE_NAME + '@' + version
}

export function createUpdateChecker(options: UpdateCheckerOptions): UpdateChecker {
  const ttlMs = options.ttlMs ?? 12 * 60 * 60 * 1000
  const failureTtlMs = options.failureTtlMs ?? 60 * 60 * 1000
  const timeoutMs = options.timeoutMs ?? 3000
  const env = options.env ?? process.env
  const now = options.now ?? Date.now
  const cacheFile = join(options.stateDir, UPDATE_CHECK_FILE)
  let last: UpdateCheckResult | null = null
  let inflight: Promise<UpdateCheckResult> | null = null

  const base = (): Omit<UpdateCheckResult, 'status' | 'ok' | 'checkedAt' | 'fromCache'> => {
    let host: string | null = null
    try {
      const raw = options.hostVersion()
      host = raw && semver.valid(raw) ? raw : null
    } catch { host = null }
    return {
      current: options.current,
      host,
      newest: null,
      bestCompatible: null,
      command: null,
    }
  }

  const finish = (status: UpdateStatus, extra: Partial<UpdateCheckResult> = {}): UpdateCheckResult => {
    const result: UpdateCheckResult = {
      ok: status !== 'unknown',
      ...base(),
      status,
      checkedAt: new Date(now()).toISOString(),
      fromCache: false,
      ...extra,
    }
    // `command` 只跟 `bestCompatible` 走，避免两处各拼一次。
    if (result.bestCompatible) {
      const profile = typeof options.profile === 'function' ? options.profile() : options.profile
      result.command = installCommand(profile, result.bestCompatible)
    }
    last = result
    return result
  }

  const readCache = async (): Promise<UpdateCheckResult | null> => {
    try {
      const raw = JSON.parse(await readFile(cacheFile, 'utf8'))
      if (!raw || typeof raw !== 'object') return null
      if (raw.current !== options.current) return null
      if ((raw.host || null) !== base().host) return null
      const age = now() - Date.parse(String(raw.checkedAt || ''))
      if (!Number.isFinite(age) || age < 0) return null
      const ttl = raw.ok === false ? failureTtlMs : ttlMs
      if (age > ttl) return null
      const result: UpdateCheckResult = { ...raw, fromCache: true }
      last = result
      return result
    } catch {
      return null
    }
  }

  const writeCache = async (result: UpdateCheckResult): Promise<void> => {
    try {
      await mkdir(options.stateDir, { recursive: true })
      await writeFileAtomically(cacheFile, JSON.stringify({ ...result, fromCache: false }, null, 2) + '\n', { mode: 0o600 })
    } catch {
      // 缓存写不进去不影响结论：下一次重新请求即可。
    }
  }

  const run = async (): Promise<UpdateCheckResult> => {
    const b = base()
    if (proxyDetected(env)) return finish('proxy-unsupported')
    if (!b.host) return finish('host-unknown')
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') return finish('unknown', { ok: false, error: 'fetch unavailable' })
    let meta: RegistryMeta
    try {
      const res = await fetchImpl(REGISTRY_URL, {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) return finish('unknown', { ok: false, error: 'registry HTTP ' + res.status })
      meta = await res.json() as RegistryMeta
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return finish('unknown', { ok: false, error: message })
    }
    const versions = meta && meta.versions && typeof meta.versions === 'object' ? meta.versions : {}
    const all = Object.keys(versions).filter((v) => semver.valid(v))
    const newest = all.length ? semver.rsort(all)[0] : (meta && meta['dist-tags'] && meta['dist-tags'].latest) || null
    const bestCompatible = pickBestCompatible(versions, b.host)
    const status = updateStatusOf({
      current: options.current,
      host: b.host,
      bestCompatible,
      currentEngines: options.currentEngines ?? null,
    })
    return finish(status, { newest, bestCompatible })
  }

  const check = async (force?: boolean): Promise<UpdateCheckResult> => {
    if (!force) {
      const cached = await readCache()
      if (cached) return cached
    }
    if (inflight) return inflight
    inflight = run()
      .then(async (result) => { await writeCache(result); return result })
      .finally(() => { inflight = null })
    return inflight
  }

  return {
    check,
    start() {
      void check(false).catch(() => { /* 更新检查永远不影响启动 */ })
    },
    peek() {
      return last
    },
  }
}
