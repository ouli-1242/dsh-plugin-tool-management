// 主动记忆的 op（HTTP 层 + 工具层共用）：开关、学习、遗忘、清单。
//
// 为什么单独一个域：这些读写不碰记忆正文的**通用编辑**（那是 `memories-*` 的职责），
// 只碰"自动记忆"这个受策略约束的子集。混进记忆域会让"改一条记忆"和"让 agent 学一条"
// 共用同一个门禁，而它们的权限要求正相反 —— 前者要确认卡，后者必须是零摩擦（否则
// 每学一条都弹窗，用户三分钟就会关掉开关）。
//
// `learn` 与 `save` 分成两条工具的完整理由见 docs 05-tools §2：授权边界写在工具名上，
// 门禁不用猜参数。

import { workspaceHashOf, type EvolutionConfigStore, type EvolutionOverrides, type EvolutionSettings } from '../evolution/config.js'
import type { EvolutionRuntime } from '../evolution/runtime.js'
import type { Learner } from '../evolution/write.js'
import { workspaceMemoryKeyOf } from '../scope/workspace-key.js'

export interface EvolutionOpDeps {
  config: EvolutionConfigStore
  /** 同步视图（清单与统计读它，比异步门面新鲜且不额外读盘）。 */
  runtime: EvolutionRuntime
  /**
   * 写入管线。没有就表示这版没接自动记忆 —— op 如实报不可用，不静默成功。
   *
   * 类型引用 `Learner`（= `createLearner` 的返回值）而不是在这里再描述一遍：
   * 手写的那一份与实现分叉时编译器不会报错（方法参数双变），后果是某个参数被静默忽略。
   */
  learner?: Learner
  /** 把一条记忆移进回收站（记忆域的 `rules-remove`）。forget 用它，不自己删文件。 */
  removeMemory?(id: string): Promise<{ ok: boolean; error?: string }>
  message(e: unknown): string
}

/** 一档的展示形态：值 + 是否真的覆盖了字段（界面据此显示"来源"）。 */
function layerView(overrides: EvolutionOverrides | undefined) {
  return { defined: overrides !== undefined && Object.keys(overrides).length > 0, values: overrides ?? {} }
}

export function buildEvolutionOps(deps: EvolutionOpDeps): Record<string, (args: any) => Promise<any>> {
  const { config, runtime, learner, message } = deps

  /** cwd → 工作区身份（与 scope 页同一口径：先向上收敛到 git root）。 */
  const workspaceOf = (args: any): { scopeKey?: string; cwd?: string; hash?: string } => {
    const cwd = typeof args?.cwd === 'string' && args.cwd !== '' ? args.cwd : undefined
    if (!cwd) return {}
    const scopeKey = workspaceMemoryKeyOf(cwd)
    if (!scopeKey) return { cwd }
    return { cwd, scopeKey, hash: workspaceHashOf(scopeKey) }
  }

  return {
    /**
     * 读：全局值、两级覆盖、解析后的生效值、来源，外加自动记忆的统计。
     *
     * `cwd` / `sessionId` 由调用方给：HTTP 层拿不到宿主 agent。工具层从 agent 取，
     * 但**层永远以真实 sid / 真实 cwd 为准**，不接受客户端伪造的"层归属"。
     */
    'evolution-status': async (args: any) => {
      try {
        const { scopeKey, cwd, hash } = workspaceOf(args)
        const sessionId = typeof args?.sessionId === 'string' && args.sessionId !== '' ? args.sessionId : undefined
        const global = await config.readSettings()
        const effective = await config.effective(scopeKey, sessionId)
        const workspaces = await config.readWorkspaces()
        const sessions = await config.readSessions()
        const workspaceRecord = hash ? workspaces.workspaces[hash] : undefined
        const sessionRecord = sessionId ? sessions.sessions[sessionId] : undefined

        // 自动记忆实况：只报计数，不把正文塞进状态回执（它会被界面高频轮询）。
        const view = runtime.view()
        const entries = Object.values(view.catalog.entries)
        const byLayer: Record<string, number> = { global: 0, workspace: 0, scene: 0, session: 0 }
        const byStatus: Record<string, number> = {}
        for (const e of entries) {
          byLayer[e.layer] = (byLayer[e.layer] ?? 0) + 1
          byStatus[e.status] = (byStatus[e.status] ?? 0) + 1
        }
        const needsReview = entries.filter((e) => {
          const st = view.state.entries[e.id]
          return st && typeof st.needsReview === 'string' && st.needsReview !== ''
        }).length

        return {
          ok: true,
          effective,
          global,
          workspace: workspaceRecord
            ? { hash, key: workspaceRecord.key, cwd: workspaceRecord.cwd, label: workspaceRecord.label, ...layerView(workspaceRecord.evolution) }
            : hash ? { hash, key: scopeKey, cwd: cwd ?? '', label: '', defined: false, values: {} } : null,
          session: sessionRecord ? layerView(sessionRecord.evolution) : null,
          defaults: global,
          auto: {
            entries: entries.length,
            byLayer,
            byStatus,
            needsReview,
            pendingReview: needsReview,
            broken: view.broken,
            active: entries.filter((e) => e.enabled && (e.status === 'active' || e.status === 'core')).length,
          },
        }
      } catch (e) {
        return { ok: false, error: message(e), code: 'status-failed' }
      }
    },

    /** 写全局设置。只接受已知字段，未传的沿用当前值。 */
    'evolution-settings': async (args: any) => {
      try {
        const current = await config.readSettings()
        if (args?.set !== true) return { ok: true, settings: current }
        const patch = args.settings && typeof args.settings === 'object' ? args.settings : {}
        const next: EvolutionSettings = { ...current }
        if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
        if (typeof patch.learnScope === 'string') next.learnScope = patch.learnScope
        if (typeof patch.writeTarget === 'string') next.writeTarget = patch.writeTarget
        if (typeof patch.inject === 'boolean') next.inject = patch.inject
        if (typeof patch.dream === 'string') next.dream = patch.dream
        if (typeof patch.skills === 'string') next.skills = patch.skills
        if (typeof patch.maxEntries === 'number') next.maxEntries = patch.maxEntries
        if (typeof patch.reviewEveryTurns === 'number') next.reviewEveryTurns = patch.reviewEveryTurns
        if (typeof patch.maxReviewsPerSession === 'number') next.maxReviewsPerSession = patch.maxReviewsPerSession
        if (typeof patch.model === 'string') next.model = patch.model
        const written = await config.writeSettings(next)
        if (!written.ok) return { ok: false, error: written.error, code: 'write-failed' }
        runtime.invalidate()
        return { ok: true, settings: written.settings }
      } catch (e) {
        return { ok: false, error: message(e), code: 'settings-failed' }
      }
    },

    /**
     * 写某一档的开关（也接受别的覆盖字段）。
     *
     * `scope='workspace'` 需要 `cwd`；`scope='session'` 需要 `sessionId`。
     * 下层可以覆盖上层的"关"——这正是"只给这个对话开"能成立的原因。
     */
    'evolution-toggle': async (args: any) => {
      try {
        const scope = args?.scope
        const enabled = args?.enabled
        if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled 必须是布尔值', code: 'bad-args' }
        if (scope === 'global') {
          const written = await config.writeSettings({ ...(await config.readSettings()), enabled })
          if (!written.ok) return { ok: false, error: written.error, code: 'write-failed' }
          runtime.invalidate()
          return { ok: true, scope, enabled }
        }
        if (scope === 'workspace') {
          const { scopeKey, cwd } = workspaceOf(args)
          if (!scopeKey) return { ok: false, error: '拿不到工作区路径，无法保存工作区开关', code: 'no-workspace' }
          // 保留同一档的其它覆盖字段，只换 enabled。
          const workspaces = await config.readWorkspaces()
          const prev = workspaces.workspaces[workspaceHashOf(scopeKey)]?.evolution ?? {}
          const written = await config.writeWorkspace(scopeKey, cwd ?? '', typeof args?.label === 'string' ? args.label : '', { ...prev, enabled })
          if (!written.ok) return { ok: false, error: written.error, code: 'write-failed' }
          runtime.invalidate()
          return { ok: true, scope, enabled, hash: written.hash }
        }
        if (scope === 'session') {
          const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : ''
          if (!sessionId) return { ok: false, error: '拿不到会话 id，无法保存会话开关', code: 'no-session' }
          const sessions = await config.readSessions()
          const prev = sessions.sessions[sessionId]?.evolution ?? {}
          const written = await config.writeSession(sessionId, { ...prev, enabled })
          if (!written.ok) return { ok: false, error: written.error, code: 'write-failed' }
          runtime.invalidate()
          return { ok: true, scope, enabled }
        }
        return { ok: false, error: 'scope 必须是 global / workspace / session', code: 'bad-args' }
      } catch (e) {
        return { ok: false, error: message(e), code: 'toggle-failed' }
      }
    },

    /**
     * 学一条（模型主动调；也是 P2 复习器的唯一写入口）。
     *
     * `source` 的四个值决定证据强度：`user_explicit` / `user_correction` 必须带**逐字引句**
     * （证据门会核对），`tool_verified` 指"工具结果证明了它"，`model_inference` 只能进候选。
     */
    'evolution-learn': async (args: any) => {
      if (!learner) return { ok: false, error: '自动记忆尚未启用', code: 'unavailable' }
      try {
        const { scopeKey, cwd } = workspaceOf(args)
        const sessionId = typeof args?.sessionId === 'string' && args.sessionId !== '' ? args.sessionId : undefined
        const cfg = await config.effective(scopeKey, sessionId)
        // 开关：学不学是一道独立的门，与"能不能写"无关。关了就说清为什么，别静默成功。
        if (!cfg.enabled || cfg.learnScope === 'off') {
          return { ok: false, error: 'proactive memory is off for this conversation / workspace', code: 'disabled' }
        }
        const result = await learner.learn(
          {
            text: String(args?.text ?? ''),
            ...(args?.kind !== undefined ? { kind: args.kind } : {}),
            ...(args?.key !== undefined ? { key: args.key } : {}),
            source: args?.source ?? 'model_inference',
            ...(args?.quote !== undefined ? { quote: args.quote } : {}),
            ...(args?.layer !== undefined ? { layer: args.layer } : {}),
            ...(args?.boundary !== undefined ? { boundary: args.boundary } : {}),
            ...(args?.ttlDays !== undefined ? { ttlDays: args.ttlDays } : {}),
            ...(args?.description !== undefined ? { description: args.description } : {}),
          },
          cfg,
          {
            ...(sessionId !== undefined ? { sessionId } : {}),
            ...(scopeKey !== undefined ? { workspaceHash: workspaceHashOf(scopeKey) } : {}),
            ...(typeof args?.scene === 'string' && args.scene !== '' ? { scene: args.scene } : {}),
          },
        )
        if (result.ok) runtime.invalidate()
        return result
      } catch (e) {
        return { ok: false, error: message(e), code: 'learn-failed' }
      }
    },

    /** 忘掉一条：正文进回收站，写墓碑（30 天内自动路径不能复活）。 */
    'evolution-forget': async (args: any) => {
      if (!learner) return { ok: false, error: '自动记忆尚未启用', code: 'unavailable' }
      try {
        const id = String(args?.id ?? '')
        if (id === '') return { ok: false, error: 'missing id', code: 'bad-args' }
        const actor = typeof args?.actor === 'string' ? args.actor : 'model'
        const result = await learner.forget(id, {
          actor,
          ...(deps.removeMemory
            ? {
                remove: async (x: string) => {
                  const r = await deps.removeMemory!(x)
                  return r.ok === true
                },
              }
            : {}),
        })
        if (result && result.ok) runtime.invalidate()
        return result
      } catch (e) {
        return { ok: false, error: message(e), code: 'forget-failed' }
      }
    },

    /**
     * 列自动记忆（界面与 `memory_manager_list` 共用）。
     *
     * 与 `rules-list` 分开：那条列的是"用户记忆"，这条列的是"agent 学的" —— 两者在界面上
     * 是同一页的两节，但权威等级、状态机、可做的操作都不同，混成一份返回会让界面到处判 `origin`。
     */
    'evolution-list': async (args: any) => {
      try {
        const view = runtime.view()
        const layerFilter = typeof args?.layer === 'string' && args.layer !== '' ? args.layer : undefined
        const includeAll = args?.all === true
        const rows: any[] = []
        for (const entry of Object.values(view.catalog.entries)) {
          if (layerFilter && entry.layer !== layerFilter) continue
          const st = view.state.entries[entry.id]
          const needsReview = st && typeof st.needsReview === 'string' && st.needsReview !== ''
          // 默认只列"会注入的 + 待确认的"：archived / superseded 只在 all=true 时出现。
          if (!includeAll && entry.status !== 'active' && entry.status !== 'core' && !needsReview) continue
          rows.push({
            id: entry.id,
            layer: entry.layer,
            kind: entry.kind,
            key: entry.key,
            status: entry.status,
            confidence: entry.confidence,
            oneLine: entry.oneLine,
            pinned: entry.pinned,
            enabled: entry.enabled,
            tokens: entry.estTokens,
            workspace: entry.workspace,
            scene: entry.scene,
            session: entry.session,
            ...(st?.degraded !== undefined ? { degraded: st.degraded } : {}),
            ...(needsReview ? { needsReview: st!.needsReview } : {}),
            ...(st?.locked === true ? { locked: true } : {}),
            counters: st?.counters ?? { injected: 0, read: 0, helpful: 0, harmful: 0 },
            evidence: (st?.evidence ?? []).map((ev) => ({ source: ev.source, quote: ev.quote, at: ev.at, session: ev.session })),
            transitions: st?.transitions ?? [],
          })
        }
        // 待确认的排前面：界面的「待确认」入口靠这个顺序。
        rows.sort((a, b) => Number(Boolean(b.needsReview)) - Number(Boolean(a.needsReview)) || b.confidence - a.confidence || a.id.localeCompare(b.id))
        return {
          ok: true,
          entries: rows,
          total: Object.keys(view.catalog.entries).length,
          broken: view.broken,
          settings: view.settings,
        }
      } catch (e) {
        return { ok: false, error: message(e), code: 'list-failed' }
      }
    },
  }
}
