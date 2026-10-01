// 规则/记忆的**发现**：扫一个来源目录读成条目、把 frontmatter 投成规则、按老布局搬家。
//
// 声明从 memories/snapshot.ts 按行号区间搬来，正文一字未改（唯一的容差是
// `--export-top-level` 加的 `export ` 前缀，moved-verify 逐字对拍）。
//
// 为什么与快照分两层：发现是「读外面进来的东西」（官方技能目录、AGENTS.md、旧布局），
// 快照是「记下当前场景长什么样并写回索引」。两者各自演化的方向不同 —— 前者跟着**来源形状**
// 变，后者跟着**索引字段**变。
import { readdirSync, statSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseSkillDoc, resolveDshHome, unquote } from '../skills/core.js'
import { MAX_SOURCE_DEPTH, MAX_DIRECTORIES, MAX_ENTRIES, MAX_DESCRIPTION_LENGTH, DEFAULT_ORDER, DEFAULT_GROUP_ORDER, GLOBAL_SCENE, TRUNCATION_MARKER, DROPPED_HEADING, SCENE_MEMORY_NOTE, LEGACY_BUNDLE_DOC, bundleDocName, SEGMENT_RULE_HINT, SHARED_GROUP, byteLen, message, isValidGroupSegment } from './constants.js'
import { ensureSceneRecords, resolveActiveScenes, signatureOfIndex, sceneLabel, sceneHeading, sceneLine, compareSceneBuckets, memoryBlock } from './projection.js'
import { isIndexQuarantined, readIndex, writeIndex, pathExists, readFileOrThrowSync, isAbsentError } from './index-io.js'
import type { RuleIndexEntry } from './index-io.js'
import type { Rule, GroupRow, SceneMemoryProjection, RulesIndex, SceneMemoryFile } from './service.js'

export const identity = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
export interface ParsedSkillDoc {
  fields: Array<{ key: string; raw: string }>
  map: Record<string, unknown>
  body: string
  hasFrontmatter: boolean
}
export interface DiscoveredEntry {
  id: string
  group: string
  name: string
  kind: 'flat' | 'bundle'
  docPath: string
  entryPath: string
  /** 仅 shadowed flat 条目：同名 bundle 优先后被遮蔽（UI 标红）。 */
  shadowed?: boolean
}
export async function discover(memoriesRoot: string): Promise<{ entries: Map<string, DiscoveredEntry>; shadowed: DiscoveredEntry[]; groups: Set<string>; scenes: string[]; warnings: string[]; truncated: boolean }> {
  const entries = new Map<string, DiscoveredEntry>()
  const shadowed: DiscoveredEntry[] = []
  const groups = new Set<string>()
  const scenes: string[] = []
  const warnings: string[] = []
  const rootPath = resolve(memoriesRoot)
  try {
    const st = await lstat(rootPath)
    if (!st.isDirectory() || st.isSymbolicLink()) return { entries, shadowed, groups, scenes, warnings, truncated: false }
  } catch {
    return { entries, shadowed, groups, scenes, warnings, truncated: false }
  }
  const queue: Array<{ path: string; group: string; depth: number; ancestors: Set<string> }> = [
    { path: rootPath, group: '', depth: 0, ancestors: new Set() },
  ]
  let directories = 0
  let itemCount = 0
  let truncated = false

  const addEntry = (entry: DiscoveredEntry): void => {
    const existing = entries.get(entry.id)
    if (!existing) {
      entries.set(entry.id, entry)
      return
    }
    if (entry.kind === 'bundle' && existing.kind === 'flat') {
      shadowed.push({ ...existing, shadowed: true })
      entries.set(entry.id, entry)
      return
    }
    if (entry.kind === 'flat' && existing.kind === 'bundle') {
      shadowed.push({ ...entry, shadowed: true })
    }
  }

  for (let cursor = 0; cursor < queue.length; cursor++) {
    if (directories >= MAX_DIRECTORIES || itemCount >= MAX_ENTRIES) {
      truncated = true
      break
    }
    const current = queue[cursor]
    let realDirectory: string
    let dirents: import('node:fs').Dirent[] = []
    try {
      realDirectory = await realpath(current.path)
      if (current.ancestors.has(identity(realDirectory))) continue
      const dir = await readdir(current.path, { withFileTypes: true })
      directories++
      for (const item of dir) {
        if (itemCount >= MAX_ENTRIES) {
          truncated = true
          break
        }
        itemCount++
        dirents.push(item)
      }
    } catch {
      continue // 失效链接或不可读目录不阻断其他来源
    }

    // bundle 检查：当前目录含 `<目录名>.md`（或旧版 `SKILL.md`）→ 它是规则叶子，父路径为场景。
    //
    // **根下的一级目录恒为场景**（`parentGroup === ''` 时不做 bundle 判断）——与
    // `probeSceneFilesSync`（注入段）同口径。场景 `1` 里一条叫 `1` 的记忆（`memories/1/1.md`）
    // 与「根层的 bundle `1`」在磁盘上同形，认成后者会把整个场景目录吃成叶子：同场景其余
    // 记忆全从列表消失、多出一条「未归属场景」的同名记忆，新建记忆还会被误报「同名 bundle
    // 遮蔽」（2026-09-16 用户实测）。根层因此没有 bundle，只有 legacy 裸 .md（见 rulesCheck 的 noScene）。
    if (current.group !== '') {
      const sepIdx = current.group.lastIndexOf('/')
      const parentGroup = sepIdx >= 0 ? current.group.slice(0, sepIdx) : ''
      const name = sepIdx >= 0 ? current.group.slice(sepIdx + 1) : current.group
      let docPath = ''
      if (parentGroup !== '') {
        for (const candidate of [bundleDocName(name), LEGACY_BUNDLE_DOC]) {
          const p = join(current.path, candidate)
          try {
            const st = await lstat(p)
            if (st.isFile() && !st.isSymbolicLink()) { docPath = p; break }
          } catch { /* 该候选名不存在 → 试下一个 */ }
        }
      }
      if (docPath !== '') {
        const id = parentGroup ? `${parentGroup}/${name}` : name
        addEntry({ id, group: parentGroup, name, kind: 'bundle', docPath, entryPath: current.path })
        continue
      }
    }
    if (current.group !== '') {
      groups.add(current.group)
      // 一级目录 = 场景名（多段场景名用 '/' 连接，见 isValidGroupPath）。
      if (current.depth === 1) scenes.push(current.group)
    }

    dirents.sort((a, b) => a.name.localeCompare(b.name))
    const ancestors = new Set(current.ancestors).add(identity(realDirectory))
    for (const item of dirents) {
      if (item.name.startsWith('.')) continue // 隐藏目录/文件跳过
      const path = join(current.path, item.name)
      try {
        const st = await lstat(path)
        // 符号链接一律不跟随：注入路径（`probeSceneFilesSync`）本来就不跟随，两端必须同口径 ——
        // 否则列表里会出现**永远注入不进去**的记忆（用户打开开关却什么也没发生）。顺带也关掉了
        // 「链接指向根外、写操作顺着链接穿透出去」这条路（写入侧另有 realpath 断言兜底）。
        if (st.isSymbolicLink()) continue
        if (st.isDirectory()) {
          if (!isValidGroupSegment(item.name)) {
            warnings.push(`跳过非法目录名（${SEGMENT_RULE_HINT}）：${current.group ? current.group + '/' : ''}${item.name}`)
            continue
          }
          if (current.depth >= MAX_SOURCE_DEPTH || queue.length >= MAX_DIRECTORIES) {
            truncated = true
            continue
          }
          queue.push({
            path,
            group: current.group ? `${current.group}/${item.name}` : item.name,
            depth: current.depth + 1,
            ancestors,
          })
          continue
        }
        if (!st.isFile()) continue
        if (!item.name.toLowerCase().endsWith('.md')) continue // 只认 .md
        const name = item.name.slice(0, -3)
        const id = current.group ? `${current.group}/${name}` : name
        addEntry({ id, group: current.group, name, kind: 'flat', docPath: path, entryPath: path })
      } catch {
        /* 来源在扫描期间失效时跳过 */
      }
    }
  }
  return { entries, shadowed, groups, scenes, warnings, truncated }
}
export function deriveDescription(body: string): string {
  const text = String(body ?? '').trim()
  if (!text) return ''
  const heading = /^#\s+(.+)$/m.exec(text)
  const raw = heading && heading[1].trim() ? heading[1].trim() : text.split(/\r?\n/, 1)[0].trim()
  return raw.slice(0, MAX_DESCRIPTION_LENGTH)
}
export interface DerivedFields {
  name: string
  description: string
  descriptionDerived: boolean
  whenToUse?: string
  globs?: string
  metadata?: unknown
}
export function deriveFromDoc(entry: DiscoveredEntry, doc: ParsedSkillDoc): DerivedFields {
  const declaredName = doc.map.name != null && String(doc.map.name).trim() !== '' ? unquote(String(doc.map.name)).trim() : ''
  const name = declaredName || entry.name
  let description = doc.map.description != null ? unquote(String(doc.map.description)).trim() : ''
  let descriptionDerived = false
  if (description === '') {
    description = deriveDescription(doc.body)
    descriptionDerived = true
  }
  const globs = doc.map.globs != null && String(doc.map.globs).trim() !== '' ? String(doc.map.globs).trim() : undefined
  let whenToUse: string | undefined
  if (doc.map.whenToUse != null && String(doc.map.whenToUse).trim() !== '') {
    whenToUse = String(doc.map.whenToUse).trim()
  } else if (globs) {
    whenToUse = `适用路径：${globs}`
  }
  const metadata = doc.map.metadata !== undefined ? doc.map.metadata : undefined
  return { name, description, descriptionDerived, whenToUse, globs, metadata }
}
export function projectRule(entry: DiscoveredEntry, derived: DerivedFields, idxEntry: RuleIndexEntry | undefined): Rule {
  // 体积按**正文文件**算（bundle 的附件不计：附件不进注入正文）。一次 stat 一条记忆，
  // 结果随快照的 1s TTL 缓存一起复用；读不到就不带这个字段，别把"不知道"报成 0 B。
  let size: number | undefined
  try { size = statSync(entry.docPath).size } catch { size = undefined }
  const rule: Rule = {
    id: entry.id,
    group: entry.group,
    name: derived.name,
    form: entry.kind,
    path: entry.docPath,
    ...(size !== undefined ? { bytes: size } : {}),
    description: derived.description,
    ...(derived.descriptionDerived ? { descriptionDerived: true } : {}),
    ...(derived.whenToUse !== undefined ? { whenToUse: derived.whenToUse } : {}),
    ...(derived.globs !== undefined ? { globs: derived.globs } : {}),
    ...(derived.metadata !== undefined ? { metadata: derived.metadata } : {}),
    enabled: idxEntry?.enabled ?? true,
    order: idxEntry?.order ?? DEFAULT_ORDER,
    tags: Array.isArray(idxEntry?.tags) ? (idxEntry!.tags as string[]) : [],
    pinned: idxEntry?.pinned === true,
    note: typeof idxEntry?.note === 'string' ? idxEntry.note : '',
    ...(typeof idxEntry?.updatedAt === 'string' ? { updatedAt: idxEntry.updatedAt } : {}),
  }
  return rule
}
export async function relocateLegacyLayout(memoriesRoot: string): Promise<void> {
  const home = resolveDshHome()
  const legacyRoots = [join(home, 'scene-memory'), join(home, 'rules')]
  for (const legacyRoot of legacyRoots) {
    if (!(await pathExists(legacyRoot))) continue
    if (identity(resolve(legacyRoot)) === identity(resolve(memoriesRoot))) continue // 自定义 roots 落在旧路径 → 不自我搬移
    let items: import('node:fs').Dirent[]
    try {
      items = await readdir(legacyRoot, { withFileTypes: true })
    } catch {
      continue
    }
    for (const item of items) {
      if (item.name.startsWith('.')) continue
      const src = join(legacyRoot, item.name)
      // 根层 .md = 旧的「全局」桶 → 搬进 `global/`，文件名保留（否则多套一层目录）。
      // 其余条目（场景目录）整体搬进 memories/，目录名保留。
      const isRootMd = item.isFile() && item.name.toLowerCase().endsWith('.md')
      const destDir = isRootMd ? join(memoriesRoot, GLOBAL_SCENE) : memoriesRoot
      const dest = join(destDir, item.name)
      try {
        if (await pathExists(dest)) continue
        await mkdir(destDir, { recursive: true })
        try {
          await rename(src, dest)
        } catch {
          // 跨设备/被占用 → 复制后删源；复制失败则保留源文件（宁可重复，不可丢失）。
          await cp(src, dest, { recursive: true })
          await rm(src, { recursive: true, force: true })
        }
      } catch {
        /* 单项失败不阻断其余项（如文件被外部程序锁住，下次启动再试） */
      }
    }
  }
}