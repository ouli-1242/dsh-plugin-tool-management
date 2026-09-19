// AGENTS.md / 提示词预设域的 HTTP ops（2026-09-19 从 index.ts 的 handlers 表抽出）。
//
// 与 ops/compat.ts 同一条纪律：只负责 op 实现，依赖显式传参；MCP 写后刷新、场景锁定守卫
// 仍作用在组装后的整张表上（见 index.ts）。

import type { createPromptsService } from '../prompts/service.js'
import type { createScenePromptSync } from '../scene-prompt-sync.js'

type PromptsServiceLike = ReturnType<typeof createPromptsService>
type ScenePromptSyncLike = ReturnType<typeof createScenePromptSync>

export interface PromptOpsDeps {
  /** 预设库服务（../prompts/service.ts）。 */
  promptsService: PromptsServiceLike
  /** 场景 ↔ 全局基线同步器：refs() 出引用清单，withSync() 写回基线。 */
  scenePromptSync: ScenePromptSyncLike
  /** rules 域的两个 op：list 查场景绑定、rebind-prompt 在改名时改绑定。 */
  rulesOps: {
    'rules-list'(args: any): Promise<any>
    'rules-rebind-prompt'(args: any): Promise<any>
  }
  applyPresetGuarded(id: string): Promise<any>
  withAgentsMdSync(res: any): Promise<any>
  promptRefReason(ref: { kind?: string; label?: string; active?: boolean }): string
  /** 引用探测失败的告警出口（宿主 logger 可能为 undefined，所以不直接依赖 ctx）。 */
  warn(message: string): void
}

export function buildPromptOps(deps: PromptOpsDeps): Record<string, (args: any) => Promise<any>> {
  return {
    // 提示词预设库（由 ../prompts/service.ts 提供）。这里把两件事对齐成用户看到的一份状态：
    //   - `active`（界面「生效中」）= **当前真正在起作用的基线**：启用的场景绑了预设就是它，
    //     否则才看文件比对（预设正文 == ~/.dsh/AGENTS.md）。用户裁定：「场景启动了，
    //     提示词页生效中的应该是场景选择的那个」。
    //   - `fileApplied` = 文件比对结果（AGENTS.md 里确实是它）。两者同时为真说明
    //     场景绑的就是已应用的那份，正文一致时宿主不会再注入第二遍（去重）。
    'agentsmd-list': async () => {
      const base = await deps.promptsService.list()
      if (!base || base.ok === false) return base
      let scenePrompt: { scene: string | null; label?: string | null; presetId: string | null; missing: boolean; duplicate?: boolean; bytes: number } | undefined
      try {
        const r: any = await deps.rulesOps['rules-list']({})
        if (r && r.ok && r.scenePrompt) scenePrompt = r.scenePrompt
      } catch { /* 场景服务不可用 → 只回预设库 */ }
      const sceneId = scenePrompt && !scenePrompt.missing && scenePrompt.scene ? scenePrompt.presetId : null
      // 场景驱动时**只有场景绑的那份**算生效中（用户裁定）；文件里那份降级为「文件里是它」，
      // 因为场景的提示词已经接管基线。没有场景驱动时才按文件比对定「生效中」。
      const sceneDrives = sceneId !== null
      // 引用清单与删除保护同源（scene-prompt-sync）：界面据此禁用删除并说明「谁在用」，
      // 不必自己再拼一遍判定（那正是这次四处状态各说各话的根源）。探测失败 = 空清单。
      const refs = await deps.scenePromptSync.refs()
      const presets = base.presets.map((p) => {
        const fileApplied = p.active === true
        const byScene = sceneDrives && sceneId === p.id
        const active = sceneDrives ? byScene : fileApplied
        return {
          ...p,
          active,
          fileApplied,
          activeVia: byScene ? 'scene' : (active && fileApplied ? 'file' : null),
          refs: refs ? refs.get(p.id) || [] : [],
        }
      })
      return { ...base, presets, ...(scenePrompt ? { scenePrompt } : {}) }
    },
    'agentsmd-read': (args: any) => deps.promptsService.read(String((args && args.id) || '')),
    // content 与 from 都可选：新建弹窗里直接写正文（content），或从现有预设复制（from）。
    'agentsmd-create': (args: any) => deps.promptsService.create(String((args && args.id) || ''), {
      ...(args && args.from ? { from: String(args.from) } : {}),
      ...(args && typeof args.content === 'string' ? { content: String(args.content) } : {}),
      ...(args && typeof args.description === 'string' ? { description: String(args.description) } : {}),
    }),
    // 保存：改正文 + 可选改名（nextId）。改名成功顺带把场景绑定一起改名 ——
    // 绑定存在 memories-index.json 里，预设库自己看不到，不叫这一声就会留悬空绑定。
    // 保存后同步一次全局基线：若改的正是「正在驱动基线的那份」，正文要跟着写进
    // `~/.dsh/AGENTS.md`（否则页面标着「生效中」而文件里还是旧内容）。
    'agentsmd-update': async (args: any) => {
      const res = await deps.promptsService.update(
        String((args && args.id) || ''),
        String((args && args.content) ?? ''),
        args && args.nextId !== undefined ? String(args.nextId) : undefined,
        // 描述与正文同一次提交：省略（undefined）= 不动，空串 = 清空。
        args && typeof args.description === 'string' ? String(args.description) : undefined,
      )
      if (!res || res.ok === false) return res
      let renamed: any = {}
      if (res.renamedFrom) {
        try {
          const r: any = await deps.rulesOps['rules-rebind-prompt']({ from: res.renamedFrom, to: res.id })
          renamed = r && r.ok ? { reboundScenes: r.changed } : {}
        } catch { /* 改名同步失败不影响保存本身 */ }
      }
      return deps.withAgentsMdSync({ ...res, ...renamed })
    },
    // 应用 = 写全局基线文件；场景接管期间只放行「场景绑定的那一份」（见 applyPresetGuarded）。
    'agentsmd-apply': (args: any) => deps.applyPresetGuarded(String((args && args.id) || '')),
    'agentsmd-get-current': () => deps.promptsService.getCurrent(),
    // 删除：**被引用的那份一律拒绝**（用户裁定，2026-09-16 扩到引用清单）。三类引用：
    // 场景绑定（含恒常的 `_shared` / `global`）、`~/.dsh/AGENTS.md` 的当前内容、
    // 进场景前保存的基线（退出场景后要恢复的那一份）。拒绝时逐条说明「谁在用」，
    // 用户知道该先改哪里。引用清单由 scene-prompt-sync 与显示/注入同源算出。
    // 探测失败（refs() 返回 null）时放行并记 warn：删预设不动 ~/.dsh/AGENTS.md，
    // 最坏是少一份副本，可重建 —— 不因一次探测故障把删除堵死。
    'agentsmd-remove': async (args: any) => {
      const id = String((args && args.id) || '')
      const refs = await deps.scenePromptSync.refs()
      if (refs === null) deps.warn('prompts: reference probe failed; remove allowed')
      const why = refs ? refs.get(id) || [] : []
      if (why.length) {
        const refsText = why.map(deps.promptRefReason).join('；')
        return {
          ok: false,
          code: 'error.agentsMd.referenced',
          error: `「${id}」仍被引用，不能删除：${refsText}。先改掉引用（换绑提示词 / 退出场景 / 应用别的预设）再删除。`,
          params: { id, refs: refsText },
        }
      }
      return deps.promptsService.remove(id)
    },
    'agentsmd-import': (args: any) => deps.promptsService.importPreset(String((args && args.id) || ''), String((args && args.content) ?? ''), args && typeof args.description === 'string' ? String(args.description) : undefined),
    // 提示词预设的回收站：删预设 = 把整个预设目录移入 `hub/trash/prompts-trash/<id>/`，
    // 误删可从「提示词」页的回收站里恢复（同 id 已存在时拒绝恢复，绝不覆盖）。
    'agentsmd-trash-list': () => deps.promptsService.trashList(),
    // 恢复也要同步：把一个「场景绑定着、但曾被删掉」的预设恢复回来 → 绑定重新变活，
    // 基线要跟着写回它（否则场景页说「生效中：它」而文件里并不是）。
    'agentsmd-trash-restore': async (args: any) => deps.withAgentsMdSync(await deps.promptsService.trashRestore(String((args && args.id) || ''))),
    'agentsmd-trash-delete': (args: any) => deps.promptsService.trashDelete(String((args && args.id) || '')),
  }
}
