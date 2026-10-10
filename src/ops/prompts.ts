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
    // 取消应用 = **回到链起点**（这一串应用/取消往复开始之前的状态）：起点有内容就把
    // `__last-applied__/AGENTS.md` 写回去，起点文件不存在就把文件删掉（`removed: true`）。
    // 连续应用过 A、B 时是**一步回到起点**，不是只退一步 —— 与场景基线同一条口径
    // （见 `service.ts` 的 `backupGlobal`）。
    // 它是「生效中」那颗开关的**关**方向 —— 此前只有「应用」没有反向动作，于是「只有一份预设
    // 且它生效中」时开关关不掉、删除又被引用拦着（2026-10-10 实测反馈）。
    //
    // 用户 2026-10-10 第二次反馈「取消应用，AGENTS.md 还是存在」暴露了另一半：`backupGlobal()`
    // 原先在文件不存在时**什么都不写**，"起点不存在"因此不可恢复，取消应用恒判 noBackup，
    // 而这里给出的出路「删除这份预设」不成立（remove 不碰 AGENTS.md）。现在那个事实由
    // `__last-applied__/absent.json` 记着，删文件这一支才走得通。
    // 第三次反馈（同一天）「新建 a、b 两份提示词，启动 a，再启动 b，不启动 a 也不启动 b，
    // AGENTS.md 没有消失」则是这个标记**被后续写入抹掉**：`backupGlobal` 原先每笔都覆盖链
    // 起点槽位，第 ③ 步「应用 b」就把"起点不存在"刷成了 a 的内容。改成链起点只写一次。
    //
    // 场景驱动时**拒绝**：那时基线归场景管（生效中的是场景绑定的那一份），在这里撤销只会被
    // 下一次场景同步写回去，而且「取消应用」对场景绑定也不成立 —— 要解除得去场景页改绑定。
    'agentsmd-unapply': async () => {
      const driver = await deps.scenePromptSync.driver()
      if (driver) {
        return {
          ok: false,
          code: 'error.agentsMd.unapplyWhileScene',
          error: `场景「${driver.label}」正在驱动全局基线，不能在这里取消应用：先退出场景，或到场景页改掉它的提示词绑定。`,
          params: { scene: driver.label },
        }
      }
      const res = await deps.promptsService.unapply()
      if (res && res.ok === false) {
        // 「没有链起点」是一种**确定的**状态（不是故障）：AGENTS.md 的当前内容不是由
        // 「应用」写进去的（首次打开时播种的 default 就是这样）。单给一个 code，界面才能
        // 把出路说清楚（应用别的预设 / 直接编辑 AGENTS.md），而不是丢一句写盘失败。
        return res.noBackup ? { ok: false, code: 'error.agentsMd.noUnapplyBackup', error: res.error } : res
      }
      return res
    },
    'agentsmd-get-current': () => deps.promptsService.getCurrent(),
    // 删除：**场景绑定**与**当前应用的那份**拦得住（判据见下方注释）。拒绝时逐条说明「谁在用」，
    // 用户知道该先改哪里。引用清单由 scene-prompt-sync 与显示/注入同源算出。
    //
    // 探测**失败**时改为拒绝（2026-09-30 审查 F13）。原来的取舍是「放行并记 warn：删预设不动
    // ~/.dsh/AGENTS.md，最坏是少一份副本，可重建」—— 这对「副本」成立，对**场景态**不成立：
    // 删掉场景绑定的那一份，场景驱动会因为找不到预设而静默失效（`driver()` 返回 null），
    // 而 AGENTS.md 停在场景态，用户看到的是「没场景驱动所以什么都没做」。
    // `refs()` 返回 null 只代表**三类探测里至少一类读盘失败**（全新环境没有场景时它返回的是
    // **空表**而不是 null），所以拒绝不会堵住正常路径。文案必须说清是「探测失败」而不是
    // 「有引用」—— 否则用户会去改一堆并不存在的引用。
    'agentsmd-remove': async (args: any) => {
      const id = String((args && args.id) || '')
      const refs = await deps.scenePromptSync.refs()
      if (refs === null) {
        deps.warn('prompts: reference probe failed; remove refused')
        return {
          ok: false,
          code: 'error.agentsMd.refProbeFailed',
          error: `无法确认「${id}」是否被引用，已拒绝删除：引用探测失败（场景绑定 / AGENTS.md 当前内容 / 进场景前的基线，这三类里至少有一类没读到）。请稍后重试。`,
          params: { id },
        }
      }
      // 删除保护认两类**真依赖**（判据是「删掉它会不会让别处静默坏掉」或「会不会留下一个
      // 用户无法理解的中间态」）：
      //   ① 场景绑定 → 会静默坏掉：场景驱动靠 `presetId` 去读预设正文，读不到 `driver()`
      //      就返回 null，场景静默失效（AGENTS.md 停在场景态，用户看到的是"什么都没做"）。
      //   ② **当前应用的**那份（`file` + `applied`，见下）→ 会留下中间态：删掉之后
      //      `~/.dsh/AGENTS.md` 内容一字不变、**照旧生效**，但界面上再没有任何预设对应它。
      //      用户看到的是「我把它删了，怎么全局提示词还在？」（2026-10-10 用户反馈：
      //      「当前应用的提示词如果直接删除，AGENTS.md 还存在，当前应用的提示词应该不能删除」）。
      //      拦住并引导先「取消应用」，这一步会把文件恢复成链起点（开始应用之前的状态），
      //      之后就能删了。
      //
      // **不拦**的两类（各自都有明确的理由，别顺手加回来）：
      //   - `file` 但没有 `applied`（首次打开提示词页时自动播种出来的 default）：它内容与
      //     AGENTS.md 相同、界面标「文件里是它」，却从未发生过写入。删掉它完全合理（那只是
      //     一份副本），而**拦它就是死路** —— 那份没有链起点可回，取消应用关不掉。
      //   - `restore`（退出场景要恢复的那一份）：恢复走的是 `scene-baseline.json` 里存下的
      //     **正文**（scene-prompt-sync 的 `restore(saved.content)`），不读预设目录。
      // 2026-09-16 的裁定是三类一律拦，那条规则在「只有一份预设且它生效中」时构成**死锁**：
      // 开关关不掉（基线没有"全部不应用"这一态）、引用又解不开。现在开关能关了（取消应用），
      // 拦 ② 才有出路 —— 取消应用会把 `__applied__.json` 清成 null，`applied` 随之变 false。
      const blocking = (refs.get(id) || []).filter((r) =>
        r.kind === 'scene' || (r.kind === 'file' && r.applied === true))
      if (blocking.length) {
        const refsText = blocking.map(deps.promptRefReason).join('；')
        const hasScene = blocking.some((r) => r.kind === 'scene')
        const hasFile = blocking.some((r) => r.kind === 'file')
        const escape = [hasScene ? '到场景页换绑提示词、或退出场景' : '', hasFile ? '先点左边那颗开关「取消应用」' : ''].filter(Boolean).join('；')
        return {
          ok: false,
          code: 'error.agentsMd.referenced',
          error: `「${id}」不能删除：${refsText}。先解除引用再删 —— ${escape}。`,
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
