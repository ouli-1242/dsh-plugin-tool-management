/**
 * 桌面壳鉴权 cookie 的启动期修剪。
 *
 * **为什么需要**：桌面端每次启动都拿一条新令牌去换 cookie，旧的那些从不清理；而 welcome 握手
 * 第二步用 Electron 的 `net.fetch` + `credentials: "include"` 取同一个 launch URL，会把 cookie
 * 库里**全部** `dsh-auth-*` 一并带上。条数堆到几十条之后服务端拒掉这次请求，界面表现为
 * 「desktop welcome: Web authentication failed」，应用起不来。同一台机器上罐里 71 条时必失败，
 * 清空后立刻恢复 —— 这就是本模块要拦住的那条路。
 *
 * **时序**：本模块在宿主进程装配期同步跑，早于桌面端发起握手。Chromium 的 cookie 库是懒加载的，
 * 首次网络请求之前读到的就是修剪后的库，因此本次启动即生效；若它已经加载过（少数情况），修剪
 * 也会在下一次启动生效，罐子至少不会无限增长。
 *
 * **边界**：只动 `127.0.0.1` 上 `dsh-auth-` 前缀的行；每进程只跑一次；任何失败都静默 ——
 * 这是替宿主兜底，绝不能因为清理失败而拖累启动。
 *
 * **移除条件**：宿主自己开始按启动轮次清理这些 cookie（罐里恒为 1 条）时，删掉本模块与调用点。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

/**
 * Electron 桌面壳的 userData 目录名（即 `app.getName()`），cookie 库在它下面的 `Network/`。
 * 这是宿主契约：改名会让本模块静默失效（找不到库就直接跳过），不会造成别的影响。
 */
const DESKTOP_APP_DIR = '@deepseek-ai/dsh-desktop'

/** 宿主鉴权 cookie 的前缀：一条对应一次启动的令牌。 */
const AUTH_COOKIE_PREFIX = 'dsh-auth-'

/** 这条 cookie 只在 `http://127.0.0.1:<port>/` 上有效，别的主机名一律不碰。 */
const AUTH_COOKIE_HOST = '127.0.0.1'

/**
 * 值得留一行日志的条数阈值。正常情况下每次启动罐里只有上一轮留下的 1 条，
 * 明显多于这个数说明曾经堆积过 —— 那种情况写一行日志，便于下次复盘。
 */
const NOISY_COUNT = 5

/** `node:sqlite` 里本模块用到的最小面（用 `createRequire` 取，避免把 Node 版本差异带进类型层）。 */
interface CookieDb {
  prepare(sql: string): { run(...params: unknown[]): { changes?: number | bigint } }
  close(): void
}

/** 修剪结果，供调用方决定是否要说点什么。 */
export interface DesktopAuthPruneResult {
  /** 是否打开了 cookie 库。`false` = 没有这个库、平台不支持、或 `node:sqlite` 不可用。 */
  opened: boolean
  /** 删掉的行数。 */
  removed: number
}

/**
 * 桌面壳 cookie 库的绝对路径。
 *
 * @param platform 目标平台，默认当前进程
 * @param env 读取 `APPDATA` / `XDG_CONFIG_HOME`，默认当前环境
 * @param home 用户主目录，默认当前用户
 * @returns 绝对路径；平台不认识时 `null`（调用方据此跳过）
 */
export function desktopCookieStorePath(
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string | null {
  const tail = join(DESKTOP_APP_DIR, 'Network', 'Cookies')
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), tail)
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', tail)
  if (platform === 'linux') return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), tail)
  return null
}

let done = false

/**
 * 清掉回环地址上残留的 `dsh-auth-*`。
 *
 * 保留不了「本次启动新换的那条」—— 此刻还没换，所以整类清空是安全且彻底的。
 * 进程内只跑一次：热重载再调也只返回空结果，避免反复去抢 Electron 正开着的库。
 *
 * @returns 本次调用的结果；`opened: false` 表示没有可清理的对象或环境不支持
 */
export function pruneDesktopAuthCookies(): DesktopAuthPruneResult {
  if (done) return { opened: false, removed: 0 }
  done = true
  const file = desktopCookieStorePath()
  if (file === null || !existsSync(file)) return { opened: false, removed: 0 }
  let db: CookieDb | null = null
  try {
    const sqlite = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync?: new (path: string) => CookieDb }
    const Ctor = sqlite.DatabaseSync
    if (typeof Ctor !== 'function') return { opened: false, removed: 0 }
    db = new Ctor(file)
    const info = db.prepare('DELETE FROM cookies WHERE host_key = ? AND name LIKE ?').run(AUTH_COOKIE_HOST, `${AUTH_COOKIE_PREFIX}%`)
    const removed = Number(info?.changes ?? 0)
    if (removed > NOISY_COUNT) {
      console.warn(`[dsh-plugin-tool-management] 清掉了 ${removed} 条桌面壳鉴权 cookie（宿主不清理，堆多了会导致启动握手被拒）。`)
    }
    return { opened: true, removed }
  } catch {
    // Electron 正开着这个库（SQLITE_BUSY）、node:sqlite 不可用、库结构不认识 —— 一律跳过。
    return { opened: false, removed: 0 }
  } finally {
    try { db?.close() } catch { /* 关不掉不影响启动 */ }
  }
}
