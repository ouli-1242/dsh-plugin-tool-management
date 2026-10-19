// 场景域的 model 工具（2026-09-23 从记忆族分出来；同日补上 `_switch` 与 `_list`）：
// `scene_manager_list` → `_switch` → `_save`。**注册顺序就是兼容页「模型工具表」的显示顺序**
// （`tools/table.ts` 刻意不定义第二份排序），这一族按其余四族同形的排法排：先查、再拨开关、
// 最后写定义 —— 场景族补上这两条时是照"先建后切"的语义顺序注册的，成了五族里唯一的例外。
//
// 为什么单独一族而不是塞进 `memory_manager_save`：场景与记忆是两个对象 —— 场景是**容器**
// （进入时按档案切换 mcp / 技能 / 人设，其余全部关掉），记忆是**内容**（按场景组织、吃注入
// 预算）。合成一条工具会让 `description` 变成双义参数、门禁按参数分叉，而这两件事的失败
// 形状都是静默的。
//
// 为什么有 `scene_manager_list`（2026-09-23 用户裁定：「记忆就管记忆，场景就管场景」）：
// 场景清单此前挂在 `memory_manager_list` 的输出末尾（它最初解释的是"这条记忆为什么没被注入"，
// 0.14.x 那次把档案也并进去时明确写过"不加新工具、不加新 op"）。省下那 106 tok/轮的代价是
// **引用方向反了** —— 场景族两条工具都要模型去调记忆族的工具看现状，而工具表可以单独关掉
// `memory_manager_list`（`tools/table.ts`），关掉后 `_switch` 描述里那句"照抄它打印的场景名"
// 就悬空了。六个注入域里也只有场景没有自己的 list。
//
// 数据源没变，仍然是 `rules-list` 的 `scenes` + `scene-mode-get` 的档案，**没有新 op**。
//
// 写侧为什么是两条、而不是一条带 `action` 的：
//   · `_save` 只写**定义**（场景记录 + 档案），不改变现在；
//   · `_switch` 改的是**现在**（进入 = 六处开关一起动 + 收窄注入 + 改写 AGENTS.md）。
// 危险度差一档，回执要说的事也完全不同。0.14.0 当初把「启用与进入」整个留在界面，
// 理由是"那是改运行时环境的动作"；补上 `_switch` 的取舍记在 CHANGELOG 里 —— 要点是
// **场景段的动作句仍然不加回来**：「上下文注入只给现在是什么」是同一天定下的原则，
// 不因为多了一条工具就破例（工具描述本来就是写"什么时候该用它"的地方）。

import { text, toolNameList, type ToolDomainDeps } from './deps.js'
import { FACTORY_TOOL_TABLE_PRESET } from './table.js'

export interface SceneToolDeps extends ToolDomainDeps {
  /** rules service 的 ops 表：`rules-list`（场景行）/ `rules-create-scene`（幂等 upsert）。 */
  rulesOps: Record<string, (args: any) => Promise<any>>
  /**
   * 场景档案引擎的 ops 表：scene-mode-get（读当前档案）/ scene-archive-save / scene-mode-set。
   *
   * `_list` 与 `_save` 读的都是 `scene-mode-get` 那一份 `{archives, mode, active}`：档案是
   * 场景域自己的现状（进入时开哪些东西），`rules-list` 的场景行里没有它。
   */
  archiveOps: Record<string, (args: any) => Promise<any>>
  /**
   * 启用集合的写入（`rules-set-active`）。
   *
   * ⚠️ **必须传 handlers 表里那一份包装过的**（index.ts 里由 `buildSceneSyncOps` 覆盖）：
   * 「场景绑定的预设正文写进 `~/.dsh/AGENTS.md`、退出时恢复进场景前的基线」这一步在包装里，
   * 直调 `memoriesService.ops['rules-set-active']` 会**静默漏掉它** —— 场景切过去了，
   * 全局提示词还是上一份，而回执看起来完全成功。
   */
  sceneActivate: (args: any) => Promise<any>
}

/** 档案里由模型设置的段（`memories` 段在 P5 已废弃，不再是档案的一部分）。
 *  `mcpNotes`（0.20.0）与其余三段同族：整段替换、段缺席 = 不碰这一域。 */
const ARCHIVE_SECTIONS = ['mcp', 'mcpNotes', 'skills', 'subagents'] as const

/** 段里的名单：数组段是名字列表，`mcp` 段是 serverName → `'*'` | 工具名数组。段缺席 = 空。 */
function segmentNames(value: any): string[] {
  if (Array.isArray(value)) return value.map((x) => String(x))
  if (value && typeof value === 'object') return Object.keys(value)
  return []
}

/**
 * `quickPrompts` 入参 → 档案值：去空、去重、保序（与 op 侧 `quickPromptsArg` 同一口径）。
 *
 * ⚠️ 空数组是**合法值**（= 进入后全部停用），不能在这里被当成"没给"滤掉 —— 它与
 * "这一域不碰"（段缺席）是两句相反的话（见 `SceneArchive.quickPrompts` 的注释）。
 */
function quickPromptIds(value: any): string[] {
  const out: string[] = []
  for (const item of Array.isArray(value) ? value : []) {
    const id = String(item == null ? '' : item).trim()
    if (id && out.indexOf(id) < 0) out.push(id)
  }
  return out
}

/**
 * 档案里绑的工具表方案 → 给人读的那一句。`factory-default` 是个哨兵值而不是本机存过的方案，
 * 原样打出来模型会去找一份叫这个名字的方案（`_save` 那边也没有这一栏，它改不了）。
 */
function toolTableLabel(name: unknown): string {
  const v = typeof name === 'string' ? name.trim() : ''
  if (!v) return ''
  return v === FACTORY_TOOL_TABLE_PRESET ? 'factory default' : v
}

/**
 * 一个档案的名单渲染（`_list` 用）。**点名而不是只给数量**：模型要判断"这个场景进入时会不会
 * 关掉它正用的那台服务器"，数量答不了这一句。`mcpNotes` 是档案里的备注覆盖，单独列一项。
 */
function archiveText(archive: any): string {
  if (!archive || typeof archive !== 'object') return 'not created (entering turns off all MCP / skill / persona domains)'
  const keys = (v: any): string[] => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : [])
  const list = (v: any): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : [])
  const parts = [
    'MCP ' + toolNameList(keys(archive.mcp)),
    'skills ' + toolNameList(list(archive.skills)),
    'personas ' + toolNameList(list(archive.subagents)),
  ]
  const notes = keys(archive.mcpNotes)
  if (notes.length) parts.push('notes ' + toolNameList(notes))
  // 模型工具表方案（0.15.0 起档案里有这一栏）：进入时换的是**模型自己能用什么**，不报就是
  // 让它事后发现自己少了工具却说不出原因。只给方案名 —— 关停名单不在档案里，硬算要多读一次
  // 方案清单，而真正需要条数的时机是切换之后（那条回执有）。没绑就不冒这一格（与备注同口径）。
  const tt = toolTableLabel(archive.toolTablePreset)
  if (tt) parts.push('tool-table preset "' + tt + '"')
  // 快捷提示词绑定（0.20.0）：进了这个场景会动到 `/` 菜单里哪些条目，不报就只能靠猜。
  // 空表是"进入后全部停用"，与"没绑"（这一域不碰）是两句相反的话，不能压成一个 "0 条"。
  //
  // 印 **id 而不是条数**（2026-10-15）：`scene_manager_save.quickPrompts` 的描述让模型
  // "copy them from a scene binding in the listing" —— 而此前这里只印「N 条」，清单里根本
  // 没有 id 可抄，那句是一条**指不到的死路**（模型照做只会白跑一趟，然后去问用户）。
  // 与 `skills` / `subagents` 两段同款（那两段本来就是 `toolNameList` 印名字）。
  const qp = archive.quickPrompts
  if (Array.isArray(qp)) parts.push(qp.length ? 'quick prompts ' + toolNameList(qp) : 'quick prompts: all off after entering')
  return parts.join(' ｜ ')
}

/**
 * 一个档案段的 before → after：`mcp 2 项 → 1 项（-B）`。
 *
 * 为什么按"项"而不是按"值"比：`mcp` 段的值可以是 `'*'`（整台）或工具名数组，值层面的收窄
 * （`A: '*'` → `A: ['read']`）**名字没变但含义变了** —— 那种情况单独标一句"勾选范围有调整"，
 * 不硬塞进 +/- 名单里（否则一个名字完全没变的段会显得像动过名单）。
 */
function segmentDiff(key: string, beforeValue: any, afterValue: any): { text: string; dropped: string[] } {
  const b = segmentNames(beforeValue)
  const a = segmentNames(afterValue)
  const dropped = b.filter((n) => a.indexOf(n) < 0)
  const added = a.filter((n) => b.indexOf(n) < 0)
  const marks: string[] = []
  if (added.length) marks.push('+' + toolNameList(added))
  if (dropped.length) marks.push('-' + toolNameList(dropped))
  if (!marks.length && JSON.stringify(beforeValue ?? null) !== JSON.stringify(afterValue ?? null)) marks.push('the checked set changed')
  return {
    text: key + ' ' + b.length + ' -> ' + a.length + ' items' + (marks.length ? ' (' + marks.join(' ') + ')' : ''),
    dropped,
  }
}

/**
 * `withSync` 产物（`agentsMd`）的一行回执：切换场景会**改写 `~/.dsh/AGENTS.md`** ——
 * 这是本插件唯一会动那个文件的动作，不写出来的话"提示词没跟着换"是静默的
 * （场景切过去了、全局基线还是上一份，模型只会以为自己已经在新场景里）。
 *
 * 探测不到 / 什么都没做（`unchanged`）就不占行：那两种情况下文件确实没变，
 * 说一句"没变"只是噪音。
 *
 * `baselineError`（0.21.2 补齐）：切进去了**但退不回来** —— 场景提示词已写进 AGENTS.md，
 * 而"进场景之前那份基线"没能落盘。此前这一支在客户端有（45-scenes.js 的
 * `scenes.agents.note.baselineLost`）、工具回执里没有，于是模型侧唯一能看到的版本是
 * "切成功了"。它比 `error` 更该说：文件已经改了，只是没有退路。
 *
 * `snapshotMissing`（0.21.2 补齐）：**模式快照丢了**，退出场景只能落盘模式位、运行时
 * （MCP / 技能 / 人设 / 工具表）回不来。客户端有计划卡上的同款文案
 * （`scenes.exit.noSnapshot`），工具回执此前同样没有 —— 模型只能看到"已退出"。
 */
function agentsMdNote(sync: any, action?: string): string {
  if (!sync || typeof sync !== 'object') return ''
  const notes: string[] = []
  if (sync.error) notes.push('\nWARN: the global baseline (AGENTS.md) was not synced: ' + String(sync.error))
  if (sync.applied) notes.push('\nAGENTS.md <- the scene-bound preset "' + String(sync.applied) + '"')
  if (sync.restored === true) notes.push('\nAGENTS.md <- restored the pre-scene baseline')
  if (sync.baselineError) {
    notes.push('\nWARN: AGENTS.md was switched, but the pre-scene baseline could not be saved ('
      + String(sync.baselineError) + ') — leaving this scene will NOT restore your previous global prompt.'
      + ' The multi-generation backups under __last-applied__/AGENTS.md.bak-* still hold earlier copies.')
  }
  if (action === 'exit' && sync.snapshotMissing === true) {
    notes.push('\nWARN: no mode snapshot was recorded for the scene that was left — the runtime'
      + ' (MCP servers / skills / personas / tool table) was NOT rolled back; only the mode bit was cleared.')
  }
  return notes.join('')
}

export function buildSceneTools(deps: SceneToolDeps): void {
  const { defineTool, register } = deps
  register(defineTool({
    name: 'scene_manager_list',
    // 只读、无参数：场景是几十个名字而不是几千条条目，没有分页的必要，也没有"默认只看启用的"
    // 这种筛选（未启用的场景照样要能被进入，藏着只会让模型以为它不存在）。
    // 描述与参数说明里**不点名同族工具**（scene_manager_list / _switch / _save 三条都在出厂
    // 默认的隐藏名单里）：静态文本没法按 toolVisible 改写，点名一条模型没有的工具只会让它
    // 白跑一趟。要说"去哪看"就用中性说法（the scene listing / the "Current scene" reminder
    // —— 后者是常驻源，只要场景域开着就在）。点名只留在**运行时回执**里、按可见性分叉。
    description: 'List every scene with its archive (what entering it switches on: MCP servers, skills, personas, quick prompts, and the bound model tool-table scheme when there is one), bound prompt preset, memory count and enabled / entered / locked state. The scene currently entered is also shown in the "Current scene" reminder.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute() {
      const r: any = await deps.rulesOps['rules-list']({})
      if (!r || r.ok === false) throw new Error((r && r.error) || 'failed to read scenes')
      // 档案与「已进入哪个场景」要额外读一次（纯读盘，`scene-mode-get`）。
      // 读不到**不阻断**清单：场景行退化成只有名字与启用状态，而不是让整条工具失败 ——
      // 一份少了档案的清单仍然有用，一次失败什么都没有。
      // `archives = null` 是"没读到"，与"读到了但某个场景没建档案"是两件事：混成一份会让
      // 每个场景都印出「档案：未建（进入时三个域全部停用）」，那是一次读盘失败的**假话**。
      let archives: Record<string, any> | null = {}
      let entered: string | null = null
      try {
        const a: any = await deps.archiveOps['scene-mode-get']({})
        if (a && a.ok !== false) {
          archives = a.archives && typeof a.archives === 'object' ? a.archives : {}
          entered = a.mode && a.mode.scene ? String(a.mode.scene) : null
        } else {
          archives = null
        }
      } catch { archives = null /* 见上：降级为"没有档案信息" */ }
      const scenes: any[] = r.scenes || []
      const lines = scenes.map((s: any) => {
        const name = String(s.name)
        const state = [s.active === true ? 'on' : 'off']
        // 「启用」与「进入」是两个独立状态轴（见 README「进/出模式」），只报前者的话，
        // 模型会把"启用着"读成"现在就是它" —— 而记忆与提示词只按**进入**的那一个注入。
        if (entered !== null && name === entered) state.push('entered')
        if (s.locked === true) state.push('locked')
        // 打**场景名**而不是 label：`scene_manager_save` / `_switch` 要的都是名字（单个
        // 路径段），label 只是界面显示名。两者不同时把 label 放进括号，别让模型照抄错那个。
        const title = name + (s.label && String(s.label) !== name ? ' (' + String(s.label) + ')' : '')
        const bits = ['- ' + title + ' [' + state.join(', ') + '] · memories: ' + Number(s.count || 0)]
        if (s.description) bits.push('description: ' + String(s.description))
        if (s.prompt) bits.push('preset: ' + String(s.prompt))
        bits.push('archive: ' + (archives === null ? 'unreadable (does not mean absent)' : archiveText(archives[name])))
        return bits.join(' · ')
      })
      return 'scenes (' + scenes.length + ' · ' +
        (r.activeMode === 'all' ? 'the enabled set is the historical default (all enabled)' : 'the enabled set is narrowed to a single scene') +
        (entered === null ? '; no scene is entered right now' : '; currently entered: "' + entered + '"') + '):\n' +
        (lines.join('\n') || '(no scenes)')
    },
  }))

  register(defineTool({
    name: 'scene_manager_switch',
    // 为什么 `action` 是必填枚举而不是一个布尔：与 `mcp_manager_switch` 同一条理由 ——
    // 让模型在 enter / exit 两个动词里选一个，比让它猜"scene 传 null 是什么意思"省一次往返。
    // 参数里刻意不出现 `null`：那是 op（`scene-mode-set`）的形态，模型照着填只会填错。
    description: 'Enter a scene, or leave the one currently entered. Entering switches on its archive and everything else off, narrows injection to its memories, and applies its bound prompt preset to AGENTS.md. Leaving restores the runtime snapshot taken on entry. Only when the user asks or approves.',
    parameters: {
      action: { type: 'string', required: true, enum: ['enter', 'exit'], description: 'enter = switch to the scene named in `scene`; exit = leave the current one (no scene needed).' },
      scene: { type: 'string', description: 'Scene name (one path segment), required for enter. Use the exact name, not the display label — the scene listing and the "Current scene" reminder both print names.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any) {
      const action = String((args && args.action) || '')
      if (action !== 'enter' && action !== 'exit') {
        throw new Error('action must be enter / exit (got: ' + (action || '(empty)') + ')')
      }
      // 刻意**不过** `lockedSceneGuard()`：场景**自身**的启停不在冻结清单里（冻结的是五个
      // 域的内容）。锁定中的场景正被进入时不能退出 —— 那条守卫在 `scene-mode-set` 的包装里
      // （index.ts），它以 ok:false 返回，下面如实抛出去。

      let scene = ''
      if (action === 'enter') {
        scene = String((args && args.scene) || '').trim()
        if (scene === '') throw new Error('action=enter needs scene: the scene name (copy it from the scene_manager_list line)')
        // 场景名是**单个路径段**（与 scene_manager_save 同一条校验、同一句报错）。
        if (scene.indexOf('/') >= 0 || scene.indexOf('\\') >= 0) {
          throw new Error('a scene name is a single path segment (no / or \\): ' + scene)
        }
      }

      // 先读一次"现在在哪个场景"：用来在回执里说清是"从 A 换到 B"还是"本来就在 B"。
      // 读不到不算失败 —— 下面 `scene-mode-set` 自己会校验场景是否存在。
      let before: string | null = null
      try {
        const g: any = await deps.archiveOps['scene-mode-get']({})
        if (g && g.ok !== false) before = g.mode && g.mode.scene ? String(g.mode.scene) : null
      } catch { /* 见上 */ }

      // 两轴齐动，与界面「进入场景」/「退出模式」逐字同一条路径（45-scenes.js 的 enterMode /
      // exitMode）：`scene-mode-set` 只动运行时快照与 mode 位，**启用集合**由
      // `rules-set-active` 写。少调后者，记忆与提示词仍按旧场景注入 —— 而运行时看起来已经切了。
      const mode: any = await deps.archiveOps['scene-mode-set']({ scene: action === 'enter' ? scene : null })
      if (!mode || mode.ok === false) throw new Error((mode && mode.error) || (action === 'enter' ? 'failed to enter the scene: ' + scene : 'failed to exit the scene'))
      const act: any = await deps.sceneActivate({ scenes: action === 'enter' ? [scene] : [] })
      if (!act || act.ok === false) {
        // 半成品状态：运行时已经切了，启用集合没跟上。**必须说出来** —— 不说的话模型以为
        // 切完了，而记忆与提示词还是旧场景的。重试一次是安全的（两个 op 都幂等）。
        throw new Error(
          (action === 'enter' ? 'runtime switched to scene "' + scene + '"' : 'runtime left the scene') +
          ', but the enabled set was not written (memories and prompts still inject per the old scene): ' + ((act && act.error) || 'unknown error') +
          ' — retry scene_manager_switch once (both ops are idempotent)',
        )
      }

      // 回执：说清"从哪到哪 + 实际切了几台 / 几个来源 + 工具表换到哪一份 + 有没有键被丢弃 + AGENTS.md 那一步"。
      // 都是界面会如实报的同一批事实（`memory.result.modeSet` / `modeSwitched` / `archive.stale`），
      // 少报一项，模型就会以为那次切换"完全干净"。
      // 「这次到底动没动」两个方向判的不是同一个值：进入看 `applied`（目标就是当前场景时引擎早退，
      // `applied` 为 null），而**成功退出也回 `applied:null`** —— 拿它当判据会把每一次退出报成
      // 「already in scene「」」。引擎只在真的退掉一个场景时回 `restored`，退出按它判。
      const sw = (mode && mode.switched) || {}
      const count = (v: any): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
      const noop = action === 'enter'
        ? (mode.applied === null || mode.applied === undefined)
        : !mode.restored
      const head = noop
        ? (action === 'enter' ? 'OK: already in scene "' + scene + '"' : 'OK: not in any scene (nothing to leave)')
        : action === 'enter'
          ? 'OK: ' + (before === null ? 'entered' : 'left "' + before + '", entered ') + 'scene "' + scene + '"'
          : 'OK: left the scene "' + (before || '') + '"'
      const parts: string[] = []
      if (count(sw.mcpServers) || count(sw.skillSources)) {
        parts.push('switched ' + count(sw.mcpServers) + ' MCP server(s) / ' + count(sw.skillSources) + ' skill source(s)')
      }
      // 工具表这一档改的就是模型自己能用什么：不报，它只会发现自己少了（或多回）几条工具却说不出
      // 原因，用户问"刚才改了什么"时拿回去的就是半截话。引擎只在**名单真的换了**时才回方案名。
      const tt = toolTableLabel(mode && mode.toolTablePreset)
      if (tt) {
        parts.push('tool table switched to preset "' + tt + '" (' + count(sw.toolTableHidden) + ' hidden)')
      } else if (action === 'exit' && mode.restored && mode.restored.toolTable === true) {
        parts.push('tool table restored from the pre-scene snapshot')
      }
      if (Array.isArray(mode.stale) && mode.stale.length) {
        parts.push('dropped keys this machine does not have: ' + mode.stale.join(', '))
      }
      // `snapshotMissing` 从模式侧带过来：`act` 是启用集合那次调用的产物，本身没有它，
      // 而"退出时快照丢了"这件事只有模式引擎知道（见 archive-engine.ts 的 scene-mode-set）。
      // 进 / 退两个方向都报 —— 进场景时它说的是"你即将进入一个退不出来的场景"。
      const snapshotMissing = mode && mode.exit && mode.exit.snapshotMissing === true
      return head + (parts.length ? ' · ' + parts.join(' · ') : '')
        + agentsMdNote(act.agentsMd, snapshotMissing ? action : undefined) +
        (noop ? '\n(' + (action === 'enter' ? 'already in the target scene' : 'already outside every scene') + ' — runtime unchanged)' : '')
    },
  }))

  register(defineTool({
    name: 'scene_manager_save',
    // 「写入指引」保留（"写成指令而不是备注"—— 这是场景说明质量的杠杆），但不再声称
    // "注入后模型会被要求照办"：2026-09-23 定稿把场景段的授权语删了（注入只陈述现状），
    // 参数说明与注入侧各说各话时，模型信的那份是错的。改为如实说明去向。
    description: 'Save a scene — a named bundle the user enters: entering it switches on exactly what its archive lists (MCP servers, scene-level MCP note overrides, skills, personas, quick prompts, and the model tool table when a scheme is bound) and everything else off. Creates it if absent, else updates it. An archive section you give replaces that section whole — include what should stay; the receipt reports what got displaced. Saving does not enter it; entering is a separate action. Only on the user\'s instruction.',
    parameters: {
      scene: { type: 'string', required: true, description: 'Scene name (one path segment, ≤64 chars, no / \\ or < > : " | ? *, not `_shared`). Created if absent.' },
      label: { type: 'string', description: 'Display name for this scene. Omit = keep.' },
      description: { type: 'string', description: 'What this scene is for; shown beside the scene name in the "Current scene" reminder while the scene is on — write an instruction, not a note. Omit = keep.' },
      // 与下面 `mcp` / `skills` / `subagents` 同一句式（"Omit = keep; X = 一个都不"）：
      // 界面 2026-10-10 补了「无」这个选项，工具侧的空串语义要跟着说清，否则模型只知道
      // 「省略 = 保持」，不知道还有一条「解绑」的路。
      prompt: { type: 'string', description: 'Prompt preset id to bind; while this scene is on it is the global baseline. Omit = keep; \'\' = bind none (this scene leaves AGENTS.md alone).' },
      // 模型工具表方案绑定（0.20.0 补上模型侧入口：0.15.0 起界面可绑、档案里一直有这一栏，
      // `_list` / `_switch` 也读它，唯独 `_save` 写不了）。'' = 解绑只能走
      // `rules-update-scene` —— `scene-archive-save` 对载荷里**不带的栏**一律保留现值
      // （archive-engine 的「不带 ≠ 解绑」），所以解绑与设置分成两条路，见 execute 的 ②。
      // 哨兵 `factory-default` 与界面下拉同值（tools/table.ts 的 FACTORY_TOOL_TABLE_PRESET）；
      // 不存在的方案名由引擎按 stale 丢弃并在进入时报告，op 不硬拒（与悬空绑定同口径）。
      toolTablePreset: { type: 'string', description: "Model tool-table scheme to bind while this scene is on. Omit = keep; '' = unbind (the scene leaves the tool table alone); 'factory-default' = the factory default; otherwise the name of a scheme saved in the panel. An unknown name is dropped and reported." },
      // 快捷提示词绑定（0.20.0）。段语义与上面三个档案段相反：**空数组是合法值**
      // （进入后全部停用），不是"清除这一段"。本工具不提供解绑（界面可解）—— 与
      // mcp / skills / subagents 三段没有解绑参数同一条口径。id 从场景清单里别的场景的
      // 绑定、或用户口述里来；不存在的 id 被引擎丢弃并在回执报出来。
      quickPrompts: { type: 'array', items: { type: 'string' }, description: 'Quick-prompt ids to switch on when this scene is entered; every other one is switched off, and the pre-entry state is restored on exit. Omit = keep; [] = switch all off on entry. Unknown ids are dropped and reported — copy them from a scene binding in the listing, or ask the user.' },
      mcp: {
        type: 'object',
        // 官方要求对象类型**显式声明开放性**（`additionalProperties` 是必需字段，且只能是
        // boolean）—— 嵌套对象不允许带 schema，所以值的形状（`'*'` 还是工具名数组）只能在
        // 描述里说清。这不是偷懒：键是服务器名，本身是动态的。
        additionalProperties: true,
        description: "Archive: serverName -> '*' (whole server) or a list of tool names to leave on. Omit = keep; {} = switch none on.",
      },
      // 场景级 MCP 备注覆盖（0.20.0）：进入这个场景时用这份盖掉全局备注，退出时还原。
      // 与 mcp 段同一句式（省略 = 保持；{} = 一个都不覆盖）—— 界面存档编辑器早就能改，
      // `_list` 也显示它，`_save` 此前不接这一段。
      mcpNotes: {
        type: 'object',
        additionalProperties: true,
        description: "Archive: serverName -> note that overrides that server's global note while this scene is on (the global note comes back on exit). Omit = keep; {} = drop every scene-level override.",
      },
      skills: { type: 'array', items: { type: 'string' }, description: 'Archive: skill keys `<root>/<name>` to switch on. Omit = keep; [] = switch none on.' },
      subagents: { type: 'array', items: { type: 'string' }, description: 'Archive: persona names to switch on. Omit = keep; [] = switch none on.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any) {
      const blocked = await deps.lockedSceneGuard()
      if (blocked) throw new Error(blocked)
      const scene = String((args && args.scene) || '').trim()
      if (scene === '') throw new Error('missing argument: scene (the scene name)')
      // 场景名是**单个路径段**（界面把场景当一级列表展示，场景名就是 `memories/<场景>/` 那级
      // 目录名）。`rules-create-scene` 会做完整校验，但档案那条路不经过它 —— 这里先挡一次，
      // 报错也更贴模型要的东西（它要的是"这个名字不行"，不是内部规则）。
      if (scene.indexOf('/') >= 0 || scene.indexOf('\\') >= 0) {
        throw new Error('a scene name is a single path segment (no / or \\): ' + scene)
      }

      // ① 场景记录：`rules-create-scene` 本身是**幂等 upsert**（已存在则更新描述/标签/绑定的
      //    预设，不报错），所以不必先查再分建/改 —— 与记忆 save 的"有则改、无则建"同一口径。
      //    总是调它：模型给 scene + 档案段而场景还不存在时，这一步把场景建出来，否则
      //    `scene-archive-save` 会以"场景不存在"拒绝。
      const payload: any = { name: scene }
      const touchedRecord: string[] = []
      if (args.label !== undefined) { payload.label = String(args.label); touchedRecord.push('label') }
      if (args.description !== undefined) { payload.description = String(args.description); touchedRecord.push('description') }
      if (args.prompt !== undefined) { payload.prompt = String(args.prompt); touchedRecord.push('prompt') }
      const created: any = await deps.rulesOps['rules-create-scene'](payload)
      if (!created || created.ok === false) throw new Error((created && created.error) || 'failed to save the scene')

      // ② 两处「解绑」只能走 `rules-update-scene`：`scene-archive-save` 对载荷里**不带的栏**
      //    一律保留现值（archive-engine 的「不带 ≠ 解绑」），从现值复制出来的合并档案会把
      //    刚解掉的绑定又写回去 —— 所以解绑与设置分成两条路，合并前还要先摘掉刚解掉的键。
      //    · `prompt` 的 '' 此前也走不到实处 —— `rules-create-scene` 的 upsert 分支把空串
      //      当"没给"（ops/scene-records.ts），旧绑定原样保留而回执报"已更新"。
      //    · `toolTablePreset` 的 '' 同解（那个 op 的更新分支认空串 = 解绑）。
      const clearPrompt = args.prompt !== undefined && String(args.prompt).trim() === ''
      const unbindToolTable = args.toolTablePreset !== undefined && String(args.toolTablePreset).trim() === ''
      const setToolTable = args.toolTablePreset !== undefined && String(args.toolTablePreset).trim() !== ''
      const setQuickPrompts = args.quickPrompts !== undefined
      if (setQuickPrompts && !Array.isArray(args.quickPrompts)) {
        throw new Error('quickPrompts must be an array of ids ([] = turn them all off on entry; unbinding is a manual step in the panel, not offered here)')
      }
      const touched = ARCHIVE_SECTIONS.filter((k) => (args as Record<string, unknown>)[k] !== undefined)
      const mustWriteArchive = touched.length > 0 || setToolTable || setQuickPrompts
      // 档案现状在读的时候就取一次，且必须在 ② **之前** —— 解绑落盘后这一栏已经没了，
      // 回执的「X → 解绑」要的是解绑前的那个 X。只为看回执的 diff 而读时（解绑且不写档案）
      // 容忍读失败：那一步已经写成功了，别为一句对比话把整次调用判失败。
      let before: any = {}
      let beforeKnown = false
      if (mustWriteArchive || unbindToolTable) {
        const cur: any = await deps.archiveOps['scene-mode-get']({})
        if (!cur || cur.ok === false) {
          if (mustWriteArchive) throw new Error((cur && cur.error) || 'failed to read the scene archive')
        } else {
          before = (cur.archives || {})[scene] || {}
          beforeKnown = true
        }
      }
      let clearWarn = ''
      if (clearPrompt || unbindToolTable) {
        const upd: any = { name: scene }
        if (clearPrompt) upd.prompt = ''
        if (unbindToolTable) upd.toolTablePreset = ''
        const u: any = await deps.rulesOps['rules-update-scene'](upd)
        if (!u || u.ok === false) {
          // 主路径已成功、解绑没写上：如实报，别让回执假装绑定已经没了。
          clearWarn = '\nWARN: the unbind was not written (' + ((u && u.error) || 'unknown error') + '); the old binding still applies'
        }
      }

      // ③ 档案 read-modify-write：段（mcp / mcpNotes / skills / subagents）与两个绑定栏的
      //    「设置」方向合并成一份，只经 `scene-archive-save` 一条路落盘。
      //    **必须 read-modify-write**：`scene-archive-save` 是**整份替换**，只把模型给的段
      //    传过去，没给的段会被静默清掉 —— 与 0.14.0 里 `subagent_manager_save` 省略字段被
      //    清空同一形状，只是这次清掉的是"这个场景进入时要开哪些东西"。
      //    注意段语义：**段不存在 = 不限制（全部照常）**，段存在但为空 = 全部停用。所以模型给
      //    `mcp: {}` 得到的是"全不勾"，不是"清除该段" —— 后者只能靠不给。
      //    `quickPrompts` 与三段都不同：段缺席 = 这一域不碰，空数组 = 进入后全部停用。
      let archiveNote = ''
      let toolTableNote = ''
      let quickNote = ''
      let warnTail = ''
      if (mustWriteArchive) {
        const archive: any = { ...before }
        for (const k of touched) archive[k] = (args as any)[k]
        if (unbindToolTable) delete archive.toolTablePreset
        if (setToolTable) archive.toolTablePreset = String(args.toolTablePreset).trim()
        if (setQuickPrompts) archive.quickPrompts = quickPromptIds(args.quickPrompts)
        const r: any = await deps.archiveOps['scene-archive-save']({ scene, archive })
        if (!r || r.ok === false) throw new Error((r && r.error) || 'failed to save the scene archive')
        // 回执必须回显**这一次替换挤掉了什么**。整段替换本身是对的（省略的段不填回就会被
        // 静默清掉，所以"模型给什么就是什么"），但"给出去的段盖掉了原来的勾选"是**静默**的
        // —— 不写出来，模型只会看到一句"档案段：mcp"，以为只是加了一项。
        const diffs = touched.map((k) => segmentDiff(k, before[k], (args as any)[k]))
        if (diffs.length) {
          archiveNote = 'archive segments: ' + diffs.map((d) => d.text).join('; ')
          if (diffs.some((d) => d.dropped.length > 0)) {
            warnTail += '\nnote: these segments are replaced as a whole; entries marked "-" above were dropped. To keep them, include them in this same call.'
          }
        }
        // 当前环境里不存在的键会被 op 丢弃并报告（改名或删除留下的，含工具表方案名与
        // 快捷提示词 id）：如实说，否则模型以为勾上了而实际没有。
        if (r.stale && r.stale.length) warnTail += '\n(dropped keys the current environment does not have: ' + r.stale.join(', ') + ')'
        // 存盘成功但应用到运行时失败：`scene-archive-save` 对"正是当前模式的那个场景"会就地
        // 重应用，失败不回滚档案。如实报出去，别假装生效了（与界面同口径）。
        if (r.applyError) warnTail += '\n(saved, but applying it to the runtime failed: ' + r.applyError + ')'
      }
      // 解绑写失败了就别输出「X → 解绑」—— 上面那句 WARN 才是事实；设置方向不受 ② 影响。
      if (args.toolTablePreset !== undefined && !(unbindToolTable && clearWarn !== '')) {
        toolTableNote = beforeKnown
          ? 'tool-table preset: ' + (toolTableLabel(before.toolTablePreset) || 'unbound') + ' -> ' +
            (unbindToolTable ? 'unbind' : toolTableLabel(String(args.toolTablePreset).trim()))
          : 'tool-table preset: unbound (the current archive is unreadable, no diff available)'
      }
      if (setQuickPrompts && beforeKnown) {
        const beforeIds: string[] = Array.isArray(before.quickPrompts) ? before.quickPrompts.map((x: unknown) => String(x)) : []
        const afterIds = quickPromptIds(args.quickPrompts)
        const added = afterIds.filter((id) => beforeIds.indexOf(id) < 0)
        const dropped = beforeIds.filter((id) => afterIds.indexOf(id) < 0)
        const marks: string[] = []
        if (added.length) marks.push('+' + toolNameList(added))
        if (dropped.length) marks.push('-' + toolNameList(dropped))
        quickNote = 'quick prompts: ' + beforeIds.length + ' -> ' + afterIds.length + ' ids' +
          (afterIds.length === 0 ? ' (all off after entering)' : '') +
          (marks.length ? ' (' + marks.join(' ') + ')' : '')
      }

      // 收敛提示：`rules-create-scene` 在"历史默认（全部启用）"状态下会把启用集合收窄成
      // 单选（`collapseActiveForNewScene`）—— 那是一次**会改变运行时**的动作，必须说出来。
      // 界面上同样如实报（`scenes.result.created.collapsed`）。
      const collapsed = created.collapsedActive === true
      const parts: string[] = [touchedRecord.length ? 'scene record updated (' + touchedRecord.join(', ') + ')' : 'scene existence ensured']
      if (archiveNote) parts.push(archiveNote)
      if (toolTableNote) parts.push(toolTableNote)
      if (quickNote) parts.push(quickNote)
      // 点名 scene_manager_switch 的那句按可见性分叉（它在出厂默认名单里就是关着的）：
      // 部分启用（开 save 不开 switch）时指向一条模型没有的工具，只会让它白跑一趟 ——
      // 与 mcp/skill 的 listHint 同一条纪律。
      const enterHint = deps.toolVisible('scene_manager_switch')
        ? 'To take effect, enter it with scene_manager_switch.'
        : 'To take effect, the user has to enter this scene manually (scene_manager_switch is not available in this session).'
      return 'OK: scene "' + scene + '"' + parts.join('; ') + warnTail + clearWarn +
        (collapsed
          ? '\nnote: every scene was enabled until now (the historical all-enabled default); this call narrowed the enabled set to one scene, and the new one is not it — the user should confirm the enabled state.'
          : '') +
        '\nSaving does not change the runtime: ' + enterHint
    },
  }))
}
