// 冷路径的持久化：episodes（摘要文件）+ outbox（待复习队列）。
//
// 顺序是设计的一部分：**先写 episode，再 append outbox，最后才调模型**。
// 关窗口 / 崩溃 / 进程被杀时，只要 outbox 那行落了盘，下次启动就能重放；反过来先调模型
// 再写盘，中间崩掉就等于这一轮白看了，而且没有任何痕迹。
//
// outbox 用 append-only 的 jsonl，状态变更也是追加一行（按 id 折叠取最后一条）。
// 为什么不"读-改-写"整份 JSON：进程被杀时那份文件会变成半截 JSON，之后整个队列都读不出来。
// 追加一行最坏只丢最后那条不完整的写入，前面的历史仍然可读。

import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomically } from '../memories/index-io.js'
import type { Episode } from './digest.js'

export type OutboxStatus = 'pending' | 'done' | 'failed' | 'dead' | 'orphan'

export interface OutboxItem {
  id: string
  session: string
  turn: number
  at: string
  /** episode 文件的相对路径（相对 hub 根）。 */
  path: string
  status: OutboxStatus
  attempts: number
  /** 退避：下次可重试的最早时间（毫秒）。没有 = 立即可试。 */
  nextAt?: number
  reason?: string
}

export interface EpisodeStoreDeps {
  /** hub 根（`$DSH_HOME/tool-management`）。 */
  stateDir: string
  message(e: unknown): string
}

const EPISODES_DIR = 'evolution/episodes'
const OUTBOX_FILE = 'evolution/outbox.jsonl'
const DEAD_FILE = 'evolution/dead-letter.jsonl'

/** 会话 id → 安全的目录名。只保留能出现在文件名里的字符，其余压成下划线。 */
export function safeSegment(id: string): string {
  const s = String(id ?? '').trim().replaceAll(/[^\p{L}\p{N}._-]+/gu, '_')
  return s === '' || s === '.' || s === '..' ? 'unknown' : s.slice(0, 80)
}

export interface EpisodeStore {
  /** 写 episode 文件。失败返回原因（调用方据此**不要**入队）。 */
  write(ep: Episode): Promise<{ ok: true; path: string } | { ok: false; error: string }>
  read(path: string): Promise<Episode | null>
  /** 入队（append 一行 pending）。写失败返回 null。 */
  enqueue(item: Omit<OutboxItem, 'status' | 'attempts'>): Promise<OutboxItem | null>
  /** 折叠后的队列（每个 id 一条，最新状态）。 */
  list(): Promise<OutboxItem[]>
  /** 追加一次状态变更。 */
  mark(item: OutboxItem, patch: Partial<Omit<OutboxItem, 'id'>>): Promise<void>
  /** 该会话可重试的项（pending / failed 且过了退避时间），按 turn 升序。 */
  retryable(session: string, limit: number, now?: number): Promise<OutboxItem[]>
  /** 清掉很久以前的 done / dead 行，避免 outbox 长到几万行。返回保留的条数。 */
  compact(maxAgeDays: number, now?: number): Promise<{ kept: number; dropped: number }>
  /** 最近 N 个 episode（按文件修改时间倒序，给 dream 当输入）。读不出来的跳过。 */
  recent(limit: number): Promise<Episode[]>
  /** 删掉超过 N 天的 episode 文件（含空会话目录）。返回删了几个。 */
  prune(maxAgeDays: number, now?: number): Promise<{ removed: number }>
}

export function createEpisodeStore(deps: EpisodeStoreDeps): EpisodeStore {
  const abs = (rel: string): string => join(deps.stateDir, rel)

  async function readLines(rel: string): Promise<string[]> {
    try {
      const text = await readFile(abs(rel), 'utf8')
      return text.split('\n')
    } catch {
      return []
    }
  }

  async function appendLine(rel: string, row: unknown): Promise<void> {
    await mkdir(dirname(abs(rel)), { recursive: true })
    await appendFile(abs(rel), JSON.stringify(row) + '\n', 'utf8')
  }

  async function listAll(): Promise<OutboxItem[]> {
    const lines = await readLines(OUTBOX_FILE)
    const byId = new Map<string, OutboxItem>()
    for (const line of lines) {
      const s = line.trim()
      if (s === '') continue
      try {
        const row = JSON.parse(s) as OutboxItem
        if (!row || typeof row.id !== 'string' || row.id === '') continue
        byId.set(row.id, row)
      } catch {
        // 半截行（进程被杀）：跳过，别让一行坏数据把整个队列读废。
      }
    }
    return [...byId.values()].sort((a, b) => a.turn - b.turn || a.id.localeCompare(b.id))
  }

  return {
    async write(ep) {
      const rel = `${EPISODES_DIR}/${safeSegment(ep.session)}/${ep.turn}.json`
      try {
        await mkdir(dirname(abs(rel)), { recursive: true })
        await writeFileAtomically(abs(rel), JSON.stringify(ep, null, 2) + '\n', { mode: 0o600 })
        return { ok: true, path: rel }
      } catch (e) {
        return { ok: false, error: deps.message(e) }
      }
    },

    async read(path) {
      try {
        const text = await readFile(abs(path), 'utf8')
        const parsed = JSON.parse(text)
        if (!parsed || typeof parsed !== 'object' || typeof parsed.turn !== 'number') return null
        return parsed as Episode
      } catch {
        return null
      }
    },

    async enqueue(item) {
      const row: OutboxItem = { ...item, status: 'pending', attempts: 0 }
      try {
        await appendLine(OUTBOX_FILE, row)
        return row
      } catch {
        return null
      }
    },

    async list() {
      return listAll()
    },

    async mark(item, patch) {
      const next: OutboxItem = { ...item, ...patch, at: new Date().toISOString() }
      const line = JSON.stringify(next) + '\n'
      try {
        await appendLine(OUTBOX_FILE, next)
      } catch {
        return
      }
      if (next.status === 'dead') {
        await appendLine(DEAD_FILE, next).catch(() => {})
      }
    },

    async retryable(session, limit, now = Date.now()) {
      const all = await listAll()
      return all
        .filter((x) => x.session === session && (x.status === 'pending' || x.status === 'failed'))
        .filter((x) => x.nextAt === undefined || x.nextAt <= now)
        .slice(0, Math.max(1, limit))
    },

    async compact(maxAgeDays, now = Date.now()) {
      const all = await this.list()
      const cutoff = now - Math.max(1, maxAgeDays) * 86400_000
      const keep = all.filter((x) => {
        if (x.status === 'pending' || x.status === 'failed') return true
        const t = Date.parse(x.at)
        return Number.isFinite(t) ? t >= cutoff : false
      })
      try {
        await mkdir(dirname(abs(OUTBOX_FILE)), { recursive: true })
        await writeFileAtomically(abs(OUTBOX_FILE), keep.map((x) => JSON.stringify(x)).join('\n') + (keep.length ? '\n' : ''), { mode: 0o600 })
      } catch {
        return { kept: all.length, dropped: 0 }
      }
      return { kept: keep.length, dropped: all.length - keep.length }
    },

    /**
     * 最近 N 个 episode。
     *
     * 按 mtime 倒序而不是按「会话 + turn」排序：dream 要的是"最近发生了什么"，跨会话的
     * 时间线才是它的输入。先排序再读文件 —— 目录里可能有上万个旧摘要，全读一遍再排是
     * 把一次整理变成一次全盘扫描。
     */
    async recent(limit) {
      const dir = abs(EPISODES_DIR)
      const rows: { path: string; mtime: number }[] = []
      let sessions: string[] = []
      try {
        sessions = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
      } catch {
        return []
      }
      for (const sid of sessions) {
        let names: string[] = []
        try {
          names = (await readdir(join(dir, sid))).filter((n) => n.endsWith('.json'))
        } catch {
          continue
        }
        for (const name of names) {
          const path = join(dir, sid, name)
          try {
            const st = await stat(path)
            rows.push({ path, mtime: st.mtimeMs })
          } catch {
            /* 刚被 prune 掉：跳过 */
          }
        }
      }
      rows.sort((a, b) => b.mtime - a.mtime)
      const out: Episode[] = []
      for (const row of rows.slice(0, Math.max(0, limit))) {
        try {
          const parsed = JSON.parse(await readFile(row.path, 'utf8'))
          if (parsed && typeof parsed === 'object' && typeof parsed.turn === 'number') out.push(parsed as Episode)
        } catch {
          /* 半截文件：跳过 */
        }
      }
      return out
    },

    async prune(maxAgeDays, now = Date.now()) {
      const dir = abs(EPISODES_DIR)
      const cutoff = now - Math.max(1, maxAgeDays) * 86400_000
      let removed = 0
      let sessions: string[] = []
      try {
        sessions = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
      } catch {
        return { removed: 0 }
      }
      for (const sid of sessions) {
        const sessionDir = join(dir, sid)
        let names: string[] = []
        try {
          names = await readdir(sessionDir)
        } catch {
          continue
        }
        let left = 0
        for (const name of names) {
          if (!name.endsWith('.json')) {
            left++
            continue
          }
          const path = join(sessionDir, name)
          try {
            const st = await stat(path)
            if (st.mtimeMs < cutoff) {
              await rm(path, { force: true })
              removed++
            } else left++
          } catch {
            /* 读不到就当它不在 */
          }
        }
        // 空目录留着会让 `recent()` 每次多 readdir 一次；顺手清掉。
        if (left === 0) await rm(sessionDir, { recursive: true, force: true }).catch(() => {})
      }
      return { removed }
    },
  }
}
