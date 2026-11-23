// hub 级跨进程写锁。
//
// 为什么需要：DSH 的 web 与 desktop 是两个宿主进程，却共用同一个 `$DSH_HOME`。apply 里那条
// `writeChain` 只能串行**同一进程**的写入；两个进程同时读-改-写同一份侧车时，后写的会覆盖
// 先写的（停用表、作用域覆盖、工具表都是整份写）。这里用 hub 根下的 `.write.lock` 做第二层。
//
// 锁文件不常开：写入 pid / 时间 / 随机 token 后立即关闭；临界区结束时按 token 删除。
// 只有**持锁进程已经不存在**（或锁内容始终读不完整）才允许别的进程删锁重试 —— 心跳过期
// 不等于进程死了，GC、调试器、系统休眠都能让它停上一分钟；按 mtime 抢锁会让两个进程同时
// 进临界区。等待上限由 `timeoutMs` 兜住：真正卡死的进程只让别的进程报错，不会造成并发写。
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** 锁文件名（hub 根；点开头，迁移与备份都不认识它）。 */
export const HUB_LOCK_FILE = '.write.lock'

/** 等锁的上限：超过就报错，不无限挂住一次面板写入。 */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * 锁文件内容读不懂时等多久再判死：`open('wx')` 成功到写完内容是极短的窗口，
 * 在这期间删锁会误删一把即将生效的锁。
 */
const PARTIAL_WRITE_GRACE_MS = 5_000

/** 等锁的重试间隔（带少量随机抖动，避免两个进程同步醒来反复撞）。 */
const RETRY_MS = 25

interface LockInfo {
  pid: number
  /** 创建时间（人读用；存活判定看 pid 是否还在）。 */
  at: number
  token: string
}

/** 跨进程写锁：`run` 里的临界区在整台机器上同一时刻只有一个进程能进。 */
export interface HubFileLock {
  /**
   * 在锁内执行 `fn`。
   *
   * @param fn 临界区；抛错会原样传给调用方，锁照样释放
   * @returns `fn` 的返回值
   * @throws 等锁超过 `timeoutMs` 时抛错，错误文案说明另一个宿主进程占着 hub
   */
  run<T>(fn: () => Promise<T>): Promise<T>
}

/** 读锁文件的内容与 mtime；不存在 / 读不动返回 null。 */
async function readLock(path: string): Promise<{ info: LockInfo | null; mtime: number } | null> {
  try {
    const [raw, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
    let parsed: LockInfo | null = null
    try {
      const obj = JSON.parse(raw) as Partial<LockInfo>
      if (typeof obj.pid === 'number' && typeof obj.at === 'number' && typeof obj.token === 'string') {
        parsed = { pid: obj.pid, at: obj.at, token: obj.token }
      }
    } catch { /* 刚创建还没写完 / 坏内容：按"有锁但读不懂"处理 */ }
    return { info: parsed, mtime: info.mtimeMs }
  } catch {
    return null
  }
}

/** 进程还在吗：`EPERM` 表示存在但没权限发信号，按活着算。 */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as { code?: string } | null)?.code === 'EPERM'
  }
}

/**
 * 建一把 hub 文件锁。
 *
 * @param dir hub 根目录（`$DSH_HOME/tool-management`）；不存在时首次等锁会创建
 * @param options 超时与锁文件名（不同临界区各用一把锁时靠 `file` 区分）
 */
export function createHubFileLock(
  dir: string,
  options: { timeoutMs?: number; file?: string } = {},
): HubFileLock {
  const path = join(dir, options.file ?? HUB_LOCK_FILE)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  /** 尝试拿锁；拿不到返回 false，拿到后由调用方持有。 */
  async function tryAcquire(token: string): Promise<boolean> {
    try {
      const handle = await open(path, 'wx')
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now(), token }), 'utf8')
      } finally {
        await handle.close()
      }
      return true
    } catch (e) {
      if ((e as { code?: string } | null)?.code !== 'EEXIST') throw e
      const seen = await readLock(path)
      if (seen === null) return false // 刚被删；下一轮重试即可
      if (seen.info !== null) {
        // 进程还活着就只等。pid 被系统复用只会让我们多等一轮超时，不会并发写。
        if (processAlive(seen.info.pid)) return false
      } else if (Date.now() - seen.mtime < PARTIAL_WRITE_GRACE_MS) {
        return false
      }
      // 只删我们看到的那一份，避免误删别人刚建的新锁：token 必须仍相同；两次都读不懂时
      // 第二次也要过了宽限期（可能是新锁刚写下半截）。
      const again = await readLock(path)
      if (again === null) return false
      if (seen.info !== null) {
        if (again.info?.token !== seen.info.token) return false
      } else if (again.info !== null || Date.now() - again.mtime < PARTIAL_WRITE_GRACE_MS) {
        return false
      }
      await unlink(path).catch(() => undefined)
      return false
    }
  }

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await mkdir(dir, { recursive: true })
      const token = randomUUID()
      const started = Date.now()
      for (;;) {
        if (await tryAcquire(token)) break
        if (Date.now() - started > timeoutMs) {
          throw new Error('另一个 DSH 进程正在写同一个数据目录，等待超时；请稍后重试，或只保留一个宿主进程。')
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS + Math.floor(Math.random() * RETRY_MS)))
      }
      try {
        return await fn()
      } finally {
        const seen = await readLock(path)
        if (seen?.info?.token === token) await unlink(path).catch(() => undefined)
      }
    },
  }
}
