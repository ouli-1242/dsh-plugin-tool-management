// dsh-plugin-tool-management —— 统一数据目录（v0.4「一个 hub」，v0.9.0 名称按域对齐）。
//
// 用户在 2026-09-13 提出：插件产生的文件夹/文件全部收在 `$DSH_HOME/tool-management/`
// 一个目录里，方便统一备份与查看。此前它们散在四处：
//
//   $DSH_HOME/scene-memory/                记忆真源            → tool-management/memories/
//   $DSH_HOME/tool-management/             侧车（索引/回收站）  → 就地（hub 根）
//   $DSH_HOME/subagents/                   人设                → tool-management/subagents/
//   <插件目录>/data/agents-md-presets/     AGENTS.md 预设库     → tool-management/prompts/
//
// 2026-09-16 用户又提出两点：① 根目录下还漏着几个以插件名开头的侧车与日志（`$DSH_HOME/
// dsh-plugin-tool-management-*.json` / `.log`）+ 改 MCP 配置前的 patch 备份，都该收进 hub；
// ② hub 内的名字要与**当前代码的域命名**一致（界面「提示词」+ 工具 `prompt_manager_*`，
// 目录却叫 `agents-md`；域早就叫「记忆」，索引还叫 `rules-index.json`）。于是统一为：
//
//   ~/.dsh/tool-management/
//   ├─ memories/<场景>/<名>.md | <场景>/<名>/<名>.md   记忆正文（真源）
//   ├─ subagents/<人设>.md                               子智能体人设
//   ├─ prompts/<预设 id>/AGENTS.md                       提示词预设库（全局指令基线）
//   ├─ skills/                                           插件新建/导入的技能（可写根）
//   ├─ memories-index.json                               记忆启停/顺序 + 场景记录/档案/模式
//   ├─ subagents-index.json                              人设启停集合
//   ├─ skills-state.json                                 技能启停 / 首选 / 自定义目录
//   ├─ mcp-disabled-tools.json | mcp-known-tools.json | mcp-notes.json | mcp-settings.json | mcp-export.json
//   ├─ tool-management.log                               插件日志（滚动 .1）
//   ├─ backups/cordis.patch.yml.bak-<时间戳>             改宿主 patch 前的备份
//   ├─ trash/{skills,subagents,prompts,scenes}-trash/<id>/  回收站（除记忆外的四类）
//   └─ memories-trash/<id>/                              记忆回收站（**hub 根下独立目录**）
//
// 记忆回收站**不在 `trash/` 下**（本机实测 `trash/` 只有 4 个 `-trash` 目录）：它走
// `memories/service.ts` 自己的路径（`join(stateDir, 'memories-trash', id)`，stateDir = hub 根），
// 不经本模块的 `moveToTrash`。此前这行把它画进 `trash/{…}` 里，按它写备份/迁移脚本会既漏搬
// 又误判（那是一类真实存在、条目数最多的用户数据）。
//
// 留在 `$DSH_HOME` 根下的两个文件**不是**插件的：`AGENTS.md`（宿主每轮读取的全局基线，
// 插件只是按场景/预设写它）与 `cordis.patch.yml`（宿主加载插件的配置入口）。
//
// 搬运纪律（三条，全部为了「不丢数据」）：
//   1. **只搬不删**——源目录里的文件被 `rename` 走后，空壳目录保留；
//      搬不动的（被占用、跨卷失败）留在原地，下次启动再试。
//   2. **绝不覆盖**——目标已存在同名项时跳过该项，保留目标。
//   3. **每进程一次**——迁移是启动期的一次性动作，失败也不阻断服务（旧目录仍可读）。

import { cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
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

/** patch 备份目录（`hub/backups/`）：宿主 patch 的 `.bak-<时间戳>` 都收在这里。 */
export function hubBackupDir(home: string = resolveDshHome()): string {
  return join(home, HUB_DIR, 'backups')
}

// ── 一次性布局迁移（v0.9.0：根目录收编 + 按域改名）────────────────────────────
//
// 旧名 → 新名（hub 内相对路径）。`readIndex` 之类的读取端只用新名，所以迁移必须在任何
// 读取之前完成 —— 由 `apply()` 在启动期同步跑一次（见 index.ts），不参与并发。

const HUB_RENAMES: ReadonlyArray<readonly [string, string]> = [
  ['agents-md', 'prompts'],
  ['rules-index.json', 'memories-index.json'],
  ['rules-trash', 'memories-trash'],
  ['agents', 'subagents'],
  ['agents-index.json', 'subagents-index.json'],
  ['state.json', 'skills-state.json'],
  // 回收站分类目录（`trash/<域>-trash/`）
  ['trash/agents-md-trash', 'trash/prompts-trash'],
  ['trash/agents-trash', 'trash/subagents-trash'],
]

/** `$DSH_HOME` 根下由插件产生、要收进 hub 的文件（旧名 → hub 内新名）。 */
const ROOT_FILE_MOVES: ReadonlyArray<readonly [string, string]> = [
  ['dsh-plugin-tool-management-disabled-tools.json', 'mcp-disabled-tools.json'],
  ['dsh-plugin-tool-management-mcp-tools.json', 'mcp-known-tools.json'],
  ['dsh-plugin-tool-management-notes.json', 'mcp-notes.json'],
  ['dsh-plugin-tool-management-settings.json', 'mcp-settings.json'],
  ['dsh-plugin-tool-management-export.json', 'mcp-export.json'],
  ['dsh-plugin-tool-management.log', 'tool-management.log'],
  ['dsh-plugin-tool-management.log.1', 'tool-management.log.1'],
  // 更早的前缀（插件曾叫 dsh-skill-mcp-manager）
  ['skill-mcp-manager-disabled-tools.json', 'mcp-disabled-tools.json'],
  ['skill-mcp-manager-notes.json', 'mcp-notes.json'],
  ['skill-mcp-manager-settings.json', 'mcp-settings.json'],
  ['skill-mcp-manager-export.json', 'mcp-export.json'],
]

/** 宿主 patch 的备份名（`cordis.patch.yml.bak-<时间戳>`）。 */
export function isPatchBackupName(name: string): boolean {
  return /^cordis\.patch\.yml\.bak-\d{8}-\d{6}$/.test(basename(name))
}

/**
 * 布局迁移（同步、幂等、只搬不删、绝不覆盖）。**必须在任何读盘之前调用一次**：
 *   ① hub 内旧名 → 新名（`agents-md/` → `prompts/` 等）；
 *   ② `$DSH_HOME` 根下的插件侧车 / 日志 → hub（原来它们躺在宿主目录里）；
 *   ③ 宿主 patch 的 `.bak-*` → `hub/backups/`；
 *   ④ 技能回收站条目 `trash/<id>/` → `trash/skills-trash/<id>/`（与其余四类的命名对齐）。
 * 任一步失败只跳过该项（下次启动再试），绝不抛错、绝不删除源数据。
 */
export function migrateHubLayoutSync(home: string = resolveDshHome()): void {
  const hubDir = join(home, HUB_DIR)
  const move = (from: string, to: string): boolean => {
    try {
      if (from === to || !existsSync(from) || existsSync(to)) return false
      mkdirSync(dirname(to), { recursive: true })
      try {
        renameSync(from, to)
      } catch {
        cpSync(from, to, { recursive: true, force: true })
        rmSync(from, { recursive: true, force: true })
      }
      return true
    } catch {
      return false // 单项失败不阻断其余项（文件被占用 → 下次启动再试）
    }
  }
  // ① 更早的 hub 目录名（插件叫 dsh-skill-mcp-manager 的时期）：**先**逐项并入 hub，
  //    让下面 ② 的改名也覆盖从旧目录搬进来的那些（同名保留 hub 里已有的那份 ——
  //    move 对已存在目标跳过且旧份不删：合并是「只进不覆盖」，滞留旧目录的条目
  //    不丢失但也不可见，清掉旧目录即可整体放弃）。
  for (const legacyHub of ['dsh-plugin-tool-management', 'skill-mcp-manager']) {
    const from = join(home, legacyHub)
    try {
      if (!existsSync(from)) continue
      for (const name of readdirSync(from)) move(join(from, name), join(hubDir, name))
    } catch { /* 列举失败：下次启动再试 */ }
  }
  // ② hub 内旧名 → 新名
  for (const [oldName, newName] of HUB_RENAMES) move(join(hubDir, oldName), join(hubDir, newName))
  // ③ `$DSH_HOME` 根下的插件侧车 / 日志 → hub
  for (const [oldName, newName] of ROOT_FILE_MOVES) move(join(home, oldName), join(hubDir, newName))
  // 技能回收站：`trash/` 直属的条目目录（其余 `<域>-trash/` 已在上面搬过）。
  try {
    const trashDir = join(hubDir, 'trash')
    if (existsSync(trashDir)) {
      for (const entry of readdirSync(trashDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.endsWith('-trash')) continue
        move(join(trashDir, entry.name), join(trashDir, 'skills-trash', entry.name))
      }
    }
  } catch { /* 列举失败：下次启动再试 */ }
  // 宿主 patch 备份：根下的直接搬；`profiles/<名字>/` 下的带上层级后缀（否则与全局撞名）。
  try {
    const backups = hubBackupDir(home)
    for (const name of existsSync(home) ? readdirSync(home) : []) {
      if (isPatchBackupName(name)) move(join(home, name), join(backups, name))
    }
    const profilesDir = join(home, 'profiles')
    if (existsSync(profilesDir)) {
      for (const prof of readdirSync(profilesDir)) {
        const dir = join(profilesDir, prof)
        try {
          for (const name of readdirSync(dir)) {
            if (!isPatchBackupName(name)) continue
            const tag = 'profile-' + prof.replace(/[^A-Za-z0-9._-]/g, '_')
            move(join(dir, name), join(backups, name.replace(/^cordis\.patch\.yml/, 'cordis.patch.yml.' + tag)))
          }
        } catch { /* 单个 profile 目录读不动就跳过 */ }
      }
    }
  } catch { /* 同上 */ }
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
// 五类内容：**技能**、**子智能体人设**、**场景**、**提示词预设**、**记忆**。
// 落点 `hub/trash/<域>-trash/<id>/`：`manifest.json` + 随条目搬走的负载。
// 但**只有四类走本模块**（`TrashKind` 就是这三类 ＋ 核心层的 skills）：
// 技能在 `hub/trash/skills-trash/`（核心层，v0.9.0 前直接躺在 `trash/` 下），
// 记忆在 `hub/memories-trash/` —— **hub 根下的独立目录，不在 `trash/` 里**，由
// `memories/service.ts` 自己实现（不经本模块的 `moveToTrash`）。
//
// 三条纪律：**移入 = 移动**（原位置立刻消失，不是复制）、**绝不覆盖**（恢复时目标
// 已存在就报错让用户自己处理）、**失败要回滚**（搬了一半失败就把已搬的搬回去）。

/** 回收站条目的种类（决定子目录名）。 */
export type TrashKind = 'subagents' | 'scenes' | 'prompts'

/**
 * 老 manifest 里写着的 kind 值（v0.9.0 按域改名前的）：读盘时一并认，否则升级后
 * 老条目会「列不出来、恢复不了」——目录搬对了名字，manifest 里的字段值还在说旧名。
 */
const LEGACY_TRASH_KINDS: Record<TrashKind, readonly string[]> = {
  prompts: ['agents-md'],
  subagents: ['agents'],
  scenes: [],
}

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
    const accepted = [kind as string, ...LEGACY_TRASH_KINDS[kind]]
    if (!accepted.includes(String(parsed.kind)) || String(parsed.id) !== id) return null
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
 * 条目里的一个负载名是不是"就在这个条目目录里"。
 *
 * 为什么 id 与场景名都有谓词、这里还得多一道：`manifest.json` 的 `files[]` 是**磁盘上的数据**，
 * 它跟 id 不一样 —— id 只由本模块生成（`isValidTrashId` 严格白名单），而 files 可能来自
 * 用户手改、别的进程、或一份被塞进来的恶意档案包。不校验就 `join(dir, dest)` 等于给了
 * "任意相对路径读源 + 任意绝对目录建目标"的能力（`mkdir(dirname(to))` 会顺手把目录建出来）。
 */
export function isValidTrashPayloadName(dest: string): boolean {
  const text = String(dest ?? '')
  if (!text || text.startsWith('.') || text.includes('\0')) return false
  if (/[\\/]/.test(text)) return false
  if (text === 'manifest.json') return false
  return true
}

/**
 * 把条目里的一个负载搬回 `to`。**不覆盖**：调用方必须先确认 `to` 不存在。
 * @throws 条目、负载名或负载缺失时抛错（调用方翻成人话）。
 */
export async function moveOutOfTrash(kind: TrashKind, id: string, dest: string, to: string): Promise<void> {
  const dir = trashEntryPath(kind, id)
  if (dir === null) throw new Error(`回收站条目 id 非法：${id}`)
  if (!isValidTrashPayloadName(dest)) throw new Error(`回收站负载名非法：${dest}`)
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
