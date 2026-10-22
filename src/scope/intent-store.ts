// 全局意图侧车的读写（`hub/scope-intent.json`）。形状与判定在 ./intent.ts。
//
// 与 `scope-store.ts` 同一条纪律：读走 TTL 缓存、写走 apply 的串行写锁、读坏 = 空表不抛。
// 不同的只有一点：**同步快照会被注入 / 守卫每步读**，所以额外给一个 `revision()` ——
// 渲染缓存键吃它，意图一改（含启动加载完成）目录缓存就跟着失效。
//
// 读坏 = 空表 = "还没有意见"：对账会从运行态反推一条（见 intent.ts 的 planReconcile）。
// 这比"读坏 = 全关"安全：全关会让下次对账把所有服务器停掉。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { hubPath } from '../hub.js'
import { normalizeScopeIntent, type ScopeIntent } from './intent.js'

/** 侧车文件名（hub 根，与 `scope-overrides.json` 并排）。 */
export const SCOPE_INTENT_FILE = 'scope-intent.json'

/** 读缓存 TTL：与覆盖表同一量级（界面点一下就回）。 */
const TTL_MS = 300

export interface IntentStoreDeps {
  withWriteLock<T>(fn: () => Promise<T>): Promise<T>
  message(e: unknown): string
}

export interface IntentStore {
  /** 读整份侧车（TTL 缓存；`force` 跳过缓存）。 */
  read(force?: boolean): Promise<ScopeIntent>
  /** 同步快照（注入 / 守卫用）：还没加载时返回空表并异步预热。 */
  snapshot(): ScopeIntent
  /** 缓存代次：每次加载完成 / 写入都自增（渲染缓存键用）。 */
  revision(): number
  /**
   * 读-改-写（写锁内强制重读）。`mutate` 返回新意图；返回 `undefined` = 放弃写入。
   */
  mutate(mutate: (current: ScopeIntent) => ScopeIntent | undefined): Promise<{ ok: true; intent: ScopeIntent } | { ok: false; error: string }>
  /** 丢掉缓存（测试与启动对账用）。 */
  invalidate(): void
}

export function createIntentStore(deps: IntentStoreDeps): IntentStore {
  let cache: { at: number; value: ScopeIntent } | null = null
  let warming = false
  let rev = 0

  function file(): string {
    return hubPath(SCOPE_INTENT_FILE)
  }

  function empty(): ScopeIntent {
    return normalizeScopeIntent(undefined)
  }

  async function load(): Promise<ScopeIntent> {
    try {
      return normalizeScopeIntent(JSON.parse(await readFile(file(), 'utf8')))
    } catch {
      return empty()
    }
  }

  async function read(force = false): Promise<ScopeIntent> {
    if (!force && cache !== null && Date.now() - cache.at < TTL_MS) return cache.value
    const value = await load()
    cache = { at: Date.now(), value }
    rev += 1
    return value
  }

  function snapshot(): ScopeIntent {
    if (cache !== null) return cache.value
    if (!warming) {
      warming = true
      void read().catch(() => {}).finally(() => { warming = false })
    }
    return empty()
  }

  async function persist(next: ScopeIntent): Promise<void> {
    const abs = file()
    await mkdir(dirname(abs), { recursive: true })
    const temp = join(dirname(abs), '.' + randomUUID().slice(0, 8) + '.intent-tmp')
    await writeFile(temp, JSON.stringify(next, null, 2) + '\n', 'utf8')
    await rename(temp, abs)
  }

  async function mutate(fn: (current: ScopeIntent) => ScopeIntent | undefined): Promise<{ ok: true; intent: ScopeIntent } | { ok: false; error: string }> {
    return deps.withWriteLock(async () => {
      try {
        const current = await load()
        const next = fn(current)
        if (next === undefined) {
          cache = { at: Date.now(), value: current }
          rev += 1
          return { ok: true, intent: current }
        }
        await persist(next)
        cache = { at: Date.now(), value: next }
        rev += 1
        return { ok: true, intent: next }
      } catch (e) {
        return { ok: false, error: deps.message(e) }
      }
    })
  }

  function invalidate(): void {
    cache = null
    rev += 1
  }

  return { read, snapshot, revision: () => rev, mutate, invalidate }
}
