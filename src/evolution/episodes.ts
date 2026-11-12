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

/**
 * 队列项的状态。`dropped` 由 `compact` 追加：清理走**追加墓碑行**而不是整份重写，
 * 读路径按 id 折叠后它自然消失（见 `compact` 的说明）。
 */
export type OutboxStatus = 'pending' | 'done' | 'failed' | 'dead' | 'orphan' | 'dropped'

/**
 * 一次复习真正落下的条目。
 *
 * 只存界面要展示的摘要：正文在记忆库里，这里留一份是为了"复习跑完但用户没看见学成了
 * 什么"时有个可读的回执；不存证据与完整 Markdown。
 */
export interface ReviewLearnedItem {
  id: string
  /** 模型给的标题；旧条目 / 合并时可能没有，界面按正文首句兜底。 */
  title?: string
  /** 学到的正文（与 LearnRequest.text 同源，已截断）。 */
  text: string
  layer: string
  status: string
  /** 证据档位（`confirmed` / `quoted` / `inferred`）。 */
  tier: string
  /**
   * 类型（`preference` / `fact` / `correction` / `procedure`）。
   *
   * 界面「这次学到了什么」要显示它：类型决定保质期（事实 / 做法 30 天后提醒复核，
   * 偏好 / 纠正不过期），不显示的话用户看不出自己批准的东西会不会过一阵被催着复核。
   * 旧数据没有这个字段，缺失时不显示。
   */
  kind?: string
}

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
  /** done 行：这次复习落下的条目（旧行没有这个字段 = 没记录）。 */
  learnedItems?: ReviewLearnedItem[]
  /** done 行：被门禁拒 / 合并掉的条数。 */
  rejected?: number
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
  /** `compact` 的**只读**版本：只算会保留 / 丢多少，不写文件（维护扫描的 dry 跑用它）。 */
  planCompact(maxAgeDays: number, now?: number): Promise<{ kept: number; dropped: number }>
  /** 删掉超过 N 天的 episode 文件（含空会话目录）。返回删了几个。 */
  prune(maxAgeDays: number, now?: number): Promise<{ removed: number }>
  /** `prune` 的**只读**版本：只算会删几个，不动文件。 */
  planPrune(maxAgeDays: number, now?: number): Promise<{ removed: number }>
}

/**
 * 列出可删的 episode 文件（绝对路径）。
 *
 * @param episodesDir episode 目录的绝对路径（`<hub>/evolution/episodes`）
 * @param cutoff 早于此时间（mtime）的才算过期
 * @param referenced outbox 仍在引用的相对路径 —— 这些一律跳过，哪怕已经很旧
 */
/**
 * outbox 里还没跑完的项引用的 episode 路径（相对 stateDir，POSIX 分隔）。
 *
 * 这些文件**不能删**：一条 pending / failed 的复习项，它的原料就是那个 episode。按 mtime
 * 删掉它，重试时会读到空内容 —— 表现为「重试成功但什么都没学到」，而死信里还留着一条永远
 * 不可能成功的记录。
 *
 * `prune` 与 `planPrune` 共用这一份，两处判据分家时 dry 报的数与真删的数会对不上。
 *
 * @returns 被引用的路径集合；读不到 outbox 时返回 `null`（调用方据此**不动手**）。
 */
async function referencedEpisodes(store: { list(): Promise<OutboxItem[]> }): Promise<Set<string> | null> {
  try {
    const out = new Set<string>()
    for (const item of await store.list()) {
      if (item.status !== 'pending' && item.status !== 'failed') continue
      if (item.path) out.add(item.path)
    }
    return out
  } catch {
    return null
  }
}

async function collectPrunable(episodesDir: string, cutoff: number, referenced: ReadonlySet<string>): Promise<string[]> {
  const out: string[] = []
  let sessions: string[] = []
  try {
    sessions = (await readdir(episodesDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return out
  }
  for (const sid of sessions) {
    const sessionDir = join(episodesDir, sid)
    let names: string[] = []
    try {
      names = await readdir(sessionDir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      // outbox 里的 `path` 是相对 hub 的 POSIX 形态；Windows 上 join 出来是反斜杠，
      // 直接比会永远不相等 —— 那等于「引用保护」在 Windows 上完全不生效。
      if (referenced.has(EPISODES_DIR + '/' + sid + '/' + name)) continue
      const file = join(sessionDir, name)
      try {
        if ((await stat(file)).mtimeMs < cutoff) out.push(file)
      } catch {
        /* 读不到就当它不在 */
      }
    }
  }
  return out
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
    // `dropped` 是 `compact` 追加的墓碑：它把这行从**视图**里去掉，但历史行还在文件里。
    return [...byId.values()]
      .filter((x) => x.status !== 'dropped')
      .sort((a, b) => a.turn - b.turn || a.id.localeCompare(b.id))
  }

  return {
    async write(ep) {
      // 文件名取 **id**，不是 turn：压缩 episode 的 id 是 `<session>:compact:<seq>`，而
      // `turn` 就是那个 seq —— 拿 turn 当文件名，同一会话里一次压缩会和旧版同号轮次的
      // episode 撞成同一个文件，先写的那条内容被后写的覆盖，而 outbox 里两行仍指着它。
      const rel = `${EPISODES_DIR}/${safeSegment(ep.session)}/${safeSegment(ep.id)}.json`
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
      const cutoff = now - Math.max(1, maxAgeDays) * 86400_000
      /** 该留的行（判定与 `planCompact` 同一份）。 */
      const keeps = (x: OutboxItem): boolean => {
        if (x.status === 'pending' || x.status === 'failed') return true
        const t = Date.parse(x.at)
        return Number.isFinite(t) ? t >= cutoff : false
      }
      // **不能读全量再整份写回**。outbox 是 append-only 的日志，冷路径随时可能在追加新行；
      // 读完到写回之间追加的那些会被整份覆盖掉 —— 症状是「刚压缩完的那一轮没进复习队列」，
      // 而且没有任何错误。
      //
      // 这里改成**只追加墓碑行**：把要丢的 id 记一条 `dropped` 状态。读路径本来就按 id 折叠
      // （后写的行赢），所以不需要重写历史，也不需要锁。文件会长一点，但它本来就是日志。
      const all = await this.list()
      const drop = all.filter((x) => !keeps(x))
      if (drop.length === 0) return { kept: all.length, dropped: 0 }
      const kept = all.filter(keeps)
      // 墓碑多了要真的压实：只追加不重写的话，反复清理会让文件无界增长（每次清理都留一行
      // 永久墓碑），而读路径每次都要把整份读进来折叠。
      //
      // 压实条件是「墓碑行数超过保留行数」—— 此时文件至少一半是废行，重写的收益确定；
      // 而重写只在**冷路径**（维护扫描 / 启动）发生，与热路径的 append 撞车的窗口极小，
      // 且重写用原子写，最坏结果是丢掉那一刻刚追加的一行（下一轮会重新入队）。
      try {
        await mkdir(dirname(abs(OUTBOX_FILE)), { recursive: true })
        const rawLines = (await readLines(OUTBOX_FILE)).length
        if (rawLines > kept.length * 2 + 200) {
          await writeFileAtomically(
            abs(OUTBOX_FILE),
            kept.map((x) => JSON.stringify(x)).join('\n') + (kept.length > 0 ? '\n' : ''),
            { mode: 0o600 },
          )
          return { kept: kept.length, dropped: drop.length }
        }
        const rows = drop.map((x) => JSON.stringify({ id: x.id, status: 'dropped', at: new Date(now).toISOString() }))
        await appendFile(abs(OUTBOX_FILE), rows.join('\n') + '\n', 'utf8')
      } catch {
        return { kept: all.length, dropped: 0 }
      }
      return { kept: kept.length, dropped: drop.length }
    },

    async planCompact(maxAgeDays, now = Date.now()) {
      const all = await this.list()
      const cutoff = now - Math.max(1, maxAgeDays) * 86400_000
      const keep = all.filter((x) => {
        if (x.status === 'pending' || x.status === 'failed') return true
        const t = Date.parse(x.at)
        return Number.isFinite(t) ? t >= cutoff : false
      })
      return { kept: keep.length, dropped: all.length - keep.length }
    },

    async prune(maxAgeDays, now = Date.now()) {
      const cutoff = now - Math.max(1, maxAgeDays) * 86400_000
      const referenced = await referencedEpisodes(this)
      // 读不到 outbox 就**不动手**：宁可这次不清理，也不要把还能重试的原料删掉。
      if (referenced === null) return { removed: 0 }
      const doomed = await collectPrunable(abs(EPISODES_DIR), cutoff, referenced)
      let removed = 0
      for (const path of doomed) {
        try {
          await rm(path, { force: true })
          removed++
        } catch {
          /* 删不掉就留着，下一轮再说 */
        }
      }
      // 空会话目录留着只会让后续扫描多 readdir 一次；顺手清掉。
      const dir = abs(EPISODES_DIR)
      let sessions: string[] = []
      try {
        sessions = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
      } catch {
        return { removed }
      }
      for (const sid of sessions) {
        const sessionDir = join(dir, sid)
        try {
          if ((await readdir(sessionDir)).length === 0) await rm(sessionDir, { recursive: true, force: true })
        } catch {
          /* 目录已经不在了 */
        }
      }
      return { removed }
    },

    async planPrune(maxAgeDays, now = Date.now()) {
      const cutoff = now - Math.max(1, maxAgeDays) * 86400_000
      const referenced = await referencedEpisodes(this)
      if (referenced === null) return { removed: 0 }
      return { removed: (await collectPrunable(abs(EPISODES_DIR), cutoff, referenced)).length }
    },
  }
}
