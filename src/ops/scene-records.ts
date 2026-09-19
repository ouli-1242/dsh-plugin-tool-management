// 规则/记忆域的**场景 ops**（2026-09-19 从 memories/service.ts 的 createMemoriesService 闭包抽出）。
//
// 启用场景切换、场景记录增删改、场景锁、场景回收站（管场景记录与档案，与记忆回收站分开）、
// 提示词改绑。动的是 index 的 scenes / active 切片与 AGENTS.md 投影，与记忆正文 ops 互不调用。

import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { SceneArchive } from '../memories/archive.js'
import { listTrashEntries, moveOutOfTrash, moveToTrash, purgeTrashEntry, readTrashEntry } from '../hub.js'
import { MAX_DESCRIPTION_LENGTH, DEFAULT_GROUP_ORDER, GLOBAL_SCENE, GLOBAL_SCENE_LABEL, SHARED_GROUP, SEGMENT_RULE_HINT, isValidGroupSegment, isValidGroupPath, message, fail } from '../memories/constants.js'
import { normalizeActive, collapseActiveForNewScene } from '../memories/projection.js'
import { readIndex, writeIndex, sceneRecordOf, normalizeScenePromptId, pathExists } from '../memories/index-io.js'
import type { SceneIndexEntry } from '../memories/index-io.js'
import type { MemoriesOpsCtx } from './ctx.js'

/** 组装本域 op。rc 由 createMemoriesService 组装，契约见 ./ctx.ts。 */
export function buildSceneRecordOps(rc: MemoriesOpsCtx) {
  const { ensureLayout, invalidateSnapshot, presetExistsSync, memoriesRoot, sceneRows, snapshot, stateDir } = rc

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
      if (!isValidGroupPath(name)) {
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
   * 场景名是**单个路径段**（不允许 `a/b`）：界面把场景当一级列表展示，
   * 允许多段只会让「记忆的场景」与「目录层级」两套语义互相打架。
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
   * 保留场景 `global` 不可删除；场景名口径与创建一致（单个路径段）。
   */
  async function rulesRemoveScene(args: any): Promise<any> {
    const name = String((args && args.name) || '').trim()
    if (!isValidGroupSegment(name)) return fail('error.rules.invalidGroup', `场景名非法：${name || '(空)'}`)
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
    const moves: Array<{ from: string; dest: string }> = []
    const collect = async (abs: string, rel: string): Promise<void> => {
      let items: import('node:fs').Dirent[] = []
      try {
        items = await readdir(abs, { withFileTypes: true })
      } catch {
        return   // 目录不存在（只有记录的场景）或读不了 → 当作没有文件
      }
      for (const item of items) {
        const childAbs = join(abs, item.name)
        const childRel = rel === '' ? item.name : `${rel}/${item.name}`
        if (item.isDirectory()) await collect(childAbs, childRel)
        else moves.push({ from: childAbs, dest: childRel })
      }
    }
    await collect(sceneDir, '')
    const trashed = await moveToTrash('scenes', name, moves, {
      record: (index.scenes && index.scenes[name]) || null,
      archive: (index.archives && index.archives[name]) || null,
      memories: moves.map((m) => m.dest),
    })
    if (trashed.ok === false) {
      return fail('error.rules.ioFailed', `移入回收站失败：${trashed.error}`)
    }
    try {
      // 文件已搬空，剩下的只是空子目录；recursive + force 一并清掉。
      await rm(sceneDir, { recursive: true, force: true })
    } catch (e) {
      // 目录没清掉就把记忆放回去：宁可整个操作失败，也不要「文件在回收站、场景还留在列表里」。
      for (const move of moves) {
        try { await moveOutOfTrash('scenes', trashed.id, move.dest, move.from) } catch { /* 尽力而为 */ }
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
   */
  async function sceneTrashRestore(args: any): Promise<any> {
    const id = String((args && args.id) || '').trim()
    const entry = await readTrashEntry('scenes', id)
    if (!entry) return fail('error.rules.notFound', `回收站条目不存在：${id}`)
    const name = String(entry.name || '').trim()
    if (!isValidGroupSegment(name)) return fail('error.rules.invalidGroup', `回收站里的场景名非法：${name || '(空)'}`)
    const index = await readIndex(stateDir)
    if (index.scenes?.[name]) return fail('error.rules.invalidGroup', `无法恢复，同名场景已存在：${name}`)
    const dir = join(memoriesRoot, name)
    let entries: string[] = []
    try { entries = await readdir(dir) } catch { entries = [] }
    if (entries.filter((n) => !n.startsWith('.')).length > 0) {
      return fail('error.rules.sceneNotEmpty', `无法恢复，记忆目录「${name}」里已有内容，请先处理`)
    }
    const data = (entry.data || {}) as { record?: unknown; archive?: unknown; memories?: unknown }
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
        return fail('error.rules.ioFailed', `恢复记忆文件失败（已放回 ${restored.length}/${files.length}）：${message(e)}`)
      }
    }
    if (data.record && typeof data.record === 'object') index.scenes = { ...(index.scenes || {}), [name]: data.record as SceneIndexEntry }
    if (data.archive && typeof data.archive === 'object') index.archives = { ...(index.archives || {}), [name]: data.archive as SceneArchive }
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
