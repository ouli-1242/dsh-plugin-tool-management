// 场景联动的 op 重包层：改名要把场景档案与运行时快照里的旧名跟着改，进/退场景要把人设开关、
// 工具目录与 MCP 状态段立刻重算，模式门禁要在退出前查一次场景锁。
//
// 正文从 index.ts 的 apply 闭包里整段搬来，一字未改（只去一层缩进，并把七个 apply 作用域
// 名字改成走 deps —— moved-verify 按这三类容差机检，容差之外任何一字不同都会报错）。
//
// 为什么这一层包在 op 表上而不是散进各个 op：这些联动跨的是**多个 service**（人设改名要动
// 档案服务的索引、快捷提示词改名要动人设服务的开关），任何一侧自己都不知道对面叫什么。
// 重包是**就地替换** `service.ops[...]`，所以传出去的是那几个 service 对象本身。
import type { createArchiveEngine } from './memories/archive-engine.js'
import type { createMemoriesService } from './memories/service.js'
import type { buildQuickPromptOps } from './ops/quick-prompts.js'
import type { createSubagentCatalog } from './subagents/catalog.js'
import type { createSubagentService } from './subagents/service.js'

export interface SceneLinkageDeps {
  /** 读档案切片 / 逐场景增量写 / 改索引里的 mode 段。 */
  memoriesService: ReturnType<typeof createMemoriesService>
  subagentService: ReturnType<typeof createSubagentService>
  archiveService: ReturnType<typeof createArchiveEngine>
  quickPromptOps: ReturnType<typeof buildQuickPromptOps>
  /** 人设目录段：改名与开关联动之后都要立即重算，别等 1s TTL。 */
  subagentCatalog: { refresh(): Promise<unknown> }
  /** MCP 域（进/退场景会改服务器启停与场景备注，状态段必须跟着重算）。 */
  mcp: { stateCatalog: { refresh(): Promise<unknown> } }
  /** 场景锁的名单查询 —— apply 里排在**后面**，所以调用点给的是 getter（见 index.ts）。 */
  lockedSceneNames(): Promise<string[]>
}

export function installSceneLinkage(deps: SceneLinkageDeps): void {
  /**
   * 人设改名后同步场景绑定：场景档案的 `subagents` 名单存的是**人设名**，
   * 不跟着改就会留一个悬空引用（界面把它报成 stale，用户看到「人设不存在」却找不到地方改）。
   * 绑定存在 memories-index.json 里，人设服务看不到它，所以在这一层补一次（同提示词改名的做法）。
   */
  async function rebindSubagentInArchives(from: string, to: string): Promise<number> {
    try {
      const slice = await deps.memoriesService.readArchiveSlice()
      const touched: Record<string, any> = {}
      for (const [scene, archive] of Object.entries(slice.archives || {})) {
        const list = (archive as { subagents?: unknown }).subagents
        if (!Array.isArray(list) || !list.includes(from)) continue
        touched[scene] = { ...(archive as Record<string, unknown>), subagents: list.map((n) => (n === from ? to : n)) } as typeof archive
      }
      const names = Object.keys(touched)
      // 逐场景增量（审查 P2-3）：此前整表回写，会把窗口期里别人保存的**别的场景**档案抹掉。
      for (const scene of names) await deps.memoriesService.saveArchive(scene, touched[scene])
      return names.length
    } catch {
      return 0
    }
  }
  /**
   * 人设改名后同步运行时快照（F-025）：退出还原按 `subagentsAll` 逐名走，快照里
   * 还留着旧名的话，退出会「旧名静默跳过、新名不还原」—— 被改名的人设停留在
   * 场景期间状态。快照在进入场景时拍、改名发生在进入后，只能在改名时跟着改。
   */
  async function renameSubagentInSnapshot(from: string, to: string): Promise<void> {
    try {
      const slice: any = await deps.memoriesService.readArchiveSlice()
      const mode: any = slice && slice.mode
      const snapshot: any = mode && mode.snapshot
      if (!snapshot) return
      let changed = false
      const next: any = { ...snapshot }
      if (snapshot.subagentsAll && Object.prototype.hasOwnProperty.call(snapshot.subagentsAll, from)) {
        const all: any = {}
        for (const [k, v] of Object.entries(snapshot.subagentsAll)) {
          all[k === from ? to : k] = v
          if (k === from) changed = true
        }
        next.subagentsAll = all
      }
      for (const field of ['subagents', 'subagentsOn']) {
        const list = snapshot[field]
        if (Array.isArray(list) && list.includes(from)) {
          next[field] = list.map((n: any) => (n === from ? to : n))
          changed = true
        }
      }
      if (changed) await deps.memoriesService.patchIndex({ mode: { ...mode, snapshot: next } })
    } catch { /* 快照同步失败不阻断改名本身；残留与修复前一致 */ }
  }
  const baseSubagentUpdate = deps.subagentService.ops['subagent-update']
  if (typeof baseSubagentUpdate === 'function') {
    deps.subagentService.ops['subagent-update'] = async (args: any) => {
      const res: any = await baseSubagentUpdate(args)
      if (res && res.ok !== false && res.renamedFrom) {
        const from = String(res.renamedFrom)
        const to = String(res.name)
        void rebindSubagentInArchives(from, to)
        void renameSubagentInSnapshot(from, to)
      }
      return res
    }
  }
  /**
   * 快捷提示词改名后同步场景档案（与人设改名那两条同一件事）：档案里存的还是旧 id 的话，
   * 下一次进场景它会被当成 stale 丢掉 —— 用户看到的就成了"改了个名字，场景里的勾选悄悄没了"，
   * 而且那条快捷词还会在进场景时被停用（它不在勾选集里了）。
   */
  async function rebindQuickPromptInArchives(from: string, to: string): Promise<void> {
    try {
      const slice = await deps.memoriesService.readArchiveSlice()
      const touched: Array<[string, any]> = []
      for (const [scene, archive] of Object.entries(slice.archives || {})) {
        const list = (archive as { quickPrompts?: unknown }).quickPrompts
        if (!Array.isArray(list) || !list.includes(from)) continue
        touched.push([scene, { ...(archive as Record<string, unknown>), quickPrompts: list.map((n) => (n === from ? to : n)) }])
      }
      // 逐场景增量写（与审查 P2-3 同一条口径）：整表回写会抹掉窗口期里别人存的别的场景。
      for (const [scene, next] of touched) await deps.memoriesService.saveArchive(scene, next)
    } catch { /* 同步失败不阻断改名本身；残留由档案保存时的 stale 清理兜住 */ }
  }
  const baseQuickPromptUpdate = deps.quickPromptOps['quickprompt-update']
  if (typeof baseQuickPromptUpdate === 'function') {
    deps.quickPromptOps['quickprompt-update'] = async (args: any) => {
      const res: any = await baseQuickPromptUpdate(args)
      if (res && res.ok !== false && res.renamedFrom) void rebindQuickPromptInArchives(String(res.renamedFrom), String(res.id))
      return res
    }
  }
  // 模式切换会改人设开关（进入=启用勾选的，退出=按快照停回）——目录段立即重算，
  // 别等 1s TTL：切完场景紧接着的下一轮请求就该看到新名单。
  const baseSceneModeSet = deps.archiveService.ops['scene-mode-set']
  if (typeof baseSceneModeSet === 'function') {
    deps.archiveService.ops['scene-mode-set'] = async (args: any) => {
      // 锁定的场景不能关闭（用户裁定）：退出模式（scene=null）和切换到别的场景
      // 都意味着先退出当前模式 —— 当前模式场景处于锁定状态时一律拒绝。
      // 目标就是当前场景 = 无操作，放行（引擎自己会 early-return）。
      try {
        const slice = await deps.memoriesService.readArchiveSlice()
        const current = slice.mode && slice.mode.scene
        if (current && args && 'scene' in (args || {})) {
          const target = args.scene == null ? null : String(args.scene).trim() || null
          if (target !== current) {
            const locked = await deps.lockedSceneNames()
            if (locked.includes(current)) {
              return { ok: false, error: `场景「${current}」已锁定：先解锁再关闭` }
            }
          }
        }
      } catch { /* 守卫读状态失败不拦正常流程（引擎自身校验兜底） */ }
      const res: any = await baseSceneModeSet(args)
      if (res && res.ok !== false) {
        // 进/退/切换模式会改 MCP 启停（服务器级）与备注（场景备注覆盖/恢复），
        // 状态段必须立即重算 —— 场景退出后下一次请求就该看到恢复的全局备注与启停。
        void deps.subagentCatalog.refresh().catch(() => { /* 同上 */ })
        void deps.mcp.stateCatalog.refresh().catch(() => { /* 同上 */ })
      }
      return res
    }
  }
  /**
   * 模式进行中保存当前场景的档案时，联动人设开关：**档案 = 这个场景开着的人设**
   * （与进入场景时同一口径，见 archive-engine）——
   *   新勾进来的立即启用，并追加进快照的「退出时停回」名单；
   *   取消勾选的立即停用；其中「进场景前就开着」的那些追加进快照的「退出时开回」名单
   *   （在停回名单里的说明是本次进场景才打开的，退出本来就该关，不进开回名单）。
   */
  const baseSceneArchiveSave = deps.archiveService.ops['scene-archive-save']
  if (typeof baseSceneArchiveSave === 'function') {
    deps.archiveService.ops['scene-archive-save'] = async (args: any) => {
      const res: any = await baseSceneArchiveSave(args)
      try {
        const bound = res && res.ok !== false && res.archive && Array.isArray(res.archive.subagents) ? res.archive.subagents as string[] : []
        const slice = await deps.memoriesService.readArchiveSlice()
        const mode = slice.mode
        if (mode && mode.scene === res.scene) {
          const every = (await deps.subagentService.list()).map((p) => p.name)
          const unbound = every.filter((n) => bound.indexOf(n) < 0)
          const toOn = await deps.subagentService.enabledStore.disabledAmong(bound)
          const toOff = await deps.subagentService.enabledStore.enabledAmong(unbound)
          if (toOn.length) await deps.subagentService.enabledStore.setEnabled(toOn, true)
          if (toOff.length) await deps.subagentService.enabledStore.setEnabled(toOff, false)
          if (toOn.length || toOff.length) void deps.subagentCatalog.refresh()
          const snapshot = mode.snapshot
          // 新快照带**全量映射**（`subagentsAll`，v0.9.1）→ 退出按映射逐个精确还原，这两个
          // 部分名单不再需要，也不再往新快照里写（老快照没有映射，仍然照旧维护，见
          // archive-engine 的 restoreSnapshot 兼容分支）。
          if (snapshot && !snapshot.subagentsAll && (toOn.length || toOff.length)) {
            const backOn = Array.isArray(snapshot.subagents) ? snapshot.subagents.slice() : []
            const offList = Array.isArray(snapshot.subagentsOn) ? snapshot.subagentsOn.slice() : []
            for (const n of toOn) if (backOn.indexOf(n) < 0) backOn.push(n)
            for (const n of toOff) if (backOn.indexOf(n) < 0 && offList.indexOf(n) < 0) offList.push(n)
            await deps.memoriesService.patchIndex({ mode: { ...mode, snapshot: { ...snapshot, subagents: backOn, subagentsOn: offList } } })
          }
        }
      } catch { /* 联动失败不阻断档案保存本身；开关会在下次进/退模式时对齐 */ }
      return res
    }
  }
}
