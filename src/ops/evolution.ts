// 主动记忆的策略 op（HTTP 层）：读三级生效值、写某一档的开关。
//
// 为什么单独一个域：这些读写不碰记忆正文（那是 `memories-*` 的职责），只碰 environment 策略。
// 混进记忆域会让"改一条记忆"和"改一个开关"共用同一个门禁，而它们的权限要求不同
// （前者要确认，后者不用）。
//
// P0 只提供开关与状态；写入管线、复习、dream 的 op 在 P1–P3 加。

import { workspaceHashOf, hasOverrides, type EvolutionConfigStore, type EvolutionOverrides, type EvolutionSettings } from '../evolution/config.js'
import { workspaceMemoryKeyOf } from '../scope/workspace-key.js'

export interface EvolutionOpDeps {
  config: EvolutionConfigStore
  message(e: unknown): string
}

/** 一档的展示形态：值 + 是否真的覆盖了字段（界面据此显示"来源"）。 */
function layerView(overrides: EvolutionOverrides | undefined) {
  return {
    defined: hasOverrides(overrides),
    values: overrides ?? {},
  }
}

export function buildEvolutionOps(deps: EvolutionOpDeps): Record<string, (args: any) => Promise<any>> {
  const { config, message } = deps

  return {
    /**
     * 读：全局值、两级覆盖、解析后的生效值、来源。
     *
     * `cwd` / `sessionId` 由调用方给：HTTP 层拿不到宿主 agent。P1 接工具面时改从 agent 取，
     * 但**层永远以真实 sid / 真实 cwd 为准**，不接受客户端伪造的"层归属"（只用于选覆盖档）。
     */
    'evolution-status': async (args: any) => {
      try {
        const cwd = typeof args?.cwd === 'string' ? args.cwd : undefined
        const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : undefined
        const scopeKey = cwd ? workspaceMemoryKeyOf(cwd) : undefined
        const global = await config.readSettings()
        const effective = await config.effective(scopeKey, sessionId)
        const workspaces = await config.readWorkspaces()
        const sessions = await config.readSessions()
        const hash = scopeKey ? workspaceHashOf(scopeKey) : undefined
        const workspaceRecord = hash ? workspaces.workspaces[hash] : undefined
        const sessionRecord = sessionId ? sessions.sessions[sessionId] : undefined
        return {
          ok: true,
          effective,
          global,
          workspace: workspaceRecord
            ? {
                hash,
                key: workspaceRecord.key,
                cwd: workspaceRecord.cwd,
                label: workspaceRecord.label,
                ...layerView(workspaceRecord.evolution),
              }
            : null,
          session: sessionRecord ? layerView(sessionRecord.evolution) : null,
          defaults: global,
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
        return { ok: true, settings: written.settings }
      } catch (e) {
        return { ok: false, error: message(e), code: 'settings-failed' }
      }
    },

    /**
     * 写某一档的开关。
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
          return { ok: true, scope, enabled }
        }
        if (scope === 'workspace') {
          const cwd = typeof args?.cwd === 'string' ? args.cwd : ''
          const scopeKey = workspaceMemoryKeyOf(cwd)
          if (!scopeKey) return { ok: false, error: '拿不到工作区路径，无法保存工作区开关', code: 'no-workspace' }
          // 保留同一档的其它覆盖字段，只换 enabled。
          const workspaces = await config.readWorkspaces()
          const prev = workspaces.workspaces[workspaceHashOf(scopeKey)]?.evolution ?? {}
          const written = await config.writeWorkspace(scopeKey, cwd, typeof args?.label === 'string' ? args.label : '', { ...prev, enabled })
          if (!written.ok) return { ok: false, error: written.error, code: 'write-failed' }
          return { ok: true, scope, enabled, hash: written.hash }
        }
        if (scope === 'session') {
          const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : ''
          if (!sessionId) return { ok: false, error: '拿不到会话 id，无法保存会话开关', code: 'no-session' }
          const sessions = await config.readSessions()
          const prev = sessions.sessions[sessionId]?.evolution ?? {}
          const written = await config.writeSession(sessionId, { ...prev, enabled })
          if (!written.ok) return { ok: false, error: written.error, code: 'write-failed' }
          return { ok: true, scope, enabled }
        }
        return { ok: false, error: 'scope 必须是 global / workspace / session', code: 'bad-args' }
      } catch (e) {
        return { ok: false, error: message(e), code: 'toggle-failed' }
      }
    },
  }
}
