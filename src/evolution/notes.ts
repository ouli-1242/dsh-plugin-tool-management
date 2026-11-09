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

import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { GLOBAL_SCENE, WORKSPACE_GROUP_PREFIX, isValidGroupPath } from '../memories/constants.js'
import { parseSkillDoc } from '../skills/core.js'
import { rewriteFrontmatterFields } from '../skills/frontmatter.js'

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

/** 独立库里的删除：正文移进 `evolution/trash/`，可人工找回，不碰用户记忆回收站。 */
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
