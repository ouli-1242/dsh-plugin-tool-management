// 场景域的 model 工具（2026-09-23 从记忆族分出来）：scene_manager_save。
//
// 为什么单独一族而不是塞进 `memory_manager_save`：场景与记忆是两个对象 —— 场景是**容器**
// （进入时按档案切换 mcp / 技能 / 人设，其余全部关掉），记忆是**内容**（按场景组织、吃注入
// 预算）。合成一条工具会让 `description` 变成双义参数、门禁按参数分叉，而这两件事的失败
// 形状都是静默的。
//
// 为什么没有 scene_manager_list：场景清单在 `memory_manager_list` 的输出末尾（它解释的是
// "这条记忆为什么没被注入"），启用场景也会由注入段给出。单独列一份要再付一条工具的成本，
// 等有明确需求再加。
//
// 只做**定义层**：这里能建场景、写档案、绑提示词，但**不能让场景生效** —— 启用与进入是
// 改运行时环境的动作（六处开关一起动），留在界面「场景」页由用户确认（该页进入前还会弹
// 一张「会改什么」的预览卡）。描述里必须说清这条边界，否则模型会以为存了档案就生效了。

import { text, type ToolDomainDeps } from './deps.js'

export interface SceneToolDeps extends ToolDomainDeps {
  /** rules service 的 ops 表：rules-create-scene（幂等 upsert）。 */
  rulesOps: Record<string, (args: any) => Promise<any>>
  /** 场景档案引擎的 ops 表：scene-mode-get（读当前档案）/ scene-archive-save。 */
  archiveOps: Record<string, (args: any) => Promise<any>>
}

/** 档案里由模型设置的三个段（`memories` 段在 P5 已废弃，不再是档案的一部分）。 */
const ARCHIVE_SECTIONS = ['mcp', 'skills', 'subagents'] as const

export function buildSceneTools(deps: SceneToolDeps): void {
  const { defineTool, register } = deps
  register(defineTool({
    name: 'scene_manager_save',
    description: 'Save a scene — a named bundle the user enters: entering it switches on exactly what its archive lists and everything else off. Creates it if absent, else updates it. Saving does not turn the scene on — the user enables or enters it on the Scenes page. Only on the user\'s instruction.',
    parameters: {
      scene: { type: 'string', required: true, description: 'Scene name (one path segment, no slashes). Created if absent.' },
      label: { type: 'string', description: 'Display name shown in the UI. Omit = keep.' },
      description: { type: 'string', description: 'What this scene is for; injected as its 「场景说明」, which the model is told to follow — write an instruction, not a note. Omit = keep.' },
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
        archiveNote = '档案段：' + touched.join('、')
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
      return 'OK: scene「' + scene + '」' + parts.join('；') +
        (collapsed
          ? '\n注意：此前所有场景都处于启用状态（历史「全部启用」默认），本次已收窄为只启用一个，新建的这个不在其中 —— 让用户到「场景」页确认。'
          : '') +
        '\n场景已保存但未启用：要不要用它，由用户在「场景」页决定。'
    },
  }))
}
