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

/** 档案里由模型设置的三个段（`memories` 段在 P5 已废弃，不再是档案的一部分）。 */
const ARCHIVE_SECTIONS = ['mcp', 'skills', 'subagents'] as const

/** 段里的名单：数组段是名字列表，`mcp` 段是 serverName → `'*'` | 工具名数组。段缺席 = 空。 */
function segmentNames(value: any): string[] {
  if (Array.isArray(value)) return value.map((x) => String(x))
  if (value && typeof value === 'object') return Object.keys(value)
  return []
}

/**
 * 一个档案的名单渲染（`_list` 用）。**点名而不是只给数量**：模型要判断"这个场景进入时会不会
 * 关掉它正用的那台服务器"，数量答不了这一句。`mcpNotes` 是档案里的备注覆盖，单独列一项。
 */
function archiveText(archive: any): string {
  if (!archive || typeof archive !== 'object') return '未建（进入时 MCP / 技能 / 人设 三个域全部停用）'
  const keys = (v: any): string[] => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : [])
  const list = (v: any): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : [])
  const parts = [
    'MCP ' + toolNameList(keys(archive.mcp)),
    '技能 ' + toolNameList(list(archive.skills)),
    '人设 ' + toolNameList(list(archive.subagents)),
  ]
  const notes = keys(archive.mcpNotes)
  if (notes.length) parts.push('备注 ' + toolNameList(notes))
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
  if (!marks.length && JSON.stringify(beforeValue ?? null) !== JSON.stringify(afterValue ?? null)) marks.push('勾选范围有调整')
  return {
    text: key + ' ' + b.length + ' 项 → ' + a.length + ' 项' + (marks.length ? '（' + marks.join(' ') + '）' : ''),
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
 */
function agentsMdNote(sync: any): string {
  if (!sync || typeof sync !== 'object') return ''
  if (sync.error) return '\nWARN: 全局基线（AGENTS.md）未同步：' + String(sync.error)
  if (sync.applied) return '\nAGENTS.md ← 场景绑定的预设「' + String(sync.applied) + '」'
  if (sync.restored === true) return '\nAGENTS.md ← 已恢复进场景前的基线'
  return ''
}

export function buildSceneTools(deps: SceneToolDeps): void {
  const { defineTool, register } = deps
  register(defineTool({
    name: 'scene_manager_list',
    // 只读、无参数：场景是几十个名字而不是几千条条目，没有分页的必要，也没有"默认只看启用的"
    // 这种筛选（未启用的场景照样要能被进入，藏着只会让模型以为它不存在）。
    // 描述与参数说明里**不点名同族工具**（scene_manager_list / _switch / _save 三条都在出厂
    // 默认的隐藏名单里）：静态文本没法按 toolVisible 改写，点名一条模型没有的工具只会让它
    // 白跑一趟。要说"去哪看"就用中性说法（the scene listing / the「本机当前的场景」reminder
    // —— 后者是常驻源，只要场景域开着就在）。点名只留在**运行时回执**里、按可见性分叉。
    description: 'List every scene with its archive (what entering it switches on), bound prompt preset, memory count and enabled / entered / locked state. Read the archive here before saving a scene: a section you give later replaces it whole. Read-only; the scene in effect now is also the「本机当前的场景」reminder.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute() {
      const r: any = await deps.rulesOps['rules-list']({})
      if (!r || r.ok === false) throw new Error((r && r.error) || '读取场景失败')
      // 档案与「当前进入的是哪个」要额外读一次（纯读盘，`scene-mode-get`）。
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
        const state = [s.active === true ? '启用' : '未启用']
        // 「启用」与「进入」是两个独立状态轴（见 README「进/出模式」），只报前者的话，
        // 模型会把"启用着"读成"现在就是它" —— 而记忆与提示词只按**进入**的那一个注入。
        if (entered !== null && name === entered) state.push('已进入')
        if (s.locked === true) state.push('已锁定')
        // 打**场景名**而不是 label：`scene_manager_save` / `_switch` 要的都是名字（单个
        // 路径段），label 只是界面显示名。两者不同时把 label 放进括号，别让模型照抄错那个。
        const title = name + (s.label && String(s.label) !== name ? '（' + String(s.label) + '）' : '')
        const bits = ['- ' + title + ' [' + state.join('·') + '] · 记忆 ' + Number(s.count || 0) + ' 条']
        if (s.description) bits.push('说明：' + String(s.description))
        if (s.prompt) bits.push('预设：' + String(s.prompt))
        bits.push('档案：' + (archives === null ? '读不到（不代表没建）' : archiveText(archives[name])))
        return bits.join(' · ')
      })
      return '场景（' + scenes.length + ' 个 · ' +
        (r.activeMode === 'all' ? '启用集为历史默认（全部启用）' : '启用集已收窄为单选') +
        (entered === null ? '；当前没有进入任何场景' : '；当前已进入「' + entered + '」') + '）：\n' +
        (lines.join('\n') || '(无场景)')
    },
  }))

  register(defineTool({
    name: 'scene_manager_switch',
    // 为什么 `action` 是必填枚举而不是一个布尔：与 `mcp_manager_switch` 同一条理由 ——
    // 让模型在 enter / exit 两个动词里选一个，比让它猜"scene 传 null 是什么意思"省一次往返。
    // 参数里刻意不出现 `null`：那是 op（`scene-mode-set`）的形态，模型照着填只会填错。
    description: 'Enter a scene, or leave the one currently entered. Entering switches on exactly what its archive lists and everything else off, narrows injection to its memories, and applies its bound prompt preset to AGENTS.md. Leaving restores the runtime snapshot taken on entry. Check the scene\'s archive in the scene listing before entering. Only when the user asks or approves.',
    parameters: {
      action: { type: 'string', required: true, enum: ['enter', 'exit'], description: 'enter = switch to the scene named in `scene`; exit = leave the current one (no scene needed).' },
      scene: { type: 'string', description: 'Scene name (one path segment), required for enter. Use the exact name, not the display label — the scene listing and the「本机当前的场景」reminder both print names.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any) {
      const action = String((args && args.action) || '')
      if (action !== 'enter' && action !== 'exit') {
        throw new Error('action 只能是 enter / exit（收到：' + (action || '(空)') + '）')
      }
      // 刻意**不过** `lockedSceneGuard()`：场景**自身**的启停不在冻结清单里（冻结的是五个
      // 域的内容）。锁定中的场景正被进入时不能退出 —— 那条守卫在 `scene-mode-set` 的包装里
      // （index.ts），它以 ok:false 返回，下面如实抛出去。

      let scene = ''
      if (action === 'enter') {
        scene = String((args && args.scene) || '').trim()
        if (scene === '') throw new Error('action=enter 需要 scene：场景名（照抄 scene_manager_list 里那一行）')
        // 场景名是**单个路径段**（与 scene_manager_save 同一条校验、同一句报错）。
        if (scene.indexOf('/') >= 0 || scene.indexOf('\\') >= 0) {
          throw new Error('场景名是单个路径段，不能含 / 或 \\：' + scene)
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
      if (!mode || mode.ok === false) throw new Error((mode && mode.error) || (action === 'enter' ? '进入场景失败：' + scene : '退出场景失败'))
      const act: any = await deps.sceneActivate({ scenes: action === 'enter' ? [scene] : [] })
      if (!act || act.ok === false) {
        // 半成品状态：运行时已经切了，启用集合没跟上。**必须说出来** —— 不说的话模型以为
        // 切完了，而记忆与提示词还是旧场景的。重试一次是安全的（两个 op 都幂等）。
        throw new Error(
          (action === 'enter' ? '场景「' + scene + '」的运行时已切换' : '运行时已退出场景') +
          '，但启用集合未写入（记忆与提示词仍按旧场景注入）：' + ((act && act.error) || '未知错误') +
          ' —— 重试一次 scene_manager_switch 即可（两个 op 都幂等）',
        )
      }

      // 回执：说清"从哪到哪 + 实际切了几台 / 几个来源 + 有没有键被丢弃 + AGENTS.md 那一步"。
      // 都是界面会如实报的同一批事实（`memory.result.modeSet` / `modeSwitched` / `archive.stale`），
      // 少报一项，模型就会以为那次切换"完全干净"。
      const noop = mode.applied === null || mode.applied === undefined
      const head = noop
        ? 'OK: already in scene「' + scene + '」'
        : action === 'enter'
          ? 'OK: ' + (before === null ? 'entered' : '「' + before + '」→') + ' scene「' + scene + '」'
          : 'OK: left the scene' + (before === null ? '' : '「' + before + '」')
      const sw = (mode && mode.switched) || {}
      const count = (v: any): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
      const parts: string[] = []
      if (count(sw.mcpServers) || count(sw.skillSources)) {
        parts.push('switched ' + count(sw.mcpServers) + ' MCP server(s) / ' + count(sw.skillSources) + ' skill source(s)')
      }
      if (Array.isArray(mode.stale) && mode.stale.length) {
        parts.push('丢弃了本机不存在的键：' + mode.stale.join('、'))
      }
      return head + (parts.length ? ' · ' + parts.join(' · ') : '') + agentsMdNote(act.agentsMd) +
        (noop ? '\n（目标就是当前场景，运行时没有改动）' : '')
    },
  }))

  register(defineTool({
    name: 'scene_manager_save',
    // 「写入指引」保留（"写成指令而不是备注"—— 这是场景说明质量的杠杆），但不再声称
    // "注入后模型会被要求照办"：2026-09-23 定稿把场景段的授权语删了（注入只陈述现状），
    // 参数说明与注入侧各说各话时，模型信的那份是错的。改为如实说明去向。
    description: 'Save a scene — a named bundle the user enters: entering it switches on exactly what its archive lists and everything else off. Creates it if absent, else updates it. An archive section you give replaces that section whole — include what should stay; the receipt reports what got displaced. Saving does not enter it; entering is a separate action. Only on the user\'s instruction.',
    parameters: {
      scene: { type: 'string', required: true, description: 'Scene name (one path segment, no slashes). Created if absent.' },
      label: { type: 'string', description: 'Display name shown in the UI. Omit = keep.' },
      description: { type: 'string', description: 'What this scene is for; shown beside the scene name in the「本机当前的场景」reminder while the scene is on — write an instruction, not a note. Omit = keep.' },
      prompt: { type: 'string', description: 'Prompt preset id to bind; while this scene is on it is the global baseline. Omit = keep.' },
      mcp: {
        type: 'object',
        // 官方要求对象类型**显式声明开放性**（`additionalProperties` 是必需字段，且只能是
        // boolean）—— 嵌套对象不允许带 schema，所以值的形状（`'*'` 还是工具名数组）只能在
        // 描述里说清。这不是偷懒：键是服务器名，本身是动态的。
        additionalProperties: true,
        description: "Archive: serverName -> '*' (whole server) or a list of tool names to leave on. Omit = keep; {} = switch none on.",
      },
      skills: { type: 'array', items: { type: 'string' }, description: 'Archive: skill keys `<root>/<name>` to switch on. Omit = keep; [] = switch none on.' },
      subagents: { type: 'array', items: { type: 'string' }, description: 'Archive: persona names to switch on. Omit = keep; [] = switch none on.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any) {
      const blocked = await deps.lockedSceneGuard()
      if (blocked) throw new Error(blocked)
      const scene = String((args && args.scene) || '').trim()
      if (scene === '') throw new Error('缺少参数：scene 是场景名')
      // 场景名是**单个路径段**（界面把场景当一级列表展示，场景名就是 `memories/<场景>/` 那级
      // 目录名）。`rules-create-scene` 会做完整校验，但档案那条路不经过它 —— 这里先挡一次，
      // 报错也更贴模型要的东西（它要的是"这个名字不行"，不是内部规则）。
      if (scene.indexOf('/') >= 0 || scene.indexOf('\\') >= 0) {
        throw new Error('场景名是单个路径段，不能含 / 或 \\：' + scene)
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
      if (!created || created.ok === false) throw new Error((created && created.error) || '保存场景失败')

      // ② 档案三段。**必须 read-modify-write**：`scene-archive-save` 是**整份替换**
      //    （`slice.archives[scene] = archive`），只把模型给的段传过去，没给的段会被静默
      //    清掉 —— 与 0.14.0 里 `subagent_manager_save` 省略字段被清空同一形状，只是这次
      //    清掉的是"这个场景进入时要开哪些东西"。
      //    注意档案的段语义：**段不存在 = 不限制（全部照常）**，段存在但为空 = 全部停用。
      //    所以模型给 `mcp: {}` 得到的是"全不勾"，不是"清除该段" —— 后者只能靠不给。
      const touched = ARCHIVE_SECTIONS.filter((k) => (args as Record<string, unknown>)[k] !== undefined)
      let archiveNote = ''
      if (touched.length) {
        const cur: any = await deps.archiveOps['scene-mode-get']({})
        if (!cur || cur.ok === false) throw new Error((cur && cur.error) || '读取场景档案失败')
        const before: any = (cur.archives || {})[scene] || {}
        const archive: any = { ...before }
        for (const k of touched) archive[k] = (args as any)[k]
        const r: any = await deps.archiveOps['scene-archive-save']({ scene, archive })
        if (!r || r.ok === false) throw new Error((r && r.error) || '保存场景档案失败')
        // 回执必须回显**这一次替换挤掉了什么**。整段替换本身是对的（省略的段不填回就会被
        // 静默清掉，所以"模型给什么就是什么"），但"给出去的段盖掉了原来的勾选"是**静默**的
        // —— 不写出来，模型只会看到一句"档案段：mcp"，以为只是加了一项。
        const diffs = touched.map((k) => segmentDiff(k, before[k], (args as any)[k]))
        archiveNote = '档案段：' + diffs.map((d) => d.text).join('；')
        if (diffs.some((d) => d.dropped.length > 0)) {
          archiveNote += '\n注意：这些段是整段替换，上面标 - 的项已被挤掉；要保留就把它们一并写进这次调用。'
        }
        // 当前环境里不存在的键会被 op 丢弃并报告（改名或删除留下的）：如实说，
        // 否则模型以为勾上了而实际没有。
        if (r.stale && r.stale.length) archiveNote += '（丢弃了当前环境不存在的键：' + r.stale.join('、') + '）'
        // 存盘成功但应用到运行时失败：`scene-archive-save` 对"正是当前模式的那个场景"会就地
        // 重应用，失败不回滚档案。如实报出去，别假装生效了（与界面同口径）。
        if (r.applyError) archiveNote += '（已存盘，但应用到运行时失败：' + r.applyError + '）'
      }

      // 收敛提示：`rules-create-scene` 在"历史默认（全部启用）"状态下会把启用集合收窄成
      // 单选（`collapseActiveForNewScene`）—— 那是一次**会改变运行时**的动作，必须说出来。
      // 界面上同样如实报（`scenes.result.created.collapsed`）。
      const collapsed = created.collapsedActive === true
      const parts: string[] = [touchedRecord.length ? '场景记录已更新（' + touchedRecord.join('、') + '）' : '场景已确保存在']
      if (archiveNote) parts.push(archiveNote)
      // 点名 scene_manager_switch 的那句按可见性分叉（它在出厂默认名单里就是关着的）：
      // 部分启用（开 save 不开 switch）时指向一条模型没有的工具，只会让它白跑一趟 ——
      // 与 mcp/skill 的 listHint 同一条纪律。
      const enterHint = deps.toolVisible('scene_manager_switch')
        ? '要让它生效，用 scene_manager_switch 进入。'
        : '要让它生效，由用户在「场景」页进入。'
      return 'OK: scene「' + scene + '」' + parts.join('；') +
        (collapsed
          ? '\n注意：此前所有场景都处于启用状态（历史「全部启用」默认），本次已收窄为只启用一个，新建的这个不在其中 —— 让用户到「场景」页确认。'
          : '') +
        '\n保存不改运行时：' + enterHint
    },
  }))
}
