// 规则/记忆域的**回收站 ops**（从 memories/service.ts 的 createMemoriesService 闭包抽出）。
//
// 删除进回收站、从回收站恢复、回收站列出与彻底删除。与记忆正文 ops 分域，
// 但共用 copyIntoMemoriesTrash 等入口，经 MemoriesOpsCtx 显式传入。

import { copyFile, cp, lstat, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isValidTrashId, readTrashPayloadFiles, trashEntryPath, type TrashKind } from '../hub.js'
import { LEGACY_BUNDLE_DOC, bundleDocName, isValidGroupSegment, isValidGroupPath, fail, MEMORIES_TRASH_DIR } from '../memories/constants.js'
import { readIndex, writeIndex } from '../memories/index-io.js'
import { isValidSegment } from '../paths.js'
import type { MemoriesOpsCtx } from './ctx.js'

/** 组装本域 op。rc 由 createMemoriesService 组装，契约见 ./ctx.ts。 */
export function buildTrashOps(rc: MemoriesOpsCtx) {
  const { buildProjected, copyIntoMemoriesTrash, invalidateSnapshot, locateRule, parseId, refuseOutsideRoot, memoriesRoot, stateDir } = rc

  async function rulesRemove(args: any): Promise<any> {
    const id = String((args && args.id) || '')
    const parts = parseId(id)
    if (!parts) return fail('error.rules.notFound', `规则不存在：${id}`)
    const located = await locateRule(parts.group, parts.name)
    if (!located) return fail('error.rules.notFound', `规则不存在：${id}`)
    // 删除前确认落点仍在根内（realpath 口径）：`located` 是顺着磁盘发现的，中间目录可能是链接。
    const denied = await refuseOutsideRoot(located.entryPath)
    if (denied) return denied
    const trashId = await copyIntoMemoriesTrash(located, parts.group, parts.name)
    if (located.kind === 'bundle') await rm(located.entryPath, { recursive: true, force: true })
    else await rm(located.docPath, { force: true })
    const index = await readIndex(stateDir)
    delete index.rules[id]
    await writeIndex(stateDir, index)
    invalidateSnapshot()
    return { ok: true, trashId }
  }

  /**
   * 同组里第一个空出来的退号名：`测` → `测（1）` → `测（2）`…（全角括号，与界面 `uniqueName`
   * 同一写法）。超过段名长度上限的候选直接跳过 —— 退号名本身也必须是合法段名，否则
   * `locateRule` 查不到、恢复时还会写出一个磁盘不接受的名字。
   */
  async function nextFreeRuleName(group: string, name: string): Promise<string | null> {
    for (let i = 1; i <= 999; i += 1) {
      const candidate = `${name}（${i}）`
      if (!isValidGroupSegment(candidate)) return null
      if (!(await locateRule(group, candidate))) return candidate
    }
    return null
  }

  async function rulesRestore(args: any): Promise<any> {
    const trashId = String((args && args.trashId) || '')
    if (!isValidTrashId(trashId)) return fail('error.rules.notFound', `回收站条目不存在：${trashId}`)
    const trashDir = join(stateDir, MEMORIES_TRASH_DIR, trashId)
    let manifest: { group: string; name: string; form: 'flat' | 'bundle'; deletedAt: string }
    try {
      manifest = JSON.parse(await readFile(join(trashDir, 'manifest.json'), 'utf8')) as typeof manifest
    } catch {
      return fail('error.rules.notFound', `回收站条目不存在：${trashId}`)
    }
    if (
      !manifest || typeof manifest.name !== 'string' || typeof manifest.group !== 'string'
      || !isValidGroupSegment(manifest.name)
      // `group` 是**磁盘数据**（manifest.json 可能被手改 / 别的进程写 / 随一份恶意档案包进来），
      // 而它是拼进 `join(memoriesRoot, group)` 的那一段 —— 只判类型的话 `../..` 就能把正文写到
      // 记忆根之外（`mkdir({recursive:true})` 还会顺手把目录建出来）。同文件 `rulesTrashList`
      // 一直是有这道判据的（`if (group !== '' && !isValidGroupPath(group)) continue`），
      // 两条路径口径必须一致。
      || (manifest.group !== '' && !isValidGroupPath(manifest.group))
    ) {
      return fail('error.rules.notFound', `回收站条目损坏：${trashId}`)
    }
    // 恢复目标已存在（期间用户重建了同名规则）→ 默认拒绝，避免覆盖。
    //
    // 「同名先问一句」（用户要求）：界面上不该静默退号、也不该只丢一句错误让人自己
    // 回去改名。所以拒绝时**连候选名字一起回**（`params.next`）—— 弹窗才能如实写出"确认后
    // 会叫 `测（1）`"。用户点确认后带 `dedupe: true` 再来一次，这一次真的按退号的名字恢复。
    //
    // `dedupe` 是**可选入参、缺省即旧行为**：模型工具（memory_manager_*）走的是同一个 op，
    // 它们依赖"撞名就拒"来决定新建还是更新，不能因为界面想要退号就改掉这条语义。
    const conflict = await locateRule(manifest.group, manifest.name)
    let name = manifest.name
    if (conflict) {
      const next = await nextFreeRuleName(manifest.group, manifest.name)
      if (args?.dedupe !== true || !next) {
        // 专用错误码（四个回收站统一）：界面按它认出"这是撞名"，据此弹确认窗 —— 而不是靠
        // 比文案。`error.rules.exists` 留给 `rules-create`，那条是"新建撞名"，语义不同。
        return fail('error.dup.conflict', `已存在同名记忆：${conflict.id}`, {
          name: manifest.name,
          ...(next ? { next } : {}),
        })
      }
      name = next
    }
    const renamed = name !== manifest.name
    const form = manifest.form === 'bundle' ? 'bundle' : 'flat'
    // 落点根内断言（realpath 口径）：`isValidGroupPath` 只挡 `..` 与分隔符，挡不住
    // 「中间目录是指向根外的链接」。与 `rulesRemove` 的删除前断言同一道闸。
    const groupDir = join(memoriesRoot, manifest.group)
    const denied = await refuseOutsideRoot(groupDir)
    if (denied) return denied
    // 恢复 = 先复制、后删回收站条目。**复制中途失败必须回滚**：
    // 原来这里 `cp` / `copyFile` 都没有 try/catch，失败时目标留下半份内容、回收站条目仍在，
    // 于是下一次点恢复会撞上面那条「同名记忆已存在」—— 这条记忆**永远恢复不了**，只能人工
    // 去删目录。场景回收站（`sceneTrashRestore`）早有这条回滚（`moveIntoTrash` 反向搬回），
    // 记忆回收站这条缺了。这里方向相反：源还在回收站，所以回滚是**删掉没放完整的副本**。
    const target = form === 'bundle'
      ? join(groupDir, name)
      : join(groupDir, name + '.md')
    try {
      await mkdir(groupDir, { recursive: true })
      if (form === 'bundle') await cp(join(trashDir, 'bundle'), target, { recursive: true })
      else await copyFile(join(trashDir, 'rule.md'), target)
    } catch (e) {
      let cleaned = true
      try { await rm(target, { recursive: true, force: true }) }
      catch (cleanupError) {
        // 落点**本来就没建成**时（父路径不是目录 → ENOTDIR；`force` 已吞掉 ENOENT），
        // 没有残留要清，别把它报成「清理失败」——那会让用户去手工删一个不存在的路径。
        const code = (cleanupError as NodeJS.ErrnoException)?.code
        cleaned = code === 'ENOENT' || code === 'ENOTDIR'
      }
      // 清理失败也如实说清楚，别让用户以为还能原样重试。
      const tail = cleaned
        ? '（未放回完整的落点已清理，回收站条目仍在，可直接重试）'
        : `（未放回完整的落点没能清理：${target}，请先手工删除再重试）`
      return fail('error.rules.ioFailed', `恢复记忆失败：${String((e as Error)?.message ?? e)}${tail}`)
    }
    await rm(trashDir, { recursive: true, force: true })
    invalidateSnapshot()
    // 回传**最终落盘的名字**：退号恢复时它与回收站里的原名不同，界面要按它来回执
    // （见 42-shared-ui.js 的 `resultRestore`），否则用户看到的是"已恢复：测"而磁盘上叫「测（1）」。
    return {
      ok: true,
      name,
      renamed,
      rule: await buildProjected(manifest.group ? `${manifest.group}/${name}` : name),
    }
  }

  /**
   * 记忆回收站列表（只读）：`<stateDir>/trash/memories-trash/<trashId>/`（`rulesRemove` 移入，
   * `rulesRestore` 恢复）。损坏或内容缺失的条目跳过，不让一个坏条目挡住整份列表。
   */
  async function rulesTrashList(): Promise<any> {
    const root = join(stateDir, MEMORIES_TRASH_DIR)
    let ids: string[] = []
    try {
      ids = await readdir(root)
    } catch {
      return { ok: true, entries: [] } // 目录不存在 = 回收站为空
    }
    const entries: Array<{ trashId: string; group: string; name: string; form: 'flat' | 'bundle'; deletedAt: string; bytes: number }> = []
    for (const trashId of ids) {
      if (!isValidTrashId(trashId)) continue
      const dir = join(root, trashId)
      try {
        const st = await lstat(dir)
        if (!st.isDirectory() || st.isSymbolicLink()) continue
        const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
        if (!manifest || typeof manifest.name !== 'string' || !isValidGroupSegment(manifest.name)) continue
        const group = typeof manifest.group === 'string' ? manifest.group : ''
        if (group !== '' && !isValidGroupPath(group)) continue
        const form: 'flat' | 'bundle' = manifest.form === 'bundle' ? 'bundle' : 'flat'
        let bytes = 0
        try {
          const bundleDoc = form === 'bundle'
            ? join(dir, 'bundle', bundleDocName(manifest.name))
            : join(dir, 'rule.md')
          bytes = (await stat(bundleDoc)).size
        } catch {
          // 兼容旧回收站条目（正文仍叫 SKILL.md）；仍读不到就按 0 计，恢复时由 rulesRestore 兜底报错。
          if (form === 'bundle') {
            try { bytes = (await stat(join(dir, 'bundle', LEGACY_BUNDLE_DOC))).size } catch { /* 内容缺失 */ }
          }
        }
        entries.push({ trashId, group, name: manifest.name, form, deletedAt: String(manifest.deletedAt || ''), bytes })
      } catch { /* 损坏条目跳过 */ }
    }
    entries.sort((a, b) => (a.deletedAt === b.deletedAt ? b.trashId.localeCompare(a.trashId) : b.deletedAt.localeCompare(a.deletedAt)))
    return { ok: true, entries }
  }

  /** 永久删除回收站条目（不可恢复）。 */
  async function rulesTrashRemove(args: any): Promise<any> {
    const trashId = String((args && args.trashId) || '')
    if (!isValidTrashId(trashId)) return fail('error.rules.notFound', `回收站条目不存在：${trashId}`)
    const dir = join(stateDir, MEMORIES_TRASH_DIR, trashId)
    try {
      const st = await lstat(dir)
      if (!st.isDirectory()) return fail('error.rules.notFound', `回收站条目不存在：${trashId}`)
    } catch {
      return fail('error.rules.notFound', `回收站条目不存在：${trashId}`)
    }
    await rm(dir, { recursive: true, force: true })
    return { ok: true }
  }

  /**
   * 回收站「详情」（只读）：把一条条目的内容读出来给界面看一眼"删掉的到底是什么"。
   *
   * 用户 ：「回收站的每条信息应该增加一个详情按键，点开就能看这个信息是什么样子，
   * 不能更改内容，没有保存按键」。所以这里**只有读**：不写盘、不改名、不动回收站条目。
   *
   * 为什么是一条跨域的 op 而不是五个域各加一条：五个回收站落在**三套不同的目录布局**里 ——
   *   hub 四类：`<hub>/trash/<kind>-trash/<id>/`（`trashEntryPath`）
   *   记忆：   `<stateDir>/trash/memories-trash/<trashId>/`
   *   技能：   `<hub>/trash/skills-trash/<id>/`（skills 域的 `trashRootPath()`，由 index 注入）
   * 但"读出来给人看"这件事完全一样，交给 `readTrashPayloadFiles` 一个函数做完，
   * 上限 / 二进制判据 / 哪些名字算清单只写一遍。
   *
   * 条目目录不存在 / 不是目录 → 明确报"条目不存在"（与"目录在、但里面没有可显示的文件"
   * 分开：前者是条死链，后者是一条正常但没内容的记录）。读不动的单个文件由
   * `readTrashPayloadFiles` 自己跳过，不抛 —— 详情打不开不该影响用户对这条目做恢复 / 永久删除。
   */
  async function trashPreview(args: any): Promise<any> {
    const domain = String((args && args.domain) || '')
    const id = String((args && args.id) || '').trim()
    const hubKinds: Record<string, TrashKind> = { presets: 'prompts', quick: 'quick-prompts', agents: 'subagents', scenes: 'scenes' }
    let dir: string | null = null
    if (hubKinds[domain] || domain === 'memories') {
      // hub 四类与记忆回收站的条目名都由 `newTrashId()` 生成（时间戳 base36 + uuid 前 8 位），
      // 走那一套严格白名单 —— 它同时也是 `rulesRestore` / 硬删除用的同一道闸。
      if (!isValidTrashId(id)) return fail('error.rules.notFound', `回收站条目不存在：${id}`)
      dir = hubKinds[domain]
        ? trashEntryPath(hubKinds[domain], id)
        : join(stateDir, MEMORIES_TRASH_DIR, id)
    } else if (domain === 'skills') {
      // ⚠️ 技能回收站的条目名是 `${Date.now()}-${randomUUID()}`（见 core.ts 的移入回收站那段），
      // **不满足** `isValidTrashId` 那条白名单（多段连字符 + 大写十六进制）—— 拿它去判会把
      // 每一条技能条目都判成"不存在"，界面上就是"详情点了没反应"。
      // 这里换成与 `skill-trash.ts` 的 `entryPath` 同一个口径：能安全当**一个路径段**即可
      //（不含分隔符 / 不是 `.` `..` / 首尾无空白与点）。以点开头的一律拒 —— `listTrash()`
      // 本来就把 `.stage-*` 那类临时目录排除在外，界面拿不到它们，这里也不该读得到。
      if (!isValidSegment(id, 128) || id.startsWith('.'))
        return fail('error.rules.notFound', `回收站条目不存在：${id}`)
      dir = rc.skillsTrashDir ? join(rc.skillsTrashDir, id) : null
    } else return fail('error.rules.notFound', `这个回收站不支持查看详情：${domain || '(空)'}`)
    if (!dir) return fail('error.rules.notFound', `回收站条目不存在：${id}`)
    // 条目目录本身必须真实存在（`readTrashPayloadFiles` 对不存在的目录返回空数组，
    // 那种"空"与"条目不存在"要分开：前者能恢复、后者是条死链）。
    try {
      const st = await lstat(dir)
      if (!st.isDirectory() || st.isSymbolicLink()) return fail('error.rules.notFound', `回收站条目不存在：${id}`)
    } catch {
      return fail('error.rules.notFound', `回收站条目不存在：${id}`)
    }
    // 清单也一并回给界面（用户 ：「回收站的详细功能做的不够好，显示的内容不够全，
    // 例如场景没有显示勾选了什么」）：场景的档案、记忆的场景 / 形态都在 `manifest.json` 里，
    // 只回文件列表的话，详情页能看到的就只剩"有几个文件"。
    // 读不到 / 坏了就回 null —— 详情页按"只有文件"那一档渲染，不因为清单缺了就整页报错。
    let manifest: unknown = null
    try { manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) } catch { manifest = null }
    return { ok: true, id, domain, manifest, files: await readTrashPayloadFiles(dir) }
  }

  return { rulesRemove, rulesRestore, rulesTrashList, rulesTrashRemove, trashPreview }
}
