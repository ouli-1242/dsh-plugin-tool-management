// 技能域的 model 工具（2026-09-19 从 index.ts 的注册区抽出；2026-09-23 合并）：
// skill_manager_list / skill_manager_read / skill_manager_switch / skill_manager_save。
//
// create → save：`skill-create` 对同名是**拒绝**的，所以"建还是改"的判定只能在工具这一侧
// （先读一次 `skill-state`）。改的分支走新加的 `skill-update` op，它只认本插件可写的两个根
// （hub = 导入落点 / dsh = 新建默认落点，2026-10-15 裁定）里的胜出者。

import { toKebab } from '../skills/core.js'
import { locateSkillRoot, text, type ToolDomainDeps } from './deps.js'

export interface SkillToolDeps extends ToolDomainDeps {
  /** skills service 的 ops 表：skill-state / skill-enable / skill-disable / skill-create / skill-update。 */
  skillsOps: Record<string, (args: any) => Promise<any>>
}

export function buildSkillTools(deps: SkillToolDeps): void {
  const { defineTool, register } = deps
  // Skill-facing tools: list, toggle, create. create is gated by the
  // tools/pre-execute hook below (the model must ask before writing files).
  register(defineTool({
    name: 'skill_manager_list',
    // `— it is absent when the preset carries the official \`skill\` tool` 删掉
    // （2026-10-15 注入文本审查）：可行动的那半句已经写在 `skill_manager_read` 的描述里
    // （"Not sent when the official `skill` tool is mounted — use that instead."），
    // 这里再预告一遍同一个条件，只是同一件事付两次 token。
    description: 'List skills with enabled state, effective/shadowed status and source file path. The「当前技能目录」reminder carries callable skills and summaries only; use this for entries that are off, for each entry\'s source-file path, and to see which source wins a name collision. Defaults to enabled only; all=true for every entry. A copy marked "shadowed-by:<root>" stays inactive even if enabled; "preferred" marks the copy that wins a name collision.',
    parameters: {
      all: { type: 'boolean', description: 'Include disabled and shadowed entries (default false).' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any, exec: any) {
      const showAll = Boolean(args && args.all === true)
      const r = await deps.skillsOps['skill-state']({})
      if (!r || r.ok === false) throw new Error((r && r.error) || 'skill-state failed')
      const data: any = r.data || {}
      // 同名（canonical = declaredName || name）跨根重复时只有**一份**生效，排序规则是
      // 「同名首选 > 来源优先级 rank」，**与启用状态无关**（core 的 groupLoadableSkillsByName）。
      // 于是「启用被覆盖的那份」是静默无效的：工具会回 OK，技能却依然不可用 —— 用户实测
      // 踩到的正是这个坑（同一技能在 dsh/agents/claude/custom 各有一份，启错根等于没启）。
      // 这里把生效/被覆盖如实标出来，让模型（和人）不必猜。
      //
      // 默认只列启用的（2026-09-16 用户裁定）：本机 36 条里只有 1 条启用，全列一次约 4.3k
      // 字符且永久留在 transcript。表头始终给出全量口径（多少条 / 多少同名组），所以
      // 「还有没列出来的」不会变成盲区 —— 要看就传 all=true。
      const rows: Array<{ root: string; text: string; enabled: boolean }> = []
      const counts = new Map<string, number>()
      for (const root of data.roots || []) {
        for (const skill of root.skills || []) {
          const key = String(skill.declaredName || skill.name || '')
          counts.set(key, (counts.get(key) || 0) + 1)
          // `enabled` 只写在「胜出者」上（core 的 markWinners）；影子副本与不可加载的技能
          // 没有这个字段。原先直接读 skill.enabled，这些技能一律被报成 disabled ——
          // 这里改用与界面同口径的兜底推导（client 的 isSkillEnabled）。
          const enabled = skill.enabled !== undefined
            ? skill.enabled === true
            : (skill.invocationPolicyValid && skill.modelInvocable && skill.userInvocable && skill.managerEnabled !== false)
          // 带标签的 `k: v` 串（2026-10-14 对抗性审查 P1-1）：此前是无列头的 pipe 串，两个标记
          // （`shadowed by <root>` / `preferred`）还会挤在同一格里、都没有标签 —— 模型得猜哪段
          // 是字段、哪段是标记，以及 `preferred` 到底是什么（它此前**全仓没有定义**）。
          // 与 `mcp_manager_list` 的 `server:` / `level:` / `user-hint:` 同款。
          rows.push({
            root: String(root.key || ''),
            enabled,
            text: 'skill:' + (skill.name || skill.declaredName || '') + ' | root:' + (root.key || '') +
              ' | ' + (enabled ? 'enabled' : 'disabled') +
              (skill.shadowedBy && skill.shadowedBy.root ? ' | shadowed-by:' + skill.shadowedBy.root : '') +
              (skill.preferred === true ? ' | preferred' : '') +
              (skill.path ? ' | path:' + skill.path : ''),
          })
        }
      }
      const dupGroups = [...counts.values()].filter((n) => n > 1).length
      const shown = showAll ? rows : rows.filter((row) => row.enabled)
      const header = 'Skills: ' + (showAll
        ? rows.length + ' entries'
        : shown.length + ' enabled of ' + rows.length + ' entries') +
        (dupGroups ? ' · ' + dupGroups + ' duplicated names' : '') +
        (showAll || shown.length === rows.length ? '' : ' (pass all=true to include disabled and shadowed entries)') + '\n'
      // 注入边界：预设没挂 dsh-tool-skill（如极简）时官方技能目录不在，本插件的
      // 「技能目录」注入域会在开关打开时兜底（见上面的注入通道）；两者都没有时模型看到的
      // 只是这份名单 —— 说清边界，别让它以为上下文里已经有技能正文（正文用路径读）。
      const notice = await deps.reachNoticeForAgent(deps.presetRoster(), exec && exec.agent && exec.agent.ctx, deps.injectNoticeOptions())
      return header + (shown.map((row) => row.text).join('\n') || '(none)') + notice
    },
  }))
  // 一次拿到技能正文。此前读正文要两步：`skill_manager_list` 拿路径 → 自己再去读那个文件。
  // 少的那一步不只是省一次调用 —— 目录里只有名字没有路径，而**同名技能常几份并存**（dsh /
  // agents / claude / 自定义目录各一份），模型自己挑路径时很容易读到被覆盖的那份影子副本：
  // 读完以为在用这个技能，其实生效的是另一份。这里先走 `skill-state`（core 的 markWinners
  // 已在上面标出胜出者），再走 `skill-detail` 读那一份 —— 读到的永远是目录列出来的那一份。
  register(defineTool({
    name: 'skill_manager_read',
    description: 'Read one skill\'s full SKILL.md body by name — what the「当前技能目录」reminder deliberately leaves out (it has names and summaries only). Also lists the other files living in that skill folder (references/, scripts/), which the body often points at. Resolves name collisions the same way, so you get the copy actually in effect; pass root only to inspect a specific (e.g. shadowed) source. Not sent when the official `skill` tool is mounted — use that instead.',
    parameters: {
      name: { type: 'string', required: true, description: 'Skill name, exactly as it appears in the catalog (kebab-case).' },
      root: { type: 'string', description: 'Source root key (dsh/hub/agents/codex/claude, a project key, or a custom one). Default: the winning copy of this name.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any, exec: any) {
      const wanted = String((args && args.name) || '').trim()
      if (!wanted) throw new Error('name is required')
      const rootWanted = String((args && args.root) || '').trim()
      const state = await deps.skillsOps['skill-state']({})
      if (!state || state.ok === false) throw new Error((state && state.error) || 'skill-state failed')
      const data: any = state.data || {}
      type Hit = { rootKey: string; entryName: string; path: string; shadowedBy: string; preferred: boolean; enabled: boolean }
      const hits: Hit[] = []
      for (const root of data.roots || []) {
        for (const skill of root.skills || []) {
          if (String(skill.declaredName || skill.name || '') !== wanted && String(skill.name || '') !== wanted) continue
          if (rootWanted && String(root.key || '') !== rootWanted) continue
          hits.push({
            rootKey: String(root.key || ''),
            // `skill-detail` 按**目录名**认条目（core 的 visibleEntryForRoot 比的是 entry.name），
            // 而目录名与 frontmatter 的 name 可以不同 —— 传错一个就读不到。
            entryName: String(skill.name || wanted),
            path: String(skill.path || ''),
            shadowedBy: skill.shadowedBy && skill.shadowedBy.root ? String(skill.shadowedBy.root) : '',
            preferred: skill.preferred === true,
            // 与 skill_manager_list 同一套启停推导（影子副本没有 enabled 字段）。
            enabled: skill.enabled !== undefined
              ? skill.enabled === true
              : (skill.invocationPolicyValid && skill.modelInvocable && skill.userInvocable && skill.managerEnabled !== false),
          })
        }
      }
      if (!hits.length) {
        // 「去调 skill_manager_list」那句：那条工具在出厂默认里就是关着的，点名一条模型没有的
        // 工具只会让它白跑一趟（执行侧拦住，而它看不出为什么）。判据按 **agent**（2026-10-14
        // 对抗性审查 P0-1 的同一条纪律）：人设用 `toolsDeny` 砍掉它时，全局开关看着是开的。
        const listHint = deps.toolVisibleFor('skill_manager_list', exec && exec.agent)
          ? ' — call skill_manager_list (pass all=true) to see what is installed'
          : ''
        throw new Error('no skill named "' + wanted + '"' + (rootWanted ? ' in source "' + rootWanted + '"' : '') + listHint)
      }
      // 胜出者优先：同名的影子副本读得到，但那不是生效的一份，所以默认不选它。
      const picked = hits.find((hit) => !hit.shadowedBy && hit.enabled)
        || hits.find((hit) => !hit.shadowedBy)
        || hits[0]
      const res = await deps.skillsOps['skill-detail']({ root: picked.rootKey, name: picked.entryName })
      if (!res || res.ok === false) throw new Error((res && res.error) || 'skill-detail failed')
      const detail: any = res.data || res
      const marks: string[] = []
      if (picked.shadowedBy) marks.push('shadowed by "' + picked.shadowedBy + '" — the copy actually in effect is a different one')
      if (picked.preferred) marks.push('preferred copy')
      if (!picked.enabled) marks.push('disabled')
      const dup = hits.filter((hit) => !hit.shadowedBy).length > 1
        ? hits.filter((hit) => !hit.shadowedBy).map((hit) => hit.rootKey).filter((k) => k !== picked.rootKey)
        : []
      // 附件清单（2026-10-16）：技能正文常写着「详见 references/xxx.md」，而这一条工具是模型
      // 读技能的唯一入口 —— 不列出来，它就会因为"看到的目录里没有那个文件"而凭空猜内容。
      // 只报名与大小、不报正文：正文要走宿主文件工具，这里塞进 transcript 太重。
      const attachments = Array.isArray(detail.attachments) ? detail.attachments : []
      const shown = attachments.slice(0, 20)
      const attLine = shown.length
        ? 'Attachments in this skill folder: ' + shown
          .map((a: any) => String(a.path) + ' (' + Number(a.size || 0) + ' bytes)')
          .join(', ')
          + (attachments.length > shown.length ? ' … ' + (attachments.length - shown.length) + ' more' : '')
          + (detail.attachmentsTruncated ? ' (listing capped at 200)' : '')
          + ' — read them with a file tool if the body refers to one\n'
        : ''
      const header = 'Skill ' + wanted + ' · source ' + picked.rootKey + (marks.length ? ' (' + marks.join('; ') + ')' : '') + '\n' +
        'Path: ' + (detail.path || picked.path || '(unknown)') + '\n' +
        'Description: ' + String(detail.description || '(none)').replace(/\s+/g, ' ').trim() + '\n' +
        (dup.length ? 'Other callable copies with the same name: ' + dup.join(', ') + ' (this one wins; read them only to compare)\n' : '') +
        attLine +
        '--- SKILL.md body ---\n'
      // 注入边界：正文读进来就永久留在这一轮的 transcript 里，压制型预设下目录也可能不在 ——
      // 与 skill_manager_list 同一句说明，别让模型以为"读过就等于技能开着"。
      const notice = await deps.reachNoticeForAgent(deps.presetRoster(), exec && exec.agent && exec.agent.ctx, deps.injectNoticeOptions())
      return header + String(detail.body || '').trim() + notice
    },
  }))
  register(defineTool({
    name: 'skill_manager_switch',
    description: 'Enable or disable one DSH skill, or a whole source folder via `source`. Pass `prefer` (with `name` + `root`) to make that copy win a same-name collision, or to clear the recorded choice. Enabling a shadowed copy has no effect. Reversible. Only when the user asks or approves.',
    parameters: {
      name: { type: 'string', description: 'Skill name (kebab-case).' },
      // `enabled` 从 required 改成"要么给 enabled、要么给 prefer"（2026-10-15）：
      // prefer 是一次独立的写（`skill-prefer`），模型不该为了改首选来源先被迫拨一次开关。
      // 缺省仍然**拒绝**（execute 里那条守卫），不然 `args.enabled ? enable : disable`
      // 会把"忘了给"静默当成"停用"。
      enabled: { type: 'boolean', description: 'true to enable, false to disable. Required unless you only pass `prefer`.' },
      source: { type: 'string', description: 'A source root key to switch as a whole (dsh/hub/agents/codex/claude or a project key).' },
      root: { type: 'string', description: 'Source root key the skill lives in (with `name`). Default: whichever source holds that skill (all sources are searched). Required when using `prefer`.' },
      // 同名首选来源（2026-10-15 注入文本审查）。此前这条工具的回执写着
      // "or make this root the preferred copy **in the panel**" —— 明明一个布尔能解决，
      // 却把用户推去界面点。而 `skill-prefer` / `skill-unprefer` 两个 op 早就在（面板在用）。
      // 代价为零：本工具在出厂默认名单里就是关着的，加参数不进默认上下文。
      prefer: { type: 'boolean', description: 'true = the copy in `root` wins this name\'s collision; false = drop the recorded choice. Needs `name` and an explicit `root`. Omit = leave the choice alone.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args) {
      const blocked = await deps.lockedSceneGuard()
      if (blocked) throw new Error(blocked)
      const name = String((args && args.name) || '').trim()
      const source = String((args && args.source) || '').trim()
      // `prefer` 的三态与它自己的前置条件（2026-10-15）：省略 = 不碰首选表；
      // true / false = 设 / 撤。**必须点名 root** —— 默认值 `dsh` 在"同名首选"这件事上
      // 恰恰是最容易猜错的一格（要选赢的往往是**非 dsh** 那一份），所以这里不接受默认值。
      const preferGiven = Boolean(args && args.prefer !== undefined)
      const prefer = args && args.prefer === true
      if (preferGiven && typeof args.prefer !== 'boolean') throw new Error('prefer 必须是 true 或 false')
      if (name && source) throw new Error('name 与 source 只能给一个：name 是单个技能，source 是整个来源目录')
      if (preferGiven && source) throw new Error('prefer 只对单个技能有意义：给 name，不要给 source')
      if (!name && !source) throw new Error('缺少参数：name（单个技能）或 source（整个来源目录）')
      if (preferGiven && !name) throw new Error('缺少参数：prefer 需要 name')
      if (preferGiven && String((args && args.root) || '').trim() === '') {
        throw new Error('prefer 需要 root：明确指定哪一份同名副本胜出（dsh / hub / agents / codex / claude 或项目键）')
      }
      // 两个动作一个都没给就拒：`args.enabled ? enable : disable` 会把"忘了给"静默当成"停用"。
      if (args.enabled === undefined && !preferGiven) {
        throw new Error('缺少参数：enabled 必须是 true 或 false（只想改同名首选就传 prefer）')
      }
      if (source) {
        // 来源级启停：登记表里 `skill-source-enable` / `skill-source-disable` 都是
        // `{ serviceWrite, frozen, syncsArchive }`，所以守卫已过、档案也要同步
        // —— 同步的入参是 `{ root }`（来源级没有独立字段，档案靠"来源下有没有被勾的技能"反推）。
        if (args.root !== undefined) throw new Error('source 已经是来源级的键，不要再给 root')
        const op = args.enabled ? 'skill-source-enable' : 'skill-source-disable'
        const r = await deps.skillsOps[op]({ root: source })
        if (!r || r.ok === false) throw new Error((r && r.error) || 'skill source toggle failed')
        const syncErr = await deps.syncSwitchToScene(op, { root: source, enabled: args.enabled === true })
        return 'OK: source ' + source + ' now ' + (args.enabled ? 'enabled' : 'disabled') +
          (syncErr ? '\nWARN: 当前场景档案未同步（' + syncErr + '）' : '')
      }
      // 不给 root 就在全部来源里找（2026-10-15 smoke-test P0-1）：`skill_manager_save` 的落点
      // 是 hub（`tool-management/skills/`），而这里的默认值原本是 dsh —— 「建完就启用」这条
      // 最自然的链路必然报「技能不存在」。默认值改哪一边都不对（面板是显式传 root 的，
      // 两边都依赖各自的默认），所以判定放到工具侧：按名字找**胜出的那一份**。
      const resolveRoot = async (): Promise<string> => {
        const explicit = String((args && args.root) || '').trim()
        if (explicit !== '') return explicit
        const found = await locateSkillRoot(deps.skillsOps, name)
        if (found.root) return found.root
        // 探得到、就是没这个技能：当场把"查过哪些来源"说清楚。否则模型收到 op 那句不带
        // 来源信息的「技能不存在」后，只能猜该传哪个 root（smoke-test P1-4-old 同一处）。
        if (found.ok) {
          throw new Error('技能不存在: ' + name + (found.roots.length ? '（已查 ' + found.roots.join('、') + '）' : ''))
        }
        // 探不到（skill-state 失败）就别在这里编结论：退回旧默认，交给 op 报它自己的错。
        return 'dsh'
      }
      const root = await resolveRoot()
      const out: string[] = []
      // 首选来源**先写**（与面板「启用这个」同序：先 prefer 再 enable）。顺序不是随意的 ——
      // 反过来的话，下面那段 `shadowedBy` 是在**旧**首选下算的，紧接着 prefer 又把胜负翻了过来，
      // 回执里那句"它被 X 盖住了"当场就成了过期的假话。
      if (preferGiven) {
        const op = prefer ? 'skill-prefer' : 'skill-unprefer'
        const p: any = await deps.skillsOps[op]({ name: args.name, root })
        if (!p || p.ok === false) throw new Error((p && p.error) || '设置同名首选失败')
        // `skill-prefer` 会在"记下了但不会生效"时回 ok:true + warning（首选指向**停用**的来源，
        // 而同名首选会挡住其他副本 → 两份都不生效）。原样转出去，否则模型以为已经生效。
        out.push((prefer
          ? 'OK: ' + root + '/' + String(p.name || args.name) + ' is now the preferred copy of that name'
          : 'OK: cleared the preferred copy of ' + String(p.name || args.name)) +
          (p.warning ? '\nWARN: ' + String(p.warning) : ''))
      }
      if (args.enabled !== undefined) {
        const op = args.enabled ? 'skill-enable' : 'skill-disable'
        const r = await deps.skillsOps[op]({ name: args.name, root })
        if (!r || r.ok === false) throw new Error((r && r.error) || 'skill toggle failed')
        // 场景未锁定时同步进当前场景档案（与 handlers 层同一套同步）。
        const syncErr = await deps.syncSwitchToScene(op, { name: args.name, root, enabled: args.enabled === true })
        // 静默无效是这个工具最容易骗人的地方：同名胜负只由「首选 > 来源优先级」决定，
        // 与启用状态无关。对影子副本操作会返回 OK，但技能依然不可用。如实说一句。
        let shadowedBy = ''
        try {
          const state: any = await deps.skillsOps['skill-state']({})
          for (const rt of (state && state.data && state.data.roots) || []) {
            for (const skill of rt.skills || []) {
              if (String(skill.declaredName || skill.name || '') !== String(args.name)) continue
              if (String(rt.key || '') !== root) continue
              if (skill.shadowedBy && skill.shadowedBy.root) shadowedBy = String(skill.shadowedBy.root)
            }
          }
        } catch { shadowedBy = '' }
        // 出路指向**本工具自己的参数**（2026-10-15 注入文本审查）：此前写的是
        // "or make this root the preferred copy in the panel" —— 模型读得到这句却做不到，
        // 只能转述给用户去点界面。现在 `prefer` 就在同一张参数表里；而这条工具在出厂默认
        // 名单里是关着的，模型既然调得到它，就一定拿得到这个参数（不会指到一条它没有的工具）。
        const warn = shadowedBy
          ? ' — BUT this copy is shadowed by the same-name skill in "' + shadowedBy + '", so it stays inactive: enable that copy instead, or make it win with prefer=true and root="' + shadowedBy + '"'
          : ''
        const sceneWarn = syncErr ? '\nWARN: 当前场景档案未同步（' + syncErr + '）' : ''
        out.push('OK: ' + args.name + ' now ' + (args.enabled ? 'enabled' : 'disabled') + warn + sceneWarn)
      }
      return out.join('\n')
    },
  }))
  register(defineTool({
    name: 'skill_manager_save',
    // 落点必须和 UI「创建技能」一致 —— 这是本工具与面板之间唯一不能各自默认的地方（否则同一个
    // 「新建技能」动作，人点界面和模型调用会落到两个不同的根）。当前两边都是 **DSH 技能目录**
    // （`~/.dsh/skills/`）：UI 是 `43-skills.js` 的 `defaultCreateRoot`，模型侧就是下面这句
    // `skill-create` 的 op 默认值。hub（`tool-management/skills/`）只留给「导入技能」功能
    // （用户裁定 2026-10-15）。历史上两边曾一个 dsh 一个 hub，靠本条纪律对齐。
    //
    // 改的分支**认全部来源里的胜出者**：同名技能在 dsh/hub/项目根各有一份时只有一份生效，
    // 改错那一份会返回 OK 而技能毫无变化 —— 那层判定在 `skill-update` op 里，它同时要求
    // 胜出者落在本插件可写的两个根（hub 导入落点 / dsh 新建落点）。也就是说：本工具建出来
    // 的技能（只落在 dsh）一定还能被本工具改回去，不会建完就改不动。
    //
    // 描述里的落点路径（`under DSH_HOME/tool-management/skills`）删掉（2026-10-15 注入文本
    // 审查）：模型不按路径行动，而这段路径还与本轮 `remove.ts` 头注释写的落点口径不一
    // （那里写 hub 的 tool-management/skills/）。真正要它知道的是"建在哪一侧"，
    // 而"只认本插件写的技能"那半句已经说清了。
    description: 'Create a DSH skill, or update the one that already has this name — the receipt says which. Only skills this plugin wrote can be updated. Only on the user\'s instruction.',
    parameters: {
      name: { type: 'string', required: true, description: 'Skill name; normalized to kebab-case (≤128 chars, [a-z0-9-]).' },
      description: { type: 'string', description: 'A concise routing description (≤500 chars). Required when creating; omit = keep.' },
      body: { type: 'string', description: 'Markdown instructions (≤256 KiB). Required when creating; omit = keep.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args) {
      const blocked = await deps.lockedSceneGuard()
      if (blocked) throw new Error(blocked)
      const wanted = String((args && args.name) || '').trim()
      if (!wanted) throw new Error('缺少参数：name')
      const kebab = toKebab(wanted)
      if (!kebab) throw new Error('无法生成合法 kebab-case 名称（原始名: ' + wanted + '）')
      // 建还是改：先看这个（规范化后的）名字在不在。`skill-create` 对同名是**拒绝**的，
      // 所以这条判定只能在这里做 —— 不能指望 op 层兜，也不能让模型自己先查一次
      // （它手里的清单可能已经过期）。
      const state: any = await deps.skillsOps['skill-state']({})
      if (!state || state.ok === false) throw new Error((state && state.error) || 'skill-state failed')
      let exists = false
      for (const root of ((state.data && state.data.roots) || [])) {
        for (const skill of root.skills || []) {
          // 与 list / read 同一套名字口径：`declaredName || name`，再比目录名。
          if (String(skill.declaredName || skill.name || '') === kebab || String(skill.name || '') === kebab) exists = true
        }
      }
      if (!exists) {
        // 建的分支：正文与简介都必填。core 自己会拒（error.create.descriptionRequired /
        // bodyRequired），但那是给用户看的 op 错；模型需要的是"这条工具要什么"。
        const description = String((args && args.description) || '').trim()
        const body = String((args && args.body) || '').trim()
        const missing = [
          description === '' ? 'description' : '',
          body === '' ? 'body' : '',
        ].filter((x) => x !== '')
        if (missing.length) throw new Error('新建技能必须给 ' + missing.join(' 与 ') + '（' + kebab + ' 还不存在）')
        const r: any = await deps.skillsOps['skill-create']({ name: wanted, description: args.description, body: args.body })
        if (!r || r.ok === false) throw new Error((r && r.error) || 'skill create failed')
        const data: any = r.data || {}
        // 新建的技能默认停用（与 MCP / 人设同口径）。这句必须留 —— 不说的话模型会直接去用，
        // 然后发现技能不生效，而它不知道自己少拨了一个开关（smoke-test 报告 P1-3：三个 save
        // 里只有这一条不报启用状态）。点名的 `skill_manager_switch` 在出厂默认名单里就是关着的，
        // 关着就改说"用户启用后才能用"，别指一条模型没有的工具。
        const enableHint = deps.toolVisible('skill_manager_switch')
          ? '（默认未启用，要启用先 skill_manager_switch）'
          : '（默认未启用，用户启用后才能用）'
        return 'Created DSH skill ' + (data.name || kebab) + ' at ' + (data.path || '(unknown)') + enableHint
      }
      // 改的分支：省略 = 保持。两个可改字段一个都没给就拒 —— op 会按"保持原样"重写一次文件
      // 并刷新时间戳，模型以为改了点什么，其实只是把同一份内容又写了一遍。
      const touched: string[] = []
      if (args.description !== undefined) touched.push('description')
      if (args.body !== undefined) touched.push('body')
      if (!touched.length) throw new Error('没有要改的东西：description / body 至少给一个')
      const r: any = await deps.skillsOps['skill-update']({ name: wanted, description: args.description, body: args.body })
      if (!r || r.ok === false) throw new Error((r && r.error) || 'skill update failed')
      const data: any = r.data || {}
      return 'Updated DSH skill ' + (data.name || kebab) + ' at ' + (data.path || '(unknown)') + '（改了 ' + touched.join('、') + '）'
    },
  }))
}
