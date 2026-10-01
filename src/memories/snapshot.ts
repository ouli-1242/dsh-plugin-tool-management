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
import { MAX_SOURCE_DEPTH, MAX_DIRECTORIES, MAX_ENTRIES, MAX_DESCRIPTION_LENGTH, DEFAULT_ORDER, DEFAULT_GROUP_ORDER, GLOBAL_SCENE, TRUNCATION_MARKER, DROPPED_HEADING, SCENE_MEMORY_NOTE, LEGACY_BUNDLE_DOC, bundleDocName, SEGMENT_RULE_HINT, SHARED_GROUP, byteLen, message, isValidGroupSegment } from './constants.js'
import { ensureSceneRecords, resolveActiveScenes, signatureOfIndex, sceneLabel, sceneHeading, sceneLine, compareSceneBuckets, memoryBlock } from './projection.js'
import { isIndexQuarantined, readIndex, writeIndex, pathExists, readFileOrThrowSync, isAbsentError } from './index-io.js'
import type { RuleIndexEntry } from './index-io.js'
import type { Rule, GroupRow, SceneMemoryProjection, RulesIndex, SceneMemoryFile } from './service.js'

// 来源发现与投影（扫目录读成条目 / frontmatter 投成规则 / 老布局搬家）2026-10-01 整段搬到
// ./discovery.js，正文一字未改（moved-verify 逐字对拍）。snapshot.js 的公开面照旧：搬走的
// 九件全部从这里再出口 —— memories/service.ts 按 ./snapshot.js 引它们。
export {
  deriveDescription,
  deriveFromDoc,
  discover,
  identity,
  projectRule,
  relocateLegacyLayout,
} from './discovery.js'
export type { DerivedFields, DiscoveredEntry, ParsedSkillDoc } from './discovery.js'
import {
  deriveFromDoc,
  discover,
  identity,
  projectRule,
  relocateLegacyLayout,
} from './discovery.js'
import type { DiscoveredEntry, ParsedSkillDoc } from './discovery.js'

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

// ── 规则解析 + 派生 ────────────────────────────────────────────────────────

/** 派生 description：首个 `#` 标题 → 首个非空行；截断 500 字符。 */

/** 从 frontmatter/正文派生字段（派生只存在于内存投影，不写回文件）。 */

/** 合并索引字段（enabled/order 等以索引为准；无记录走默认投影）。 */

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

/**
 * `mtime:size` 指纹；**不存在**返回 `'missing'`，其余 IO 失败**抛异常**。
 *
 * 为什么抛（2026-09-30 审查 F7）：探测阶段这个值同时用来判「bundle 的正文文件在不在」。
 * 把 EACCES/EBUSY 一并吞成 `'missing'`，等于把"读不动"读成"没有这条记忆" —— 段里少一条，
 * 而注入通道只看到"内容变了/变空了"，最坏时发出一条假的「已清空」。抛出去之后，注入侧
 * 报 `error` 并**保留上一轮内容**，界面侧退回上一轮投影（见 service.ts 的同名注释）。
 */
export function fileStampSync(path: string): string {
  try {
    const st = statSync(path)
    return `${st.mtimeMs}:${st.size}`
  } catch (e) {
    if (isAbsentError(e)) return 'missing'
    throw e
  }
}

/**
 * 第一相：走目录树 + stat，不读正文。
 *   `<场景>/...` → 场景记忆（一级目录名即场景名，含保留场景 `global`）；
 *   是否生效由 index.active 决定，`global` 恒定生效（见 renderSceneMemory）。
 * 根层的裸 .md **不再是记忆**（旧的「全局」桶已迁入 `global/`，见 relocateLegacyLayout），
 * 因此这里不再扫描根层文件——把文件丢在 memories/ 根下不会静默生效，也不会被投影。
 * `signature` 不变 ⇒ 上次渲染结果可原样复用（零正文 IO、零重排）。
 *
 * **读失败抛异常、不存在才算空**（2026-09-30 审查 F7）：根目录与子目录的 `readdirSync` 只在
 * `ENOENT`（目录不存在 = 全新用户 / 刚删掉）时退化成空段；其余 IO 错误（Windows 上杀软 /
 * 索引器 / 备份软件占住会报 EACCES/EBUSY）一律抛给调用方 —— 把"读不动"当成"没有记忆"会让
 * 注入通道发出假的「已清空」。
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
  } catch (e) {
    // 目录不存在（全新用户 / 刚删掉）→ 空段。签名含固定前缀，便于与"空树"区分。
    // 其余 IO 错误必须抛：见函数头注释（F7）。
    if (!isAbsentError(e)) throw e
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
    } catch (e) {
      // 子目录在遍历中途被删 → 跳过（正常竞态）；其余 IO 失败照函数头的口径抛出（F7）。
      if (isAbsentError(e)) return
      throw e
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
    const text = readFileOrThrowSync(ref.path)
    // 探测与读取之间被删 → 跳过（下次指纹变化会再校正）。读不动**不**走这条：那会静默
    // 少一条记忆，最坏时让注入通道发假的「已清空」（F7）—— 抛出去由调用方决定处置。
    if (text === null) continue
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
    // 场景块只留标题：**场景说明归场景段**（`renderSceneCatalog`），否则同一句话会在
    // 上下文里出现两遍。记忆段要的是"这些条目属于哪个场景"这个分组标签。
    // `sceneHeading` 只给标题、不自带结尾空行（场景段的 `sceneLine` 才自带），这里补上 ——
    // 否则标题会与紧跟的引导语/条目贴成一行（`## 场景：全局**以下是…**`）。
    const header = sceneHeading(scene) + '\n\n'
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
   *
   * 授权语**只有一版**：2026-09-23 第四次裁定删掉了完整性声明（「以下就是全部信息」），
   * 于是"按截断状态选长短两版"的自适应失去意义（两版会完全相同），`dropped` 参数一并移除。
   * 详见 `SCENE_MEMORY_NOTE` 的注释 —— 代价是这一段不再有防探测手段。
   */
  const renderBody = (selected: SceneBlockCandidate[]): string => {
    if (selected.length === 0) return ''
    const note = SCENE_MEMORY_NOTE
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
        buf = c.header
        prevInline = false
      }
      const inline = c.inline
      if (!(inline && prevInline) && !buf.endsWith('\n\n')) buf += '\n'
      prevInline = inline
      buf += c.block
    }
    if (buf !== '') chunks.push(buf)
    // 引导语只出现**一次**，放在板块层（第一个场景块之前）。
    //
    // 为什么挪上来（用户 2026-09-23 看到实际注入后要求）：此前它跟着**每个场景块**各来一遍
    // —— 2 个场景就是 272 B ≈68 tok/轮，占记忆段整段的 22%；而且它夹在 `## 场景：X` 与条目
    // 之间，把"分组"和"内容"隔开了。它管的本来就是整段（授权语讲的是这一整段条目的效力，
    // 不是某个场景的），放在最前面才对得上。
    //
    // 2026-09-23 更早那条「放最顶层会飘在场景之外（用户实测）」的约束**已不成立**：那次是
    // 板块标题还是 `##`、与场景分组平级，放顶层确实分不清它管谁；现在板块升成 `#` 一级、
    // 场景分组是 `##` 二级，放在两者之间就是明确的"板块级说明"。
    return `${note}\n\n${chunks.join('\n')}`
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
  // 本该放得下的记忆（引导语的字节见 SCENE_NOTE_BYTES）。引导语现在**整段只算一次**
  // （放在板块层，见 renderBody），所以直接进初始用量，不再按场景累加。
  let used = sceneNoteBytes()
  for (const c of candidates) {
    const headerCost = takenScenes.has(c.scene) ? 0 : byteLen(c.header)
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
  let body = renderBody(selected)
  let tail = renderTail(missed, maxBytes - byteLen(body), probe.truncated || missed.length > 0)
  while (byteLen(body) + byteLen(tail) > maxBytes && selected.length > 0) {
    missed.push(selected.pop() as SceneBlockCandidate)
    missed.sort((a, b) => a.seq - b.seq)
    body = renderBody(selected)
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
 * 引导语所占的字节（含它后面的一个空行）。**整段只算一次** —— 它放在板块层（见 renderBody），
 * 不再跟着场景块重复。
 *
 * 注意：模块级不能直接算 —— `byteLen` 是后面才声明的 const，模块初始化期取它会 TDZ 报错。
 */
/**
 * 场景段（`scene-manager-catalog`）：列出**当前启用**的场景，一行一个
 * （`**「场景名」—— 场景说明**`，见 `sceneLine`）。
 *
 * 为什么从记忆段里拆出来（2026-09-23 用户裁定）：场景说明是"这个场景是干什么的"，记忆条目是
 * **记录**（权威等级低于用户当场说的）—— 两者性质不同，而原来的实现靠一句话同时管两者。拆开后
 * 用户能**单独关掉记忆段**（省字节）而保留场景说明。
 *
 * 本段**没有任何引导语**：授权语在 2026-09-23 第二次裁定里删掉（上一版把场景说明写成
 * "一律照办"的约定，而它的实例是「写代码」这种**标签**，让模型"照办一个标签"正是它读不懂
 * 这一段的原因）；替它补的那句"场景是什么"线索当天也被删了（第三次裁定，连同六个域的动作句
 * 一起，理由见 `DomainFrame`）。现在本段只有 `sceneLine` 一行 —— 用户的原则是「上下文注入
 * 就是当前的情况，不需要模型知道没用的信息」。
 *
 * 与记忆段的分工：这里给"框架"，记忆段给"内容"（各场景下的条目）。**场景说明只在这里出现**
 * —— 记忆段的场景块只留标题（`sceneHeading`），否则同一句话会在上下文里出现两遍。代价是
 * 关掉本段后记忆段少了"这个场景是什么"的语境，但那正是用户关掉它的意思。
 *
 * 场景清单取**磁盘目录 ∪ 索引记录**：两者通常一致（建场景时同时落目录与记录），取并集是
 * 为了手工建的目录 / 手工删过记录的目录也能如实列出。**空场景也列** —— "这个场景存在但还
 * 没有内容"本身就是框架信息（记忆段只列有记忆的场景，两者不是同一份清单）。
 *
 * **只列启用的非保留场景**（排除 `global` / `_shared`）：那两个桶恒常生效，说"当前处于全局"
 * 是废话 —— 默认状态不该占上下文（用户 2026-09-23 裁定）。一个具体场景都没启用时整段返回
 * 空串（通道不发这条消息），而不是发一句"当前处于全局"。
 *
 * **场景是单选的**：除保留场景（`global` / `_shared`）外至多一个处于启用状态。这条约束由
 * `rules-set-active`（界面单选）+ `rules-create-scene` 的 `collapseActiveForNewScene`（把
 * 历史「全部启用」收敛成单选）保证，本函数**只读**、不替用户收敛。历史遗留的"同时启用多个"
 * 在收敛之前会如实列出多个 —— 注入反映现状，界面另有 `scenes.legacyAll` 提示与一键收敛。
 */
export function renderSceneCatalog(
  // 只要清单与截断标记：场景段不读正文（`refs` 是记忆段才需要的）。
  probe: { scenes: string[]; truncated: boolean },
  index: RulesIndex,
  maxBytes: number,
): SceneMemoryProjection {
  const { active } = resolveActiveScenes(index, probe.scenes)
  const names = new Set<string>([...probe.scenes, ...Object.keys(index.scenes || {})])
  const wanted = [...names]
    .filter((scene) => scene !== '' && scene !== GLOBAL_SCENE && scene !== SHARED_GROUP && active.has(scene))
    .sort((a, b) => compareSceneBuckets(a, b, index))
  // 默认状态（只有保留桶生效）：整段不注入。返回空串而不是"当前处于全局"——后者是废话，
  // 而且会让通道每轮都发一条没有信息量的消息。
  if (wanted.length === 0) {
    return { text: '', bytes: 0, truncated: probe.truncated, maxBytes, scenes: [], items: [], dropped: [] }
  }
  // 这一段**只给当前情况**：启用了哪些非保留场景、各自是什么（`sceneLine`）。
  //
  // 曾经在这里加过一句因果（"下面的记忆、MCP、技能与人设都已按它筛过"），已删（用户
  // 2026-09-23 裁定）：「上下文注入就是当前的情况，目的是让 agent 知道现在的情况，不需要它
  // 知道没用的信息，反推更是浪费 token」。那句话解释的是**另外四段是怎么产生的**（机制），
  // 不是当前情况本身。留着它的两个额外代价也一并消失：① 场景**启用**（`active`）与场景
  // **进入**（`mode.scene`）是两份状态、两个 op，只启用没进入时那句是假话，得按 mode 分叉
  // 才能不说错；② 它排在场景名之前时「它」没有指代。
  const marker = `\n${TRUNCATION_MARKER}\n`
  const kept: string[] = []
  let used = 0
  let dropped = false
  for (const scene of wanted) {
    const block = sceneLine(scene, index)
    // 场景是单选的（至多一个 + 两个保留场景），正常永远碰不到预算 —— 这一层只是不让
    // "预算被配得极小"变成一段没有边界说明的静默截断。
    if (used + byteLen(block) + marker.length > maxBytes) { dropped = true; continue }
    kept.push(scene)
    used += byteLen(block)
  }
  let text = kept.map((scene) => sceneLine(scene, index)).join('')
  if (dropped) text += marker
  text = text.replace(/^\n+/, '')
  return {
    text,
    bytes: byteLen(text),
    truncated: probe.truncated || dropped,
    maxBytes,
    scenes: kept,
    items: [],
    dropped: [],
  }
}

export const sceneNoteBytes = (): number => byteLen(`${SCENE_MEMORY_NOTE}\n\n`)

// ── 创建服务 ───────────────────────────────────────────────────────────────
