// dsh-plugin-tool-management —— 统一数据目录（v0.4「一个 hub」）。
//
// 用户在 2026-09-13 提出：插件产生的文件夹/文件全部收在 `$DSH_HOME/tool-management/`
// 一个目录里，方便统一备份与查看。此前它们散在四处：
//
//   $DSH_HOME/scene-memory/                记忆真源            → tool-management/memories/
//   $DSH_HOME/tool-management/             侧车（索引/回收站）  → 就地（hub 根）
//   $DSH_HOME/subagents/                   人设                → tool-management/agents/
//   <插件目录>/data/agents-md-presets/     AGENTS.md 预设库     → tool-management/agents-md/
//
// 最终布局：
//
//   ~/.dsh/tool-management/
//   ├─ memories/<场景>/<名>.md | <场景>/<名>/SKILL.md   记忆正文（真源）
//   ├─ agents/<人设>.md                                  子智能体人设
//   ├─ agents-md/<预设 id>/AGENTS.md                     全局指令基线预设库
//   ├─ skills/                                           插件新建的技能（可写根）
//   ├─ trash/rules-trash/<id>/                           记忆回收站
//   ├─ rules-index.json                                  启停/顺序/场景记录/档案/模式
//   └─ config.json                                       插件设置
//
// 搬运纪律（三条，全部为了「不丢数据」）：
//   1. **只搬不删**——源目录里的文件被 `rename` 走后，空壳目录保留；
//      搬不动的（被占用、跨卷失败）留在原地，下次启动再试。
//   2. **绝不覆盖**——目标已存在同名项时跳过该项，保留目标。
//   3. **每进程一次**——迁移是启动期的一次性动作，失败也不阻断服务（旧目录仍可读）。

import { cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import { resolveDshHome } from './skills/core.js'

/** hub 根目录名（`$DSH_HOME` 下）。 */
export const HUB_DIR = 'tool-management'

/** hub 根绝对路径。 */
export function hubRoot(): string {
  return join(resolveDshHome(), HUB_DIR)
}

/** hub 下的子目录绝对路径。 */
export function hubPath(...segments: string[]): string {
  return join(hubRoot(), ...segments)
}

/** 路径是否存在（不跟随符号链接）。 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/**
 * 把一个目录里的**顶层条目**搬到另一个目录（幂等、只搬不删、绝不覆盖）。
 * @param from 源目录（不存在则直接返回 0）
 * @param to 目标目录（自动创建）
 * @param filter 可选的条目过滤（默认全部非隐藏项）
 * @returns 实际搬移的条目数
 */
export async function relocateEntries(
  from: string,
  to: string,
  filter?: (name: string) => boolean,
): Promise<number> {
  if (from === to) return 0
  let names: string[]
  try {
    names = await readdir(from)
  } catch {
    return 0
  }
  await mkdir(to, { recursive: true }).catch(() => undefined)
  let moved = 0
  for (const name of names) {
    if (name.startsWith('.')) continue
    if (filter && !filter(name)) continue
    const src = join(from, name)
    const dest = join(to, name)
    try {
      if (await pathExists(dest)) continue // 绝不覆盖
      try {
        await rename(src, dest)
      } catch {
        // 跨卷 / 目标被占用 → 复制后删源；复制失败则原样留在旧目录（下次再试）。
        await cp(src, dest, { recursive: true })
        await rm(src, { recursive: true, force: true })
      }
      moved++
    } catch {
      /* 单项失败不阻断其余项 */
    }
  }
  return moved
}

// ── 回收站 ───────────────────────────────────────────────────────────────────
//
// 三类内容共用这一套：**子智能体人设**、**场景**、**提示词预设**。
// 落点 `hub/trash/<kind>-trash/<id>/`：`manifest.json` + 随条目搬走的负载。
// 与既有两处同源：技能回收站在 `hub/trash/<id>/`（核心层），记忆回收站在
// `hub/rules-trash/<id>/`（rules 层）—— 本模块只服务本文件之上的三类，互不干扰
// （技能那边的列举会跳过没有 metadata.json 的目录，所以同放 trash/ 下是安全的）。
//
// 三条纪律：**移入 = 移动**（原位置立刻消失，不是复制）、**绝不覆盖**（恢复时目标
// 已存在就报错让用户自己处理）、**失败要回滚**（搬了一半失败就把已搬的搬回去）。

/** 回收站条目的种类（决定子目录名）。 */
export type TrashKind = 'agents' | 'scenes' | 'agents-md'

/** 回收站条目的清单文件。 */
export interface TrashManifest {
  readonly v: number
  readonly kind: TrashKind
  readonly id: string
  /** 恢复时还原的名字 / id。 */
  readonly name: string
  /** ISO 时间戳。 */
  readonly deletedAt: string
  /** 条目目录内的负载文件名（恢复时按它搬出）。 */
  readonly files: readonly string[]
  /** 非文件型负载（场景的记录与档案就放这里）。 */
  readonly data?: unknown
}

/** 回收站里的一条（界面用）。 */
export interface TrashEntry {
  readonly id: string
  readonly name: string
  readonly deletedAt: string
  readonly files: readonly string[]
  readonly hasData: boolean
}

/** 某一类回收站的根目录：`hub/trash/<kind>-trash`。 */
export function trashKindDir(kind: TrashKind): string {
  return hubPath('trash', `${kind}-trash`)
}

/** 新条目 id（时间戳 base36 + uuid 前 8 位，与记忆回收站同形）。 */
export function newTrashId(): string {
  return Date.now().toString(36) + '-' + randomUUID().slice(0, 8)
}

/** id 只由本模块生成：严格白名单，杜绝路径穿越。 */
export function isValidTrashId(id: string): boolean {
  return /^[a-z0-9]+-[a-z0-9]{1,32}$/i.test(id)
}

/** 条目目录（id 非法时返回 null）。 */
export function trashEntryPath(kind: TrashKind, id: string): string | null {
  if (!isValidTrashId(id)) return null
  return join(trashKindDir(kind), id)
}

async function readManifest(kind: TrashKind, id: string): Promise<TrashManifest | null> {
  const dir = trashEntryPath(kind, id)
  if (dir === null) return null
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as TrashManifest
    if (parsed === null || typeof parsed !== 'object') return null
    if (String(parsed.kind) !== kind || String(parsed.id) !== id) return null
    return {
      v: Number(parsed.v) || 1,
      kind,
      id,
      name: String(parsed.name ?? ''),
      deletedAt: String(parsed.deletedAt ?? ''),
      files: Array.isArray(parsed.files) ? parsed.files.map((n) => String(n)) : [],
      ...(parsed.data === undefined ? {} : { data: parsed.data }),
    }
  } catch {
    return null
  }
}

/**
 * 把一个文件/目录移入回收站（新建条目）。
 *
 * @param kind 种类（决定子目录）
 * @param name 恢复时用的名字
 * @param moves 要搬的项：`from` 绝对路径 → 条目目录内的 `dest` 名
 * @param data 可选的非文件型负载（如场景的记录与档案）
 */
export async function moveToTrash(
  kind: TrashKind,
  name: string,
  moves: ReadonlyArray<{ from: string; dest: string }>,
  data?: unknown,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const id = newTrashId()
  const dir = join(trashKindDir(kind), id)
  const done: Array<{ from: string; to: string }> = []
  try {
    await mkdir(dir, { recursive: true })
    for (const move of moves) {
      const to = join(dir, move.dest)
      try {
        await rename(move.from, to)
      } catch {
        // 跨卷 / 被占用 → 复制后删源；两步都失败就抛出去走回滚。
        await cp(move.from, to, { recursive: true })
        await rm(move.from, { recursive: true, force: true })
      }
      done.push({ from: move.from, to })
    }
    const manifest: TrashManifest = {
      v: 1,
      kind,
      id,
      name,
      deletedAt: new Date().toISOString(),
      files: moves.map((m) => m.dest),
      ...(data === undefined ? {} : { data }),
    }
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    return { ok: true, id }
  } catch (e) {
    // 回滚：把已经搬走的搬回原处，再删掉半成品条目目录。
    for (const item of done.reverse()) {
      try {
        await rename(item.to, item.from)
      } catch {
        try {
          await cp(item.to, item.from, { recursive: true })
          await rm(item.to, { recursive: true, force: true })
        } catch { /* 回滚失败：把原因交给调用方的错误信息 */ }
      }
    }
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
}

/** 列出某一类回收站的条目（按删除时间倒序）。 */
export async function listTrashEntries(kind: TrashKind): Promise<TrashEntry[]> {
  let names: string[]
  try {
    names = (await readdir(trashKindDir(kind), { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
  } catch {
    return []
  }
  const entries: TrashEntry[] = []
  for (const id of names) {
    const manifest = await readManifest(kind, id)
    if (!manifest) continue
    entries.push({
      id: manifest.id,
      name: manifest.name,
      deletedAt: manifest.deletedAt,
      files: manifest.files,
      hasData: manifest.data !== undefined,
    })
  }
  return entries.sort((a, b) => (a.deletedAt === b.deletedAt ? b.id.localeCompare(a.id) : b.deletedAt.localeCompare(a.deletedAt)))
}

/** 读一条回收站条目的清单（不存在/损坏返回 null）。 */
export async function readTrashEntry(kind: TrashKind, id: string): Promise<TrashManifest | null> {
  return await readManifest(kind, id)
}

/**
 * 把条目里的一个负载搬回 `to`。**不覆盖**：调用方必须先确认 `to` 不存在。
 * @throws 条目或负载缺失时抛错（调用方翻成人话）。
 */
export async function moveOutOfTrash(kind: TrashKind, id: string, dest: string, to: string): Promise<void> {
  const dir = trashEntryPath(kind, id)
  if (dir === null) throw new Error(`回收站条目 id 非法：${id}`)
  const from = join(dir, dest)
  await mkdir(dirname(to), { recursive: true })
  try {
    await rename(from, to)
  } catch {
    await cp(from, to, { recursive: true })
    await rm(from, { recursive: true, force: true })
  }
}

/** 永久删除一条回收站条目（连带负载）。 */
export async function purgeTrashEntry(kind: TrashKind, id: string): Promise<boolean> {
  const dir = trashEntryPath(kind, id)
  if (dir === null) return false
  const manifest = await readManifest(kind, id)
  if (!manifest) return false
  await rm(dir, { recursive: true, force: true })
  return true
}
