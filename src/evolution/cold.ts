// 冷路径的接线：把官方 `compaction/summary` 接到 episode → outbox → 复习器。
//
// 这一层只做"什么时候做什么"，判断都在 episodes / review 里。三个原则：
//
//   1. **事件钩子绝不抛**。它跑在宿主的会话主链上，抛一次就是用户的一轮对话崩掉。
//      所有分支都包在 try/catch 里，失败只写日志。
//   2. **不阻塞压缩**。复习是异步的：`compaction/summary` 的处理器同步返回，模型调用在
//      后台跑。用户等的是下一句话，不是我们的记忆整理。
//   3. **每会话串行**。同一会话的两轮复习并发跑会撞 state 写锁（那是全局锁，会互相拖慢），
//      也会让两条相似的记忆互相看不见、各写一份。一个会话一条 promise 链。
//
// 为什么只在压缩时复习：宿主已经把整段对话交给模型提炼成一份结构化 checkpoint，那是
// 信息密度最高、且已经付过钱的产物。按轮次自己攒几条用户消息 / 工具结果再读一遍，既
// 重复劳动又容易把关键话挤掉。没触发压缩就不复习 —— 热路径 `memory_note` 负责当场记。

import { captureUserTexts, isGenuineUserMessage, textOfMessage } from './evidence.js'
import { checkpointEpisodeOf } from './digest.js'
import type { EpisodeStore, OutboxItem } from './episodes.js'
import type { EffectiveEvolutionConfig } from './config.js'
import { MAX_REVIEW_ATTEMPTS, outboxFailed, type createReviewer } from './review.js'

export interface ColdPathDeps {
  /** 每会话的生效配置（异步：要读三级开关文件）。 */
  effectiveOf(sessionId: string, cwd: string | undefined): Promise<EffectiveEvolutionConfig>
  /** outbox 与 episodes（启动重放与压缩时都走它）。 */
  episodes: EpisodeStore
  reviewer: ReturnType<typeof createReviewer>
  /** cwd → 工作区 hash（与写入路由同一口径）。 */
  workspaceHashOf(cwd: string): string | undefined
  log(row: Record<string, unknown>): Promise<void>
  message(e: unknown): string
  /** 测试注入：固定时间（退避判定）。 */
  now?(): number
  /**
   * 复习结束后的钩子（P3 的每日整理挂在这里）。
   *
   * 压缩时才有"这一轮请求用的模型"可参照；钩子不 await、异常全吞：它跑在会话主链的
   * 尾巴上，慢一点可以，炸一次不行。
   */
  afterReview?(sessionId: string, cwd: string | undefined, cfg: EffectiveEvolutionConfig, route: { provider: string; model: string } | null): Promise<void>
}

export interface ColdPathHandle {
  /** `request/header`：记下这一轮用的模型路由（复习默认用它）。 */
  noteRoute(sessionId: string, route: { provider: string; model: string }): void
  routeOf(sessionId: string): { provider: string; model: string } | null
  /** 官方压缩事件：落 episode、入队、异步复习。 */
  compactionSummary(sessionId: string, seq: number, summary: unknown, cwd?: string): Promise<void>
  /** 启动时重放：把 pending / failed 且没过重试上限的项跑一遍。 */
  replay(): Promise<{ attempted: number; done: number; failed: number }>
  /** 手动触发（界面「立即复习」/ 测试）。 */
  drain(sessionId: string): Promise<void>
  /** 诊断：队列统计。 */
  stats(): Promise<{ pending: number; failed: number; dead: number; done: number }>
  /** 队列全貌（界面「待复习 / 失败 / 无法处理」三栏）。 */
  queue(): Promise<OutboxItem[]>
  /** 手动重试一条（含 dead-letter 里的）：用户明确要求时才把计数清零。 */
  retry(id: string): Promise<{ ok: boolean; session?: string }>
}

/** 一次复习取几条（按 turn 升序）。 */
const BATCH = 3

/** checkpoint 纯文本的字节上限：它已经是一份摘要，再长就该截断，不能撑爆复习提示。 */
export const MAX_CHECKPOINT_BYTES = 12_000

/** 超限时留给尾部的比例：官方模板把 `Critical Context`（偏好 / 约束）放在**最后一节**。 */
const TAIL_SHARE = 0.5

/**
 * 官方 `compaction/summary` 的 `data.summary`：只取 text 块拼成纯文本。
 *
 * 超限时**保头也保尾、砍中间**。官方的 `COMPACTION_INSTRUCTION` 章节顺序是
 * Primary Request → Key Technical Concepts → Files and Code → Errors → Pending →
 * Current Work → Next Step → Critical Context：最该学的「用户偏好 / 约束」在**最后**，
 * 而中间几节正是复习提示明确要求丢弃的任务态。只保头会把唯一有价值的那一节砍掉。
 */
export function checkpointTextOf(summary: unknown): string {
  if (!Array.isArray(summary)) return ''
  const parts: string[] = []
  for (const block of summary) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: unknown; text?: unknown }
    if (b.type !== 'text' || typeof b.text !== 'string') continue
    parts.push(b.text)
  }
  const text = parts.join('\n').trim()
  if (Buffer.byteLength(text, 'utf8') <= MAX_CHECKPOINT_BYTES) return text
  const budget = MAX_CHECKPOINT_BYTES
  const tailBudget = Math.floor(budget * TAIL_SHARE)
  const headBudget = budget - tailBudget
  // 按字符截，不按字节切：中文 / emoji 被切半个会变成乱码。
  const takeHead = (limit: number): string => {
    let out = ''
    let bytes = 0
    for (const ch of text) {
      const size = Buffer.byteLength(ch, 'utf8')
      if (bytes + size > limit) break
      out += ch
      bytes += size
    }
    return out
  }
  const takeTail = (limit: number): string => {
    const chars = [...text]
    let out = ''
    let bytes = 0
    for (let i = chars.length - 1; i >= 0; i--) {
      const size = Buffer.byteLength(chars[i]!, 'utf8')
      if (bytes + size > limit) break
      out = chars[i]! + out
      bytes += size
    }
    return out
  }
  const head = takeHead(headBudget)
  const tail = takeTail(tailBudget)
  const omitted = Buffer.byteLength(text, 'utf8') - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8')
  const marker = `\n\n[… ${omitted} bytes of the middle omitted …]\n\n`
  // 标记本身也占字节：从头部额度里扣掉，保证整段不越过上限。
  const room = budget - Buffer.byteLength(marker, 'utf8')
  return takeHead(room - tailBudget) + marker + tail
}

export function createColdPath(deps: ColdPathDeps): ColdPathHandle {
  /** 每会话一条串行链。 */
  const chains = new Map<string, Promise<void>>()
  /** 最近一次请求头里的模型路由。 */
  const routes = new Map<string, { provider: string; model: string }>()

  const routeOf = (sessionId: string): { provider: string; model: string } | null => routes.get(sessionId) ?? null

  /** 退避判定与写入用同一个时钟（生产里就是 `Date.now()`，测试里可注入）。 */
  const clock = (): number => (deps.now ? deps.now() : Date.now())

  /** 取一条 outbox 项对应的 episode 并复习。 */
  async function reviewOne(item: OutboxItem, cfg: EffectiveEvolutionConfig): Promise<'done' | 'failed'> {
    const ep = await deps.episodes.read(item.path)
    if (!ep) {
      // 文件没了（被清理 / 写失败但入队成功）：标 orphan 而不是反复重试。
      await deps.episodes.mark(item, { status: 'orphan', reason: 'episode file missing' })
      return 'done'
    }
    const out = await deps.reviewer.review(ep, cfg, routeOf(item.session))
    if (out.ok) {
      await deps.episodes.mark(item, {
        status: 'done',
        reason: out.reason ?? (out.learned > 0 ? `learned ${out.learned}` : 'nothing worth keeping'),
        ...(out.items !== undefined && out.items.length > 0 ? { learnedItems: out.items } : {}),
        ...(out.rejected > 0 ? { rejected: out.rejected } : {}),
      })
      return 'done'
    }
    // 名额用尽是终态；输出坏 JSON / 模型报错是可恢复的，走退避重试，
    // 但不占「成功学习次数」（见 review.ts 的预算口径）。
    if (out.reason === 'budget') {
      await deps.episodes.mark(item, { status: 'done', reason: 'budget' })
      return 'done'
    }
    // 拿不到模型路由 / 宿主没给 llm 服务：环境还没就绪，不算这次复习的失败次数。
    // 启动重放时路由表必然是空的，按失败计数的话重启三次就把残留项全烧成 dead-letter。
    const transient = out.reason === 'no-model' || out.reason === 'no-llm'
    await deps.episodes.mark(item, outboxFailed(item, out.error ?? out.reason ?? 'review failed', clock(), { transient }))
    return 'failed'
  }

  async function drain(sessionId: string): Promise<void> {
    const items = await deps.episodes.retryable(sessionId, BATCH, clock())
    if (items.length === 0) return
    // 用 episode 里存的 cwd 取配置：这里是异步路径，拿不到活的 session 对象。
    for (const item of items) {
      const ep = await deps.episodes.read(item.path)
      const cfg = await deps.effectiveOf(item.session, ep?.cwd)
      if (!cfg.enabled) {
        // 开关关掉了：这一项**不会再有人复习**，留在队列里只会变成一条永远 pending 的
        // 僵尸项（界面显示"待复习"、重试也跑不动）。标 done 并写清原因，用户事后能查。
        await deps.episodes.mark(item, { status: 'done', reason: 'disabled' })
        continue
      }
      await reviewOne(item, cfg)
    }
  }

  /** 同一会话的复习串行（不同会话可以并行）。 */
  function schedule(sessionId: string): Promise<void> {
    const prev = chains.get(sessionId) ?? Promise.resolve()
    const next = prev
      .then(() => drain(sessionId))
      .catch((e) => deps.log({ at: new Date().toISOString(), session: sessionId, event: 'drain-failed', error: deps.message(e) }).then(() => undefined))
      .finally(() => {
        if (chains.get(sessionId) === next) chains.delete(sessionId)
      })
    chains.set(sessionId, next)
    return next
  }

  /** 官方压缩事件落盘：先写 episode，再 append outbox，最后才调模型。 */
  async function onCompaction(
    sessionId: string,
    seq: number,
    checkpoint: string,
    cwd: string | undefined,
  ): Promise<EffectiveEvolutionConfig | null> {
    if (checkpoint === '') return null
    const cfg = await deps.effectiveOf(sessionId, cwd)
    if (!cfg.enabled) return null
    const at = new Date().toISOString()
    const hash = cwd ? deps.workspaceHashOf(cwd) : undefined
    const ep = checkpointEpisodeOf({
      session: sessionId,
      seq,
      at,
      checkpoint,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(hash !== undefined ? { workspaceHash: hash } : {}),
    })
    const written = await deps.episodes.write(ep)
    if (!written.ok) {
      // 宁可这次不学，也不要产生指向空文件的队列项。
      await deps.log({ at, session: sessionId, seq, event: 'episode-write-failed', error: written.error })
      return cfg
    }
    const item = await deps.episodes.enqueue({ id: ep.id, session: sessionId, turn: ep.turn, at, path: written.path })
    if (!item) {
      await deps.log({ at, session: sessionId, seq, event: 'outbox-write-failed' })
      return cfg
    }
    await deps.log({ at, session: sessionId, seq, event: 'queued', reason: 'compaction' })
    return cfg
  }

  async function handleCompaction(
    sessionId: string,
    seq: number,
    summary: unknown,
    cwd: string | undefined,
  ): Promise<void> {
    try {
      const cfg = await onCompaction(sessionId, seq, checkpointTextOf(summary), cwd)
      await schedule(sessionId)
      // 整理钩子放在复习之后：它要看的是"这次学完之后"的库。
      if (cfg && deps.afterReview) {
        void deps.afterReview(sessionId, cwd, cfg, routeOf(sessionId))
          .catch((e) => deps.log({ at: new Date().toISOString(), session: sessionId, seq, event: 'after-review-failed', error: deps.message(e) }).then(() => undefined))
      }
    } catch (e) {
      await deps.log({ at: new Date().toISOString(), session: sessionId, seq, event: 'compaction-failed', error: deps.message(e) }).catch(() => undefined)
    }
  }

  return {
    noteRoute(sessionId, route) {
      if (sessionId !== '' && route.provider !== '' && route.model !== '') routes.set(sessionId, route)
    },

    routeOf,

    compactionSummary: handleCompaction,

    async replay() {
      const all = await deps.episodes.list()
      const targets = all.filter((x) => x.status === 'pending'
        || (x.status === 'failed' && (x.attempts ?? 0) <= MAX_REVIEW_ATTEMPTS))
      let done = 0
      let failed = 0
      for (const item of targets) {
        const ep = await deps.episodes.read(item.path)
        const cfg = await deps.effectiveOf(item.session, ep?.cwd)
        if (!cfg.enabled) continue
        try {
          const r = await reviewOne(item, cfg)
          if (r === 'done') done++
          else failed++
        } catch (e) {
          failed++
          await deps.log({ at: new Date().toISOString(), session: item.session, turn: item.turn, event: 'replay-failed', error: deps.message(e) })
        }
      }
      return { attempted: targets.length, done, failed }
    },

    drain: schedule,

    async stats() {
      const all = await deps.episodes.list()
      const out = { pending: 0, failed: 0, dead: 0, done: 0 }
      for (const x of all) {
        if (x.status === 'pending') out.pending++
        else if (x.status === 'failed') out.failed++
        else if (x.status === 'dead') out.dead++
        else if (x.status === 'done') out.done++
      }
      return out
    },

    async queue() {
      return deps.episodes.list()
    },

    async retry(id) {
      const all = await deps.episodes.list()
      const hit = all.find((x) => x.id === id)
      if (!hit) return { ok: false }
      // 计数清零是**用户意图**的一部分：死信手动重试如果还接着上次的 attempts，
      // 第一次失败就直接又进 dead-letter，等于点了没反应。
      await deps.episodes.mark(hit, { status: 'pending', attempts: 0, nextAt: undefined, reason: 'manual retry' })
      await schedule(hit.session)
      return { ok: true, session: hit.session }
    },
  }
}

/**
 * 把冷路径挂到宿主的事件总线上。
 *
 * 事件处理里只做"记下来"与"排一次队"，任何异常都吞掉 —— 它跑在会话主链上。
 */
export function attachColdPath(
  ctx: { on(name: string, cb: (...args: any[]) => any): unknown },
  deps: ColdPathDeps,
): ColdPathHandle {
  const cold = createColdPath(deps)

  const safe = (fn: () => void): void => {
    try {
      fn()
    } catch (e) {
      void deps.log({ at: new Date().toISOString(), event: 'session-event-failed', error: deps.message(e) })
    }
  }

  ctx.on('session/event', (session: any, event: any) => {
    safe(() => {
      const sid = typeof session?.id === 'string' ? session.id : ''
      if (sid === '' || !event || typeof event !== 'object') return
      const type = String(event.type ?? '')
      const data = event.data || {}
      switch (type) {
        case 'user/message': {
          // 真人原话继续喂证据缓存：热路径 `memory_note` 声明 user_explicit 时，
          // 证据门要逐字核对这句是不是用户真的说过。
          if (!isGenuineUserMessage(data)) break
          const text = textOfMessage(data).trim()
          if (text === '') break
          captureUserTexts(sid, [{ ...data, role: 'user' }])
          break
        }
        case 'request/header': {
          const cfg = data.header && typeof data.header === 'object' ? data.header.config : undefined
          if (cfg && typeof cfg.provider === 'string' && typeof cfg.model === 'string') {
            cold.noteRoute(sid, { provider: cfg.provider, model: cfg.model })
          }
          break
        }
        case 'compaction/summary': {
          const seq = Number(event.seq)
          if (!Number.isFinite(seq)) return
          const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : undefined
          // 不 await：压缩的处理器必须同步返回，复习在后台跑。
          void cold.compactionSummary(sid, seq, data.summary, cwd)
          break
        }
        default:
          break
      }
    })
  })

  // 启动重放：进程被杀 / 关窗口时留下的 pending 与 failed。
  void cold.replay().catch(() => undefined)
  return cold
}
