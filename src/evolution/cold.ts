// 冷路径的接线：把 `session/event` 与 `turn/end` 接到 digest → episode → outbox → 复习器。
//
// 这一层只做"什么时候做什么"，判断都在 digest / episodes / review 里。三个原则：
//
//   1. **事件钩子绝不抛**。它跑在宿主的会话主链上，抛一次就是用户的一轮对话崩掉。
//      所有分支都包在 try/catch 里，失败只写日志。
//   2. **不阻塞 turn/end**。复习是异步的：`turn/end` 的处理器同步返回，模型调用在
//      后台跑。用户等的是下一句话，不是我们的记忆整理。
//   3. **每会话串行**。同一会话的两轮复习并发跑会撞 state 写锁（那是全局锁，会互相拖慢），
//      也会让两条相似的记忆互相看不见、各写一份。一个会话一条 promise 链。

import { textOfMessage, captureUserTexts, isGenuineUserMessage } from './evidence.js'
import { createDigestStore, episodeOf, reviewDecision, type DigestStore } from './digest.js'
import type { EpisodeStore, OutboxItem } from './episodes.js'
import type { EffectiveEvolutionConfig } from './config.js'
import { outboxFailed, type createReviewer } from './review.js'

export interface ColdPathDeps {
  /** 每会话的生效配置（异步：要读三级开关文件）。 */
  effectiveOf(sessionId: string, cwd: string | undefined): Promise<EffectiveEvolutionConfig>
  /** outbox 与 episodes（启动重放与轮末都走它）。 */
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
   * 为什么挂在轮末而不是启动时：整理要调模型，而"用哪个模型"只有这一轮请求头知道。
   * 启动时拿不到路由，只能赌一个默认模型 —— 学到的风格会和对话不一致。
   * 钩子不 await、异常全吞：它跑在会话主链的尾巴上，慢一点可以，炸一次不行。
   */
  afterReview?(sessionId: string, cwd: string | undefined, cfg: EffectiveEvolutionConfig, route: { provider: string; model: string } | null): Promise<void>
}

export interface ColdPathHandle {
  digests: DigestStore
  /** `turn/start`：记下当前轮次（`user/message` 不带 turn）。 */
  noteTurn(sessionId: string, turn: number): void
  currentTurn(sessionId: string): number
  /** `request/header`：记下这一轮用的模型路由（复习默认用它）。 */
  noteRoute(sessionId: string, route: { provider: string; model: string }): void
  routeOf(sessionId: string): { provider: string; model: string } | null
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
  /** 轮末入口：封存 digest → episode → outbox，然后异步复习。 */
  turnEnd(sessionId: string, turn: number, cwd?: string): Promise<void>
}

/** 一次复习取几条（按 turn 升序）。 */
const BATCH = 3

export function createColdPath(deps: ColdPathDeps): ColdPathHandle {
  const digests = createDigestStore()
  /** 每个会话当前的 turn（`user/message` 不带 turn，只能跟 `turn/start`）。 */
  const currentTurn = new Map<string, number>()
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
    // 这几类重试没有意义：预算用光、拿不到模型、输出不是 JSON（模型已经跑偏）。
    // 标 done + reason，让它们从队列里消失，但在 episode 与日志里留痕。
    if (out.reason === 'budget' || out.reason === 'no-model' || out.reason === 'no-llm' || out.reason === 'bad-json') {
      await deps.episodes.mark(item, { status: 'done', reason: out.reason })
      return 'done'
    }
    await deps.episodes.mark(item, outboxFailed(item, out.error ?? 'review failed', clock()))
    return 'failed'
  }

  async function drain(sessionId: string): Promise<void> {
    const items = await deps.episodes.retryable(sessionId, BATCH, clock())
    if (items.length === 0) return
    // 用 episode 里存的 cwd 取配置：这里是异步路径，拿不到活的 session 对象。
    for (const item of items) {
      const ep = await deps.episodes.read(item.path)
      const cfg = await deps.effectiveOf(item.session, ep?.cwd)
      if (!cfg.enabled) return
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

  async function onTurnEnd(sessionId: string, turn: number, cwd: string | undefined): Promise<EffectiveEvolutionConfig | null> {
    const digest = digests.seal(sessionId, turn)
    if (!digest) return null
    const cfg = await deps.effectiveOf(sessionId, cwd)
    if (!cfg.enabled) return null
    const decision = reviewDecision(digest, cfg.reviewEveryTurns)
    if (!decision.review) {
      await deps.log({ at: new Date().toISOString(), session: sessionId, turn, event: 'turn-skipped', reason: decision.reason })
      return cfg
    }
    const at = new Date().toISOString()
    const hash = cwd ? deps.workspaceHashOf(cwd) : undefined
    const ep = episodeOf(digest, {
      session: sessionId,
      at,
      reason: decision.reason,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(hash !== undefined ? { workspaceHash: hash } : {}),
    })
    const written = await deps.episodes.write(ep)
    if (!written.ok) {
      // 宁可这轮不学，也不要产生指向空文件的队列项。
      await deps.log({ at, session: sessionId, turn, event: 'episode-write-failed', error: written.error })
      return cfg
    }
    const item = await deps.episodes.enqueue({ id: ep.id, session: sessionId, turn, at, path: written.path })
    if (!item) {
      await deps.log({ at, session: sessionId, turn, event: 'outbox-write-failed' })
      return cfg
    }
    await deps.log({ at, session: sessionId, turn, event: 'queued', reason: decision.reason, signals: decision.signals })
    return cfg
  }

  // 轮末：先封存 episode 与 outbox，再异步复习。不 await —— 见文件头第 2 条。
  async function handleTurnEnd(sessionId: string, turn: number, cwd: string | undefined): Promise<void> {
    try {
      const cfg = await onTurnEnd(sessionId, turn, cwd)
      await schedule(sessionId)
      // 整理钩子放在复习之后：它要看的是"这一轮学完之后"的库。
      if (cfg && deps.afterReview) {
        void deps.afterReview(sessionId, cwd, cfg, routeOf(sessionId))
          .catch((e) => deps.log({ at: new Date().toISOString(), session: sessionId, turn, event: 'after-review-failed', error: deps.message(e) }).then(() => undefined))
      }
    } catch (e) {
      await deps.log({ at: new Date().toISOString(), session: sessionId, turn, event: 'turn-end-failed', error: deps.message(e) }).catch(() => undefined)
    }
  }

  return {
    digests,

    turnEnd: handleTurnEnd,

    noteTurn(sessionId, turn) {
      if (sessionId !== '' && Number.isFinite(turn)) currentTurn.set(sessionId, Math.floor(turn))
    },

    currentTurn(sessionId) {
      return currentTurn.get(sessionId) ?? 0
    },

    noteRoute(sessionId, route) {
      if (sessionId !== '' && route.provider !== '' && route.model !== '') routes.set(sessionId, route)
    },

    routeOf,

    async replay() {
      const all = await deps.episodes.list()
      const targets = all.filter((x) => x.status === 'pending' || (x.status === 'failed' && (x.attempts ?? 0) < 3))
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
        case 'turn/start': {
          const turn = Number(data.turn)
          if (Number.isFinite(turn)) cold.noteTurn(sid, turn)
          break
        }
        case 'user/message': {
          // 只收真人输入：`kind === 'user'` 才是用户自己打的字（`user` / `user-rpc` 两种源
          // 都是这个 kind）；`runtime-context` / `tool-registry` / `system-reminder` 那些是
          // 各插件注入的合成消息。摘要在"用户说了什么"这件事上不能比证据门更宽松。
          if (!isGenuineUserMessage(data)) break
          const text = textOfMessage(data).trim()
          if (text === '') break
          cold.digests.capture(sid, cold.currentTurn(sid), { kind: 'user', text })
          // 证据门要逐字核对；这里顺手喂一份，热路径的 learn 与冷路径的复习都能查到。
          captureUserTexts(sid, [data])
          break
        }
        case 'tool/call': {
          const turn = Number(data.turn)
          cold.digests.noteToolCall(sid, Number.isFinite(turn) ? turn : cold.currentTurn(sid), String(data.callId ?? ''), String(data.name ?? ''))
          break
        }
        case 'tool/result': {
          const m = data.message
          const callId = m?.source && typeof m.source === 'object' ? String(m.source.callId ?? '') : ''
          const turn = Number(data.turn)
          const useTurn = Number.isFinite(turn) ? turn : cold.currentTurn(sid)
          cold.digests.capture(sid, useTurn, {
            kind: 'tool',
            tool: cold.digests.toolNameOf(sid, useTurn, callId),
            ok: m?.isError !== true,
            text: textOfMessage(m).trim(),
          })
          break
        }
        case 'request/header': {
          const cfg = data.header && typeof data.header === 'object' ? data.header.config : undefined
          if (cfg && typeof cfg.provider === 'string' && typeof cfg.model === 'string') {
            cold.noteRoute(sid, { provider: cfg.provider, model: cfg.model })
          }
          break
        }
        case 'turn/end': {
          const turn = Number(data.turn)
          if (!Number.isFinite(turn)) return
          const reasonKind = data.reason && typeof data.reason === 'object' ? String(data.reason.kind ?? '') : ''
          if (reasonKind !== 'completed') {
            // 取消 / 出错的一轮没有"发生了什么"的完整叙述，不复习；digest 也丢掉。
            cold.digests.drop(sid, turn)
            return
          }
          const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : undefined
          // 不 await：turn/end 的处理器必须同步返回，复习在后台跑。
          void cold.turnEnd(sid, turn, cwd)
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
