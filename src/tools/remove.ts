// 删除 / 回收站族的 model 工具：五个域各一条 `*_manager_remove`。
//
// 为什么单开一族：此前模型**只能停用、不能删除** —— "把这条过时的记忆删掉"这类要求手里
// 没有出口，模型会去调 `*_switch(enabled:false)` 然后回一句"已停用"，用户以为删了。面板上
// 每个域都有删除，模型侧一条都没有。
//
// 三条纪律：
//   · **删除一律进回收站**（可恢复），与面板同一条路 —— 回执如实说"可恢复"。
//   · **不做 purge**（永久删除）：低频且不可恢复，用户要求"使用频率低的可以不要，
//     太多功能反而冗余" —— 清空回收站留给面板。
//   · `list` 是只读（不进场景冻结守卫，与 `trash-preview` 只读口径一致）；`trash` /
//     `restore` 是写，过 `lockedSceneGuard()`。
//
// 参数名统一 `id`：`trash` 时是资源标识（记忆 `<场景>/<名>`、技能名、人设名、预设 id、
// 场景名），`restore` 时是 `action=list` 给出的**回收站条目 id** —— 两种含义在描述里写清。

import type { ScopeFlagDomain } from '../scope/scope-overrides.js'
import {
  candidateNote, globalActionNote, locateSkillRoot, requireGlobalScope, scopeGlobalOnlyDesc, sessionLayerOn, text,
  toolOrNeutral, type ToolDomainDeps,
} from './deps.js'

/** 一条删除工具的域配置（纯数据，execute 逻辑共用 `runRemove`）。 */
interface RemoveCfg {
  /** 英文域名单数（进描述）。 */
  noun: string
  /** 回执里用的名词（英文，模型侧）。 */
  label: string
  /** 资源 → 回收站。 */
  trash(args: any): Promise<any>
  /** 回收站条目 → 恢复。 */
  restore(args: any): Promise<any>
  /** 列回收站：返回规范化后的条目（id = 回收站条目 id）。 */
  list(): Promise<Array<{ id: string; name: string; deletedAt?: string }>>
  /**
   * 会话覆盖域：本会话真把这一域改过时，删除回执补一句「那条开关还在」。
   * `undefined` = 该域没有会话覆盖概念（提示词）。
   */
  domain?: ScopeFlagDomain | 'scene'
  /**
   * 漏传 / 传错 `id` 时的补救：现成候选从哪儿读，读不到时退到哪儿。
   *
   * 只在这条错误路径上被调用（正常删除不会碰它）。五个域的参数名都叫 `id`，而用户
   * 口语里给的往往是"那条记忆"/"docx 那个技能"—— 模型真正缺的是**现成的叫什么**，
   * 让它再去列一次清单就是白跑一趟。
   */
  idHelp: {
    /** 列这个域清单的工具名：只在它真在模型手里时才点名（见 `toolOrNeutral`）。 */
    tool: string
    /** `tool` 不可见时的中性出口 —— 指向常驻注入段，不点名任何工具。 */
    neutral: string
    /** 候选标签（"memory ids" / "skills" …），进 `candidateNote` 的文案。 */
    label: string
    list(): Promise<string[]>
  }
}

/** 五个域各自的 op 表 + 场景删除（后者走 handlers 里带 AGENTS.md 同步的那份）。 */
export interface RemoveToolDeps extends ToolDomainDeps {
  memoryOps: Record<string, (args: any) => Promise<any>>
  skillOps: Record<string, (args: any) => Promise<any>>
  subagentOps: Record<string, (args: any) => Promise<any>>
  promptOps: Record<string, (args: any) => Promise<any>>
  sceneOps: Record<string, (args: any) => Promise<any>>
  sceneRemove: (args: any) => Promise<any>
}

/** 三个动词共用的描述骨架。 */
function removeDescription(noun: string): string {
  return 'Delete one ' + noun + ' (to the trash), restore one, or list the trash. '
    + 'Deletes are recoverable; this tool never empties the trash. '
    + 'Blocked while the active scene is locked. Only on the user\'s instruction.'
}

/** `action` 参数：三个动词 + 每个动词要哪个 `id`。 */
const ACTION_DESC = 'trash = delete the item named by `id`; restore = put back a trash entry id (from list); list = list the trash (no `id`).'

/** 删除只有全局一份（会话层没有可删的东西），四个域同一句话。 */
const REMOVE_SCOPE_DESC = scopeGlobalOnlyDesc('one machine-wide copy', 'switch it off here instead')
/**
 * 场景的变体：`REMOVE_SCOPE_DESC` 让模型「在本会话里把它关掉」，
 * 而场景根本没有「关掉」这个动作 —— `scene_manager_switch` 只有 enter / exit。照抄那一句
 * 会让模型去找一个不存在的开关，或者干脆回一句「做不到」。
 */
const REMOVE_SCOPE_DESC_SCENE = scopeGlobalOnlyDesc('the scene record and archive are machine-wide', 'exit it here with scene_manager_switch (action=exit)')

/**
 * 恢复 op 回传的**最终落盘名**。五个域把名字放在不同字段上：
 *   · 记忆 / 技能 / 人设 / 场景 → `name`（退号恢复时它是新名字，不是回收站里的原名）
 *   · 提示词预设               → `id`（预设的 id 就是它的名字）
 * 记忆还会把投影对象放在 `rule.id` 上，作为第三顺位兜底。
 *
 * 还要解一层 `data`（漏掉的那半）：技能的 op 表外面包了
 * `wrap`（`skills/service.ts:239` —— `{ ok: true, data: result }`），名字在 `r.data.name`，
 * 不在 `r.name` 上。其余四个域的 op 是扁平返回。两边都要看，否则技能域的回执仍会退回 trashId。
 */
function restoredName(r: any): string {
  const pick = (o: any): string => {
    if (!o || typeof o !== 'object') return ''
    if (typeof o.name === 'string' && o.name !== '') return o.name
    if (o.rule && typeof o.rule.id === 'string' && o.rule.id !== '') return o.rule.id
    if (typeof o.id === 'string' && o.id !== '') return o.id
    return ''
  }
  return pick(r) || pick(r && r.data)
}

/**
 * 一条删除工具的 execute：三个动词的分派与回执。
 *
 * 会话层：删除是**全局**动作 —— 技能正文、人设 `.md`、场景档案、MCP 补丁
 * 提示词预设都只有一份，没有「本会话的副本」，所以这一格的口径就是「全局动作」。
 * 所以这里不写会话层，只在**这个对话真有该域覆盖**时补一句尾注：
 * 删完之后那条会话覆盖还在（读时忽略，对账才清），不说明的话用户会以为它跟着没了。
 */
/**
 * 记忆库存在性探测：给「带斜杠的 id 传到别的域」那条错误用。
 *
 * 单独传进来而不是放进 `RemoveCfg`：五个域共用同一个实现，而它要读的是记忆域的 op。
 * 实现方必须自己吞掉失败 —— 探不到就当不是记忆 id（少说一句总好过说错）。
 */
type MemoryIdProbe = (id: string) => Promise<boolean>

async function runRemove(deps: ToolDomainDeps, cfg: RemoveCfg, args: any, agent: unknown, isMemoryId: MemoryIdProbe): Promise<string> {
  const action = String((args && args.action) || '')
  if (action !== 'trash' && action !== 'restore' && action !== 'list') {
    throw new Error('action must be trash / restore / list (got: ' + (action || '(empty)') + ')')
  }
  if (action === 'list') {
    const entries = await cfg.list()
    return entries.length
      ? 'trash: ' + entries.length + ' item(s)\n' + entries.map((e) =>
        '- ' + e.id + ' · ' + e.name + (e.deletedAt ? ' · ' + e.deletedAt : '')).join('\n')
      : 'the trash is empty.'
  }
  // 进 / 出回收站都是写：过场景冻结守卫（与面板的删除按钮同一档）。
  const blocked = await deps.lockedSceneGuard()
  if (blocked) throw new Error(blocked)
  // 会话层：`scope: "session"` 是模型**以为**自己能删本会话那一份时的错误
  // 当场纠回来。省略 / "global" 照旧走全局。五条删除都是全局动作 ——
  // 连提示词那一族也一样（提示词根本不进会话域，更没有「本会话的预设」可删）。
  requireGlobalScope(args, cfg.noun + 's', !sessionLayerOn(deps))
  const id = String((args && args.id) || '').trim()
  if (id === '') {
    // 恢复的 id 是**回收站条目 id**（与 trash 的资源标识不是一回事），指错地方最费时间 ——
    // 这一条不用候选名单，一句 `action=list` 就是正解。
    let note = ''
    let hint = ''
    if (action === 'restore') {
      note = ' A restore id is a trash entry id — action=list prints them.'
    } else {
      note = await candidateNote(cfg.idHelp.list, cfg.idHelp.label)
      // 有候选就不必再说去哪儿拿（两句叠在一起只是把错误读长一倍）；一条都读不到时才指路。
      if (note === '') {
        hint = toolOrNeutral(deps, agent, cfg.idHelp.tool, ' Call `' + cfg.idHelp.tool + '` to get one.', cfg.idHelp.neutral)
      }
    }
    throw new Error('missing argument: id (required by action=' + action + ')' + note + hint)
  }
  // 跨族误用里唯一能**确认**的一种：带斜杠的 id 落到别的域，且这个 id 确实在记忆库里。
  // 只按形状（`a/b`）判会误伤 —— 场景名与技能名都没有禁止斜杠的校验，用户起的名字里
  // 完全可能出现。所以这里读一次记忆库确认存在；读不到就当不是，宁可少说一句。
  if (action === 'trash' && cfg.domain !== 'memory' && id.indexOf('/') > 0 && await isMemoryId(id)) {
    throw new Error('"' + id + '" is a memory id (memory ids are <scene>/<name>); this tool handles ' + cfg.noun + 's.'
      + toolOrNeutral(deps, agent, 'memory_manager_remove', ' Use `memory_manager_remove` with action=trash for it.',
        ' Pass it to the memory manager instead — this one only handles ' + cfg.noun + 's.'))
  }
  const r: any = action === 'trash' ? await cfg.trash(args) : await cfg.restore(args)
  if (!r || r.ok === false) throw new Error((r && r.error) || (action === 'trash' ? 'failed to move it to the trash' : 'restore failed'))
  if (action === 'trash') {
    return 'OK: ' + cfg.label + ' "' + id + '" moved to the trash (recoverable; permanent deletion lives in the panel trash)' +
      (cfg.domain === undefined ? '' : globalActionNote(deps, agent, cfg.domain, cfg.label))
  }
  // 恢复的回执要说**恢复成了什么**，而不是回收站条目 id：
  // `id` 是 `action=list` 给的那一串（记忆 `mv…`、技能 `<时间戳>-<uuid>`），模型看到它
  // 认不出恢复了哪一条；退号恢复时最终落盘的名字还与回收站里的原名不同，更要说准。
  const name = restoredName(r) || id
  return 'OK: restored ' + cfg.label + ' "' + name + '" from the trash' +
    (name === id ? '' : ' (trash entry ' + id + ')')
}

/** 注册删除类工具：技能 / 人设 / 场景三种对象各一个动词。 */
export function buildRemoveTools(deps: RemoveToolDeps): void {
  const { defineTool, register } = deps
  const mem = deps.memoryOps
  const sk = deps.skillOps
  const sub = deps.subagentOps
  const pr = deps.promptOps
  const sc = deps.sceneOps

  /**
   * 这个 id 是不是记忆库里一条真实存在的记忆。
   *
   * 只在「带斜杠的 id 传到别的域」那条错误路径上调用，正常删除不会碰它。
   * 读失败一律 false：探不到就不说那句话，错误结论仍由原逻辑给出。
   */
  const isMemoryId: MemoryIdProbe = async (id) => {
    try {
      const r: any = await mem['rules-list']({})
      if (!r || r.ok === false) return false
      return (r.rules || []).some((x: any) => String(x.id) === id)
    } catch { return false }
  }

  const memoryCfg: RemoveCfg = {
    noun: 'memory', label: 'memory', domain: 'memory',
    trash: (a) => mem['rules-remove']({ id: String(a.id || '') }),
    restore: (a) => mem['rules-restore']({ trashId: String(a.id || '') }),
    list: async () => {
      const r: any = await mem['rules-trash-list']({})
      if (!r || r.ok === false) throw new Error((r && r.error) || 'failed to read the trash')
      return (r.entries || []).map((e: any) => ({ id: String(e.trashId), name: String(e.name), deletedAt: e.deletedAt }))
    },
    idHelp: {
      tool: 'memory_manager_list',
      neutral: ' — the ids are the lines in the "Current memories" reminder.',
      label: 'memory ids',
      list: async () => {
        const r: any = await mem['rules-list']({})
        return r && r.ok !== false ? (r.rules || []).map((x: any) => String(x.id)) : []
      },
    },
  }
  const skillCfg: RemoveCfg = {
    noun: 'skill', label: 'skill', domain: 'skills',
    // 与 `skill_manager_switch` 同一条：不给 root 就按名字在全部来源里
    // 找胜出的那一份。默认值原本是 dsh，而 `skill_manager_save` 落 hub —— 「建完就删」
    // 必然报「技能不存在」。删一个真的不存在的技能时退回 dsh，交给 op 报它自己的错。
    trash: async (a) => {
      const name = String((a && a.id) || '')
      const explicit = String((a && a.root) || '').trim()
      const root = explicit !== '' ? explicit : ((await locateSkillRoot(sk, name)).root || 'dsh')
      return sk['skill-delete']({ root, name })
    },
    restore: (a) => sk['skill-trash-restore']({ id: String(a.id || '') }),
    // 技能没有独立的回收站列表 op：它挂在 `skill-state` 的 `data.trash` 上（界面同一条来源）。
    list: async () => {
      const r: any = await sk['skill-state']({})
      if (!r || r.ok === false) throw new Error((r && r.error) || 'skill-state failed')
      return (((r.data && r.data.trash) || []) as any[]).map((e: any) => ({ id: String(e.id), name: String(e.name), deletedAt: e.deletedAt }))
    },
    idHelp: {
      tool: 'skill_manager_list',
      neutral: ' — the names are in the "Current skills" reminder.',
      label: 'skills',
      list: async () => {
        const r: any = await sk['skill-state']({})
        const names: string[] = []
        for (const root of (r && r.ok !== false && r.data && r.data.roots) || []) {
          for (const skill of root.skills || []) {
            const n = String(skill.declaredName || skill.name || '')
            if (n !== '' && names.indexOf(n) < 0) names.push(n)
          }
        }
        return names
      },
    },
  }
  const subagentCfg: RemoveCfg = {
    noun: 'persona', label: 'persona', domain: 'subagents',
    trash: (a) => sub['subagent-delete']({ name: String(a.id || '') }),
    restore: (a) => sub['subagent-trash-restore']({ id: String(a.id || '') }),
    list: async () => {
      const r: any = await sub['subagent-trash-list']({})
      if (!r || r.ok === false) throw new Error((r && r.error) || 'failed to read the trash')
      return (r.trash || []).map((e: any) => ({ id: String(e.id), name: String(e.name), deletedAt: e.deletedAt }))
    },
    idHelp: {
      tool: 'subagent_manager_list',
      neutral: ' — the names are in the "Current subagents" reminder.',
      label: 'personas',
      list: async () => {
        const r: any = await sub['subagent-list']({})
        return r && r.ok !== false ? (r.subagents || []).map((p: any) => String(p.name)) : []
      },
    },
  }
  const promptCfg: RemoveCfg = {
    noun: 'preset', label: 'preset',
    trash: (a) => pr['agentsmd-remove']({ id: String(a.id || '') }),
    restore: (a) => pr['agentsmd-trash-restore']({ id: String(a.id || '') }),
    list: async () => {
      const r: any = await pr['agentsmd-trash-list']({})
      if (!r || r.ok === false) throw new Error((r && r.error) || 'failed to read the trash')
      const arr = Array.isArray(r) ? r : (r.presets || r.trash || r.entries || [])
      return arr.map((e: any) => ({ id: String(e.id), name: String(e.name || e.id), deletedAt: e.deletedAt }))
    },
    idHelp: {
      tool: 'prompt_manager_list',
      neutral: ' — the one in effect is named in the "Current prompt" reminder.',
      label: 'presets',
      list: async () => {
        const r: any = await pr['agentsmd-list']({})
        return r && r.ok !== false ? (r.presets || []).map((p: any) => String(p.id)) : []
      },
    },
  }
  const sceneCfg: RemoveCfg = {
    noun: 'scene', label: 'scene', domain: 'scene',
    // 删场景走 handlers 里那份（`withAgentsMdSync` 包过）：直调 `memoriesService.ops` 会漏掉
    // 「场景绑的预设曾写进 AGENTS.md，删了要跟着处理」那一步。
    trash: (a) => deps.sceneRemove({ name: String(a.id || '') }),
    restore: (a) => sc['scene-trash-restore']({ id: String(a.id || '') }),
    list: async () => {
      const r: any = await sc['scene-trash-list']({})
      if (!r || r.ok === false) throw new Error((r && r.error) || 'failed to read the trash')
      return (r.trash || []).map((e: any) => ({ id: String(e.id), name: String(e.name), deletedAt: e.deletedAt }))
    },
    idHelp: {
      tool: 'scene_manager_list',
      neutral: ' — the names are in the "Current scene" reminder.',
      label: 'scenes',
      list: async () => {
        const r: any = await sc['rules-list']({})
        return r && r.ok !== false ? (r.scenes || []).map((s: any) => String(s.name)) : []
      },
    },
  }

  register(defineTool({
    name: 'memory_manager_remove',
    description: removeDescription('memory'),
    parameters: {
      action: { type: 'string', required: true, enum: ['trash', 'restore', 'list'], description: ACTION_DESC },
      id: { type: 'string', description: 'For trash: the memory id `<scene>/<name>`; for restore: a trash entry id; omit for list.' },
      scope: { type: 'string', enum: ['session', 'global'], description: REMOVE_SCOPE_DESC },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(String(v)) },
    async execute(args: any, exec: any) { return runRemove(deps, memoryCfg, args, exec && exec.agent, isMemoryId) },
  }))

  register(defineTool({
    name: 'skill_manager_remove',
    description: removeDescription('skill'),
    parameters: {
      action: { type: 'string', required: true, enum: ['trash', 'restore', 'list'], description: ACTION_DESC },
      id: { type: 'string', description: 'For trash: the skill name; for restore: a trash entry id; omit for list.' },
      scope: { type: 'string', enum: ['session', 'global'], description: REMOVE_SCOPE_DESC },
      root: { type: 'string', description: 'Source root the skill lives in. Default: whichever source holds that skill; only used by action=trash.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(String(v)) },
    async execute(args: any, exec: any) { return runRemove(deps, skillCfg, args, exec && exec.agent, isMemoryId) },
  }))

  register(defineTool({
    name: 'subagent_manager_remove',
    description: removeDescription('persona'),
    parameters: {
      action: { type: 'string', required: true, enum: ['trash', 'restore', 'list'], description: ACTION_DESC },
      id: { type: 'string', description: 'For trash: the persona name; for restore: a trash entry id; omit for list.' },
      scope: { type: 'string', enum: ['session', 'global'], description: REMOVE_SCOPE_DESC },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(String(v)) },
    async execute(args: any, exec: any) { return runRemove(deps, subagentCfg, args, exec && exec.agent, isMemoryId) },
  }))

  register(defineTool({
    name: 'prompt_manager_remove',
    description: removeDescription('AGENTS.md preset'),
    parameters: {
      action: { type: 'string', required: true, enum: ['trash', 'restore', 'list'], description: ACTION_DESC },
      id: { type: 'string', description: 'For trash: the preset id; for restore: a trash entry id; omit for list.' },
      scope: { type: 'string', enum: ['session', 'global'], description: scopeGlobalOnlyDesc('a preset writes the one global baseline', 'there is nothing per-conversation to delete') },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(String(v)) },
    async execute(args: any, exec: any) { return runRemove(deps, promptCfg, args, exec && exec.agent, isMemoryId) },
  }))

  register(defineTool({
    name: 'scene_manager_remove',
    description: removeDescription('scene'),
    parameters: {
      action: { type: 'string', required: true, enum: ['trash', 'restore', 'list'], description: ACTION_DESC },
      id: { type: 'string', description: 'For trash: the scene name; for restore: a trash entry id; omit for list.' },
      scope: { type: 'string', enum: ['session', 'global'], description: REMOVE_SCOPE_DESC_SCENE },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(String(v)) },
    async execute(args: any, exec: any) { return runRemove(deps, sceneCfg, args, exec && exec.agent, isMemoryId) },
  }))
}
