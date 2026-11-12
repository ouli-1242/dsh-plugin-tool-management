// 自主记忆的**独立根目录**与一次性迁移。
//
// 为什么要独立：用户手写记忆住在 `memories/` 下，与场景单选、`memories-index.json` 的
// 启停、以及「进一个场景就不能开别的场景」那套机制绑在一起。自主记忆是模型写的、
// 低权威、要衰减淘汰的东西，混进去会出现两个具体故障：
//   ① `global/` 下的自动文件会被用户记忆段**全文**注入一次、又被自动段注入一次（双重计费）；
//   ② 用户停用一个场景 / 切换场景时，自动条目跟着一起消失，而它根本不属于任何场景。
//
// 所以正文搬到 `evolution/notes/`，索引也用这一份目录下的 `memories-index.json`
// （同结构、同 IO，但物理隔离）：用户记忆页、场景档案、导出、回收站都再也碰不到它。
//
// 目录即层，只剩两种：`global/`（任何项目）与 `_ws/<hash16>/`（本项目）。
// 旧版本留下的 `_session/<sid>/` 与场景层文件不删：迁进目标层并标成 archived，
// 数据不丢、不注入，用户能在弹窗里看到它们。

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { GLOBAL_SCENE, MEMORIES_TRASH_DIR, WORKSPACE_GROUP_PREFIX, isValidGroupPath, type MemoryLayer } from '../memories/constants.js'
import { parseSkillDoc } from '../skills/core.js'
import { rewriteFrontmatterFields } from '../skills/frontmatter.js'
import { newTrashId } from '../trash-id.js'

/** hub 内相对目录（与 `evolution/state.json` 同一个 stateDir）。 */
export const AUTO_NOTES_DIR = 'evolution/notes'
/** 迁移标记：存在即表示这份库已经迁过，避免每次重建 catalog 都重复搬。 */
export const AUTO_NOTES_MARKER = '.migrated'

export const autoNotesRootOf = (stateDir: string): string => join(stateDir, AUTO_NOTES_DIR)

export interface NotesMigrationReport {
  /** 这次真的跑了迁移（false = 已有标记或没有旧文件）。 */
  ran: boolean
  /** 搬走的文件数。 */
  moved: number
  /** 跳过（非 auto / 读不动 / 目标已存在）的数量。 */
  skipped: number
  /** 因没有工作区身份而降成全局 archived 的旧会话/场景条目数。 */
  archived: number
  error?: string
}

const exists = async (p: string): Promise<boolean> => {
  try { await stat(p); return true } catch { return false }
}

/** 递归列出 root 下的 .md，返回相对 root 的 posix 路径。读不动的目录整支跳过。 */
async function mdFilesOf(root: string, prefix = ''): Promise<string[]> {
  let names: string[] = []
  try { names = await readdir(join(root, prefix)) } catch { return [] }
  const out: string[] = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    const rel = prefix === '' ? name : posix.join(prefix, name)
    const abs = join(root, rel)
    try {
      const info = await stat(abs)
      if (info.isDirectory()) out.push(...await mdFilesOf(root, rel))
      else if (info.isFile() && name.endsWith('.md')) out.push(rel)
    } catch { /* 探测与读取之间被删：跳过 */ }
  }
  return out
}

/**
 * 旧 group → 新 group。
 *
 * 只有四种输入：`global` / `_ws/<hash>` / `_session/<sid>` / 普通场景名。
 * 前两种原样保留；后两种没有工作区身份就落到 `global`，并且由调用方标成 archived
 * （它们是"这次对话/这个场景才成立"的旧约束，不该在所有项目里生效）。
 */
export function targetGroupOf(oldGroup: string, workspaceHash?: string): { group: string; archived: boolean } {
  const head = oldGroup.split('/')[0]
  if (head === GLOBAL_SCENE) return { group: GLOBAL_SCENE, archived: false }
  if (head === WORKSPACE_GROUP_PREFIX && oldGroup.split('/').length === 2) {
    return { group: oldGroup, archived: false }
  }
  if (workspaceHash && workspaceHash !== '') {
    return { group: `${WORKSPACE_GROUP_PREFIX}/${workspaceHash}`, archived: true }
  }
  return { group: GLOBAL_SCENE, archived: true }
}

/**
 * 把旧 `memories/` 下的自动条目搬进独立根。
 *
 * 幂等：标记文件存在就直接返回。失败不抛（迁移失败只影响"旧条目看不见"，不该让启动挂掉），
 * 但会把原因写进返回值，调用方可以记日志。
 */
export async function migrateLegacyAutoNotes(deps: {
  memoriesRoot: string
  stateDir: string
  autoRoot?: string
  workspaceHash?: string
}): Promise<NotesMigrationReport> {
  const autoRoot = deps.autoRoot ?? autoNotesRootOf(deps.stateDir)
  const report: NotesMigrationReport = { ran: false, moved: 0, skipped: 0, archived: 0 }
  try {
    await mkdir(autoRoot, { recursive: true })
    if (await exists(join(autoRoot, AUTO_NOTES_MARKER))) return report
    const files = await mdFilesOf(deps.memoriesRoot)
    for (const rel of files) {
      const src = join(deps.memoriesRoot, rel)
      let text: string
      try { text = await readFile(src, 'utf8') } catch { report.skipped++; continue }
      let origin = ''
      try { origin = String((parseSkillDoc(text) as any)?.map?.origin ?? '') } catch { /* 解析失败按用户记忆处理 */ }
      if (origin !== 'auto') { report.skipped++; continue }

      const oldGroup = posix.dirname(rel) || GLOBAL_SCENE
      const { group, archived } = targetGroupOf(oldGroup, deps.workspaceHash)
      if (!isValidGroupPath(group)) { report.skipped++; continue }
      const destDir = join(autoRoot, group)
      await mkdir(destDir, { recursive: true })
      const base = posix.basename(rel)
      let dest = join(destDir, base)
      // 同名不覆盖：旧全局与旧会话可能各有一条同名笔记，后者加后缀保留。
      for (let i = 2; await exists(dest) && i <= 20; i++) {
        dest = join(destDir, base.replace(/\.md$/, `-${i}.md`))
      }
      if (await exists(dest)) { report.skipped++; continue }
      let body = text
      if (archived) {
        body = rewriteFrontmatterFields(text, {
          auto_status: 'archived',
          auto_migrated_from: oldGroup,
        })
        report.archived++
      }
      await writeFile(dest, body, { encoding: 'utf8', mode: 0o600 })
      // 改名留档而不是删：跨卷 / 权限导致 rename 失败时，目标已经写好、原件仍在，
      // 最多是磁盘上多一份旧副本，绝不丢数据。后缀不是 .md，发现器不会再扫到它。
      await rename(src, `${src}.migrated`).catch(() => undefined)
      report.moved++
    }
    // 标记只在整轮扫完之后写：中途崩了下次会重跑，比"标记在、一半文件没搬"好。
    await writeFile(join(autoRoot, AUTO_NOTES_MARKER), new Date().toISOString() + '\n', { encoding: 'utf8', mode: 0o600 })
    report.ran = true
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e)
  }
  return report
}

/**
 * 提升为用户记忆后清理原件：移进 `evolution/trash/`，可人工找回。
 *
 * 正文已经复制成用户记忆，这里的副本只防"提升写失败后原件也没了"；普通删除走
 * {@link moveAutoNoteToTrash}，不再落进这个隐藏目录。
 */
export async function trashAutoNote(autoRoot: string, stateDir: string, id: string): Promise<boolean> {
  const slash = id.lastIndexOf('/')
  if (slash <= 0) return false
  const group = id.slice(0, slash)
  const name = id.slice(slash + 1)
  if (!isValidGroupPath(group) || name === '') return false
  const src = join(autoRoot, group, `${name}.md`)
  if (!await exists(src)) return false
  const dir = join(stateDir, 'evolution', 'trash')
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  await rename(src, join(dir, `${stamp}-${group.replaceAll('/', '_')}-${name}.md`))
  return true
}

/** 统一回收站里的自动记忆条目清单（`manifest.json` 的自动字段）。 */
export interface AutoTrashManifest {
  group: string
  name: string
  form: 'flat'
  deletedAt: string
  auto: true
  autoId: string
  autoLayer: MemoryLayer
  autoStatus: 'archived'
}

const trashDirOf = (stateDir: string, trashId: string): string => join(stateDir, MEMORIES_TRASH_DIR, trashId)

/** 读一条自动记忆回收站条目；不是自动条目 / 损坏 / 不存在都返回 null。 */
export async function readAutoTrashManifest(stateDir: string, trashId: string): Promise<AutoTrashManifest | null> {
  try {
    const raw = JSON.parse(await readFile(join(trashDirOf(stateDir, trashId), 'manifest.json'), 'utf8'))
    if (!raw || raw.auto !== true) return null
    if (typeof raw.autoId !== 'string' || raw.autoId === '') return null
    if (typeof raw.group !== 'string' || !isValidGroupPath(raw.group)) return null
    if (typeof raw.name !== 'string' || raw.name === '') return null
    if (raw.autoLayer !== 'global' && raw.autoLayer !== 'workspace') return null
    return {
      group: raw.group,
      name: raw.name,
      form: 'flat',
      deletedAt: typeof raw.deletedAt === 'string' ? raw.deletedAt : '',
      auto: true,
      autoId: raw.autoId,
      autoLayer: raw.autoLayer,
      autoStatus: 'archived',
    }
  } catch {
    return null
  }
}

/** 按条目 id 找已有的自动回收站条目（重复停用不重复建）。 */
export async function findAutoTrashByNoteId(stateDir: string, id: string): Promise<string | null> {
  let ids: string[] = []
  try {
    ids = await readdir(join(stateDir, MEMORIES_TRASH_DIR))
  } catch {
    return null
  }
  for (const trashId of ids) {
    const manifest = await readAutoTrashManifest(stateDir, trashId)
    if (manifest !== null && manifest.autoId === id) return trashId
  }
  return null
}

/**
 * 停用 = 复制一份进统一回收站（原文件保留为 archived）。
 *
 * 为什么是复制不是移动：维护扫描会在工作区目录回来时按 id 恢复条目，catalog 重建也要
 * 能读到这条 archived 记录。移动会把「恢复」变成一条找不到文件的死路。永久删除由
 * `purgeTrash` 负责，会同时删掉原文件。
 *
 * 同一 id 已有条目时复用旧 trashId，并用当前正文刷新 `rule.md`：重复停用（例如维护扫描
 * 与用户操作撞车）不该在回收站里堆出第二份，恢复时也不该拿到旧内容。
 */
export async function archiveAutoNote(
  autoRoot: string,
  stateDir: string,
  id: string,
  layer: MemoryLayer,
): Promise<string | null> {
  const slash = id.lastIndexOf('/')
  if (slash <= 0) return null
  const group = id.slice(0, slash)
  const name = id.slice(slash + 1)
  if (!isValidGroupPath(group) || name === '') return null
  const src = join(autoRoot, group, `${name}.md`)
  let text: string
  try {
    text = await readFile(src, 'utf8')
  } catch {
    return null
  }
  const existing = await findAutoTrashByNoteId(stateDir, id)
  if (existing !== null) {
    try {
      await writeFile(
        join(trashDirOf(stateDir, existing), 'rule.md'),
        rewriteFrontmatterFields(text, {
          auto_status: 'archived',
          auto_updated: new Date().toISOString(),
        }),
        { encoding: 'utf8', mode: 0o600 },
      )
      return existing
    } catch {
      return null
    }
  }
  const trashId = newTrashId()
  const dir = trashDirOf(stateDir, trashId)
  const deletedAt = new Date().toISOString()
  const manifest: AutoTrashManifest = {
    group,
    name,
    form: 'flat',
    deletedAt,
    auto: true,
    autoId: id,
    autoLayer: layer,
    autoStatus: 'archived',
  }
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    await writeFile(
      join(dir, 'rule.md'),
      rewriteFrontmatterFields(text, { auto_status: 'archived', auto_updated: deletedAt }),
      { encoding: 'utf8', mode: 0o600 },
    )
    return trashId
  } catch {
    // 半份条目比没有更糟：失败时清掉，让调用方拒绝这次归档。
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    return null
  }
}

/**
 * 用户否决 / 删除：把正文移进统一回收站，并删除独立库里的原件。
 *
 * 与 {@link archiveAutoNote} 的分工：这里给"用户不要这条了"用，原件必须消失；维护扫描
 * 仍用复制语义，工作区目录回来时要按 id 把 archived 条目恢复。
 *
 * @returns 回收站条目 id；复制或删除失败返回 `null`（原文件未删，调用方不得继续清 state）。
 */
export async function moveAutoNoteToTrash(
  autoRoot: string,
  stateDir: string,
  id: string,
  layer: MemoryLayer,
): Promise<string | null> {
  const trashId = await archiveAutoNote(autoRoot, stateDir, id, layer)
  if (trashId === null) return null
  const slash = id.lastIndexOf('/')
  const group = id.slice(0, slash)
  const name = id.slice(slash + 1)
  const src = join(autoRoot, group, `${name}.md`)
  try {
    await rm(src, { force: true })
  } catch {
    return null
  }
  if (await exists(src)) return null
  return trashId
}

/** 从回收站副本还原正文到独立库；目标已存在时拒绝（不覆盖正在用的条目）。 */
export async function restoreAutoNoteFromTrash(
  autoRoot: string,
  stateDir: string,
  trashId: string,
): Promise<{ ok: true; manifest: AutoTrashManifest } | { ok: false; code: 'missing' | 'exists' | 'io'; error: string }> {
  const manifest = await readAutoTrashManifest(stateDir, trashId)
  if (manifest === null) return { ok: false, code: 'missing', error: 'recycle-bin entry not found or not an autonomous note' }
  const dir = trashDirOf(stateDir, trashId)
  const target = join(autoRoot, manifest.group, `${manifest.name}.md`)
  if (await exists(target)) return { ok: false, code: 'exists', error: `a note with this id already exists: ${manifest.autoId}` }
  try {
    const text = await readFile(join(dir, 'rule.md'), 'utf8')
    await mkdir(join(autoRoot, manifest.group), { recursive: true })
    await writeFile(target, rewriteFrontmatterFields(text, {
      auto_status: 'active',
      auto_updated: new Date().toISOString(),
    }), { encoding: 'utf8', mode: 0o600 })
    await rm(dir, { recursive: true, force: true })
    return { ok: true, manifest }
  } catch (e) {
    return { ok: false, code: 'io', error: e instanceof Error ? e.message : String(e) }
  }
}

/** 删掉一条自动回收站条目（恢复 / 永久删除后调用）。 */
export async function dropAutoTrashEntry(stateDir: string, trashId: string): Promise<void> {
  await rm(trashDirOf(stateDir, trashId), { recursive: true, force: true })
}

/**
 * 把旧版本留下的 archived 条目补进统一回收站。
 *
 * 旧版的「停用」只改 frontmatter，不写回收站副本；升级后卡片不再列 archived，回收站
 * 又只认 manifest —— 不补这一步，升级前停用的条目会从界面上消失（文件还在）。
 * 先扫一遍现有条目，避免逐条 `findAutoTrashByNoteId` 把回收站目录读成 N²。
 *
 * @returns 本次新补进回收站的条目数；已有副本的跳过。
 */
export async function backfillArchivedTrash(
  autoRoot: string,
  stateDir: string,
  entries: ReadonlyArray<{ id: string; layer: MemoryLayer }>,
): Promise<number> {
  const existing = new Set<string>()
  try {
    for (const trashId of await readdir(join(stateDir, MEMORIES_TRASH_DIR))) {
      const manifest = await readAutoTrashManifest(stateDir, trashId)
      if (manifest !== null) existing.add(manifest.autoId)
    }
  } catch { /* 回收站为空或不可读：当作没有副本 */ }
  let added = 0
  for (const entry of entries) {
    if (existing.has(entry.id)) continue
    if (await archiveAutoNote(autoRoot, stateDir, entry.id, entry.layer) === null) continue
    existing.add(entry.id)
    added++
  }
  return added
}
