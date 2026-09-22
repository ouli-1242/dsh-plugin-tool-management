// src/ops/state-doctor.ts —— 跨域**悬空引用**体检（只读）。
//
// 为什么需要它：这个插件到处在存"别人的名字" —— 场景档案存 MCP 服务器名、技能 key、
// 人设名，场景记录存提示词预设 id，模式快照存进场景前的那一整套。名字会过期：改名与删除
// 之后，存着旧名的那一条**不会报错，只是再也不匹配任何东西**。界面因此骗人：
// 「档案里还写着 代码审查」→ 看着像绑着，委派时按新名找不到，设置像在、其实不生效。
// 这一类已经真出过两次（0.9.1 人设改名、0.10.0 预设改名），所以缺的不是又一份同步代码，
// 是一个把全部悬空引用一次数出来的出口。
//
// 为什么是一个 op 而不是一份"引用表"：那要求所有写路径都改成先登记再引用，是一次大动作，
// 而且要改官方 provider 的写入语义。这里只做**读侧对账**：拿现有的权威集合
// （配置里的服务器 / 实时发现的技能 / 人设 / 预设清单）去比现有的存储，比不上的说出来。
//
// 只读纪律：本模块不写任何文件。索引走 `readIndexSync`（契约见 memories/index-io.ts 的注释：
// 返回的可能是缓存实例，只许读）；**不走** `rules-list` / `snapshot()` —— 那两个会做悬空
// 记忆清理并整份覆盖索引，那样一来"体检"自己就成了改动。
//
// 判据与界面共用：这里的"存在"与场景页 / 档案编辑器同一套口径（`configuredServers` /
// `knownSkillKeys` / `knownPersonas` / `promptsService.list`），不另起一套。

/** 一条悬空引用。 */
export interface DanglingRef {
  /** 住在哪儿（人可读的位置串，直接显示给用户）。 */
  where: string
  /** 哪一类引用。界面按它分组。 */
  kind: 'prompt' | 'mcp' | 'mcpNote' | 'skill' | 'persona' | 'snapshot'
  /** 指向谁 —— 那个已经不在的名字。 */
  name: string
}

export interface DoctorReport {
  /** 全部悬空引用；空数组 = 一致。 */
  findings: DanglingRef[]
  /** 按类计数（界面标题用，省得自己再数一遍）。 */
  counts: Record<string, number>
  /** 某一域的权威集合没读到（读失败 ≠ 集合为空）：报告必须说"这一类没查"，不能报"没有悬空"。 */
  skipped: string[]
}

export interface StateDoctorDeps {
  /** 只读拿索引（`readIndexSync(stateDir)`）。 */
  index(): any
  /** 预设 id 全集；读失败返回 null（→ 这一类记进 skipped）。 */
  presetIds(): Promise<string[] | null>
  /** 配置中真实存在的 MCP 服务器名；失败 null。 */
  serverNames(): Promise<string[] | null>
  /** 实时发现的技能 key（`<rootKey>/<name>`）全集；失败 null。 */
  skillKeys(): Promise<Set<string> | null>
  /** 实时发现的人设名全集；失败 null。 */
  personaNames(): Promise<Set<string> | null>
}

const toSet = (list: string[] | null): Set<string> | null => (list === null ? null : new Set(list))

/** 跑一次体检。纯读，任何一域的权威集合读不到就跳过那一类并如实记下来。 */
export async function runStateDoctor(deps: StateDoctorDeps): Promise<DoctorReport> {
  const findings: DanglingRef[] = []
  const skipped: string[] = []
  const index = deps.index() || {}
  const scenes: Record<string, any> = index.scenes || {}
  const archives: Record<string, any> = index.archives || {}

  const presets = toSet(await deps.presetIds())
  if (presets === null) skipped.push('prompts')
  const servers = toSet(await deps.serverNames())
  if (servers === null) skipped.push('mcp')
  const skills = await deps.skillKeys()
  if (skills === null) skipped.push('skills')
  const personas = await deps.personaNames()
  if (personas === null) skipped.push('subagents')

  // ① 场景记录 → 提示词预设。界面上那条 `scenes.prompt.missing` 标签今天**永远不亮**
  //    （宿主把"绑的预设读不到正文"当成"没绑"，见 memories/service.ts 的 resolveScenePreset），
  //    所以改名留下的悬空绑定在别处没有任何地方说得出来 —— 这一类是本 op 的主要新增价值。
  if (presets !== null) {
    for (const scene of Object.keys(scenes)) {
      const bound = String(scenes[scene]?.prompt || '')
      if (bound !== '' && !presets.has(bound)) {
        findings.push({ where: `场景「${scene}」绑定的提示词预设`, kind: 'prompt', name: bound })
      }
    }
  }

  // ② 档案三段 + 备注段：勾选集里的名字逐个对权威集合。
  //
  // （这里原本还想查"档案表里孤儿场景键"。**没做**，因为它要的权威集合是"哪些场景存在"，
  //  而那份只能从 `snapshot()` 拿 —— 那个函数会顺手清理悬空记忆并整份覆盖索引，
  //  一个"体检"op 自己先把状态改了是不可接受的。少一个检查远比误报一条好：
  //  索引没镜像到目录场景时，报"这份档案没人读"是假话。）
  for (const scene of Object.keys(archives)) {
    const archive = archives[scene] || {}
    if (servers !== null) {
      for (const server of Object.keys(archive.mcp || {})) {
        if (!servers.has(server)) findings.push({ where: `场景「${scene}」的 MCP 勾选`, kind: 'mcp', name: server })
      }
      for (const server of Object.keys(archive.mcpNotes || {})) {
        if (!servers.has(server)) findings.push({ where: `场景「${scene}」的场景备注`, kind: 'mcpNote', name: server })
      }
    }
    if (skills !== null) {
      for (const key of Array.isArray(archive.skills) ? archive.skills : []) {
        if (!skills.has(String(key))) findings.push({ where: `场景「${scene}」的技能勾选`, kind: 'skill', name: String(key) })
      }
    }
    if (personas !== null) {
      for (const name of Array.isArray(archive.subagents) ? archive.subagents : []) {
        if (!personas.has(String(name))) findings.push({ where: `场景「${scene}」的人设勾选`, kind: 'persona', name: String(name) })
      }
    }
  }

  // ⑥ 模式快照：退出场景按它整体回写，所以快照里的悬空名字**比档案里的更贵** ——
  //    档案的悬空项在应用时被补集成 stale 名单，快照则会在退出时原样写回去。
  const snapshot = index.mode && index.mode.snapshot
  if (snapshot) {
    const modeScene = String((index.mode && index.mode.scene) || '(当前场景)')
    if (skills !== null) {
      for (const key of Object.keys(snapshot.skills || {})) {
        if (!skills.has(key)) findings.push({ where: `模式快照（退出「${modeScene}」时要回写的技能）`, kind: 'snapshot', name: key })
      }
    }
    if (servers !== null) {
      for (const server of Object.keys(snapshot.mcp || {})) {
        if (!servers.has(server)) findings.push({ where: `模式快照（退出「${modeScene}」时要回写的 MCP 停用表）`, kind: 'snapshot', name: server })
      }
    }
    if (personas !== null) {
      const personaNames = new Set<string>([
        ...Object.keys(snapshot.subagentsAll || {}),
        ...(Array.isArray(snapshot.subagents) ? snapshot.subagents : []),
        ...(Array.isArray(snapshot.subagentsOn) ? snapshot.subagentsOn : []),
      ])
      for (const name of personaNames) {
        if (!personas.has(String(name))) findings.push({ where: `模式快照（退出「${modeScene}」时要回写的人设）`, kind: 'snapshot', name: String(name) })
      }
    }
  }

  const counts: Record<string, number> = {}
  for (const row of findings) counts[row.kind] = (counts[row.kind] || 0) + 1
  return { findings, counts, skipped }
}
