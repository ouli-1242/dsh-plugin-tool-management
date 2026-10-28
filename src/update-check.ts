// 更新检查—— 只读、可缓存、绝不自动更新。
//
// 判据只有一条：**每个候选版本自己的 `engines.dsh`**。插件版本号与宿主版本号之间没有可推导的
// 对应关系（本仓库的版本约定是人工映射），拿 `latest` 或"版本号更大"当兼容结论都会把人带到
// 一个装不上的版本上。所以：
//   · 只从 registry 的 `versions` 里挑 `engines.dsh` 满足当前宿主的；
//   · 挑不出来就说 `no-compatible-version`，不给"最新版"这种没有意义的答案；
//   · 命令固定 `dsh plugin --profile <p> add <pkg>@<version>`，**绝不出现 `@latest`**。
//
// 下载源跟宿主走，不自己再定一套：`pluginManager.registries()` 给出配置的第一源与 fallback，
// `pluginRegistryProbe.fastest()` 是宿主自己的双源测速；两个都取不到时退回 npm 官方单源。
// 这里只把宿主的顺序落成请求顺序 —— 私有源优先是用户明确配置的意图，测速结果不许把它挤后。
//
// 网络策略：只请求 npm registry（不穿透代理）；首源 3 秒、回退源 4 秒——镜像的元数据可能比
// `/ping` 慢得多，3 秒会把能通的路判死；检测到代理环境变量直接返回 `proxy-unsupported`，
// 不尝试穿透（穿透失败会挂住启动流程，而这件事本来就不该阻塞任何东西）。
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as semver from 'semver'
import { writeFileAtomically } from './memories/index-io.js'

/** 更新检查结果的缓存文件名（在 hub 内）；删掉只是下次重新查。 */
export const UPDATE_CHECK_FILE = 'update-check.json'
/** 本插件在 npm 上的包名 —— 查更新与拼安装命令都用它。 */
export const PACKAGE_NAME = 'dsh-plugin-tool-management'
/** npm 官方 registry：没有宿主登记时的唯一来源，也是单源回退的默认值。 */
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'
/** npm registry 的元数据地址（单源回退时使用）。 */
export const REGISTRY_URL = DEFAULT_REGISTRY + PACKAGE_NAME
/** 公网源集合：宿主测速只覆盖这两个，只有它们能被测速结果提到最前。 */
const PUBLIC_REGISTRIES = new Set([DEFAULT_REGISTRY, 'https://registry.npmmirror.com/'])
/**
 * registry 元数据的响应体上限（8 MiB）。
 *
 * 本包的 install-v1 元数据只有几十 KiB；上限只用来挡住恶意或误配的源在超时前推来
 * 数百 MB —— `res.json()` 本身不设限，宿主与插件同进程，内存峰值会直接拖垮宿主。
 */
const MAX_REGISTRY_BYTES = 8 * 1024 * 1024

/** 宿主登记的下载源（`pluginManager.registries()` 的投影）。 */
export interface HostRegistries {
  /** 配置里显式指定的第一源；未配置 = null（此时看 `resolved`）。 */
  registry: string | null
  /** 第一源不可达或副本过期时依次跟上的源，顺序即优先级。 */
  fallbackRegistries: string[]
  /** pnpm 在 profile 里实际解析到的源；解析不出 = null。 */
  resolved: string | null
}

/** 更新检查的结论：有新版本 / 已最新 / 没有兼容版本 / 当前版本已不兼容 等。 */
export type UpdateStatus =
  | 'update-available'
  | 'up-to-date'
  | 'no-compatible-version'
  | 'current-incompatible'
  | 'local-ahead'
  | 'host-unknown'
  | 'proxy-unsupported'
  | 'unknown'

/** 一次更新检查的结果：当前版本、最新版本、有没有新东西。 */
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
  /** 回答这次检查的源（规范化 URL）；单源回退时是 npm 官方。 */
  source: string | null
  /** 可直接复制的安装命令（`bestCompatible` 为空时是 null）。 */
  command: string | null
  checkedAt: string
  fromCache: boolean
  error?: string
}

/** 更新检查的选项：超时、是否走代理、缓存路径。 */
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
  /** 宿主的下载源登记（`pluginManager.registries()`）；取不到 = null，退回单源。 */
  registries?: () => Promise<HostRegistries | null>
  /** 宿主双源测速（`pluginRegistryProbe.fastest()`）；返回命中的源或 null。 */
  fastest?: () => Promise<string | null>
  /** 成功结果的缓存时长（默认 12h）。 */
  ttlMs?: number
  /** 失败结果的缓存时长（默认 1h）。 */
  failureTtlMs?: number
  /** 首个源的请求超时（默认 3s）。 */
  timeoutMs?: number
  /** 回退源的请求超时（默认 4s）：镜像元数据慢于 `/ping`，首源的 3 秒对它不公平。 */
  fallbackTimeoutMs?: number
  /** 读宿主源登记的上限（默认 2.5s）：只有宿主需要去跑 pnpm 解析 `.npmrc` 时才会用到。 */
  planTimeoutMs?: number
  /** 等测速结论的上限（默认 2s）：宿主自己 1.5 秒就会给答案。 */
  probeTimeoutMs?: number
  /** 便于测试注入；默认 `process.env`。 */
  env?: Record<string, string | undefined>
  /** 便于测试注入；默认全局 fetch。 */
  fetchImpl?: typeof fetch
  /** 便于测试注入；默认 `Date.now`。 */
  now?: () => number
}

/** 更新检查的对外面：查一次、读缓存、判断能不能升。 */
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
 * 规范成与 pnpm 比较时同样的形状：http(s)、主机小写、路径以 `/` 结尾。
 *
 * 保留路径与端口 —— 私有源常挂在反向代理的子路径下（`/artifactory/api/npm/`），
 * 砍掉就指到别处去了。
 *
 * @param raw 配置里的原始地址
 * @returns 规范化后的地址；不是合法 http(s) URL 时 null
 */
function normalizeRegistry(raw: string | null | undefined): string | null {
  const text = String(raw ?? '').trim()
  if (text === '') return null
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (!url.pathname.endsWith('/')) url.pathname += '/'
    url.search = ''
    url.hash = ''
    // 凭据走 ~/.npmrc（宿主安装器的口径），不跟着地址进缓存与界面。
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return null
  }
}

/**
 * 把宿主的下载源登记整理成按序尝试的列表。
 *
 * 顺序就是宿主安装器自己的顺序：配置的第一源 → fallback 列表 →（配置为空时）pnpm 解析到的源。
 * 测速结果只在**首项本来就是公网源**时提前：首项是私有源时保持用户配置的顺序，
 * 一次公网测速不许把私有源挤到后面。
 *
 * @param configured 宿主登记；null（取不到）→ 返回空数组，由调用方走 npm 官方单源
 * @param fastest 测速命中的源；null = 没测或都不可达
 * @returns 规范化、去重后的源列表；可能为空
 */
export function sourcePlan(configured: HostRegistries | null, fastest: string | null): string[] {
  if (!configured) return []
  const first = normalizeRegistry(configured.registry) ?? normalizeRegistry(configured.resolved)
  const plan: string[] = []
  for (const raw of [first, ...configured.fallbackRegistries.map(normalizeRegistry)]) {
    if (raw !== null && !plan.includes(raw)) plan.push(raw)
  }
  const probed = normalizeRegistry(fastest)
  const head = plan[0]
  if (probed !== null && plan.includes(probed) && (head === undefined || PUBLIC_REGISTRIES.has(head))) {
    return [probed, ...plan.filter((registry) => registry !== probed)]
  }
  return plan
}

/**
 * 限时等待外部答案；超时或抛错都得到 null。
 *
 * 超时的那次调用没法取消（宿主的 pnpm 子进程照跑），但这里不等它 ——
 * 更新检查不该被一次 pnpm 慢启动拖住。
 */
async function settleWithin<T>(run: (() => Promise<T | null>) | undefined, ms: number): Promise<T | null> {
  if (!run) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      run().catch(() => null),
      new Promise<null>((resolvePromise) => { timer = setTimeout(() => resolvePromise(null), ms) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 读一份 registry 元数据，流式累计并限制响应体大小。
 *
 * @param fetchImpl 注入的 fetch（便于测试）
 * @param url 完整元数据地址
 * @param timeoutMs 本次请求的超时（与调用方的首源 / 回退源预算一致）
 * @returns 解析后的元数据
 * @throws 非 2xx、响应体超过 `MAX_REGISTRY_BYTES`、超时或 JSON 不合法
 */
async function readRegistryMeta(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<RegistryMeta> {
  const res = await fetchImpl(url, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error('registry HTTP ' + res.status)
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_REGISTRY_BYTES) throw new Error('registry response too large')
  const body = res.body as {
    getReader?: () => {
      read(): Promise<{ done: boolean; value?: Uint8Array }>
      cancel?(): Promise<void>
    }
  } | null
  let text: string
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > MAX_REGISTRY_BYTES) throw new Error('registry response too large')
        chunks.push(value)
      }
    } finally {
      try { await reader.cancel?.() } catch { /* 已经读完或已中止 */ }
    }
    text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8')
  } else {
    // 没有流实现的 fetch（测试替身 / 老运行时）：只能读完再校验，至少不把超大文本交给 JSON.parse。
    text = await res.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_REGISTRY_BYTES) throw new Error('registry response too large')
  }
  return JSON.parse(text) as RegistryMeta
}

/**
 * 从 registry 的 `versions` 里挑与 `host` 兼容的最高版本。
 *
 * 兼容判据是**每个版本自己的** `engines.dsh`：没有该字段、不是合法 range、或不满足 → 跳过。
 * 被维护者标记 `deprecated` 的版本也跳过 —— 它可能仍满足 range，但正是维护者明确不建议装的。
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
    const deprecated = meta && (meta as { deprecated?: unknown }).deprecated
    if (deprecated !== undefined && deprecated !== null && deprecated !== false && deprecated !== '') continue
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

/** 更新检查器：按 TTL 缓存结果，源跟随宿主登记，检测到代理直接跳过，绝不自动更新。 */
export function createUpdateChecker(options: UpdateCheckerOptions): UpdateChecker {
  const ttlMs = options.ttlMs ?? 12 * 60 * 60 * 1000
  const failureTtlMs = options.failureTtlMs ?? 60 * 60 * 1000
  const timeoutMs = options.timeoutMs ?? 3000
  const fallbackTimeoutMs = options.fallbackTimeoutMs ?? 4000
  const planTimeoutMs = options.planTimeoutMs ?? 2500
  const probeTimeoutMs = options.probeTimeoutMs ?? 2000
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
      source: null,
      command: null,
    }
  }

  const finish = (status: UpdateStatus, extra: Partial<UpdateCheckResult> = {}): UpdateCheckResult => {
    const result: UpdateCheckResult = {
      // `host-unknown` 是"这一拍读不到宿主版本"，不是结论：按失败 TTL 缓存，等宿主就绪后重试。
      ok: status !== 'unknown' && status !== 'host-unknown',
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
      // 旧缓存没有 `source`：按 null 处理，装的时候不指定源即可，不算无效缓存。
      const result: UpdateCheckResult = { ...raw, fromCache: true, source: typeof raw.source === 'string' ? raw.source : null }
      // 命令按当前 profile 重建：启动早期的检查可能还没有 profile 名，缓存里的 `<profile>` 不能一直留着。
      if (result.bestCompatible) {
        const profile = typeof options.profile === 'function' ? options.profile() : options.profile
        result.command = installCommand(profile, result.bestCompatible)
      }
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

  /** 宿主登记 + 测速 → 本次按序尝试的源；登记取不到时返回空数组，调用方走默认单源。 */
  const resolveSources = async (): Promise<string[]> => {
    const configured = await settleWithin(options.registries, planTimeoutMs)
    if (!configured) return []
    const head = sourcePlan(configured, null)[0]
    // 首项已是私有源时不测速：测速只覆盖两个公网源，把结果提到私有源前面是错的。
    const probed = head === undefined || PUBLIC_REGISTRIES.has(head)
      ? await settleWithin(options.fastest, probeTimeoutMs)
      : null
    return sourcePlan(configured, probed)
  }

  const run = async (): Promise<UpdateCheckResult> => {
    const b = base()
    if (proxyDetected(env)) return finish('proxy-unsupported')
    if (!b.host) return finish('host-unknown')
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') return finish('unknown', { ok: false, error: 'fetch unavailable' })
    const plan = await resolveSources()
    // 最多试两个：首项（通常已经过测速）失败时用回退源兜一次，再多只是把等待拖长。
    const sources = plan.length ? plan.slice(0, 2) : [DEFAULT_REGISTRY]
    let meta: RegistryMeta | null = null
    let source: string | null = null
    let lastError = ''
    for (const [index, registry] of sources.entries()) {
      try {
        meta = await readRegistryMeta(fetchImpl, registry + PACKAGE_NAME, index === 0 ? timeoutMs : fallbackTimeoutMs)
        source = registry
        break
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e)
      }
    }
    if (!meta) return finish('unknown', { ok: false, error: lastError || 'registry unreachable' })
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
    return finish(status, { newest, bestCompatible, source })
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
