// 规则/记忆域的**场景 ops**（2026-09-19 从 memories/service.ts 的 createMemoriesService 闭包抽出）。
//
// 启用场景切换、场景记录增删改、场景锁、场景回收站（管场景记录与档案，与记忆回收站分开）、
// 提示词改绑。动的是 index 的 scenes / active 切片与 AGENTS.md 投影，与记忆正文 ops 互不调用。

import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { SceneArchive } from '../memories/archive.js'
import { listTrashEntries, moveIntoTrash, moveOutOfTrash, moveToTrash, purgeTrashEntry, readTrashEntry } from '../hub.js'
import { MAX_DESCRIPTION_LENGTH, DEFAULT_GROUP_ORDER, GLOBAL_SCENE, GLOBAL_SCENE_LABEL, SHARED_GROUP, SEGMENT_RULE_HINT, isValidGroupSegment, isValidGroupPath, message, fail } from '../memories/constants.js'
import { normalizeActive, collapseActiveForNewScene } from '../memories/projection.js'
import { readIndex, writeIndex, sceneRecordOf, normalizeScenePromptId, pathExists } from '../memories/index-io.js'
import type { RuleIndexEntry, SceneIndexEntry } from '../memories/index-io.js'
import type { MemoriesOpsCtx } from './ctx.js'

/** 组装本域 op。rc 由 createMemoriesService 组装，契约见 ./ctx.ts。 */
export function buildSceneRecordOps(rc: MemoriesOpsCtx) {
  const { ensureLayout, invalidateSnapshot, presetExistsSync, memoriesRoot, refuseOutsideRoot, sceneRows, snapshot, stateDir } = rc

  /**
   * 设置"启用场景"（全局持久化，切换后**下一个请求即生效**，§4 对照表）。
   *   - `args.scenes` 数组 → 启用集合；**至多一个非保留场景**（用户裁定：除「全局」外
   *     同时只能启用一个），`[]` = 全部关闭（只留恒常的 `_shared` 与 `global`）
   *   - `args.all === true` → 旧的"全部启用"形态，与新模型冲突，明确拒绝（不猜）
   * 场景名按放宽后的规则校验；不存在的场景名也允许保存（目录随后创建即可生效）。
   */
  async function rulesSetActive(args: any): Promise<any> {
    // 参数必须显式二选一。旧实现把「没传参数」「传了未知参数名」都落进 else 分支、
    // 用空数组覆盖 active，于是 `rules-set-active {}` 会静默把模式切成 custom 且零激活场景
    // （用户以为自己只是"没改动"，实际已经改了注入范围）。这里显式拒绝。
    const hasAll = !!(args && args.all === true)
    const hasScenes = Array.isArray(args && args.scenes)
    if (!hasAll && !hasScenes) {
      return fail('error.rules.invalidArgs', '缺少参数：需要 scenes:[...]（启用集合，至多一个场景）')
    }
    if (hasAll) {
      return fail('error.rules.singleSceneOnly', '除「全局」外同时只能启用一个场景：不支持"全部启用"，请改用 scenes:[<场景名>] 或 scenes:[]（全部关闭）', { detail: '：不支持"全部启用"，请改用 scenes:[<场景名>] 或 scenes:[]（全部关闭）' })
    }
    const index = await readIndex(stateDir)
    const raw = Array.isArray(args && args.scenes) ? args.scenes : []
    const names: string[] = []
    const seen = new Set<string>()
    for (const item of raw) {
      const name = String(item == null ? '' : item).trim()
      // 恒常启用的保留场景不入显式集合：`_shared`（公共基线）与 `global`（「全局」）。
      if (name === '' || name === SHARED_GROUP || name === GLOBAL_SCENE) continue
      // 启用集合里的场景名必须是**单个路径段**（2026-09-30 审查 P2-4）。此前这里走
      // `isValidGroupPath`，于是 `a/b` 这种多段名**通过校验并被写进 `active`**，但它压根
      // 不是一个场景：场景恒等于一级目录（见 `snapshot.ts` 的 `depth === 1` 与
      // `projection.ts` 的 `sceneOf`），注入时桶名是 `a`、`active` 里写的是 `a/b` ——
      // 两边对不上，用户看到的是"开关点了、场景没生效"，且**没有任何报错**。
      // 改成单段后这种名字会当场被拒（响亮地失败），与创建/改名的口径一致。
      if (!isValidGroupSegment(name)) {
        return fail('error.rules.invalidGroup', `场景名非法：${name}（${SEGMENT_RULE_HINT}）`)
      }
      if (seen.has(name)) continue
      seen.add(name)
      names.push(name)
    }
    if (names.length > 1) {
      return fail('error.rules.singleSceneOnly', `除「全局」外同时只能启用一个场景（收到 ${names.length} 个：${names.join('、')}）`, { detail: `（收到 ${names.length} 个：${names.join('、')}）` })
    }
    index.active = names
    await writeIndex(stateDir, index)
    invalidateSnapshot()
    const snap = await snapshot()
    return {
      ok: true,
      activeMode: index.active === null ? 'all' : 'custom',
      scenes: sceneRows(snap, index),
    }
  }

  /**
   * 新建场景：写一条场景记录（索引 scenes 切片）+ 建空目录 `memories/<场景>/`。
   * 场景是**显式实体**——空场景（还没有记忆）也是合法场景，会出现在场景列表里。
   *
   * 场景名的统一口径（2026-09-30 审查 P2-4 收敛，此前全仓分成两派）：
   *   - **命名路径**（新建 / 改名目标 / 启用集合）一律是**单个路径段**。场景恒等于一级目录
   *     （见 `snapshot.ts` 的 `depth === 1` 与 `projection.ts` 的 `sceneOf`），允许 `a/b`
   *     只会让「场景」与「场景内的分组」两套语义互相打架，而且启用时桶名对不上（静默失效）。
   *   - **定位路径**（改名的旧名 / 锁定 / 删除 / 回收站恢复）按**完整路径**寻址，`isValidGroupPath`。
   *     历史与导入留下的多段记录因此仍能被改名或删除 —— 否则它们成了"看得见、动不了"的死条目。
   *
   * 幂等：已存在则更新描述/标签，不报错。`_shared` 与 `global` 是保留名。
   */
  async function rulesCreateScene(args: any): Promise<any> {
    const name = String((args && args.name) || '').trim()
    if (!isValidGroupSegment(name)) {
      return fail('error.rules.invalidGroup', `场景名非法：${name || '(空)'}（${SEGMENT_RULE_HINT}）`)
    }
    if (name === SHARED_GROUP) return fail('error.rules.invalidGroup', `_shared 是保留场景名，无需创建`)
    const label = args && args.label !== undefined ? String(args.label).trim() : ''
    const description = args && args.description !== undefined ? String(args.description).trim() : ''
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      return fail('error.rules.descriptionTooLong', `场景描述过长（≤${MAX_DESCRIPTION_LENGTH} 字符）`)
    }
    const prompt = args && args.prompt !== undefined ? normalizeScenePromptId(args.prompt) : undefined
    if (prompt === null) {
      return fail('error.rules.invalidGroup', `提示词预设 id 非法：${String(args.prompt)}（仅小写字母/数字/连字符，且不能是备份槽）`)
    }
    await ensureLayout()
    try {
      await mkdir(join(memoriesRoot, name), { recursive: true })
    } catch (e) {
      return fail('error.rules.ioFailed', `创建场景目录失败：${message(e)}`)
    }
    const index = await readIndex(stateDir)
    // **新场景默认不启动**：先把历史默认（active=null=全部启用）收敛成显式集合，
    // 新建的这个自然不在其中；收敛后仍是"至多一个场景启用"。
    const collapsed = collapseActiveForNewScene(index)
    if (!index.scenes) index.scenes = {}
    const prev = index.scenes[name] || {}
    const next: SceneIndexEntry = {
      ...prev,
      ...(label !== '' && name !== GLOBAL_SCENE ? { label } : {}),
      ...(description !== '' ? { description } : {}),
      ...(prompt !== undefined && prompt !== '' ? { prompt } : {}),
      order: prev.order ?? DEFAULT_GROUP_ORDER,
      createdAt: prev.createdAt ?? new Date().toISOString(),
    }
    if (name === GLOBAL_SCENE) next.label = GLOBAL_SCENE_LABEL
    index.scenes[name] = next
    // 模型工具表方案绑定（0.15.0 用户裁定：入口改到「修改场景」表单）：绑定存**档案**，
    // 只在真的绑了东西时才建档案存根 —— 不绑就保持「没有档案」的原语义
    //（没有档案与有空档案在进入场景的预览提示上不等价）。
    const toolTablePreset = args && args.toolTablePreset !== undefined ? String(args.toolTablePreset).trim() : ''
    if (toolTablePreset.length > 64) {
      return fail('error.rules.invalidGroup', `工具表方案名过长（≤64 字符）`)
    }
    if (toolTablePreset !== '') {
      if (!index.archives) index.archives = {}
      index.archives[name] = { ...(index.archives[name] || {}), toolTablePreset }
    }
    await writeIndex(stateDir, index)
    invalidateSnapshot()
    return { ok: true, scene: sceneRecordOf(name, next), ...(collapsed ? { collapsedActive: true } : {}) }
  }

  /**
   * 更新场景记录（描述 / 显示名 / 顺序 / 绑定的提示词预设），**可选改名**（nextName）。
   *
   * 场景名就是它的一级目录名（`memories/<场景>/…`），所以改名不是改一个字段：
   *   ① 目录 `memories/<旧>` → `memories/<新>`；
   *   ② 索引里的四处引用一起改：`scenes` 记录、`archives` 档案、`active` 启用集合、`mode.scene`。
   * 记忆正文一个字节都不动（只是换了所在目录名）。
   *
   * 拒绝的三种情况：保留场景 `global` / `_shared`；目标名已被占用（目录或记录）；
   * 该场景正在当前模式里——模式快照是按场景名算的，改了名与快照就对不上（同删除的处理）。
   */
  async function rulesUpdateScene(args: any): Promise<any> {
    const name = String((args && args.name) || '').trim()
    if (!isValidGroupPath(name)) return fail('error.rules.invalidGroup', `场景名非法：${name || '(空)'}`)
    const index = await readIndex(stateDir)
    if (!index.scenes) index.scenes = {}
    const prev = index.scenes[name]
    if (!prev && name !== GLOBAL_SCENE) return fail('error.rules.notFound', `场景不存在：${name}`)
    const next: SceneIndexEntry = { ...(prev || {}) }
    if (args && args.description !== undefined) {
      const description = String(args.description).trim()
      if (description.length > MAX_DESCRIPTION_LENGTH) {
        return fail('error.rules.descriptionTooLong', `场景描述过长（≤${MAX_DESCRIPTION_LENGTH} 字符）`)
      }
      if (description === '') delete next.description
      else next.description = description
    }
    if (args && args.prompt !== undefined) {
      const prompt = normalizeScenePromptId(args.prompt)
      if (prompt === null) {
        return fail('error.rules.invalidGroup', `提示词预设 id 非法：${String(args.prompt)}（仅小写字母/数字/连字符，且不能是备份槽）`)
      }
      // 绑定前校验预设确实存在：宁可现在拒绝，也不要留一个永远注入不出东西的悬空绑定。
      if (prompt !== '' && !presetExistsSync(prompt)) {
        return fail('error.rules.notFound', `提示词预设不存在：${prompt}`)
      }
      if (prompt === '') delete next.prompt
      else next.prompt = prompt
    }
    if (args && args.toolTablePreset !== undefined) {
      // 模型工具表方案绑定（0.15.0 用户裁定：入口改到「修改场景」表单）：绑定存**档案**，
      // 记录与档案同在一份索引 JSON，这一次读-改-写顺带落掉。''= 解绑（删字段；档案因此
      // 变空时整条删掉，与档案保存「空档案不落条目」的约定一致）；不传这个参数 = 完全不碰
      // 这一域（旧调用方兼容）。绑了不存在的方案在这里不硬失败 —— 引擎在进出场景时按
      // stale 丢弃并报告，和档案保存对悬空绑定的处理同口径。
      const toolTablePreset = String(args.toolTablePreset).trim()
      if (toolTablePreset.length > 64) {
        return fail('error.rules.invalidGroup', `工具表方案名过长（≤64 字符）`)
      }
      if (!index.archives) index.archives = {}
      const archive = { ...((index.archives && index.archives[name]) || {}) }
      if (toolTablePreset === '') delete archive.toolTablePreset
      else archive.toolTablePreset = toolTablePreset
      if (Object.keys(archive).length > 0) index.archives[name] = archive
      else delete index.archives[name]
    }
    if (args && args.label !== undefined && name !== GLOBAL_SCENE) {
      const label = String(args.label).trim()
      if (label === '') delete next.label
      else next.label = label
    }
    if (args && args.order !== undefined) {
      const order = Number(args.order)
      if (!Number.isFinite(order) || order < 0) return fail('error.rules.invalidGroup', `非法排序值：${args.order}`)
      next.order = Math.floor(order)
    }
    // ── 改名（可选）：目录 + 索引里的四处引用一起动 ──
    let finalName = name
    const nextRaw = args && args.nextName !== undefined ? String(args.nextName).trim() : ''
    if (nextRaw !== '' && nextRaw !== name) {
      if (!isValidGroupSegment(nextRaw)) {
        return fail('error.rules.invalidGroup', `新场景名非法：${nextRaw}（${SEGMENT_RULE_HINT}）`)
      }
      if (name === GLOBAL_SCENE) return fail('error.rules.reservedScene', '「全局」是保留场景，不可改名', { name: GLOBAL_SCENE, action: 'rename', reason: '' })
      if (name === SHARED_GROUP || nextRaw === SHARED_GROUP) return fail('error.rules.invalidGroup', '_shared 是保留场景名，不可改名')
      if ((index.scenes && index.scenes[nextRaw]) || (await pathExists(join(memoriesRoot, nextRaw)))) {
        return fail('error.rules.nameTaken', `目标场景名已被占用：${nextRaw}`)
      }
      if (index.mode && index.mode.scene === name) {
        return fail('error.rules.sceneInMode', `场景「${name}」正处在当前模式，请先退出模式再改名`)
      }
      const fromDir = join(memoriesRoot, name)
      const toDir = join(memoriesRoot, nextRaw)
      let movedDir = false
      if (await pathExists(fromDir)) {
        try {
          await rename(fromDir, toDir)
          movedDir = true
        } catch (e) {
          return fail('error.rules.ioFailed', `场景目录改名失败：${message(e)}`)
        }
      }
      // 目录已经搬过去了：索引这一步失败就必须把目录搬回来，否则目录名与索引各说各话。
      try {
        const scenes = index.scenes || {}
        if (scenes[name]) {
          scenes[nextRaw] = scenes[name]
          delete scenes[name]
        } else {
          scenes[nextRaw] = { order: DEFAULT_GROUP_ORDER, createdAt: new Date().toISOString() }
        }
        index.scenes = scenes
        if (index.archives && index.archives[name]) {
          index.archives[nextRaw] = index.archives[name]
          delete index.archives[name]
        }
        // 该场景下的**记忆条目**也要跟着换前缀（2026-09-30 审查 P1-1）。不迁的话：改名后
        // 旧键 `<旧场景>/<名>` 在磁盘上找不到对应文件，`buildSnapshot` 的清理会把它删掉
        // （见 `memories/snapshot.ts` 的"索引有记录但文件已删"分支）→ 那条记忆失去索引条目
        // → `projectRule` 的 `enabled ?? true` 把它**重新启用** —— 用户显式停用的记忆复活，
        // 且 order / tags / pinned / note 一并丢失。记忆自己的改名路径（`ops/memory.ts`）
        // 一直是迁索引的，场景这条漏了同一件事。
        // 只换前缀、原值不动；`nextRaw` 的场景名已被上面的占用检查保证为空，不会覆盖。
        const sceneRules = index.rules || {}
        for (const id of Object.keys(sceneRules).filter((k) => k.startsWith(name + '/'))) {
          sceneRules[nextRaw + id.slice(name.length)] = sceneRules[id]
          delete sceneRules[id]
        }
        const act = normalizeActive(index.active)
        if (act !== null && act.indexOf(name) >= 0) index.active = act.map((n) => (n === name ? nextRaw : n))
        if (index.mode && index.mode.scene === name) index.mode = { ...index.mode, scene: nextRaw }
      } catch (e) {
        if (movedDir) {
          try { await rename(toDir, fromDir) } catch { /* 回滚失败：错误信息里如实带上原因 */ }
        }
        return fail('error.rules.ioFailed', `场景改名后索引更新失败：${message(e)}`)
      }
      finalName = nextRaw
    }

    if (finalName === GLOBAL_SCENE) next.label = GLOBAL_SCENE_LABEL
    index.scenes[finalName] = next
    await writeIndex(stateDir, index)
    invalidateSnapshot()
    return {
      ok: true,
      ...(finalName === name ? {} : { renamedFrom: name }),
      scene: sceneRecordOf(finalName, next),
    }
  }

  /**
   * 场景锁定（v0.8）：锁定后五个管理域（MCP/技能/子智能体/记忆/提示词）整体只读 ——
   * 场景页的档案编辑与功能页的启停/编辑都被拒（index.ts 的 handlers 守卫 + 界面禁用），
   * 场景自身的启停（进/退模式）不受影响。`locked` 必须显式给布尔值（与 rules-toggle 同一口径）。
   * 保留场景 `global` 不在场景页出现，不可锁。
   */
  async function rulesSceneLock(args: any): Promise<any> {
    const name = String((args && args.scene) || '').trim()
    if (!isValidGroupPath(name)) return fail('error.rules.invalidGroup', `场景名非法：${name || '(空)'}`)
    if (name === GLOBAL_SCENE || name === SHARED_GROUP) return fail('error.rules.reservedScene', '「全局 / _shared」是保留场景，不可锁定', { name: '全局 / _shared', action: 'lock', reason: '' })
    if (typeof (args && args.locked) !== 'boolean') {
      return fail('error.rules.invalidArgs', '缺少参数：locked 必须是布尔值（只按传入值写入，不做"翻转"推断）')
    }
    const index = await readIndex(stateDir)
    if (!index.scenes || !index.scenes[name]) return fail('error.rules.notFound', `场景不存在：${name}`)
    // 未启动的场景不能上锁（用户裁定）：锁定的意义是冻结**运行中**场景的配置。
    // 解锁随时允许 —— 否则退出模式后，被锁的场景就没人能解了。
    if (args.locked === true && (!index.mode || index.mode.scene !== name)) {
      return fail('error.rules.sceneNotActive', `场景「${name}」未启动：先启动再锁定`)
    }
    index.scenes[name] = { ...index.scenes[name], locked: args.locked === true }
    await writeIndex(stateDir, index)
    invalidateSnapshot()
    return { ok: true, scene: name, locked: args.locked === true }
  }

  /**
   * 删除场景：**仅空目录可删**（避免一次操作带走整组记忆）。
   * 同时删掉场景记录、把它从 `active` 集合里摘掉、清掉它的档案，避免悬空引用。
   * 保留场景 `global` 不可删除。
   *
   * 场景名在这里按**完整路径**寻址（`isValidGroupPath`，2026-09-30 审查 P2-4）：命名路径
   * （创建 / 改名目标 / 启用集合）一律要求单段，而历史与导入留下的多段记录得能**被清掉** ——
   * 否则它就成了"看得见、动不了"的死条目。删除只是定位 + 移入回收站，多段名不会造成歧义。
   */
  async function rulesRemoveScene(args: any): Promise<any> {
    const name = String((args && args.name) || '').trim()
    if (!isValidGroupPath(name)) return fail('error.rules.invalidGroup', `场景名非法：${name || '(空)'}`)
    if (name === SHARED_GROUP) return fail('error.rules.invalidGroup', `_shared 是保留场景名，不可删除`)
    if (name === GLOBAL_SCENE) return fail('error.rules.reservedScene', `「全局」是保留场景，不可删除（它的记忆对任何对话都生效）`, { name: GLOBAL_SCENE, action: 'delete', reason: '（它的记忆对任何对话都生效）' })
    const index = await readIndex(stateDir)
    // 场景不存在（既无记录也无目录）→ 明确报错，而不是假装删成功。
    if (!index.scenes?.[name] && !(await pathExists(join(memoriesRoot, name)))) {
      return fail('error.rules.notFound', `场景不存在：${name}`)
    }
    // 当前模式场景不可删：快照只在引擎里可退（rules service 反向注入会成环），
    // 直接删除会让运行时启停永久停在档案态且无恢复路径 → 给出可逆出路（先退出模式）。
    if (index.mode?.scene === name) {
      return fail('error.rules.sceneInMode', `场景「${name}」正处在当前模式，请先退出模式再删除`)
    }
    // 删除场景 = **连它下面的全部记忆一起去掉**（用户裁定）：不管有没有启用、是不是子目录、
    // 是不是 bundle 附件，统统收走。
    // 但一律**先移入回收站**（与场景记录、档案装在同一条条目里），所以「删错了」还能整条恢复：
    // 记忆文件按原来的相对路径放回，场景记录与档案也一起回来。
    const sceneDir = join(memoriesRoot, name)
    // 删除前先确认落点仍在根内（realpath 口径）—— 与 `rulesRemove` / `rulesRestore` 同一道闸。
    // 为什么删除侧最需要它（2026-09-30 审查 P1-2，已实测复现）：`memories/<场景>` 若是指向根外的
    // 目录链接（用户手工建、或旧布局迁移带进来的），下面 `collect` 的 `readdir` 会**列出链接目标
    // 的内容**，于是 `from` 拼成 `<memoriesRoot>/<场景>/x.md` 看着在根内、`rename` 实际作用于
    // **根外的真实文件** —— 删除场景会把 `D:\重要数据` 里的文件搬进回收站。`isValidGroupSegment`
    // 挡不住（名字本身合法），`lstat` 也挡不住（只看末级）。
    const deniedDir = await refuseOutsideRoot(sceneDir)
    if (deniedDir) return deniedDir
    const moves: Array<{ from: string; dest: string }> = []
    const collect = async (abs: string, rel: string): Promise<void> => {
      let items: import('node:fs').Dirent[] = []
      try {
        items = await readdir(abs, { withFileTypes: true })
      } catch {
        return   // 目录不存在（只有记录的场景）或读不了 → 当作没有文件
      }
      for (const item of items) {
        // 跳过符号链接（含 Windows junction），与 `snapshot.ts` 的 `discover` 同口径。
        // 上面那道 realpath 断言挡的是「场景目录本身是链接」；这一条挡的是「场景目录内的某一项是
        // 链接」—— 两者是不同的路径，缺一条就漏一条。链接本身也不搬走（它是环境相关的，
        // 不该被回收站带到另一台机器上），留给后面的 `rm` 清掉。
        if (item.isSymbolicLink()) continue
        const childAbs = join(abs, item.name)
        const childRel = rel === '' ? item.name : `${rel}/${item.name}`
        if (item.isDirectory()) await collect(childAbs, childRel)
        else moves.push({ from: childAbs, dest: childRel })
      }
    }
    await collect(sceneDir, '')
    // 该场景下每条记忆的索引条目（enabled / order / tags / pinned / note）一并收进回收站条目
    // 的 `data`（2026-09-30 审查 P1-1）。不带的话：恢复出来的记忆全部按 `enabled ?? true`
    // 重置 —— 用户停用的会复活，其余元数据归零。文件在回收站、元数据也得跟着在。
    const sceneRuleSubset: Record<string, unknown> = {}
    for (const id of Object.keys(index.rules || {})) {
      if (id.startsWith(name + '/')) sceneRuleSubset[id] = (index.rules as Record<string, unknown>)[id]
    }
    const trashed = await moveToTrash('scenes', name, moves, {
      record: (index.scenes && index.scenes[name]) || null,
      archive: (index.archives && index.archives[name]) || null,
      memories: moves.map((m) => m.dest),
      rules: sceneRuleSubset,
    })
    if (trashed.ok === false) {
      return fail('error.rules.ioFailed', `移入回收站失败：${trashed.error}`)
    }
    try {
      // 文件已搬空，剩下的只是空子目录；recursive + force 一并清掉。
      await rm(sceneDir, { recursive: true, force: true })
    } catch (e) {
      // 目录没清掉就把记忆放回去：宁可整个操作失败，也不要「文件在回收站、场景还留在列表里」。
      let rollbackFailed = 0
      for (const move of moves) {
        try { await moveOutOfTrash('scenes', trashed.id, move.dest, move.from) } catch { rollbackFailed += 1 }
      }
      // **回滚没做完就绝不 purge**：purge 会把条目整目录删掉，而没能放回的那些文件还在里面
      // —— 那是一次静默的**永久删除**（用户记忆），且场景目录还留在原地（一个被掏空的场景）。
      // 宁可留一条脏条目（界面看得见、能再点一次恢复），也不要"删干净"（审查 P0-2）。
      if (rollbackFailed > 0) {
        return fail(
          'error.rules.ioFailed',
          `删除场景目录失败：${message(e)}；另有 ${rollbackFailed} 个记忆文件没能放回原位，`
          + `它们仍在回收站条目 ${trashed.id} 里（未删除），可从回收站恢复`,
        )
      }
      try { await purgeTrashEntry('scenes', trashed.id) } catch { /* 同上 */ }
      return fail('error.rules.ioFailed', `删除场景目录失败：${message(e)}`)
    }
// 索引清理一次读-改-写：记录 + 启用集合悬空引用 + 该场景档案（否则 archives 留孤儿条目）。
    let dirty = false
    if (index.scenes && index.scenes[name]) {
      delete index.scenes[name]
      dirty = true
    }
    if (Array.isArray(index.active) && index.active.indexOf(name) >= 0) {
      index.active = index.active.filter((s) => s !== name)
      dirty = true
    }
    if (index.archives && index.archives[name]) {
      delete index.archives[name]
      dirty = true
    }
    // 记忆条目也跟着进了回收站（见上面的 `sceneRuleSubset`）→ 索引里同步删掉。不删的话会留下
    // "索引有记录、磁盘没文件"的悬空键：`buildSnapshot` 下一轮也会清掉，但中间那一轮界面会
    // 把它显示成"这条记忆不存在"，且恢复时 `data.rules` 合并回来会与残留键打架。显式删干净。
    if (index.rules) {
      for (const id of Object.keys(index.rules)) {
        if (id.startsWith(name + '/')) { delete index.rules[id]; dirty = true }
      }
    }
    if (dirty) await writeIndex(stateDir, index)
    invalidateSnapshot()
    return { ok: true, name, trashId: trashed.id, movedFiles: moves.length }
  }

  /** 场景回收站列表（只读）：`<hub>/trash/scenes-trash/<id>/manifest.json`。 */
  async function sceneTrashList(): Promise<any> {
    return { ok: true, trash: await listTrashEntries('scenes') }
  }

  /**
   * 从回收站恢复一个场景：重建记忆目录 + 写回记录与档案。
   * 同名场景已存在时**拒绝**（绝不覆盖既有场景）。
   *
   * 场景名按**完整路径**寻址（2026-09-30 审查 P2-4，与删除侧同口径）：回收站里的名字来自
   * 当初删掉的那条记录，多段名同样得能恢复回来 —— 否则删得掉、恢复不了，数据就卡在回收站里。
   */
  async function sceneTrashRestore(args: any): Promise<any> {
    const id = String((args && args.id) || '').trim()
    const entry = await readTrashEntry('scenes', id)
    if (!entry) return fail('error.rules.notFound', `回收站条目不存在：${id}`)
    const name = String(entry.name || '').trim()
    if (!isValidGroupPath(name)) return fail('error.rules.invalidGroup', `回收站里的场景名非法：${name || '(空)'}`)
    const index = await readIndex(stateDir)
    if (index.scenes?.[name]) return fail('error.rules.invalidGroup', `无法恢复，同名场景已存在：${name}`)
    const dir = join(memoriesRoot, name)
    // 恢复是**写入**方向：落点若是指向根外的目录链接，`mkdir` 会顺着链接成功、随后
    // `moveOutOfTrash` 把记忆文件写到**根外**去。与删除侧同一个根因（缺 realpath 根内断言），
    // 2026-09-30 审查 P1-2 的相邻面 —— 修一处必须一起修，否则只是把同一个洞挪了个方向。
    const deniedDir = await refuseOutsideRoot(dir)
    if (deniedDir) return deniedDir
    let entries: string[] = []
    try { entries = await readdir(dir) } catch { entries = [] }
    if (entries.filter((n) => !n.startsWith('.')).length > 0) {
      return fail('error.rules.sceneNotEmpty', `无法恢复，记忆目录「${name}」里已有内容，请先处理`)
    }
    const data = (entry.data || {}) as { record?: unknown; archive?: unknown; memories?: unknown; rules?: unknown }
    try {
      await mkdir(dir, { recursive: true })
    } catch (e) {
      return fail('error.rules.ioFailed', `重建场景目录失败：${message(e)}`)
    }
    // 删除场景时一起收进回收站的记忆文件：按原来的相对路径放回（目录已确认是空的，不会覆盖）。
    const files = Array.isArray(entry.files) ? entry.files : []
    const restored: string[] = []
    for (const rel of files) {
      try {
        await moveOutOfTrash('scenes', id, String(rel), join(dir, String(rel)))
        restored.push(String(rel))
      } catch (e) {
        // 已放回的文件**搬回回收站**再报错：原来这里是直接 return，已放回的那几个留在记忆目录里
        // —— 下一次点恢复会撞上面那条「目录里已有内容」的检查，于是这个场景**永远恢复不了**
        // （审查 P0-2）。回滚失败也如实说清楚，别让用户以为还能原样重试。
        let backFailed = 0
        for (const doneRel of [...restored].reverse()) {
          try { await moveIntoTrash('scenes', id, join(dir, doneRel), doneRel) } catch { backFailed += 1 }
        }
        const tail = backFailed === 0
          ? '（已放回的记忆文件已退回回收站，可重试）'
          : `（另有 ${backFailed} 个文件没能退回回收站，它们现在在记忆目录「${name}」里，请先手工处理再重试）`
        return fail('error.rules.ioFailed', `恢复记忆文件失败：${message(e)}${tail}`)
      }
    }
    if (data.record && typeof data.record === 'object') index.scenes = { ...(index.scenes || {}), [name]: data.record as SceneIndexEntry }
    if (data.archive && typeof data.archive === 'object') index.archives = { ...(index.archives || {}), [name]: data.archive as SceneArchive }
    // 记忆条目随文件一起回来（删除时存进 `data.rules`，见 `rulesRemoveScene`）——
    // 否则恢复出来的记忆全部按 `enabled ?? true` 重置，用户停用的会复活（审查 P1-1）。
    // **只补不覆盖**：同名键若已存在以现有为准（上面已拒绝同名场景，正常情况下不会撞）。
    if (data.rules && typeof data.rules === 'object' && !Array.isArray(data.rules)) {
      const rules = index.rules || (index.rules = {})
      for (const [ruleId, ruleEntry] of Object.entries(data.rules as Record<string, RuleIndexEntry>)) {
        if (rules[ruleId] === undefined) rules[ruleId] = ruleEntry
      }
    }
    await writeIndex(stateDir, index)
    await purgeTrashEntry('scenes', id)
    invalidateSnapshot()
    return { ok: true, name, restoredFiles: restored.length }
  }

  /** 永久删除一条场景回收站条目。 */
  async function sceneTrashDelete(args: any): Promise<any> {
    const id = String((args && args.id) || '').trim()
    const gone = await purgeTrashEntry('scenes', id)
    if (!gone) return fail('error.rules.notFound', `回收站条目不存在：${id}`)
    return { ok: true, id }
  }

  /**
   * 提示词预设改名后**同步场景绑定**：把所有 `scenes[].prompt === from` 改成 `to`。
   * 由 AGENTS.md 预设库的改名路径调用——绑定存在 `memories-index.json` 里，预设库
   * 自己看不到它，不叫这一声改名就会留下悬空绑定（场景卡片显示「预设不存在」）。
   * @returns 改了几个场景。
   */
  async function rulesRebindPrompt(args: any): Promise<any> {
    const from = String((args && args.from) || '').trim()
    const to = String((args && args.to) || '').trim()
    if (!from || !to) return fail('error.rules.invalidArgs', '需要 from 与 to 两个预设 id')
    const index = await readIndex(stateDir)
    const scenes = index.scenes || {}
    let changed = 0
    for (const [name, entry] of Object.entries(scenes)) {
      if (entry && entry.prompt === from) { scenes[name] = { ...entry, prompt: to }; changed++ }
    }
    if (changed) {
      index.scenes = scenes
      await writeIndex(stateDir, index)
      invalidateSnapshot()
    }
    return { ok: true, from, to, changed }
  }

  return { rulesSetActive, rulesCreateScene, rulesUpdateScene, rulesSceneLock, rulesRemoveScene, sceneTrashList, sceneTrashRestore, sceneTrashDelete, rulesRebindPrompt }
}
