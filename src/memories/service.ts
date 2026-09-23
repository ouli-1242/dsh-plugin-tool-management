// 域 op（2026-09-19 抽出）：24 个 op 按记忆正文 / 回收站 / 场景分域，依赖经显式 ctx 传入。
import { buildMemoryOps } from '../ops/memory.js'
import { buildTrashOps } from '../ops/trash.js'
import { buildSceneRecordOps } from '../ops/scene-records.js'
import type { MemoriesOpsCtx } from '../ops/ctx.js'
// dsh-plugin-tool-management —— 规则/记忆（Rules v0.3，见 CHANGE-REQUEST-01）服务层。
//
// 记忆 = $DSH_HOME/tool-management/memories/<场景>/<name>.md（flat）或 <场景>/<name>/<name>.md（bundle）。
// 历史遗留的 bundle 正文文件名 `SKILL.md` 仍被识别（只读兼容），但新建/更新一律写 `<name>.md`。
// **场景是显式记录**，但记录的真源是 `memories-index.json` 的 `scenes` 切片（见 `SceneRecord`
// 与 `sceneRecordOf`），**不是** `scenes/<场景>.json` —— 那个目录是 v0.3 遗留的空壳：代码
// 只 `mkdir` 它、并把路径回显给前端，从不读写里面的文件（`SCENES_DIR` 全仓仅 3 处命中）。
// 场景因此不依赖"memories/ 下恰好有这个名字的目录"这种隐式约定：空场景可以存在，
// 且场景可以有描述。目录名即场景名（任意 Unicode，见 isValidGroupSegment）。
// （按 `scenes/*.json` 去找场景记录、或按它写备份/迁移脚本，都会扑空 —— 2026-09-19 订正。）
// 保留场景 `global`（界面显示「全局」）：其记忆注入任何对话；它恒定存在、不可删除。
// 勾选启用后，该目录树内所有 .md 的正文自动进入模型的上下文（index.ts 注册的注入通道，
// 每步一条消息；见 src/context-inject.ts），模型无需做任何动作 —— 这就是"不用每次都要解释"。
//
// 单投影（原 ADR-4 的"双投影"已被本变更单修订）：
//   - 活动场景记忆 → 上下文注入（自动在场，会话级恒定 → 前缀稳定、缓存可命中；
//     文本没变时不重发 —— 2026-09-16 从 systemPrompt 段改道，理由见 context-inject.ts 文件头）
//   - `_shared/` 承担"恒常"语义（所有场景共用）；原 per-rule `always` 标志已移除
//   - 不再写 ~/.dsh/AGENTS.md（原始终层投影下线）
//
// 状态分层（两份文件各司其职，互不写回）：
//   - 规则文件：正文真源。frontmatter 可声明 name/description/whenToUse/globs/metadata。
//   - memories-index.json：启停/排序/标签/启用场景集合等**索引为准**字段（不写回记忆文件）。
//
// 发现必须自实现（不复用 readonly-discovery）：可写来源只扫一层会压扁子目录场景，
// 而规则的目录树天然是多层的；且 readonly-discovery 的 flat 只认顶层。
//
// 缓存红线（§5.2）：段内容只由「启用场景 + 文件内容」决定，禁止时间戳/计数/相对时间；
// 场景组合或记忆文件不变 ⇒ 逐字节稳定 ⇒ 前缀缓存命中。切换场景/编辑记忆只变化一次。
//
// 错误约定：业务校验失败返回 { ok:false, error: 中文, code, params? }（与 skills core 一致）；
// ops 成功返回扁平 { ok:true, ... }，不套 { ok:true, data }。

import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, renameSync, statSync } from 'node:fs'
import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { isInsideRootResolved, isValidSegment } from '../paths.js'
import { parseSkillDoc, renameWithRetry, resolveDshHome, unquote } from '../skills/core.js'
import { expandUploads, planMemoryImport } from '../imports/upload.js'
import { normalizePresetId } from '../prompts/preset-id.js'
import { normalizeArchive, type ModeState, type SceneArchive } from './archive.js'
import { isValidTrashId, listTrashEntries, moveOutOfTrash, moveToTrash, newTrashId, purgeTrashEntry, readTrashEntry } from '../hub.js'
// 预算 / 保留场景名 / 段渲染常量（2026-09-19 抽到 ./constants.ts：投影函数与本服务共用，
// 留在这里会让 projection.ts 反向 import 本文件，形成运行时循环依赖）。
import {
  ATTACHMENT_LIST_MAX, bundleDocName, byteLen, DEFAULT_GROUP_ORDER, DEFAULT_MAX_BYTES, DEFAULT_ORDER,
  DROPPED_HEADING, GLOBAL_SCENE, GLOBAL_SCENE_LABEL, INDEX_VERSION, INLINE_BODY_MAX, LEGACY_BUNDLE_DOC,
  MAX_ATTACH_ENTRIES, MAX_ATTACH_ENTRY_BYTES, MAX_ATTACH_TOTAL_BYTES, MAX_DESCRIPTION_LENGTH,
  MAX_DIRECTORIES, MAX_ENTRIES, MAX_GROUP_SEGMENT_LENGTH, MAX_RULE_BYTES, MAX_SOURCE_DEPTH,
  SCENE_CATALOG_MAX_BYTES, SCENE_MEMORY_NOTE, SEGMENT_RULE_HINT, SHARED_GROUP, SNAPSHOT_TTL_MS,
  TRUNCATION_MARKER, isValidGroupPath, isValidGroupSegment, message, MEMORIES_TRASH_DIR, fail,
} from './constants.js'
// 对外契约保持在原路径：本文件此前直接 export 这两个，index.ts 等已按此 import。
export { GLOBAL_SCENE, GLOBAL_SCENE_LABEL } from './constants.js'
export { isValidGroupSegment, isValidGroupPath, MEMORIES_INDEX_FILE, MEMORIES_TRASH_DIR } from './constants.js'
// parseModeState 搬到了 index-io.ts，但 test/contracts.test.mjs 按原路径引它 —— 契约不能断。
export { parseModeState } from './index-io.js'
// 投影 / 渲染纯函数（2026-09-19 抽到 ./projection.ts）：索引 → 界面与注入看到的那份文本。
import {
  attachmentLine, attachmentNamesSync, attachmentSummarySync, collapseActiveForNewScene,
  compareSceneBuckets, enabledSceneOf, ensureSceneRecords, explicitDescriptionOf,
  bodyBlock, memoryBlock, normalizeActive, resolveActiveScenes, sceneHeading, sceneLabel,
  sceneOf, sceneOrderOf, signatureOfIndex,
} from './projection.js'
// 索引 IO 组与发现/快照组（2026-09-19 抽出）。
import { writeFileAtomically, writeFileAtomicBinary, isIndexQuarantined, readIndex, readIndexSync, writeIndex, sceneRecordOf, normalizeScenePromptId, pathExists } from './index-io.js'
import type { SceneIndexEntry, RuleIndexEntry, GroupIndexEntry } from './index-io.js'
import { deriveDescription, deriveFromDoc, projectRule, relocateLegacyLayout, buildSnapshot, probeSceneFilesSync, renderSceneCatalog, renderSceneMemory } from './snapshot.js'
import type { ParsedSkillDoc, DiscoveredEntry, Snapshot } from './snapshot.js'

// ── 目录常量与失败约定 ─────────────────────────────────────────────────────
// 其余跨文件共用的常量与无依赖小工具（message / isValidGroupSegment / isValidGroupPath /
// MEMORIES_INDEX_FILE）已下沉到 ./constants.ts，避免 index-io / snapshot 反向引本文件。


/**
 * 场景/记忆根目录名（$DSH_HOME 下），集中在 `tool-management/` 一个目录内：
 *   - `memories/<场景>/…`    记忆正文真源
 *   - `..`（即 tool-management 根）侧车：memories-index.json（内含 `scenes` 切片 = 场景记录
 *     的**真源**）/ skills-state.json / trash/ / memories-trash/
 *
 * `scenes/`（`SCENES_DIR`）是 v0.3 遗留的**空壳**：只创建、只回显路径，没有任何读写。
 * 别把场景记录的位置写成它。
 *
 * 历史位置 `$DSH_HOME/scene-memory/` 由 `relocateLegacyLayout()` 在首次读写前搬入。
 */
export const HUB_DIR = 'tool-management'

export const SCENES_DIR = 'scenes'

export const MEMORIES_DIR = 'memories'


/** 提示词预设库目录名（hub 根下；域 = 提示词，工具 `prompt_manager_*`）。 */
export const PRESETS_DIR = 'prompts'


// ── 对外接口 ───────────────────────────────────────────────────────────────

export interface MemoriesDeps {
  /** 记忆根目录（绝对路径；空串/未提供时按 $DSH_HOME/tool-management/memories 解析）。 */
  memoriesRoot: string
  /** 侧车目录（索引/回收站；空串/未提供时按 $DSH_HOME/tool-management 解析）。 */
  stateDir: string
  /** 场景记录目录（绝对路径；空串/未提供时按 <stateDir>/scenes 解析）。 */
  scenesDir?: string
  /** 场景记忆段预算上限（字节），默认 65536。 */
  maxBytes?: number
}

export interface Rule {
  id: string
  group: string
  name: string
  /** 对外契约用 form（与 §7.1 一致）；内部发现用 DiscoveredEntry.kind。 */
  form: 'flat' | 'bundle'
  /** 规则文件绝对路径（flat= .md；bundle= <名>.md，旧数据可能是 SKILL.md）。 */
  path: string
  description: string
  descriptionDerived?: boolean
  whenToUse?: string
  globs?: string
  metadata?: unknown
  enabled: boolean
  order: number
  tags: string[]
  pinned: boolean
  note: string
  updatedAt?: string
  /**
   * 正文文件在磁盘上的字节数（记忆是**直接吃注入预算**的那一域，128 KiB 上限按场景段算，
   * 界面上此前却看不出哪条大）。读不到文件时不带这个字段 —— 0 与"不知道"必须能分开。
   */
  bytes?: number
  /** 同名 bundle 存在时被遮蔽的 flat（UI 标红，不参与投影）。 */
  shadowed?: boolean
  /**
   * bundle 记忆的附件摘要。**只在 `rules-list` 的返回里**补上（发现阶段不扫附件目录）；
   * flat 记忆没有这个字段。目录读不到时也不会有（界面据此不显示附件标签，而不是谎报 0）。
   */
  attach?: { count: number; bytes: number; names: string[] }
}

/**
 * 记忆导出的落盘映射（`bundle-export` 的 `kind: 'memories'` 用，见 design-plan D14）。
 *
 * 记忆有两种形态（见文件头）：flat = `<场景>/<name>.md`，bundle = `<场景>/<name>/<name>.md`；
 * 而且**场景名本身可含 `/`**（多段场景名，见 `isValidGroupPath`）。所以「按 id 的最后一个
 * `/` 切出场景与名字、再拼 `.md`」是错的：bundle 会被读成 `<场景>/<name>.md` → 读不到 →
 * 该项目静默丢失（只在 `missing` 里留个名，界面按「导出成功」显示）。
 *
 * 这里一律按索引里那条规则自己的 `path` 与 `form` 决定；bundle 只交出目录，由调用方
 * 把目录内的文件全部打包（与技能分支同口径）。索引里没有、或已被同名 bundle 遮蔽的 id
 * 进 `missing`——遮蔽的 flat 不会被加载，导出去只会让人以为它能用。
 *
 * 纯函数（不碰磁盘），可直接断言。
 */
export function planMemoryExport(
  names: unknown,
  rules: unknown,
): { entries: Array<{ id: string; zip: string; abs: string; kind: 'file' | 'dir' }>; missing: string[] } {
  type Row = { id?: unknown; form?: unknown; path?: unknown; shadowed?: unknown }
  const list = Array.isArray(names) ? names.map((n) => String(n).trim()).filter(Boolean) : []
  const byId = new Map<string, Row>()
  for (const row of (Array.isArray(rules) ? rules : []) as Row[]) {
    const id = row && typeof row.id === 'string' ? row.id : ''
    if (id !== '') byId.set(id, row)
  }
  const entries: Array<{ id: string; zip: string; abs: string; kind: 'file' | 'dir' }> = []
  const missing: string[] = []
  for (const id of list) {
    const row = byId.get(id)
    const abs = row && typeof row.path === 'string' ? row.path : ''
    if (!row || abs === '' || row.shadowed === true) {
      missing.push(id)
      continue
    }
    entries.push(row.form === 'bundle'
      ? { id, zip: id, abs: dirname(abs), kind: 'dir' }
      : { id, zip: `${id}.md`, abs, kind: 'file' })
  }
  return { entries, missing }
}

export interface GroupRow {
  name: string
  label: string
  order: number
  count: number
}

/** 场景 = 记忆的一级归属；`global` 为保留的「全局」场景。 */
export interface SceneRow {
  name: string
  label: string
  order: number
  /** 该场景目录树内的记忆条数（不含被遮蔽条目）。 */
  count: number
  /** 是否参与系统提示词注入（`_shared` 与 `global` 恒为 true）。 */
  active: boolean
  /** `_shared`：公共基线，UI 上锁定为常开。 */
  shared: boolean
  /** 保留场景 `global`（界面「全局」）：不可删除、不可停用。 */
  global: boolean
  /** 场景描述（用户在「新建/编辑场景」里填的一句话）。 */
  description: string
}

/** 场景记忆段的一次渲染结果（纯函数产物，确定性：无时间戳/计数）。 */
export interface SceneMemoryProjection {
  text: string
  bytes: number
  truncated: boolean
  maxBytes: number
  /** 参与渲染的场景（确定性顺序，含 `_shared` 与全局 `''`）。 */
  scenes: string[]
  items: Array<{ id: string; scene: string; name: string; bytes: number }>
  /** 因超出预算**未**注入的记忆（确定性顺序；段尾也会列出它们，模型与用户都能看见）。 */
  dropped: Array<{ id: string; scene: string; name: string; bytes: number }>
}

/** 当前生效的场景提示词投影（供注入兜底与只读状态展示）。 */
export interface ScenePromptProjection {
  /** 提供这段提示词的场景；`null` = 没有任何场景绑定提示词。 */
  scene: string | null
  /** 绑定的预设 id；`null` = 未绑定。 */
  presetId: string | null
  /** 预设正文（逐字节原样；段为空时宿主会删除该段）。 */
  text: string
  /** 绑定了预设但文件不存在/为空（UI 要如实标出来，别让用户以为注入了）。 */
  missing: boolean
  /**
   * 绑定的预设与**当前 `~/.dsh/AGENTS.md` 内容一致** → 不重复注入（否则同一份正文会出现两遍）。
   * 此时这份预设本来就是生效中的基线，用户看不出差别；界面据此显示「生效中」。
   */
  duplicate?: boolean
}

export interface MemoriesService {
  ops: Record<string, (args: any) => Promise<any>>
  /** 写操作 op 名集合（HTTP 端 WRITE_OPS 由它派生；与 ops 表同文件同源维护）。 */
  writeOps: ReadonlySet<string>
  /** 记忆段文本（`memory-manager-catalog`；注入通道同步取用，见 src/context-inject.ts）。 */
  memoryText: () => string
  /**
   * 场景段文本（`scene-manager-catalog`）：**启用的场景 + 场景说明**（约定）。
   * 与记忆段是两个独立注入段，各自去重、各自可被关掉（见 snapshot.ts 的 renderSceneCatalog）。
   */
  sceneCatalogText: () => string
  /**
   * 全局提示词正文（注入兜底用；官方 agent-instructions 行没挂时才被取用）：
   * 场景期间 = 当前场景绑定的提示词，否则 = `~/.dsh/AGENTS.md` 正文。
   */
  promptText: () => string
  /**
   * `promptText()` 的来源文件（同步；注入通道用作 instructions 形态的 `changes`，
   * 界面据此显示文件清单与「已载入/已更新」）。`[]` = 本次没有提示词正文。
   */
  promptFiles: () => Array<{ path: string; digest: string }>
  /** 失效快照与场景记忆缓存（写操作后调用）。 */
  refresh: () => Promise<void>
  /** 场景档案引擎专用：读-改-写 mode/archives/active 切片（写队列内执行，非公开 op，无门禁面）。 */
  patchIndex: (patch: { mode?: ModeState; archives?: Record<string, SceneArchive>; active?: string[] | null }) => Promise<void>
  /** 场景档案引擎专用：读 mode/archives/active 切片。 */
  readArchiveSlice: () => Promise<{ mode: ModeState; archives: Record<string, SceneArchive>; active: string[] | null }>
}

// ── 内部类型 ───────────────────────────────────────────────────────────────

export interface RulesIndex {
  version: 1
  rules: Record<string, RuleIndexEntry>
  groups: Record<string, GroupIndexEntry>
  /** 场景记录（`scenes/<名>.json` 的镜像，索引为准）：名称 → 描述/顺序/创建时间。 */
  scenes?: Record<string, SceneIndexEntry>
  /** 启用场景集合；`null` / 缺失 = 全部场景启用（默认，保证"丢进去就有用"）。 */
  active?: string[] | null
  /** 场景档案（设计 §2.1）：每场景可选的 tools/skills/subagents 勾选集，键存在性独立于集合空否。 */
  archives?: Record<string, SceneArchive>
  /** 当前模式（设计 §2.2）：至多一个场景的档案生效；snapshot = 进入时的运行时启停，退出恢复。 */
  mode?: ModeState
}

/**
 * 一条场景记录。
 *
 * 真源是**索引的 `scenes` 切片**（`index.scenes[name]`）—— 本接口由 `sceneRecordOf()` 从索引
 * 反向构造出来，供响应体使用；`scenes/<名>.json` 那个目录是 v0.3 遗留空壳，从不读写。
 * （主从关系此前写反了，见文件头。）
 */
export interface SceneRecord {
  /** 场景名（= 记忆目录名；`global` 为保留场景）。 */
  name: string
  /** 界面显示名；缺省用 name（保留场景显示「全局」）。 */
  label?: string
  /** 一句话说明这个场景是干什么的（界面卡片副标题）。 */
  description?: string
  /**
   * 绑定的提示词预设 id（`tool-management/prompts/<id>/AGENTS.md`）。
   * 启用该场景时，宿主把这份正文写进 `~/.dsh/AGENTS.md`（scene-prompt-sync.ts，与「提示词」页
   * 的「应用」同一条路，关掉场景恢复进场景前的基线）；预设挂不到官方 agent-instructions 行时
   * （极简），注入通道再拿这份正文兜底（`promptText()` → src/context-inject.ts）。
   * 一个场景至多绑定一个（单值字段即天然单选）；未启用/未绑定 → 不注入。
   */
  prompt?: string
  order?: number
  /** ISO 时间戳；只要**创建**时间，不参与提示词段（段必须逐字节稳定）。 */
  createdAt?: string
}

/** 同步扫描得到的单条场景记忆（供注入文本渲染）。 */
export interface SceneMemoryFile {
  id: string
  /** 一级目录名；`''` = 规则根目录下的全局记忆，`_shared` = 公共基线。 */
  scene: string
  name: string
  description: string
  descriptionDerived: boolean
  order: number
  body: string
  /** `bundle` = 目录形态（正文是 `<名>.md`，同目录其余文件是附件）；`flat` = 单个 .md。 */
  kind: 'flat' | 'bundle'
  /** bundle 的目录（flat 为 `''`）：只用来把**路径**告诉模型，附件正文一律不注入。 */
  bundleDir: string
}

export function createMemoriesService(ctx: any, deps: MemoriesDeps): MemoriesService {
  // 仅测试注入绝对路径；生产按 $DSH_HOME 解析（与核心技能目录同源）。
  // v0.4：全部落到 $DSH_HOME/tool-management/ 一个目录内（memories/ + scenes/ + 侧车），
  // 旧的 $DSH_HOME/scene-memory 与更旧的 $DSH_HOME/rules 由 relocateLegacyLayout() 搬入。
  const stateDir = deps.stateDir && deps.stateDir.trim() !== '' ? resolve(deps.stateDir) : join(resolveDshHome(), HUB_DIR)
  const memoriesRoot = deps.memoriesRoot && deps.memoriesRoot.trim() !== '' ? resolve(deps.memoriesRoot) : join(stateDir, MEMORIES_DIR)
  const scenesRoot = deps.scenesDir && deps.scenesDir.trim() !== '' ? resolve(deps.scenesDir) : join(stateDir, SCENES_DIR)
  const maxBytes = Number.isFinite(deps.maxBytes) && deps.maxBytes! > 0 ? deps.maxBytes! : DEFAULT_MAX_BYTES

  // 旧布局迁移：每个进程只跑一次。放在目录解析之后、任何首次读盘之前。
  let legacyRelocated = false
  const ensureLayout = async (): Promise<void> => {
    if (legacyRelocated) return
    legacyRelocated = true
    try {
      await relocateLegacyLayout(memoriesRoot)
    } catch {
      /* 迁移失败不阻断服务：旧目录原样留着，用户可手工搬 */
    }
    try {
      await mkdir(join(memoriesRoot, GLOBAL_SCENE), { recursive: true })
      await mkdir(scenesRoot, { recursive: true })
    } catch {
      /* 目录建不出来时后面的 op 会各自报错，这里不提前抛 */
    }
  }

  let snapCache: { at: number; value: Snapshot } | null = null
  const snapshot = async (): Promise<Snapshot> => {
    if (snapCache && Date.now() - snapCache.at < SNAPSHOT_TTL_MS) return snapCache.value
    await ensureLayout()
    const value = await buildSnapshot(memoriesRoot, stateDir)
    snapCache = { at: Date.now(), value }
    return value
  }
  const invalidateSnapshot = (): void => {
    snapCache = null
  }

  // ── 场景记忆段（两相扫描 + 指纹缓存）──────────────────────────────────────
  //
  // 段文本 = 活动场景（`_shared` ∪ index.active，缺失时全部）下所有 .md 正文，
  // 按「场景顺序 → 记忆名」确定性拼接；超预算按同一顺序确定性截断并追加固定标记。
  // 禁止时间戳/计数：否则每请求都变，前缀缓存永远不命中（§5.2）。
  //
  // 每次装配：只做「读索引 + stat 遍历」的廉价探测；指纹不变直接返回上次结果，
  // 指纹一变（切场景 / 改文件 / 外部编辑器改文件 / 改 enabled）才重读正文并重排。
  // 见文件顶部「两相扫描」注释里为什么不选 fs.watch 方案。

  let sceneCache: { signature: string; value: SceneMemoryProjection } | null = null
  let sceneCatalogCache: { signature: string; value: SceneMemoryProjection } | null = null

  function sceneMemory(): SceneMemoryProjection {
    const index = readIndexSync(stateDir)
    const probe = probeSceneFilesSync(memoriesRoot, index, isIndexQuarantined(stateDir))
    if (sceneCache && sceneCache.signature === probe.signature) return sceneCache.value
    const value = renderSceneMemory(probe, index, maxBytes)
    sceneCache = { signature: probe.signature, value }
    return value
  }

  // ── 场景提示词（绑定预设正文；读盘、只读；写文件由 scene-prompt-sync.ts 负责）──
  //
  // 语义（用户裁定 2026-09-15）：
  //   - 场景可绑定**一个**提示词预设（`scenes[].prompt` → `prompts/<id>/AGENTS.md`）；
  //   - 除保留场景 `global` 外**同时只能启用一个场景**，所以同一时刻至多一份提示词在场；
  //   - 没有启用其它场景时才轮到 `global` 自己的绑定（它恒常生效，覆盖"永远在场的提示词"）；
  //   - 预设文件不存在 / 未绑定 → 返回 `''`（renderPrompt 会删掉空段，不产生空标题）。
  //
  // 为什么不用 fs.watch 也不用每请求读盘：段契约要求**同步返回**且逐字节稳定，
  // 因此按 `mtimeMs + size` 做一次 stat 缓存 —— 命中时零读盘，外部编辑器改了预设
  // 也会在下一个请求自动刷新（与记忆段的"两相扫描"同一哲学）。
  const promptFileCache = new Map<string, { key: string; text: string }>()

  /** 读一个预设正文（同步、带 stat 指纹缓存）；不存在返回 `''`。 */
  function readPresetTextSync(id: string): string {
    const file = join(stateDir, PRESETS_DIR, id, 'AGENTS.md')
    let key: string
    try {
      const st = statSync(file)
      if (!st.isFile()) return ''
      key = `${st.mtimeMs}:${st.size}`
    } catch {
      promptFileCache.delete(id)
      return ''
    }
    const cached = promptFileCache.get(id)
    if (cached && cached.key === key) return cached.text
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { return '' }
    promptFileCache.set(id, { key, text })
    return text
  }

  /** 预设文件是否存在（同步；绑定前校验用，避免悬空绑定）。 */
  function presetExistsSync(id: string): boolean {
    try {
      return statSync(join(stateDir, PRESETS_DIR, id, 'AGENTS.md')).isFile()
    } catch {
      return false
    }
  }

  /**
   * 读当前 `~/.dsh/AGENTS.md`（同步、带 stat 指纹缓存）。
   * 用途只有一个：**去重**——绑定的预设与文件内容逐字节相同时不再注入第二遍正文。
   */
  let globalAgentsCache: { key: string; text: string } | null = null
  function readGlobalAgentsMdSync(): string {
    const file = join(resolveDshHome(), 'AGENTS.md')
    let key: string
    try {
      const st = statSync(file)
      if (!st.isFile()) return ''
      key = `${st.mtimeMs}:${st.size}`
    } catch {
      globalAgentsCache = null
      return ''
    }
    if (globalAgentsCache && globalAgentsCache.key === key) return globalAgentsCache.text
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { return '' }
    globalAgentsCache = { key, text }
    return text
  }

  /**
   * 当前生效的场景提示词：启用场景的绑定优先，其次 `global` 的绑定；都没有 → `null`。
   * 「绑了但预设为空/已删」按没绑处理（不注入空段），继续找下一个。
   */
  function resolveScenePreset(): { scene: string; presetId: string; text: string } | null {
    const index = readIndexSync(stateDir)
    const names = Object.keys(index.scenes || {})
    const { active } = resolveActiveScenes(index, names)
    // 单选：取唯一一个非保留启用场景（resolveActiveScenes 已保证 ≤1，这里仍做确定性排序兜底）。
    const enabled = names
      .filter((n) => n !== SHARED_GROUP && n !== GLOBAL_SCENE && active.has(n))
      .sort((a, b) => sceneOrderOf(index, a) - sceneOrderOf(index, b) || a.localeCompare(b))
    for (const scene of enabled) {
      const id = index.scenes?.[scene]?.prompt
      if (!id) continue
      const text = readPresetTextSync(id)
      // 绑了但预设为空/已删 → 继续找下一个（不注入空段）。
      if (text.trim() === '') continue
      return { scene, presetId: id, text }
    }
    const globalId = index.scenes?.[GLOBAL_SCENE]?.prompt
    if (globalId) {
      const text = readPresetTextSync(globalId)
      if (text.trim() !== '') return { scene: GLOBAL_SCENE, presetId: globalId, text }
    }
    return null
  }

  /**
   * 当前生效的场景提示词（只读投影，界面用）：绑定内容与 `~/.dsh/AGENTS.md` 相同时标记
   * `duplicate` 且返回空段 —— 那份正文已经在基线里了，界面据此显示「生效中」。
   * （注入侧不看这个字段：预设挂不到 AGENTS.md 通道时照样要注入，见 `promptText`。）
   */
  function scenePrompt(): ScenePromptProjection {
    const found = resolveScenePreset()
    if (!found) return { scene: null, presetId: null, text: '', missing: false }
    const globalText = readGlobalAgentsMdSync().trim()
    if (globalText !== '' && found.text.trim() === globalText) {
      return { scene: found.scene, presetId: found.presetId, text: '', missing: false, duplicate: true }
    }
    return { scene: found.scene, presetId: found.presetId, text: found.text, missing: false }
  }

  // ── 写操作串行队列（避免并发覆盖同一索引/文件）──
  let mutationQueue: Promise<unknown> = Promise.resolve()
  const enqueueMutation = <T>(task: () => Promise<T>): Promise<T> => {
    const queued = mutationQueue.then(task, task)
    mutationQueue = queued.catch(() => undefined)
    return queued
  }

  // ── 定位 / 解析 id ──────────────────────────────────────────────────────

  /** id = "<group>/<name>"；group 可含 '/'（多层），根下规则允许 group 为空。 */
  function parseId(id: string): { group: string; name: string } | null {
    if (typeof id !== 'string' || id === '' || id.startsWith('/') || id.endsWith('/')) return null
    const idx = id.lastIndexOf('/')
    const group = idx >= 0 ? id.slice(0, idx) : ''
    const name = idx >= 0 ? id.slice(idx + 1) : id
    if (!name || !isValidGroupSegment(name)) return null
    if (group && !isValidGroupPath(group)) return null
    return { group, name }
  }

  /**
   * 磁盘定位（bundle 优先）。返回规则文件与条目路径。
   * 根层（`group === ''`）**没有 bundle**：一级目录恒为场景（见 discover 的注释），
   * 否则 `memories/1/1.md`（场景 1 的 flat 记忆 1）会被这里读成根层 bundle「1」，
   * 与列表/注入两端不一致（编辑、删除都会落到错误的文件上）。
   */
  async function locateRule(group: string, name: string): Promise<DiscoveredEntry | null> {
    if (group !== '') {
      const bundleDir = join(memoriesRoot, group, name)
      for (const candidate of [bundleDocName(name), LEGACY_BUNDLE_DOC]) {
        const bundleDoc = join(bundleDir, candidate)
        try {
          const st = await lstat(bundleDoc)
          if (st.isFile() && !st.isSymbolicLink()) {
            return { id: group ? `${group}/${name}` : name, group, name, kind: 'bundle', docPath: bundleDoc, entryPath: bundleDir }
          }
        } catch { /* 该候选名不存在 → 试下一个 */ }
      }
    }
    const flatPath = join(memoriesRoot, group, name + '.md')
    try {
      const st = await lstat(flatPath)
      if (st.isFile() && !st.isSymbolicLink()) {
        return { id: group ? `${group}/${name}` : name, group, name, kind: 'flat', docPath: flatPath, entryPath: flatPath }
      }
    } catch { /* 非 flat */ }
    return null
  }

  /**
   * 写入 / 删除前的根内断言（realpath 口径）。
   *
   * 为什么 `parseId` 还不够：它挡住了 `..` 与分隔符，但**中间目录可以是符号链接** ——
   * `<root>/办公` 若是指向别处的链接，`join(root, '办公', 'x.md')` 看着在根内，
   * 实际会落到链接目标里（`lstat` 只看末级，发现不了）。发现侧已经不跟随链接，
   * 这里是第二道：直接调 op 的调用方（模型工具、HTTP）绕过发现也拦得住。
   * @returns 在根内返回 `null`，否则返回可直接交给调用方的失败对象。
   */
  async function refuseOutsideRoot(target: string): Promise<{ ok: false; error: string; code: string } | null> {
    if (await isInsideRootResolved(memoriesRoot, target)) return null
    return fail('error.rules.outsideRoot', `拒绝操作：解析后的落点不在记忆根目录内（可能存在指向根外的目录链接）：${target}`)
  }

  /** 写操作后构建单条投影（不依赖快照，避免全量重扫）。 */
  async function buildProjected(id: string): Promise<Rule | null> {
    const parts = parseId(id)
    if (!parts) return null
    const entry = await locateRule(parts.group, parts.name)
    if (!entry) return null
    try {
      const text = await readFile(entry.docPath, 'utf8')
      const doc = parseSkillDoc(text) as ParsedSkillDoc
      const derived = deriveFromDoc(entry, doc)
      const index = await readIndex(stateDir)
      return projectRule(entry, derived, index.rules[id])
    } catch {
      return null
    }
  }

  // ── 规则文件序列化 ──────────────────────────────────────────────────────

  /**
   * 值含换行用 `|` 块（保留换行）；否则 `key: value` 原样（parseSkillDoc 按行贪婪解析）。
   * 例外：多行值里有去空白后恰为 `---` 的行时改用 JSON 引号标量 —— 块标量把内容行缩进
   * 两格也躲不开 parseSkillDoc 的 frontmatter 结束扫描（`trim() === '---'`），描述会被
   * 截断、残片混进正文；引号形式是单物理行，扫描无从误判，decodeYamlScalar 无损还原
   * （skills 写侧的引号标量正是靠这一点免疫同一断裂）。
   */
  function yamlField(key: string, value: string | boolean): string[] {
    if (typeof value === 'boolean') return [`${key}: ${value}`]
    const s = String(value)
    if (s.includes('\n')) {
      if (s.split('\n').some((line) => line.trim() === '---')) return [`${key}: ${JSON.stringify(s)}`]
      return [`${key}: |`, ...s.split('\n').map((line) => `  ${line}`)]
    }
    return [`${key}: ${s}`]
  }

  function serializeRuleFile(fields: Record<string, string | boolean>, body: string): string {
    const lines: string[] = ['---']
    for (const [key, value] of Object.entries(fields)) lines.push(...yamlField(key, value))
    lines.push('---', '')
    return lines.join('\n') + String(body ?? '')
  }

  /** update 时重建文件：保留 frontmatter 其余字段，仅更新 name/description。 */
  function serializeUpdatedFile(doc: ParsedSkillDoc, newName: string, description: string | undefined | null, body: string): string {
    const fields: Record<string, string | boolean> = {}
    for (const [key, value] of Object.entries(doc.map)) {
      if (key === 'name' || key === 'description') continue
      fields[key] = String(value)
    }
    fields.name = newName
    if (description === undefined) {
      if (doc.map.description != null && String(doc.map.description).trim() !== '') fields.description = String(doc.map.description)
    } else if (description !== null) {
      fields.description = description
    }
    return serializeRuleFile(fields, body)
  }

  /**
   * 写操作成功后：失效快照 + 丢弃场景记忆段缓存 + 通知 provider。
   * 指纹本身已能发现变化，这里显式丢弃是为了让写操作返回后**必然**是新鲜结果。
   * 不再写 ~/.dsh/AGENTS.md（原始终层投影已下线，见变更单 §4/§10）：
   * 公共基线改由 `_shared/` 场景承担，统一走 systemPrompt 段。
   */
  const refresh = async (): Promise<void> => {
    invalidateSnapshot()
    sceneCache = null
  }

  /** 场景档案引擎专用：读-改-写 mode/archives/active 切片（写队列内，保持与其余索引写串行）。 */
  const patchIndex = (patch: { mode?: ModeState; archives?: Record<string, SceneArchive>; active?: string[] | null }): Promise<void> =>
    enqueueMutation(async () => {
      const index = await readIndex(stateDir)
      if (patch.mode !== undefined) index.mode = patch.mode
      if (patch.archives !== undefined) index.archives = patch.archives
      // active 复用「记忆启用集」语义（null = 全部启用）；进入模式时引擎收窄为 [S]。
      if (patch.active !== undefined) index.active = patch.active
      await writeIndex(stateDir, index)
      await refresh()
    })

  /** 场景档案引擎专用：读 mode/archives/active 切片（容忍缺失，缺省 = 无档案 + 自由模式 + 全部启用）。 */
  const readArchiveSlice = async (): Promise<{ mode: ModeState; archives: Record<string, SceneArchive>; active: string[] | null }> => {
    const index = await readIndex(stateDir)
    return { mode: index.mode ?? { scene: null, snapshot: null }, archives: index.archives ?? {}, active: normalizeActive(index.active) }
  }

  // ── 场景行（UI 用：启用/停用开关）──────────────────────────────────────

  /** 场景行：**以索引的场景记录为准**（空场景也在列表里），记忆条数由快照统计。 */
  function sceneRows(snap: Snapshot, index: RulesIndex): SceneRow[] {
    const names = new Set<string>([GLOBAL_SCENE, ...Object.keys(index.scenes || {}), ...snap.scenes])
    const counts = new Map<string, number>()
    for (const rule of snap.rules) {
      if (rule.shadowed) continue
      const scene = sceneOf(rule.group)
      if (scene === '') continue // 无场景归属的记忆（旧根层遗留）不归属任何场景
      counts.set(scene, (counts.get(scene) || 0) + 1)
    }
    const known = [...names]
    const { active } = resolveActiveScenes(index, known)
    const enabledScene = enabledSceneOf(index)
    return known
      .map((name) => ({
        name,
        label: sceneLabel(name, index),
        order: sceneOrderOf(index, name),
        count: counts.get(name) || 0,
        active: active.has(name),
        shared: name === SHARED_GROUP,
        global: name === GLOBAL_SCENE,
        description: index.scenes?.[name]?.description || '',
        prompt: index.scenes?.[name]?.prompt || '',
        // 单选模型下"能不能点开"：已被别的场景占用时，这个开关要置灰。
        selectable: name !== SHARED_GROUP && name !== GLOBAL_SCENE && (enabledScene === null || enabledScene === name),
        locked: index.scenes?.[name]?.locked === true,
      }))
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  }

  // ── ops：读 ─────────────────────────────────────────────────────────────

  /**
   * 把条目原件复制进 memories 回收站并写 manifest，返回 trashId。只复制、不删除：
   * 原件的 rm 由调用方在复制成功后执行 —— 先有副本才允许删，rm 永远不会销毁唯一数据。
   * manifest 先于原件删除落盘：中途崩溃最坏留下「原件还在 + 一份完整回收站副本」，
   * 不会出现「有文件没清单」的损坏条目。
   */
  async function copyIntoMemoriesTrash(located: DiscoveredEntry, group: string, name: string): Promise<string> {
    const trashId = newTrashId()
    const trashDir = join(stateDir, MEMORIES_TRASH_DIR, trashId)
    const manifest = { group, name, form: located.kind, deletedAt: new Date().toISOString() }
    await mkdir(trashDir, { recursive: true })
    if (located.kind === 'bundle') {
      const { cp } = await import('node:fs/promises')
      await cp(located.entryPath, join(trashDir, 'bundle'), { recursive: true })
    } else {
      await copyFile(located.docPath, join(trashDir, 'rule.md'))
    }
    await writeFileAtomically(join(trashDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    return trashId
  }

  /** bundle 目录下的附件（顶层普通文件，排除正文 `<名>.md`，兼容旧数据 `SKILL.md`）；不存在/不可读返回空数组。 */
  async function listAttachments(bundleDir: string, name: string): Promise<Array<{ name: string; size: number }>> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(bundleDir, { withFileTypes: true })
    } catch {
      return []
    }
    const docNames = new Set([bundleDocName(name), LEGACY_BUNDLE_DOC])
    const out: Array<{ name: string; size: number }> = []
    for (const entry of entries) {
      if (docNames.has(entry.name)) continue
      if (!entry.isFile()) continue // 子目录 / 符号链接不列出（detach 也只动普通文件）
      try {
        out.push({ name: entry.name, size: (await stat(join(bundleDir, entry.name))).size })
      } catch { /* 读不到的条目跳过 */ }
    }
    out.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }

  // 注入文本出口（2026-09-16 第四版）。
  //
  // 历史：本服务先后把场景记忆做成"系统提示词段"（会被 persona complete 压掉）与
  // "写 AGENTS.md 文件"（预设不挂 dsh-agent-instructions 时到不了模型）。现在两条都交给
  // 注入通道（src/context-inject.ts）：每个 step 前把文本并进一条注入消息，任何预设都到得了。
  // 这里只留**同步取文本**的两个出口，注册/生命周期由 index.ts 的注入器统一管。
  //
  //   - `memoryText`：场景记忆段（记忆正文；`''` = 没有可注入的内容）。
  //   - `promptText`：全局提示词正文 = 场景期间用场景提示词、平时用 AGENTS.md 正文。
  //     **不判"与文件重复"** —— 预设挂了官方 agent-instructions 时那份正文已经由文件送达
  //     （注入侧会跳过整个域），没挂时（极简）才需要注入兜底；判定在注入器的 `selectInjections` 里。
  const memoryText = (): string => sceneMemory().text
  // 场景段。与记忆段是**两次探测**：`probeSceneFilesSync` 没有内部缓存（signature 本身就是
  // 扫描的结果，缓存不了），代价是有界的一次目录树 stat（**不读正文**），换来两段各自渲染、
  // 各自去重 —— 只改场景描述时不会连带重发整段记忆正文。
  const sceneCatalog = (): SceneMemoryProjection => {
    const index = readIndexSync(stateDir)
    const probe = probeSceneFilesSync(memoriesRoot, index, isIndexQuarantined(stateDir))
    if (sceneCatalogCache && sceneCatalogCache.signature === probe.signature) return sceneCatalogCache.value
    const value = renderSceneCatalog(probe, index, SCENE_CATALOG_MAX_BYTES)
    sceneCatalogCache = { signature: probe.signature, value }
    return value
  }
  const sceneCatalogText = (): string => sceneCatalog().text
  /**
   * `~/.dsh/AGENTS.md` 正文的上限，与官方那一行的 `maxBytes` 同量级（64 KiB）：超大文件按字节
   * 截断并留一行标记，免得一份手写的巨型基线把上下文撑爆。
   */
  const AGENTS_MD_MAX_BYTES = 65536
  /**
   * DSH home 的**展示形态**，规则与官方 `dsh-home-paths` 的 `dshHomeDisplay()` 一致
   * （`dsh-home-paths/lib/index.js:93`）：默认位置显示 `~/.dsh`，被 `DSH_HOME` 指到别处时
   * 才显示 `$DSH_HOME`。只在给**界面**看的字符串里用 —— 读盘一律用真实路径。
   */
  const dshHomeDisplay = (): string => {
    const home = resolveDshHome()
    return resolve(home) === resolve(join(homedir(), '.dsh')) ? '~/.dsh' : '$DSH_HOME'
  }
  /**
   * 当前生效的提示词：**来源文件 + 正文**，一次解析、两处出口共用（模型侧 `promptText`、
   * 界面清单 `promptFiles`）。`null` = 现在没有提示词。
   *
   * 为什么合并成一处：两条出口必须给出**同一个**结论（文件是哪个、正文取哪份），分开写两份
   * 同样的分支判断迟早分叉 —— 分叉的后果就是界面标错文件、或模型看到与文件不符的正文。
   * 合并前那里已经有一处小分叉：场景预设在场但正文为空时，文本退回 AGENTS.md、清单却仍报
   * 预设路径。现在两边同源，这类角落不可能再各说各话。
   *
   * `digest` 照抄官方 `instructionContentSha1`（`dsh-agent-instructions/lib/index.js:90`，
   * sha1 hex）：算的是**文件内容**（AGENTS.md 取截断前的原文），是"文件这一版"的身份，
   * 不是"这次注入了什么"；界面只拿它当悬停提示，不参与任何判定。
   *
   * `text` 是**模型侧**正文，开头一行 `来源：<展示路径>` —— 照抄官方 agent-instructions 的
   * 写法（`Instructions from: <path>`，`render.js` 的 `sectionText`）。模型据此知道这些规则
   * 写在哪个文件里：用户说"把这条记下来"时它知道该改哪份文件，而不是只能凭印象回答。
   */
  const resolvePrompt = (): { path: string; digest: string; text: string } | null => {
    // 场景提示词与 AGENTS.md 正文在用户眼里就是同一件事（"全局提示词"）：场景期间前者取代后者，
    // 与官方语义一致（进场景改写文件、退出恢复）。所以一个域、一份文本，取到非空的场景提示词就用它。
    const scene = resolveScenePreset()
    if (scene && scene.text.trim() !== '') {
      const path = `${dshHomeDisplay()}/${HUB_DIR}/${PRESETS_DIR}/${scene.presetId}/AGENTS.md`
      return {
        path,
        digest: createHash('sha1').update(scene.text).digest('hex'),
        text: `来源：${path}\n\n${scene.text}`,
      }
    }
    const raw = readGlobalAgentsMdSync()
    if (raw.trim() === '') return null
    const path = `${dshHomeDisplay()}/AGENTS.md`
    const body = Buffer.byteLength(raw, 'utf8') <= AGENTS_MD_MAX_BYTES
      ? raw
      : Buffer.from(raw, 'utf8').subarray(0, AGENTS_MD_MAX_BYTES).toString('utf8') +
        `\n\n（…文件超过 ${Math.floor(AGENTS_MD_MAX_BYTES / 1024)} KiB，已截断。）`
    return { path, digest: createHash('sha1').update(raw).digest('hex'), text: `来源：${path}\n\n${body}` }
  }
  /**
   * 模型侧的提示词正文（`''` = 没有可注入的内容）。
   *
   * **不判"与文件重复"** —— 预设挂了官方 agent-instructions 时那份正文已经由文件送达
   * （注入侧会跳过整个域），没挂时（极简）才需要注入兜底；判定在注入器的 `selectInjections` 里。
   */
  const promptText = (): string => resolvePrompt()?.text ?? ''
  /**
   * `promptText()` 的**来源文件**（同步）：注入通道把它当作 instructions 形态的
   * `changes` 交给界面（文件清单 + 已载入/已更新），见 context-inject.ts 的 `files`。
   * 与文本同源（都走 `resolvePrompt`），所以两边不会分叉；`[]` = 无正文。
   *
   * 路径用**展示形态**（见 `dshHomeDisplay`）：界面里官方 agent-instructions 那条行写的是
   * `~/.dsh/AGENTS.md`，我们写绝对路径的话，同一个界面上会出现两种风格。
   */
  const promptFiles = (): Array<{ path: string; digest: string }> => {
    const resolved = resolvePrompt()
    return resolved === null ? [] : [{ path: resolved.path, digest: resolved.digest }]
  }

  /** 写操作：串行队列内执行，成功后触发 refresh（失效缓存，下一请求即生效）。 */
  const runWrite = (task: () => Promise<any>) =>
    enqueueMutation(async () => {
      const result = await task()
      if (result && result.ok !== false) await refresh()
      return result
    })

  // 写操作清单：与下方 ops 表同文件同源维护（含此前漂移漏掉的
  // rules-attach / rules-detach / rules-trash-remove）；HTTP 端门禁由
  // index.ts 从本集合派生，勿在宿主端另抄一份。
  // 域 op 的显式上下文：成员就是本闭包内的读模型 / 写管道 / 入口，契约见 ops/ctx.ts。
  // 抽出去的 ops/*.ts 只通过它访问闭包，任何漏挂都会在 tsc 阶段报「Cannot find name」。
  const rc: MemoriesOpsCtx = {
    stateDir, memoriesRoot, scenesRoot, maxBytes,
    snapshot, invalidateSnapshot, sceneMemory, scenePrompt,
    parseId, locateRule, refuseOutsideRoot, buildProjected, sceneRows,
    copyIntoMemoriesTrash, listAttachments, serializeRuleFile, serializeUpdatedFile,
    ensureLayout, presetExistsSync,
  }
  const memoryOps = buildMemoryOps(rc)
  const trashOps = buildTrashOps(rc)
  const sceneOps = buildSceneRecordOps(rc)

  const writeOps: ReadonlySet<string> = new Set([
    'rules-create', 'rules-update', 'rules-remove', 'rules-restore', 'rules-toggle', 'rules-import',
    'rules-set-index', 'rules-set-active', 'rules-create-scene', 'rules-update-scene', 'rules-remove-scene', 'rules-rebind-prompt',
    'rules-scene-lock',
    'rules-attach', 'rules-detach', 'rules-trash-remove',
    // 场景回收站（与记忆回收站 rules-trash-* 分开：那套管记忆正文，这套管场景记录与档案）
    'scene-trash-restore', 'scene-trash-delete',
  ])

  const ops: Record<string, (args: any) => Promise<any>> = {
    // 这三个「只读」op 也要进写队列：它们经 snapshot() → buildSnapshot 做悬空记录清理，
    // 而那次清理是**整份 index 覆盖写**。不入队时，一次并发的 rules-list 会把
    // rules-toggle 刚写入的开关用旧快照盖回去（用户点了开关、状态却弹回）。
    // 注意**不能**用 runWrite —— 那个还会 refresh()，会让只读 op 每次都作废快照缓存。
    'rules-list': (args) => enqueueMutation(() => memoryOps.rulesList(args || {})),
    'rules-read': (args) => enqueueMutation(() => memoryOps.rulesRead(args || {})),
    'rules-budget': () => memoryOps.rulesBudget(),
    'rules-diagnose': () => enqueueMutation(() => memoryOps.rulesDiagnose()),
    'rules-create': (args) => runWrite(() => memoryOps.rulesCreate(args || {})),
    'rules-import': (args) => runWrite(() => memoryOps.rulesImport(args || {})),
    'rules-update': (args) => runWrite(() => memoryOps.rulesUpdate(args || {})),
    'rules-remove': (args) => runWrite(() => trashOps.rulesRemove(args || {})),
    'rules-restore': (args) => runWrite(() => trashOps.rulesRestore(args || {})),
    'rules-trash-list': () => trashOps.rulesTrashList(),
    'rules-trash-remove': (args) => runWrite(() => trashOps.rulesTrashRemove(args || {})),
    'rules-attach': (args) => runWrite(() => memoryOps.rulesAttach(args || {})),
    'rules-detach': (args) => runWrite(() => memoryOps.rulesDetach(args || {})),
    'rules-toggle': (args) => runWrite(() => memoryOps.rulesToggle(args || {})),
    'rules-set-index': (args) => runWrite(() => memoryOps.rulesSetIndex(args || {})),
    'rules-set-active': (args) => runWrite(() => sceneOps.rulesSetActive(args || {})),
    'rules-create-scene': (args) => runWrite(() => sceneOps.rulesCreateScene(args || {})),
    'rules-update-scene': (args) => runWrite(() => sceneOps.rulesUpdateScene(args || {})),
    'rules-scene-lock': (args) => runWrite(() => sceneOps.rulesSceneLock(args || {})),
    'rules-remove-scene': (args) => runWrite(() => sceneOps.rulesRemoveScene(args || {})),
    'scene-trash-list': () => sceneOps.sceneTrashList(),
    'scene-trash-restore': (args) => runWrite(() => sceneOps.sceneTrashRestore(args || {})),
    'scene-trash-delete': (args) => runWrite(() => sceneOps.sceneTrashDelete(args || {})),
    'rules-rebind-prompt': (args) => runWrite(() => sceneOps.rulesRebindPrompt(args || {})),
  }

  const service: MemoriesService = {
    ops,
    writeOps,
    memoryText,
    sceneCatalogText,
    promptText,
    promptFiles,
    refresh,
    patchIndex,
    readArchiveSlice,
  }
  return service
}
