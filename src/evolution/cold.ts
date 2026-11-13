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
// 重复劳动又容易把关键话挤掉。没触发压缩就不复习 —— 热路径 `memory_manager_note` 负责当场记。

import { subagentDepthOf } from '../context-inject-contract.js'
import { captureUserTexts, isGenuineUserMessage, textOfMessage } from './evidence.js'
import { checkpointEpisodeOf } from './digest.js'
import type { EpisodeStore, OutboxItem } from './episodes.js'
import type { EffectiveEvolutionConfig } from './config.js'
import { MAX_REVIEW_ATTEMPTS, outboxFailed, type createReviewer } from './review.js'
import { noteCompaction } from './runtime.js'

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
  stats(): Promise<{ pending: number; failed: number; dead: number; done: number; orphan: number }>
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
 * 这里**不需要**剥 `<compacted-summary>` 标签：官方事件里的 `summary` 是模型原始输出
 * （`summarizer.ts` 的 `summary = summaryText(rawOutput)`），标签由 `frameSummary()` 加在
 * **替换消息**上，两处是不同字段。剥标签反而会把用户真正写过的同名标签当成框架吃掉。
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
  /**
   * 这个会话有复习项在**等路由**（`no-model`）。
   *
   * 为什么需要它：压缩可以发生在会话的第一轮请求里 —— 那时 `request/header` 还没到，
   * 路由表是空的，复习直接判 `no-model`。只把队列项留在 pending 没用：能再触发 drain 的
   * 只有「下一次压缩 / 重启 / 手动重放」，而这次压缩的摘要就这样一直躺着（真实会话里
   * 请求头比压缩晚 30 秒到，用户看到的就是"压缩完了什么都没学"）。
   * 记下这一位，路由一到就补跑。
   */
  const awaitingRoute = new Set<string>()

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
    // `no-model` 不写退避：路由一到就补跑，让 `nextAt` 先等一分钟只是白拖。
    if (out.reason === 'no-model') awaitingRoute.add(item.session)
    else awaitingRoute.delete(item.session)
    await deps.episodes.mark(item, outboxFailed(item, out.error ?? out.reason ?? 'review failed', clock(), {
      ...(transient ? { transient: true } : {}),
      ...(out.reason === 'no-model' ? { immediate: true } : {}),
    }))
    return 'failed'
  }

  async function drain(sessionId: string): Promise<void> {
    const items = await deps.episodes.retryable(sessionId, BATCH, clock())
    if (items.length === 0) return
    for (const item of items) await reviewItem(item)
  }

  /** 复习一条指定的项（手动重试走这条路：整队重跑碰不到排在 BATCH 之后的那条）。 */
  async function reviewItem(item: OutboxItem): Promise<void> {
    const ep = await deps.episodes.read(item.path)
    const cfg = await deps.effectiveOf(item.session, ep?.cwd)
    if (!cfg.enabled) {
      await deps.episodes.mark(item, { status: 'done', reason: 'disabled' })
      return
    }
    await reviewOne(item, cfg)
  }

  /** 把一段工作排进该会话的串行链。 */
  function enqueue(sessionId: string, work: () => Promise<void>): Promise<void> {
    const prev = chains.get(sessionId) ?? Promise.resolve()
    const next = prev
      .then(work)
      .catch((e) => deps.log({ at: new Date().toISOString(), session: sessionId, event: 'drain-failed', error: deps.message(e) }).then(() => undefined))
      .finally(() => {
        if (chains.get(sessionId) === next) chains.delete(sessionId)
      })
    chains.set(sessionId, next)
    return next
  }

  /** 同一会话的复习串行（不同会话可以并行）。 */
  function schedule(sessionId: string): Promise<void> {
    return enqueue(sessionId, () => drain(sessionId))
  }

  /** 手动重试一条：只跑它自己，不去碰队列里其它的。 */
  function scheduleOne(item: OutboxItem): Promise<void> {
    return enqueue(item.session, () => reviewItem(item))
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
      if (sessionId === '' || route.provider === '' || route.model === '') return
      routes.set(sessionId, route)
      // 这个会话之前因为拿不到路由而没复习成：路由到了就补跑，不等下一次压缩 / 重启。
      if (awaitingRoute.delete(sessionId)) void schedule(sessionId)
    },

    routeOf,

    compactionSummary: handleCompaction,

    async replay() {
      const now = Date.now()
      const all = await deps.episodes.list()
      const targets = all.filter((x) => x.status === 'pending'
        || (x.status === 'failed' && (x.attempts ?? 0) <= MAX_REVIEW_ATTEMPTS))
        // **退避要认**：`nextAt` 是失败后算出来的「最早什么时候可以再试」。启动重放
        // 不看它就等于把退避整个作废 —— 一分钟内重启三次，一条本该 30 分钟后才重试的项
        // 会被烧成 dead-letter，而它可能只是模型那一次超时。
        .filter((x) => x.nextAt === undefined || x.nextAt <= now)
      let done = 0
      let failed = 0
      for (const item of targets) {
        // **每条都排进该会话的串行链**，不要在这里直接调 `reviewOne`。
        //
        // 启动重放与实时压缩走的是同一条会话：直接调会让两边同时复习同一个 episode，
        // 结果是两次模型调用、预算双计、同一条笔记被写两遍（第二条撞门禁报「已存在」）。
        let outcome: string = 'failed'
        await enqueue(item.session, async () => {
          const ep = await deps.episodes.read(item.path)
          const cfg = await deps.effectiveOf(item.session, ep?.cwd)
          if (!cfg.enabled) return
          outcome = await reviewOne(item, cfg)
        })
        if (outcome === 'done') done++
        else failed++
      }
      return { attempted: targets.length, done, failed }
    },

    drain: schedule,

    async stats() {
      const all = await deps.episodes.list()
      const out = { pending: 0, failed: 0, dead: 0, done: 0, orphan: 0 }
      for (const x of all) {
        if (x.status === 'pending') out.pending++
        else if (x.status === 'failed') out.failed++
        else if (x.status === 'dead') out.dead++
        else if (x.status === 'done') out.done++
        // orphan = episode 文件没了：这条永远不会再被处理，但用户得看得见它，
        // 否则"队列里有东西"和"队列是空的"在界面上长得一样。
        else if (x.status === 'orphan') out.orphan++
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
      // 只跑这一条：`drain` 按 turn 升序取前 BATCH 条，用户点的若是第 4 条，整队重跑
      // 不会碰它 —— 界面回了 ok、实际什么都没发生。
      // 传**清零后**的那份：`hit` 里的 attempts 还是旧值，直接用它复习失败一次就会
      // 撞过上限再进 dead-letter，同样等于点了没反应。
      await scheduleOne({ ...hit, status: 'pending', attempts: 0, nextAt: undefined, reason: 'manual retry' })
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
          // 真人原话继续喂证据缓存：热路径 `memory_manager_note` 声明 user_explicit 时，
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
          // 子会话不复习：热路径明确禁止子代理学习（`autoLearnEnabledFor` 要求深度为 0），
          // 冷路径是同一个闸门 —— 子代理压缩出来的 checkpoint 是「父代理写进委派说明的任务」，
          // 不是用户偏好。放它进复习等于从后门绕过深度限制，还会把工作区笔记写成任务态。
          // 判据复用 `subagentDepthOf`（全仓唯一一份深度口径），不再写第二套。
          // 它读的是 `agent.session.header`，而这里手里拿的已经是 `session` 本身 ——
          // 包一层 `{ session }` 而不是另写一份读 header 的逻辑。
          //
          // 只包 `session` 是**够的**：`subagentDepthOf` 的三路判据里，`options.subagentDepth`
          // 是运行期镜像，`header.origin === 'subagent'` 是持久化硬信号（子会话建出来就写进
          // 头里，见 `sessions/workspace.ts` 的归档判据），后者单独就足以把深度抬到 1。
          // 反过来说，如果哪天这个事件也能拿到 agent，应当改成直接传 agent —— 那时三路都用得上。
          if (subagentDepthOf({ session }) >= 1) break
          const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : undefined
          // 压缩把中间几轮折进摘要，而摘要里没有当初注入的记忆正文 —— 差集注入从此建立在
          // 模型已经不记得的基线上（它看到「+1 条」，却不知道原有的有哪些）。
          // 记一次代数，让该会话的下一轮注入回全量重发。
          //
          // 放在子会话闸门**之后**：子代理的上下文收敛为「角色 + 任务」，回全量只会灌进
          // 它用不上的父会话记忆。
          noteCompaction(sid)
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
