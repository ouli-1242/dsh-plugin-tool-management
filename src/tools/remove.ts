// 删除 / 回收站族的 model 工具（2026-10-15）：五个域各一条 `*_manager_remove`。
//
// 为什么单开一族：此前模型**只能停用、不能删除** —— "把这条过时的记忆删掉"这类要求手里
// 没有出口，模型会去调 `*_switch(enabled:false)` 然后回一句"已停用"，用户以为删了。面板上
// 每个域都有删除，模型侧一条都没有。
//
// 三条纪律：
//   · **删除一律进回收站**（可恢复），与面板同一条路 —— 回执如实说"可恢复"。
//   · **不做 purge**（永久删除）：低频且不可恢复，用户裁定"使用频率低的可以不要，
//     太多功能反而冗余" —— 清空回收站留给面板。
//   · `list` 是只读（不进场景冻结守卫，与 `trash-preview` 只读口径一致）；`trash` /
//     `restore` 是写，过 `lockedSceneGuard()`。
//
// 参数名统一 `id`：`trash` 时是资源标识（记忆 `<场景>/<名>`、技能名、人设名、预设 id、
// 场景名），`restore` 时是 `action=list` 给出的**回收站条目 id** —— 两种含义在描述里写清。

import { locateSkillRoot, text, type ToolDomainDeps } from './deps.js'

/** 一条删除工具的域配置（纯数据，execute 逻辑共用 `runRemove`）。 */
interface RemoveCfg {
  /** 英文域名单数（进描述）。 */
  noun: string
  /** 中文标签（进回执）。 */
  label: string
  /** 资源 → 回收站。 */
  trash(args: any): Promise<any>
  /** 回收站条目 → 恢复。 */
  restore(args: any): Promise<any>
  /** 列回收站：返回规范化后的条目（id = 回收站条目 id）。 */
  list(): Promise<Array<{ id: string; name: string; deletedAt?: string }>>
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
  return 'Delete one ' + noun + ' (moves it to the trash), restore one from the trash, or list the trash. '
    + 'Nothing here is permanent — emptying the trash is a panel action. '
    + 'Blocked while the active scene is locked. Only on the user\'s instruction.'
}

/** `action` 参数：三个动词 + 每个动词要哪个 `id`。 */
const ACTION_DESC = 'trash = delete the item named in `id` (moves it to the trash); restore = put back the trash entry `id` (get its id from action=list); list = list the trash (no `id`).'

/**
 * 恢复 op 回传的**最终落盘名**。五个域把名字放在不同字段上：
 *   · 记忆 / 技能 / 人设 / 场景 → `name`（退号恢复时它是新名字，不是回收站里的原名）
 *   · 提示词预设               → `id`（预设的 id 就是它的名字）
 * 记忆还会把投影对象放在 `rule.id` 上，作为第三顺位兜底。
 *
 * 还要解一层 `data`（2026-10-15 复核 P1-6 时漏掉的那半）：技能的 op 表外面包了
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

/** 一条删除工具的 execute：三个动词的分派与回执。 */
async function runRemove(deps: ToolDomainDeps, cfg: RemoveCfg, args: any): Promise<string> {
  const action = String((args && args.action) || '')
  if (action !== 'trash' && action !== 'restore' && action !== 'list') {
    throw new Error('action 只能是 trash / restore / list（收到：' + (action || '(空)') + '）')
  }
  if (action === 'list') {
    const entries = await cfg.list()
    return entries.length
      ? '回收站（' + entries.length + ' 条）：\n' + entries.map((e) =>
        '- ' + e.id + ' · ' + e.name + (e.deletedAt ? ' · ' + e.deletedAt : '')).join('\n')
      : '回收站是空的。'
  }
  // 进 / 出回收站都是写：过场景冻结守卫（与面板的删除按钮同一档）。
  const blocked = await deps.lockedSceneGuard()
  if (blocked) throw new Error(blocked)
  const id = String((args && args.id) || '').trim()
  if (id === '') throw new Error('缺少参数：id（action=' + action + ' 需要）')
  const r: any = action === 'trash' ? await cfg.trash(args) : await cfg.restore(args)
  if (!r || r.ok === false) throw new Error((r && r.error) || (action === 'trash' ? '移入回收站失败' : '恢复失败'))
  if (action === 'trash') {
    return 'OK: ' + cfg.label + '「' + id + '」已移入回收站（可恢复；永久删除在面板的回收站里）'
  }
  // 恢复的回执要说**恢复成了什么**，而不是回收站条目 id（2026-10-15 smoke-test P1-6）：
  // `id` 是 `action=list` 给的那一串（记忆 `mv…`、技能 `<时间戳>-<uuid>`），模型看到它
  // 认不出恢复了哪一条；退号恢复时最终落盘的名字还与回收站里的原名不同，更要说准。
  const name = restoredName(r) || id
  return 'OK: 已从回收站恢复 ' + cfg.label + '「' + name + '」' +
    (name === id ? '' : '（回收站条目 ' + id + '）')
}

export function buildRemoveTools(deps: RemoveToolDeps): void {
  const { defineTool, register } = deps
  const mem = deps.memoryOps
  const sk = deps.skillOps
  const sub = deps.subagentOps
  const pr = deps.promptOps
  const sc = deps.sceneOps

  const memoryCfg: RemoveCfg = {
    noun: 'memory', label: '记忆',
    trash: (a) => mem['rules-remove']({ id: String(a.id || '') }),
    restore: (a) => mem['rules-restore']({ trashId: String(a.id || '') }),
    list: async () => {
      const r: any = await mem['rules-trash-list']({})
      if (!r || r.ok === false) throw new Error((r && r.error) || '读取回收站失败')
      return (r.entries || []).map((e: any) => ({ id: String(e.trashId), name: String(e.name), deletedAt: e.deletedAt }))
    },
  }
  const skillCfg: RemoveCfg = {
    noun: 'skill', label: '技能',
    // 与 `skill_manager_switch` 同一条（smoke-test P0-1）：不给 root 就按名字在全部来源里
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
  }
  const subagentCfg: RemoveCfg = {
    noun: 'persona', label: '人设',
    trash: (a) => sub['subagent-delete']({ name: String(a.id || '') }),
    restore: (a) => sub['subagent-trash-restore']({ id: String(a.id || '') }),
    list: async () => {
      const r: any = await sub['subagent-trash-list']({})
      if (!r || r.ok === false) throw new Error((r && r.error) || '读取回收站失败')
      return (r.trash || []).map((e: any) => ({ id: String(e.id), name: String(e.name), deletedAt: e.deletedAt }))
    },
  }
  const promptCfg: RemoveCfg = {
    noun: 'preset', label: '提示词预设',
    trash: (a) => pr['agentsmd-remove']({ id: String(a.id || '') }),
    restore: (a) => pr['agentsmd-trash-restore']({ id: String(a.id || '') }),
    list: async () => {
      const r: any = await pr['agentsmd-trash-list']({})
      if (!r || r.ok === false) throw new Error((r && r.error) || '读取回收站失败')
      const arr = Array.isArray(r) ? r : (r.presets || r.trash || r.entries || [])
      return arr.map((e: any) => ({ id: String(e.id), name: String(e.name || e.id), deletedAt: e.deletedAt }))
    },
  }
  const sceneCfg: RemoveCfg = {
    noun: 'scene', label: '场景',
    // 删场景走 handlers 里那份（`withAgentsMdSync` 包过）：直调 `memoriesService.ops` 会漏掉
    // 「场景绑的预设曾写进 AGENTS.md，删了要跟着处理」那一步。
    trash: (a) => deps.sceneRemove({ name: String(a.id || '') }),
    restore: (a) => sc['scene-trash-restore']({ id: String(a.id || '') }),
    list: async () => {
      const r: any = await sc['scene-trash-list']({})
      if (!r || r.ok === false) throw new Error((r && r.error) || '读取回收站失败')
      return (r.trash || []).map((e: any) => ({ id: String(e.id), name: String(e.name), deletedAt: e.deletedAt }))
    },
  }

  register(defineTool({
    name: 'memory_manager_remove',
    description: removeDescription('memory'),
    parameters: {
      action: { type: 'string', required: true, enum: ['trash', 'restore', 'list'], description: ACTION_DESC },
      id: { type: 'string', description: 'For trash: the memory id `<scene>/<name>`. For restore: the trash entry id from action=list. Not needed for list.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(String(v)) },
    async execute(args: any) { return runRemove(deps, memoryCfg, args) },
  }))

  register(defineTool({
    name: 'skill_manager_remove',
    description: removeDescription('skill'),
    parameters: {
      action: { type: 'string', required: true, enum: ['trash', 'restore', 'list'], description: ACTION_DESC },
      id: { type: 'string', description: 'For trash: the skill name. For restore: the trash entry id from action=list. Not needed for list.' },
      root: { type: 'string', description: 'Source root the skill lives in. Default: whichever source holds that skill; only used by action=trash.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(String(v)) },
    async execute(args: any) { return runRemove(deps, skillCfg, args) },
  }))

  register(defineTool({
    name: 'subagent_manager_remove',
    description: removeDescription('persona'),
    parameters: {
      action: { type: 'string', required: true, enum: ['trash', 'restore', 'list'], description: ACTION_DESC },
      id: { type: 'string', description: 'For trash: the persona name. For restore: the trash entry id from action=list. Not needed for list.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(String(v)) },
    async execute(args: any) { return runRemove(deps, subagentCfg, args) },
  }))

  register(defineTool({
    name: 'prompt_manager_remove',
    description: removeDescription('AGENTS.md preset'),
    parameters: {
      action: { type: 'string', required: true, enum: ['trash', 'restore', 'list'], description: ACTION_DESC },
      id: { type: 'string', description: 'For trash: the preset id. For restore: the trash entry id from action=list. Not needed for list.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(String(v)) },
    async execute(args: any) { return runRemove(deps, promptCfg, args) },
  }))

  register(defineTool({
    name: 'scene_manager_remove',
    description: removeDescription('scene'),
    parameters: {
      action: { type: 'string', required: true, enum: ['trash', 'restore', 'list'], description: ACTION_DESC },
      id: { type: 'string', description: 'For trash: the scene name. For restore: the trash entry id from action=list. Not needed for list.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(String(v)) },
    async execute(args: any) { return runRemove(deps, sceneCfg, args) },
  }))
}
