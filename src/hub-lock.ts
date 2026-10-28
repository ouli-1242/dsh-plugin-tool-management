// hub 级跨进程写锁。
//
// 为什么需要：DSH 的 web 与 desktop 是两个宿主进程，却共用同一个 `$DSH_HOME`。apply 里那条
// `writeChain` 只能串行**同一进程**的写入；两个进程同时读-改-写同一份侧车时，后写的会覆盖
// 先写的（停用表、作用域覆盖、工具表都是整份写）。这里用 hub 根下的 `.write.lock` 做第二层。
//
// 锁文件不常开：写入 pid / 时间 / 随机 token 后立即关闭；临界区结束时按 token 删除。持锁期间
// 每 5 秒 touch 一次 mtime，心跳停了超过 `staleMs` 才允许别的进程抢占。这样进程崩溃留下的锁
// 最多挡一分钟，不会永久锁死 hub。
import { mkdir, open, readFile, stat, unlink, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** 锁文件名（hub 根；点开头，迁移与备份都不认识它）。 */
export const HUB_LOCK_FILE = '.write.lock'

/** 等锁的上限：超过就报错，不无限挂住一次面板写入。 */
const DEFAULT_TIMEOUT_MS = 30_000

/** 没有心跳多久算死锁。必须明显大于心跳间隔，给一次长写入留余量。 */
const DEFAULT_STALE_MS = 60_000

/** 心跳间隔：touch 锁文件 mtime。 */
const HEARTBEAT_MS = 5_000

/** 等锁的重试间隔（带少量随机抖动，避免两个进程同步醒来反复撞）。 */
const RETRY_MS = 25

interface LockInfo {
  pid: number
  /** 创建时间（人读用；存活判定看 mtime，心跳只 touch 文件）。 */
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
 * @param options 超时与死锁阈值（测试可缩短）
 */
export function createHubFileLock(
  dir: string,
  options: { timeoutMs?: number; staleMs?: number } = {},
): HubFileLock {
  const path = join(dir, HUB_LOCK_FILE)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS

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
      const age = Date.now() - seen.mtime
      if (seen.info !== null && processAlive(seen.info.pid) && age < staleMs) return false
      // 进程已死 / 心跳过期 / 内容读不懂：只删我们看到的那一份，避免误删别人刚建的新锁。
      const again = await readLock(path)
      if (again !== null && (seen.info === null || again.info?.token === seen.info.token)) {
        await unlink(path).catch(() => undefined)
      }
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
      const beat = setInterval(() => {
        // 心跳失败（文件被删 / 被抢占）不打断临界区：释放时还会按 token 再确认一次。
        void utimes(path, new Date(), new Date()).catch(() => undefined)
      }, HEARTBEAT_MS)
      beat.unref()
      try {
        return await fn()
      } finally {
        clearInterval(beat)
        const seen = await readLock(path)
        if (seen?.info?.token === token) await unlink(path).catch(() => undefined)
      }
    },
  }
}
