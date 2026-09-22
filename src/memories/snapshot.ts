// 规则/记忆域的**发现与快照**（2026-09-19 从 memories/service.ts 抽出）。
//
// 两件事：① `discover` 扫 memories/ 目录树得出条目清单（必须自实现，理由见 service.ts 文件头）；
// ② `buildSnapshot` / `renderSceneMemory` 把索引 + 文件内容投影成界面与注入看到的那份快照。
//
// 缓存红线在这里落地：段内容只由「启用场景 + 文件内容」决定，不掺时间戳/计数，
// 场景组合或记忆文件不变 ⇒ 逐字节稳定 ⇒ 前缀缓存命中。
//
// 对 service.ts 只做 type-only 引用（`import type`），避免与它形成运行时循环依赖。

import { readdirSync, statSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseSkillDoc, resolveDshHome, unquote } from '../skills/core.js'
import { MAX_SOURCE_DEPTH, MAX_DIRECTORIES, MAX_ENTRIES, MAX_DESCRIPTION_LENGTH, DEFAULT_ORDER, DEFAULT_GROUP_ORDER, GLOBAL_SCENE, TRUNCATION_MARKER, DROPPED_HEADING, SCENE_MEMORY_NOTE, SCENE_MEMORY_NOTE_PARTIAL, LEGACY_BUNDLE_DOC, bundleDocName, SEGMENT_RULE_HINT, byteLen, message, isValidGroupSegment } from './constants.js'
import { ensureSceneRecords, resolveActiveScenes, signatureOfIndex, sceneLabel, sceneHeader, compareSceneBuckets, memoryBlock } from './projection.js'
import { isIndexQuarantined, readIndex, writeIndex, pathExists, readFileIfExistsSync } from './index-io.js'
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

export interface Snapshot {
  rules: Rule[]
  groups: GroupRow[]
  /** memories/ 下的一级目录（= 场景名，含保留场景 global；不含只有记录没有目录的场景）。 */
  scenes: string[]
  warnings: string[]
  truncated: boolean
  entries: Map<string, DiscoveredEntry>
  bodies: Map<string, string>
  /** 这份快照读到的索引（孤儿清理之后的权威态）：同一 op 里不要再读第二遍。 */
  index: RulesIndex
}

/** 段渲染的候选块：一个「场景标题 + 一条记忆正文」的可选单元。 */
export interface SceneBlockCandidate {
  /** 全局确定性序号（候选顺序 = 场景顺序 → 场景内 order/名称）。 */
  seq: number
  scene: string
  header: string
  block: string
  /** 单行压缩形态（`- **名称** — 正文`）：连续两条可直接相邻，其余情况前空一行。 */
  inline: boolean
  item: { id: string; scene: string; name: string; bytes: number }
}

// ── 文件工具 ───────────────────────────────────────────────────────────────

/**
 * BFS 发现（realpath 防环、深度/目录/条目预算），与 readonly-discovery 同构，
 * 但规则的场景是**多层相对路径**（readonly-discovery 的 group 恒为第一层），
 * 且**不跟随符号链接**（readonly-discovery 允许目录链接，因为那是用户显式接入的只读技能源；
 * 记忆根则必须与注入路径同口径，见下方 `st.isSymbolicLink()` 处）。
 *
 * 目录语义：目录含 `<目录名>.md` → 它是 bundle 规则（叶子，不再深入），其「父路径」
 * 是场景、目录名是规则名；找不到时再退回认旧文件名 `SKILL.md`（只读兼容，不再新建）；
 * 都没有则它是场景/子分类，继续遍历其下 .md（flat，任意层级）
 * 与子目录。同名 flat 与 bundle 冲突时 bundle 优先，flat 记入 shadowed。
 */
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

// ── 规则解析 + 派生 ────────────────────────────────────────────────────────

/** 派生 description：首个 `#` 标题 → 首个非空行；截断 500 字符。 */
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

/** 从 frontmatter/正文派生字段（派生只存在于内存投影，不写回文件）。 */
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

/** 合并索引字段（enabled/order 等以索引为准；无记录走默认投影）。 */
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

// ── 侧车文件（索引 / 场景）─────────────────────────────────────────────────

/** 把旧布局搬进 `tool-management/`（每个进程只尝试一次，幂等）。
 *
 *   旧：$DSH_HOME/scene-memory/<root>.md        → memories/global/<root>.md
 *       $DSH_HOME/scene-memory/<scene>/…        → memories/<scene>/…
 *       （场景记录由索引镜像补齐，见 ensureSceneRecords）
 *   更旧：$DSH_HOME/rules/…（v0.3 之前）同样按上面两条处理。
 *
 * 搬移用 `rename`（同卷零拷贝）；跨卷（EXDEV）退化为 `cp` + `rm`。
 * 源目录**保留**（内容已搬走，留空壳不影响正确性，也方便用户核对）。
 * 目标已存在同名项 → 保留目标、跳过该项（绝不覆盖新数据）。
 */
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







// ── 快照（发现 + 索引合并 + 索引清理）──────────────────────────────────────

export async function buildSnapshot(memoriesRoot: string, stateDir: string): Promise<Snapshot> {
  const discovery = await discover(memoriesRoot)
  let index = await readIndex(stateDir)
  // 索引损坏时一律按「未启用」投影（理由同 probeSceneFilesSync 的 forceDisabled）。
  // 必须在 readIndex 之后取：隔离判定正是在那次读失败时建立的。
  const quarantined = isIndexQuarantined(stateDir)
  // 索引有记录但文件已删 → 清理记录（磁盘与索引保持一致）。
  let dirty = false
  for (const id of Object.keys(index.rules)) {
    if (!discovery.entries.has(id)) {
      delete index.rules[id]
      dirty = true
    }
  }
  for (const group of Object.keys(index.groups)) {
    if (!discovery.groups.has(group)) {
      delete index.groups[group]
      dirty = true
    }
  }
  // 场景记录：保留场景 global 恒存在；有目录没记录的补一条。
  // 注意**不反向清理**——删掉 memories/<场景>/ 目录不应删掉场景记录，
  // 否则“先建场景、后加记忆”的用法会在加记忆前把场景弄丢。
  if (ensureSceneRecords(index, discovery.scenes)) dirty = true
  // 索引损坏时跳过这次清理落盘：写侧本就拒绝（会抛），而这里的清理只是收尾性的，
  // 它抛出去会让整个记忆页打不开 —— 用户更需要先看见「记忆都在、只是全未启用」。
  if (dirty && !quarantined) await writeIndex(stateDir, index)

  const rules: Rule[] = []
  const bodies = new Map<string, string>()
  const entries: Map<string, DiscoveredEntry> = new Map()
  // 读取失败必须说出来：那一条会从三处（`rules` / `bodies` / `entries`）同时消失，
  // 界面表现为"这条记忆不存在"，而 `rules-diagnose` 的 `emptyBody` 依赖 `snap.bodies`、
  // 也兜不到它。走与 `discover()` 同一条 `warnings` 通道 → `rules-list` 透传 → 记忆页横幅。
  const warnings = discovery.warnings.slice()
  for (const entry of discovery.entries.values()) {
    try {
      const text = await readFile(entry.docPath, 'utf8')
      const doc = parseSkillDoc(text) as ParsedSkillDoc
      const derived = deriveFromDoc(entry, doc)
      rules.push(projectRule(entry, derived, quarantined ? { enabled: false } : index.rules[entry.id]))
      bodies.set(entry.id, doc.body)
      entries.set(entry.id, entry)
    } catch (error) {
      /* 文件在扫描与读取间被删/损坏：跳过该规则，但如实说出是哪一条、为什么 */
      warnings.push(`读取失败，已跳过：${entry.id}（${message(error)}）`)
    }
  }
  for (const entry of discovery.shadowed) {
    try {
      const text = await readFile(entry.docPath, 'utf8')
      const doc = parseSkillDoc(text) as ParsedSkillDoc
      const derived = deriveFromDoc(entry, doc)
      rules.push({ ...projectRule(entry, derived, undefined), shadowed: true })
      entries.set(entry.id, entry)
    } catch (error) {
      warnings.push(`读取失败，已跳过（被同名 bundle 遮蔽的条目）：${entry.id}（${message(error)}）`)
    }
  }

  const groups: GroupRow[] = [...discovery.groups]
    .map((name) => {
      const gi = index.groups[name] || {}
      return {
        name,
        label: typeof gi.label === 'string' && gi.label !== '' ? gi.label : name,
        order: gi.order ?? DEFAULT_GROUP_ORDER,
        count: rules.filter((r) => r.group === name && !r.shadowed).length,
      }
    })
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))

  return { rules, groups, scenes: discovery.scenes, warnings, truncated: discovery.truncated, entries, bodies, index }
}

// ── 场景记忆段：两相扫描（廉价指纹 → 按需读正文）──────────────────────────
//
// 硬约束 1（§5.1）：注入通道每个 step 都要求**同步**取一次文本（`text: () => string`，
// 见 src/context-inject.ts），返回 Promise 会让这一步的注入直接失败（异常被吞）。
//
// 缓存策略（§5.4 S3）：文本出口必须同步返回 string，但不希望每个模型步骤都
// 读一遍所有记忆正文。因此拆成两相：
//   ① `probeSceneFilesSync()`：只走目录树 + `statSync`（**不读正文**），产出候选文件
//      与**指纹**（`id|mtime|size` + 影响渲染的索引字段）。
//   ② 指纹变化时才 `renderSceneMemory()`：读正文、派生、排序、拼接。
//
// 为什么不用「内存缓存 + 目录监听（方案 a）」：fs.watch 在 Windows 上不可靠（本仓库
// 技能侧不得不把 watcher 放进 worker 线程才不被卡死），而 watcher 静默失效的后果是
// **永久返回过期内容**——正是本次变更单要根治的"静默失效"形态。指纹探测每次装配只做
// 一次 stat 遍历（个人记忆树是亚毫秒级），换来"永远最新且永不静默失效"，优先于"零 IO"。
//
// 与 discover() 的关系：discover 是异步全量快照（供 CRUD/列表/体检），这里是同步轻量
// 扫描（供注入通道），两者对"什么是规则"的定义保持一致：
//   目录含 `<目录名>.md`（或旧版 `SKILL.md`）→ bundle 规则（叶子）；否则继续下钻；只认 .md；跳过隐藏项；
//   同名 flat 与 bundle 冲突时 bundle 优先。

/** 第一相产物：一条候选记忆的**位置与指纹**（无正文）。 */
export interface SceneFileRef {
  id: string
  scene: string
  name: string
  kind: 'flat' | 'bundle'
  path: string
  order: number
  /** 指纹片段：mtime + size，文件内容一变即变。 */
  stamp: string
}

export function fileStampSync(path: string): string {
  try {
    const st = statSync(path)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return 'missing'
  }
}

/**
 * 第一相：走目录树 + stat，不读正文。
 *   `<场景>/...` → 场景记忆（一级目录名即场景名，含保留场景 `global`）；
 *   是否生效由 index.active 决定，`global` 恒定生效（见 renderSceneMemory）。
 * 根层的裸 .md **不再是记忆**（旧的「全局」桶已迁入 `global/`，见 relocateLegacyLayout），
 * 因此这里不再扫描根层文件——把文件丢在 memories/ 根下不会静默生效，也不会被投影。
 * `signature` 不变 ⇒ 上次渲染结果可原样复用（零正文 IO、零重排）。
 */
export function probeSceneFilesSync(
  memoriesRoot: string,
  index: RulesIndex,
  // 索引已损坏时置真：索引是开关的唯一真相源，它没了就无法知道用户开过哪些记忆，
  // 而默认值（无记录 = 启用）会把**全部**记忆一次性注入模型上下文。表现为「记忆都没生效」
  // 是可解释、可恢复的；替用户决定全开不是。
  forceDisabled = false,
): { refs: SceneFileRef[]; scenes: string[]; truncated: boolean; signature: string } {
  const byId = new Map<string, SceneFileRef>()
  const scenes: string[] = []
  let truncated = false
  const budget = { dirs: 0, items: 0 }

  let rootEntries: import('node:fs').Dirent[]
  try {
    rootEntries = readdirSync(memoriesRoot, { withFileTypes: true })
  } catch {
    // 目录不存在/不可读 → 空段（不报错）。签名含固定前缀，便于与"空树"区分。
    return { refs: [], scenes: [], truncated: false, signature: `∅|${signatureOfIndex(index)}` }
  }

  const add = (ref: SceneFileRef): void => {
    const existing = byId.get(ref.id)
    // bundle 优先于 flat（与 discover 的同名遮蔽规则一致）。
    if (!existing || (ref.kind === 'bundle' && existing.kind === 'flat')) byId.set(ref.id, ref)
  }

  /** 收集单个目录树内的记忆（scene = 场景名）。 */
  const walk = (scene: string, dir: string, rel: string, depth: number): void => {
    if (depth > MAX_SOURCE_DEPTH || budget.dirs >= MAX_DIRECTORIES || budget.items >= MAX_ENTRIES) {
      truncated = true
      return
    }
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    budget.dirs++
    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const item of entries) {
      if (budget.items >= MAX_ENTRIES) {
        truncated = true
        return
      }
      if (item.name.startsWith('.')) continue // 隐藏项跳过
      const child = join(dir, item.name)
      const relChild = rel ? `${rel}/${item.name}` : item.name

      if (item.isSymbolicLink()) continue // 同步扫描不跟随符号链接（防环）
      if (item.isDirectory()) {
        budget.items++
        let docPath = ''
        for (const candidate of [bundleDocName(item.name), LEGACY_BUNDLE_DOC]) {
          const p = join(child, candidate)
          if (fileStampSync(p) !== 'missing') { docPath = p; break }
        }
        // 指纹带上**目录本身**的 mtime：附件只在段里以「路径 + 文件名」出现，
        // 增删附件不改正文文件，只靠它的话指纹不变、段不会重算，列表就会停在旧值。
        if (docPath !== '') {
          const stamp = `${fileStampSync(docPath)}:${fileStampSync(child)}`
          // bundle 规则（叶子）：父路径为场景，目录名为记忆名。
          const id = scene ? `${scene}/${relChild}` : relChild
          if (forceDisabled || index.rules[id]?.enabled === false) continue // 单条停用 → 不进入段
          add({ id, scene, name: item.name, kind: 'bundle', path: docPath, order: index.rules[id]?.order ?? DEFAULT_ORDER, stamp })
          continue
        }
        walk(scene, child, relChild, depth + 1)
        continue
      }
      if (!item.isFile()) continue
      if (!item.name.toLowerCase().endsWith('.md')) continue // 只认 .md
      budget.items++
      const id = scene ? `${scene}/${relChild.slice(0, -3)}` : relChild.slice(0, -3)
      if (forceDisabled || index.rules[id]?.enabled === false) continue
      add({
        id,
        scene,
        name: item.name.slice(0, -3),
        kind: 'flat',
        path: child,
        order: index.rules[id]?.order ?? DEFAULT_ORDER,
        stamp: fileStampSync(child),
      })
    }
  }

  // 一级目录 = 场景（根层的裸 .md 不再是记忆，故此处不处理文件）。
  for (const item of [...rootEntries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.name.startsWith('.')) continue
    if (item.isSymbolicLink()) continue
    if (!item.isDirectory()) continue
    if (!isValidGroupSegment(item.name)) continue // 非法目录名 → 不作为场景
    scenes.push(item.name)
  }

  // ② 场景目录树
  for (const scene of scenes) walk(scene, join(memoriesRoot, scene), '', 1)

  const refs = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
  const signature = [
    signatureOfIndex(index),
    truncated ? 'T' : '-',
    scenes.join('\u0001'),
    ...refs.map((r) => `${r.id}\u0000${r.kind}\u0000${r.order}\u0000${r.stamp}`),
  ].join('\u0002')
  return { refs, scenes, truncated, signature }
}

/**
 * 第二相：读正文 + 派生 + 确定性拼接。仅在指纹变化时调用。
 */
export function renderSceneMemory(
  probe: { refs: SceneFileRef[]; scenes: string[]; truncated: boolean },
  index: RulesIndex,
  maxBytes: number,
): SceneMemoryProjection {
  const files: SceneMemoryFile[] = []
  for (const ref of probe.refs) {
    const text = readFileIfExistsSync(ref.path)
    if (text === null) continue // 探测与读取之间被删：跳过（下次指纹变化会再校正）
    const doc = parseSkillDoc(text) as ParsedSkillDoc
    const derived = deriveFromDoc(
      { id: ref.id, group: ref.scene, name: ref.name, kind: ref.kind, docPath: ref.path, entryPath: ref.path },
      doc,
    )
    files.push({
      id: ref.id,
      scene: ref.scene,
      name: derived.name,
      description: derived.description,
      descriptionDerived: derived.descriptionDerived,
      order: ref.order,
      body: doc.body,
      kind: ref.kind,
      // bundle 的正文是 `<目录>/<名>.md`，附件是**同目录**的其余文件。
      bundleDir: ref.kind === 'bundle' ? dirname(ref.path) : '',
    })
  }

  const { active } = resolveActiveScenes(index, probe.scenes)
  const buckets = new Map<string, SceneMemoryFile[]>()
  for (const file of files) {
    // 保留场景 global 恒定生效（「全局」= 任何对话都注入）；其余由 index.active 决定。
    if (file.scene !== GLOBAL_SCENE && !active.has(file.scene)) continue
    // ⚠️ 这里**不再**看场景档案的 memories 段：记忆的开关是**单一真相源** `rules[*].enabled`
    // （见下方 enabled 判定）。档案弹窗里的记忆勾选就是同一个值，所以两边天然一致，
    // 不存在「记忆页开了、档案页还显示未开」的两套状态。
    const list = buckets.get(file.scene)
    if (list) list.push(file)
    else buckets.set(file.scene, [file])
  }

  // ── 候选块（确定性顺序：场景 → 场景内 order/名称）────────────────────────
  const candidates: SceneBlockCandidate[] = []
  let seq = 0
  for (const scene of [...buckets.keys()].sort((a, b) => compareSceneBuckets(a, b, index))) {
    const sceneFiles = (buckets.get(scene) || []).slice().sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    const header = sceneHeader(scene, index)
    for (const file of sceneFiles) {
      const { text: block, inline } = memoryBlock(file)
      candidates.push({
        seq: seq++,
        scene,
        header,
        block,
        inline,
        item: { id: file.id, scene: file.scene, name: file.name, bytes: byteLen(block) },
      })
    }
  }
  if (candidates.length === 0) {
    return { text: '', bytes: 0, truncated: probe.truncated, maxBytes, scenes: [], items: [], dropped: [] }
  }

  /**
   * 选中块 → 段正文（同一场景的 `## 场景：x` 只在首次出现时发出）。
   * `dropped` 决定引导语用哪一版：真有条目没注入时不再声称「以下就是全部信息」。
   */
  const renderBody = (selected: SceneBlockCandidate[], dropped: boolean): string => {
    if (selected.length === 0) return ''
    const note = dropped ? SCENE_MEMORY_NOTE_PARTIAL : SCENE_MEMORY_NOTE
    const chunks: string[] = []
    let current: string | null = null
    let buf = ''
    // 上一条是不是「单行条目」。连续两条单行条目紧挨着（列表的自然形态），
    // 其余情况都要空一行 —— 多行正文（含其缩进挂载的附件行）与下一条之间没有空行的话，
    // 读起来会连成一片、看不出条目边界。
    let prevInline = false
    for (const c of selected) {
      if (c.scene !== current) {
        if (buf !== '') chunks.push(buf)
        current = c.scene
        // 引导语跟着**场景块**走（场景说明之后、条目之前）：它管的就是下面这些条目，
        // 放最顶层会飘在场景之外（用户实测反馈「怎么跑到最顶层了」）。场景数有上限
        // （`global`/`_shared` 恒常启用 + 至多一个启用场景），最多出现 3 次，代价可接受。
        buf = `${c.header}${note}\n\n`
        prevInline = false
      }
      const inline = c.inline
      if (!(inline && prevInline) && !buf.endsWith('\n\n')) buf += '\n'
      prevInline = inline
      buf += c.block
    }
    if (buf !== '') chunks.push(buf)
    return chunks.join('\n')
  }

  const sceneLabelOf = (scene: string): string => sceneLabel(scene)

  /** 未注入清单 + 截断标记，在 `space` 字节内尽量列全（放不下的折叠为一行计数）。 */
  const renderTail = (missed: SceneBlockCandidate[], space: number, wasTruncated: boolean): string => {
    if (!wasTruncated) return '' // 没截断就不该出现标记
    const marker = `\n${TRUNCATION_MARKER}\n`
    if (missed.length === 0) return byteLen(marker) <= space ? marker : ''
    const head = `\n${DROPPED_HEADING}\n\n`
    const lines: string[] = []
    let used = byteLen(head) + byteLen(marker)
    for (const c of missed) {
      const line = `- ${sceneLabelOf(c.scene)}/${c.item.name}（${c.item.bytes} B）\n`
      if (used + byteLen(line) > space) break
      lines.push(line)
      used += byteLen(line)
    }
    if (lines.length === 0) return byteLen(marker) <= space ? marker : ''
    const rest = missed.length - lines.length
    const fold = `- …（其余 ${rest} 条未列出）\n`
    const tail = `${head}${lines.join('')}${rest > 0 && used + byteLen(fold) <= space ? fold : ''}${marker}`
    return tail
  }

  // ── ① 贪心：放得下就放，越界**跳过**（而不是整体停止）──────────────────
  // 原来一旦某块越界就 stopped，于是一条超长记忆会把它后面的所有小记忆一起饿死。
  const markerReserve = byteLen(`\n${TRUNCATION_MARKER}\n`)
  const selected: SceneBlockCandidate[] = []
  const missed: SceneBlockCandidate[] = []
  const takenScenes = new Set<string>()
  // 场景标题与引导语也是开销，按「每个首次出现的场景」计进预算 —— 否则它们会挤掉
  // 本该放得下的记忆（引导语的字节见 SCENE_NOTE_BYTES）。
  let used = 0
  const noteBytes = sceneNoteBytes()
  for (const c of candidates) {
    const headerCost = takenScenes.has(c.scene) ? 0 : byteLen(c.header) + noteBytes
    if (used + headerCost + c.item.bytes + markerReserve > maxBytes) {
      missed.push(c)
      continue
    }
    selected.push(c)
    takenScenes.add(c.scene)
    used += headerCost + c.item.bytes
  }
  missed.sort((a, b) => a.seq - b.seq)

  // ── ② 尾注自身也占字节：放不下就把已入选的块从后往前退回，直到回到预算内 ──
  let body = renderBody(selected, probe.truncated || missed.length > 0)
  let tail = renderTail(missed, maxBytes - byteLen(body), probe.truncated || missed.length > 0)
  while (byteLen(body) + byteLen(tail) > maxBytes && selected.length > 0) {
    missed.push(selected.pop() as SceneBlockCandidate)
    missed.sort((a, b) => a.seq - b.seq)
    body = renderBody(selected, true)
    tail = renderTail(missed, maxBytes - byteLen(body), true)
  }

  let text = `${body}${tail}`.replace(/^\n+/, '')
  // ③ 兜底：预算小到连标记都放不下时也宁可超出几个字节——"有记忆没注入"这件事
  // 绝不能静默消失（原来单条超预算会让整段变成空串，模型端完全无痕）。
  if (text === '' && (missed.length > 0 || probe.truncated)) text = `${TRUNCATION_MARKER}\n`

  const scenes: string[] = []
  for (const c of selected) if (!scenes.includes(c.scene)) scenes.push(c.scene)
  return {
    text,
    bytes: byteLen(text),
    truncated: probe.truncated || missed.length > 0,
    maxBytes,
    scenes,
    items: selected.map((c) => c.item),
    dropped: missed.map((c) => c.item),
  }
}

/**
 * 段首固定块。以 `\n` 结尾，与场景块 join 后自然空一行。
 * 预算按**较长**的那版算（见 renderSceneMemory），保守一点只会浪费几个字节。
 */
/**
 * 引导语所占的字节（含它后面的一个空行）。跟着场景块走，所以按**每个场景**计入段头开销；
 * 用较长的那版（带完整性声明）算，保守一点只会浪费几个字节。
 *
 * 注意：模块级不能直接算 —— `byteLen` 是后面才声明的 const，模块初始化期取它会 TDZ 报错。
 */
export const sceneNoteBytes = (): number => byteLen(`${SCENE_MEMORY_NOTE}\n\n`)

// ── 创建服务 ───────────────────────────────────────────────────────────────
