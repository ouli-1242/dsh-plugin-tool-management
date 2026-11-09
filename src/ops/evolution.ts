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
// 只取类型：冷路径在装配层晚于本函数创建，所以拿的是 getter 而不是实例。
import type { ColdPathHandle } from '../evolution/cold.js'
import type { Dreamer } from '../evolution/dream.js'
import type { SweepReport } from '../evolution/maintenance.js'
import { canPromotePlaybook, parseProcedureSteps, type ProcedureSkillStore, type SkillDraftInput } from '../evolution/procedure.js'
import { isInjectableStatus } from '../memories/catalog.js'
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
  /**
   * 会话 id → 工作目录。客户端的「本工作区」那一行只知道自己当前是哪个对话，
   * 不知道 cwd；宿主那边的映射只有装配层有（与 `scope-sessions-list` 同一份）。
   *
   * 取不到就当作"没有工作区"：界面少一行工作区开关，好过写错层。
   */
  sessionCwd?(sessionId: string): Promise<string | undefined>
  /**
   * 冷路径句柄（后台复习队列）。
   *
   * 用 getter 而不是直接传实例：op 表在 `attachColdPath` **之前**装配（op 要能被
   * 「开关打开」之前就调用，那时光标还没有后台复习）。传 getter 就不会出现
   * "先建一份空队列、真正跑起来的是另一份"的错位。
   */
  cold?(): ColdPathHandle | null
  /** dream 执行器（P3）。同样用 getter：它依赖冷路径的 episode 存储。 */
  dream?(): Dreamer | null
  /** 维护扫描（P3）：TTL / 会话 GC / 衰减 / 工作区失效 / 配额。 */
  sweep?(opts?: { dry?: boolean }): Promise<SweepReport>
  /** P4：程序性记忆与技能提议的存储（同样用 getter，装配晚于 op 表）。 */
  procedureSkills?(): ProcedureSkillStore | null
  /** 健康度（只读统计）。 */
  health?(): Promise<{
    byLayer: Record<string, { active: number; candidate: number; archived: number; cap: number; tokens: number }>
    tokens: number
    conflicts: number
    needsReview: number
    expired: number
    total: number
  }>
  /**
   * 设置写入后的通知：那条主动记忆工具跟随总开关，而模型侧的 restrict 名单是缓存的。
   * 不主动重排一次，拨完开关要等下一次无关的 tools/change 工具才真的出现 / 消失。
   * 可选：单测里不接也能跑；回调自己抛错不该让开关保存失败。
   */
  onSettingsChanged?(): void
  message(e: unknown): string
}

/** 一档的展示形态：值 + 是否真的覆盖了字段（界面据此显示"来源"）。 */
function layerView(overrides: EvolutionOverrides | undefined) {
  return { defined: overrides !== undefined && Object.keys(overrides).length > 0, values: overrides ?? {} }
}

export function buildEvolutionOps(deps: EvolutionOpDeps): Record<string, (args: any) => Promise<any>> {
  const { config, runtime, learner, message } = deps
  /** 只在这四处「写设置」之后调；记忆正文写入不碰工具表，不必重排。 */
  const notifySettingsChanged = () => {
    try { deps.onSettingsChanged?.() } catch { /* 重排失败不该让开关保存失败 */ }
  }

  /**
   * 把一条 playbook 读成「技能草案的输入」。
   *
   * 只认 `playbook`：active / core 的 procedure 还没走完验证阶梯，直接生成技能等于跳过
   * 人工确认链。步骤以 state.json 为准，正文解析只给旧条目兜底。
   */
  const procedureInputOf = async (id: string): Promise<{ ok: true; input: SkillDraftInput } | { ok: false; error: string }> => {
    if (!learner) return { ok: false, error: '自动记忆尚未启用' }
    const view = runtime.view()
    const entry = view.catalog.entries[id]
    if (!entry || entry.kind !== 'procedure') return { ok: false, error: `不是程序性记忆：${id}` }
    if (entry.status !== 'playbook') return { ok: false, error: '只有 playbook 能生成技能（先验证 3 次并晋升）' }
    const d = await learner.describe(id)
    if (!d.ok) return { ok: false, error: d.error }
    const st = view.state.entries[id]
    const steps = st?.procedure?.steps ?? parseProcedureSteps(d.body)
    if (steps.length < 2) return { ok: false, error: '这条流程没有至少 2 个步骤' }
    return {
      ok: true,
      input: {
        id,
        key: entry.key,
        title: d.title || entry.title || entry.key,
        description: entry.oneLine,
        steps,
        boundary: d.boundary,
        successes: st?.procedure?.successes ?? 0,
      },
    }
  }

  /**
   * cwd → 工作区身份（与 scope 页同一口径：先向上收敛到 git root）。
   *
   * 客户端只给 `sessionId` 时按会话查一次 cwd（`deps.sessionCwd`）—— 界面上「本工作区」
   * 那颗开关否则永远没有落点。查不到就返回空：宁可少一行开关，也不猜一个工作区。
   */
  const workspaceOf = async (args: any): Promise<{ scopeKey?: string; cwd?: string; hash?: string }> => {
    let cwd = typeof args?.cwd === 'string' && args.cwd !== '' ? args.cwd : undefined
    if (!cwd && deps.sessionCwd && typeof args?.sessionId === 'string' && args.sessionId !== '') {
      cwd = await deps.sessionCwd(args.sessionId)
    }
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
        const { scopeKey, cwd, hash } = await workspaceOf(args)
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
          // 会话那一行：**有会话 id 就要给一行**（哪怕还没写过记录）。
          // 返回 null 会让界面把整行藏掉 —— 用户第一次想给这个对话开开关时，找不到入口。
          // 工作区那一档就是这么处理的（`defined: false` + 空 values 表示"还没覆盖"）。
          session: sessionId === ''
            ? null
            : (sessionRecord ? layerView(sessionRecord.evolution) : { defined: false, values: {} }),
          defaults: global,
          auto: {
            entries: entries.length,
            byLayer,
            byStatus,
            needsReview,
            pendingReview: needsReview,
            broken: view.broken,
            active: entries.filter((e) => e.enabled && isInjectableStatus(e.status)).length,
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
        notifySettingsChanged()
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
        // `inherit: true` = 清掉这一档的覆盖，回到跟上一级走。
        // 为什么需要它：三级开关是"逐字段覆盖"，没有"清除"这条路的话，用户一旦点过
        // 工作区那一档就再也回不到"跟随全局" —— 他只能选开或关，而上层改了之后这里不会跟。
        const inherit = args?.inherit === true
        const enabled = args?.enabled
        if (!inherit && typeof enabled !== 'boolean') return { ok: false, error: 'enabled 必须是布尔值', code: 'bad-args' }
        if (scope === 'global') {
          if (inherit) return { ok: false, error: '全局这一档没有「继承」', code: 'bad-args' }
          const written = await config.writeSettings({ ...(await config.readSettings()), enabled })
          if (!written.ok) return { ok: false, error: written.error, code: 'write-failed' }
          runtime.invalidate()
          notifySettingsChanged()
          return { ok: true, scope, enabled }
        }
        if (scope === 'workspace') {
          const { scopeKey, cwd } = await workspaceOf(args)
          if (!scopeKey) return { ok: false, error: '拿不到工作区路径，无法保存工作区开关', code: 'no-workspace' }
          // 保留同一档的其它覆盖字段，只换 enabled（继承 = 整块清空）。
          const workspaces = await config.readWorkspaces()
          const record = workspaces.workspaces[workspaceHashOf(scopeKey)]
          const prev = record?.evolution ?? {}
          // 标签沿用已存的那一份：开关请求通常不带 label，覆盖成 '' 会把用户见过的
          // 工作区名字抹掉（下拉框里就只剩一串路径）。
          const label = typeof args?.label === 'string' && args.label !== '' ? args.label : (record?.label ?? '')
          const written = await config.writeWorkspace(scopeKey, cwd ?? '', label, inherit ? {} : { ...prev, enabled })
          if (!written.ok) return { ok: false, error: written.error, code: 'write-failed' }
          runtime.invalidate()
          notifySettingsChanged()
          return { ok: true, scope, inherit, ...(inherit ? {} : { enabled }), hash: written.hash }
        }
        if (scope === 'session') {
          const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : ''
          if (!sessionId) return { ok: false, error: '拿不到会话 id，无法保存会话开关', code: 'no-session' }
          const sessions = await config.readSessions()
          const prev = sessions.sessions[sessionId]?.evolution ?? {}
          const written = await config.writeSession(sessionId, inherit ? {} : { ...prev, enabled })
          if (!written.ok) return { ok: false, error: written.error, code: 'write-failed' }
          runtime.invalidate()
          notifySettingsChanged()
          return { ok: true, scope, inherit, ...(inherit ? {} : { enabled }) }
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
        const { scopeKey, cwd } = await workspaceOf(args)
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
            // P4：只有 procedure 用；写入管线会洗净并限长，非 procedure 一律忽略。
            ...(Array.isArray(args?.steps) ? { steps: args.steps.map((x: unknown) => String(x)) } : {}),
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
     * 确认一条候选（记忆页的「确认」）。
     *
     * 只做"候选 → 生效"这一件事：换层 / 合并 / 拆条属于 dream 的草案，不走这条。
     * 候选不注入，所以确认是用户把一条自动记忆真正启用的唯一入口。
     */
    'evolution-approve': async (args: any) => {
      if (!learner) return { ok: false, error: '自动记忆尚未启用', code: 'unavailable' }
      try {
        const id = String(args?.id ?? '')
        if (id === '') return { ok: false, error: 'missing id', code: 'bad-args' }
        const result = await learner.approve(id)
        if (result && result.ok) runtime.invalidate()
        return result
      } catch (e) {
        return { ok: false, error: message(e), code: 'approve-failed' }
      }
    },

    /**
     * 停用 / 恢复一条。
     *
     * 与 `evolution-forget` 的区别要体现在回执里：这条**不删文件、不写墓碑**，随时能恢复。
     * 用户点「停用」时想的是"别再拿它烦我"，不是"永远别让我看见"。
     */
    'evolution-set-status': async (args: any) => {
      if (!learner) return { ok: false, error: '自动记忆尚未启用', code: 'unavailable' }
      try {
        const id = String(args?.id ?? '')
        if (id === '') return { ok: false, error: 'missing id', code: 'bad-args' }
        // 两个入参名都收：界面按开关语义传 `enabled`，工具按状态语义传 `status`。
        // 只认一个会让另一条路静默写成 undefined —— 而 `setStatus` 会拿它跟当前值比、
        // 比不出来就返回 unchanged，症状是"点了没反应但不报错"。
        const wanted = typeof args?.status === 'string' ? args.status : ''
        const status = wanted === 'playbook' || wanted === 'core'
          ? wanted
          : wanted === 'archived' || args?.enabled === false ? 'archived' : 'active'
        // 升 playbook 一律走 dream 那条判据（core → playbook、成功 ≥3、harmful=0、有步骤），
        // 不让界面传个 actor 就把门槛绕过去。
        const actor = status === 'playbook' ? 'dream' : args?.actor === 'user' ? 'user' : 'curator'
        const result = await learner.setStatus(id, status, actor)
        if (result && result.ok) runtime.invalidate()
        return result
      } catch (e) {
        return { ok: false, error: message(e), code: 'status-failed' }
      }
    },

    /** 提升为用户记忆：从自动段移出，进用户记忆的注入与预算。 */
    'evolution-promote': async (args: any) => {
      if (!learner) return { ok: false, error: '自动记忆尚未启用', code: 'unavailable' }
      try {
        const id = String(args?.id ?? '')
        if (id === '') return { ok: false, error: 'missing id', code: 'bad-args' }
        const result = await learner.promote(id, { actor: args?.actor === 'user' ? 'user' : 'curator' })
        if (result && result.ok) runtime.invalidate()
        return result
      } catch (e) {
        return { ok: false, error: message(e), code: 'promote-failed' }
      }
    },

    /** 读一条自动记忆的详情（界面展开 / `memory_manager_read` 兜底）。 */
    'evolution-read': async (args: any) => {
      if (!learner) return { ok: false, error: '自动记忆尚未启用', code: 'unavailable' }
      try {
        const id = String(args?.id ?? '')
        if (id === '') return { ok: false, error: 'missing id', code: 'bad-args' }
        return await learner.describe(id)
      } catch (e) {
        return { ok: false, error: message(e), code: 'read-failed' }
      }
    },

    /**
     * 算整理草案：只读。
     *
     * 返回的 `drafts[].id` 是确定性的（action + ids）—— 界面「应用」时原样回传，
     * 服务端不靠"再算一遍碰运气"，而是按回传的 ids 直接执行并逐条校验。
     */
    'evolution-organize': async (args: any) => {
      if (!learner) return { ok: false, error: '自动记忆尚未启用', code: 'unavailable' }
      try {
        const scope = args?.scope === 'all' ? 'all' : args?.scope === 'global' ? 'global' : 'workspace'
        return await learner.organize(scope)
      } catch (e) {
        return { ok: false, error: message(e), code: 'organize-failed' }
      }
    },

    /** 应用一条草案（用户点过「应用」才会到这里）。 */
    'evolution-apply-organize': async (args: any) => {
      if (!learner) return { ok: false, error: '自动记忆尚未启用', code: 'unavailable' }
      try {
        const result = await learner.applyOrganize({
          action: args?.action,
          ids: Array.isArray(args?.ids) ? args.ids.map((x: unknown) => String(x)) : undefined,
          ...(typeof args?.keep === 'string' ? { keep: args.keep } : {}),
        })
        if (result && result.ok) runtime.invalidate()
        return result
      } catch (e) {
        return { ok: false, error: message(e), code: 'apply-failed' }
      }
    },

    /**
     * 后台复习队列（只读）。
     *
     * 为什么界面需要看这个：复习完全在后台跑，用户唯一的观察窗口就是"学到的条目"。一旦
     * 整批失败（模型没配、密钥过期、上游 5xx），表现是"开了开关但什么都不学" —— 没有
     * 这个 op，这个状态和"这几轮确实没什么可记"长得一模一样。
     *
     * 只返回非 done 的项：done 的计数在 `stats` 里，条目本身进了记忆库，再列一遍没有意义。
     */
    'evolution-queue': async () => {
      const cold = deps.cold?.()
      if (!cold) return { ok: false, error: '后台复习尚未接线', code: 'no-cold' }
      try {
        const [items, stats] = await Promise.all([cold.queue(), cold.stats()])
        const order = ['dead', 'failed', 'pending', 'orphan']
        const rows = items
          .filter((x) => x.status !== 'done')
          .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.turn - a.turn)
          .slice(0, 50)
          .map((x) => ({
            id: x.id,
            session: x.session,
            turn: x.turn,
            status: x.status,
            attempts: x.attempts,
            at: x.at,
            ...(x.reason !== undefined ? { reason: x.reason } : {}),
            ...(x.nextAt !== undefined ? { nextAt: x.nextAt } : {}),
          }))
        return { ok: true, stats, items: rows }
      } catch (e) {
        return { ok: false, error: message(e), code: 'queue-failed' }
      }
    },

    /**
     * 手动重跑复习。
     *
     * 带 `id` = 重试那一条（含 dead-letter：这是它唯一的出口）；不带 = 把队列里所有
     * pending / failed 跑一遍。两者都不改记忆正文本身 —— 真正写库的仍是复习器 + 九道门。
     */
    'evolution-replay': async (args: any) => {
      const cold = deps.cold?.()
      if (!cold) return { ok: false, error: '后台复习尚未接线', code: 'no-cold' }
      const id = typeof args?.id === 'string' ? args.id.trim() : ''
      try {
        if (id !== '') {
          const r = await cold.retry(id)
          if (!r.ok) return { ok: false, error: '队列里没有这一条', code: 'not-found' }
          return { ok: true, attempted: 1 }
        }
        return { ok: true, ...(await cold.replay()) }
      } catch (e) {
        return { ok: false, error: message(e), code: 'replay-failed' }
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
        const statusFilter = typeof args?.status === 'string' && args.status !== '' ? args.status : undefined
        const kindFilter = typeof args?.kind === 'string' && args.kind !== '' ? args.kind : undefined
        const includeAll = args?.all === true
        const rows: any[] = []
        for (const entry of Object.values(view.catalog.entries)) {
          if (layerFilter && entry.layer !== layerFilter) continue
          if (statusFilter && entry.status !== statusFilter) continue
          if (kindFilter && entry.kind !== kindFilter) continue
          const st = view.state.entries[entry.id]
          const needsReview = st && typeof st.needsReview === 'string' && st.needsReview !== ''
          // 默认只列"会注入的 + 待确认的"：archived / superseded 只在 all=true 时出现。
          if (!includeAll && !isInjectableStatus(entry.status) && !needsReview) continue
          rows.push({
            id: entry.id,
            layer: entry.layer,
            kind: entry.kind,
            key: entry.key,
            status: entry.status,
            confidence: entry.confidence,
            oneLine: entry.oneLine,
            ...(entry.title !== undefined ? { title: entry.title } : {}),
            // P4：列表不返回步骤正文（一次几十条会变大），只给条数与成功次数，展开再走 read。
            ...(st?.procedure !== undefined ? { stepCount: st.procedure.steps.length, successes: st.procedure.successes, failures: st.procedure.failures } : {}),
            pinned: entry.pinned,
            enabled: entry.enabled,
            // 「会不会进上下文」的主判据就是这两个：状态与单条开关。层匹配由调用方判
            // （界面知道自己是谁、模型知道自己的 sid/cwd），op 层不猜。
            injects: entry.enabled && isInjectableStatus(entry.status),
            tokens: entry.estTokens,
            workspace: entry.workspace,
            scene: entry.scene,
            session: entry.session,
            ...(st?.degraded !== undefined ? { degraded: st.degraded } : {}),
            ...(needsReview ? { needsReview: st!.needsReview } : {}),
            ...(st?.locked === true ? { locked: true } : {}),
            counters: st?.counters ?? { injected: 0, read: 0, helpful: 0, harmful: 0 },
            // 证据不在这里返回：一条 quote 可以到 2000 字，界面一次刷新几十条就是几十 KB。
            // 时间线留最近 5 条（很小），展开单条时再走 `evolution-read` 补证据与依据。
            transitions: (st?.transitions ?? []).slice(-5),
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

    /**
     * 生成一份整理草案（P3）。
     *
     * 只出草案，不改库 —— 应用是用户点过之后的另一条 op。这条会花一次模型调用，
     * 所以界面上的按钮有确认弹窗，而不是进页面就自动跑。
     */
    'evolution-dream': async (args: any) => {
      const dreamer = deps.dream?.()
      if (!dreamer) return { ok: false, error: '整理器尚未接线', code: 'no-dream' }
      try {
        const { scopeKey } = await workspaceOf(args)
        const sessionId = typeof args?.sessionId === 'string' && args.sessionId !== '' ? args.sessionId : undefined
        const cfg = await config.effective(scopeKey, sessionId)
        if (!cfg.enabled) return { ok: false, error: '主动记忆已关闭，整理不会运行', code: 'disabled' }
        // 模型路由：优先用这个会话正在用的那个；没有就靠 `evolution.model` 或上次记下的路由。
        const route = sessionId ? deps.cold?.()?.routeOf(sessionId) ?? null : null
        const out = await dreamer.dream(cfg, route)
        if (out.ok) runtime.invalidate()
        return out
      } catch (e) {
        return { ok: false, error: message(e), code: 'dream-failed' }
      }
    },

    /** 草案清单 + 上次整理 / 体检时间（界面顶部那块）。 */
    'evolution-dreams': async (args: any) => {
      const dreamer = deps.dream?.()
      if (!dreamer) return { ok: false, error: '整理器尚未接线', code: 'no-dream' }
      try {
        const limit = typeof args?.limit === 'number' && args.limit > 0 ? Math.min(50, Math.floor(args.limit)) : 20
        const view = runtime.view()
        return {
          ok: true,
          drafts: await dreamer.listDrafts(limit),
          lastDreamAt: view.state.watermarks.lastDreamAt ?? null,
          lastSweepAt: view.state.watermarks.lastSweepAt ?? null,
          ...(deps.health ? { health: await deps.health() } : {}),
        }
      } catch (e) {
        return { ok: false, error: message(e), code: 'dreams-failed' }
      }
    },

    /** 读一份草案（界面渲染 diff：id → oneLine）。 */
    'evolution-dream-read': async (args: any) => {
      const dreamer = deps.dream?.()
      if (!dreamer) return { ok: false, error: '整理器尚未接线', code: 'no-dream' }
      try {
        const id = String(args?.id ?? '').trim()
        if (id === '') return { ok: false, error: 'missing id', code: 'bad-args' }
        return await dreamer.readDraft(id)
      } catch (e) {
        return { ok: false, error: message(e), code: 'dream-read-failed' }
      }
    },

    'evolution-dream-apply': async (args: any) => {
      const dreamer = deps.dream?.()
      if (!dreamer) return { ok: false, error: '整理器尚未接线', code: 'no-dream' }
      try {
        const id = String(args?.id ?? '').trim()
        if (id === '') return { ok: false, error: 'missing id', code: 'bad-args' }
        const out = await dreamer.apply(id)
        if (out.ok) runtime.invalidate()
        return out
      } catch (e) {
        return { ok: false, error: message(e), code: 'dream-apply-failed' }
      }
    },

    /**
     * 回滚一份已应用的草案。
     *
     * `force` 只在用户确认过"应用之后的新写入也会被撤销"后才传 —— 默认拒绝是为了不让
     * 一次误点把刚学会的几条一起抹掉。
     */
    'evolution-dream-revert': async (args: any) => {
      const dreamer = deps.dream?.()
      if (!dreamer) return { ok: false, error: '整理器尚未接线', code: 'no-dream' }
      try {
        const id = String(args?.id ?? '').trim()
        if (id === '') return { ok: false, error: 'missing id', code: 'bad-args' }
        const out = await dreamer.revert(id, { force: args?.force === true })
        if (out.ok) runtime.invalidate()
        return out
      } catch (e) {
        return { ok: false, error: message(e), code: 'dream-revert-failed' }
      }
    },

    /** 跑一遍维护扫描（`dry: true` 只出计划）。 */
    'evolution-maintain': async (args: any) => {
      if (!deps.sweep) return { ok: false, error: '维护扫描尚未接线', code: 'no-sweep' }
      try {
        const dry = args?.dry === true
        const report = await deps.sweep({ dry })
        if (!dry) runtime.invalidate()
        return { ok: true, ...report }
      } catch (e) {
        return { ok: false, error: message(e), code: 'maintain-failed' }
      }
    },

    /** 健康度：只读，界面每次打开记忆页都会拉一次。 */
    'evolution-health': async () => {
      if (!deps.health) return { ok: false, error: '健康度尚未接线', code: 'no-health' }
      try {
        return { ok: true, ...(await deps.health()) }
      } catch (e) {
        return { ok: false, error: message(e), code: 'health-failed' }
      }
    },

    /**
     * P4：程序性记忆清单 + 技能草案 + learned 名单。
     *
     * 一次拉全而不是让界面拼三次：这三者要画在同一块卡片上，分三次请求会出现
     * "步骤显示 3 次成功、草案却说还没验证"的中间态。
     */
    'evolution-procedures': async () => {
      if (!learner) return { ok: false, error: '自动记忆尚未启用', code: 'unavailable' }
      try {
        const view = runtime.view()
        const rows: any[] = []
        for (const e of Object.values(view.catalog.entries)) {
          if (e.kind !== 'procedure') continue
          const st = view.state.entries[e.id]
          const d: any = await learner.describe(e.id)
          const steps = st?.procedure?.steps ?? (d.ok ? parseProcedureSteps(d.body) : [])
          const successes = st?.procedure?.successes ?? 0
          const failures = st?.procedure?.failures ?? 0
          rows.push({
            id: e.id,
            title: (d.ok && d.title) || e.title || e.key,
            key: e.key,
            status: e.status,
            oneLine: e.oneLine,
            boundary: d.ok ? d.boundary : '',
            steps,
            successes,
            failures,
            canPromote: canPromotePlaybook({
              kind: e.kind, status: e.status, steps, successes,
              harmful: st?.counters?.harmful ?? 0, needsReview: st?.needsReview,
            }).ok,
            canProposeSkill: e.status === 'playbook' && steps.length >= 2,
          })
        }
        rows.sort((a, b) => Number(b.canProposeSkill) - Number(a.canProposeSkill) || b.successes - a.successes || a.id.localeCompare(b.id))
        const store = deps.procedureSkills?.() ?? null
        const skills = store ? await store.list() : { proposals: [], learned: [] }
        return { ok: true, entries: rows, proposals: skills.proposals, learned: skills.learned }
      } catch (e) {
        return { ok: false, error: message(e), code: 'procedures-failed' }
      }
    },

    /** 记一次流程执行结果。到门槛会自动升 playbook（判据在 learner.setStatus 里再过一遍）。 */
    'evolution-procedure-done': async (args: any) => {
      if (!learner) return { ok: false, error: '自动记忆尚未启用', code: 'unavailable' }
      try {
        const id = String(args?.id ?? '').trim()
        if (id === '') return { ok: false, error: 'missing id', code: 'bad-args' }
        const out = await learner.recordProcedure(id, args?.ok !== false)
        if (out.ok) runtime.invalidate()
        return out
      } catch (e) {
        return { ok: false, error: message(e), code: 'procedure-done-failed' }
      }
    },

    /** 出技能草案：只写 `evolution/procedures/*.json`，绝不碰技能目录。 */
    'evolution-skill-propose': async (args: any) => {
      const store = deps.procedureSkills?.() ?? null
      if (!store) return { ok: false, error: '技能提议尚未接线', code: 'no-store' }
      try {
        const prepared = await procedureInputOf(String(args?.id ?? '').trim())
        if (!prepared.ok) return { ok: false, error: prepared.error, code: 'bad-procedure' }
        return await store.propose(prepared.input)
      } catch (e) {
        return { ok: false, error: message(e), code: 'skill-propose-failed' }
      }
    },

    /**
     * 生成技能：`confirm` 必须由界面确认卡给出。写后 lint + 不在清单里就回滚，
     * 失败原因原样返回（界面要解释"为什么没生成"）。
     */
    'evolution-skill-apply': async (args: any) => {
      const store = deps.procedureSkills?.() ?? null
      if (!store) return { ok: false, error: '技能提议尚未接线', code: 'no-store' }
      try {
        const out = await store.apply(String(args?.name ?? '').trim(), args?.confirm === true)
        if (out.ok) runtime.invalidate()
        return out
      } catch (e) {
        return { ok: false, error: message(e), code: 'skill-apply-failed' }
      }
    },

    /** 回滚：把本功能生成的技能移进回收站（可恢复），并摘掉 learned 徽章。 */
    'evolution-skill-rollback': async (args: any) => {
      const store = deps.procedureSkills?.() ?? null
      if (!store) return { ok: false, error: '技能提议尚未接线', code: 'no-store' }
      try {
        const out = await store.rollback(String(args?.name ?? '').trim())
        if (out.ok) runtime.invalidate()
        return out
      } catch (e) {
        return { ok: false, error: message(e), code: 'skill-rollback-failed' }
      }
    },

    /** 技能页的「learned」徽章。没接线时返回空名单，不让整个技能页报错。 */
    'evolution-learned-skills': async () => {
      const store = deps.procedureSkills?.() ?? null
      if (!store) return { ok: true, skills: [] }
      try {
        return { ok: true, skills: await store.learned() }
      } catch (e) {
        return { ok: false, error: message(e), code: 'learned-failed' }
      }
    },
  }
}
