// 域 op（抽出）：24 个 op 按记忆正文 / 回收站 / 场景分域，依赖经显式 ctx 传入。
import { buildMemoryOps } from '../ops/memory.js'
import { buildTrashOps } from '../ops/trash.js'
import { buildSceneRecordOps } from '../ops/scene-records.js'
import type { MemoriesOpsCtx } from '../ops/ctx.js'
import { discoverProjectInstructions, renderProjectInstructions } from '../prompts/project-instructions.js'
import { chooseUserPromptLayer } from './prompt-layer.js'
import type {
  MemoriesDeps,
  MemoriesService,
  MemoryScopeOverride,
  PromptScopeOverride,
  Rule,
  RulesIndex,
  SceneMemoryProjection,
  ScenePromptProjection,
  SceneRecord,
  SceneRow,
} from './memories-types.js'

// 类型面与导出计划拆出去后，memories/service.js 的公开面照旧（snapshot.ts、projection.ts、
// index-io.ts、ops/* 与 index.ts 都按这个路径引）。
export { planMemoryExport } from './export-plan.js'
export type {
  GroupRow,
  MemoriesDeps,
  MemoriesService,
  MemoryScopeOverride,
  PromptScopeOverride,
  Rule,
  RulesIndex,
  SceneMemoryFile,
  SceneMemoryProjection,
  ScenePromptProjection,
  SceneRecord,
  SceneRow,
} from './memories-types.js'
// dsh-plugin-tool-management —— 规则/记忆（Rules v0.3，见 CHANGE-REQUEST-01）服务层。
//
// 记忆 = $DSH_HOME/tool-management/memories/<场景>/<name>.md（flat）或 <场景>/<name>/<name>.md（bundle）。
// 历史遗留的 bundle 正文文件名 `SKILL.md` 仍被识别（只读兼容），但新建/更新一律写 `<name>.md`。
// **场景是显式记录**，但记录的真源是 `memories-index.json` 的 `scenes` 切片（见 `SceneRecord`
// 与 `sceneRecordOf`），**不是** `scenes/<场景>.json` —— 那个目录是 v0.3 遗留的空壳：代码
// 只 `mkdir` 它、并把路径回显给前端，从不读写里面的文件（`SCENES_DIR` 全仓仅 3 处命中）。
// 场景因此不依赖"memories/ 下恰好有这个名字的目录"这种隐式约定：空场景可以存在，
// 且场景可以有描述。目录名即场景名（任意 Unicode，见 isValidGroupSegment）。
// （按 `scenes/*.json` 去找场景记录、或按它写备份/迁移脚本，都会扑空 —— 订正。）
// 保留场景 `global`（界面显示「全局」）：其记忆注入任何对话；它恒定存在、不可删除。
// 勾选启用后，该目录树内所有 .md 的正文自动进入模型的上下文（index.ts 注册的注入通道，
// 每步一条消息；见 src/context-inject.ts），模型无需做任何动作 —— 这就是"不用每次都要解释"。
//
// 单投影：
//   - 活动场景记忆 → 上下文注入（自动在场，会话级恒定 → 前缀稳定、缓存可命中；
//     文本没变时不重发 —— 从 systemPrompt 段改道，理由见 context-inject.ts 文件头）
//   - `_shared/` 承担"恒常"语义（所有场景共用）；原 per-rule `always` 标志已移除
//   - 不再写 ~/.dsh/AGENTS.md（原始终层投影下线）
//
// 状态分层（两份文件各司其职，互不写回）：
//   - 规则文件：正文真源。frontmatter 可声明 name/whenToUse/globs/metadata（旧数据里的
//     `description` 不再读：它只是正文的有损副本，而正文本身就会注入）。
//   - memories-index.json：启停/排序/标签/启用场景集合等**索引为准**字段（不写回记忆文件）。
//
// 发现必须自实现（不复用 readonly-discovery）：可写来源只扫一层会压扁子目录场景，
// 而规则的目录树天然是多层的；且 readonly-discovery 的 flat 只认顶层。
//
// 缓存红线：段内容只由「启用场景 + 文件内容」决定，禁止时间戳/计数/相对时间
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
import { parseSkillDoc, renameWithRetry, resolveDshHome, rewriteFrontmatterFields, unquote, yamlFieldLines } from '../skills/core.js'
import { expandUploads, planMemoryImport } from '../imports/upload.js'
import { normalizePresetId } from '../prompts/preset-id.js'
import { normalizeArchive, type ModeState, type SceneArchive } from './archive.js'
import { isValidTrashId, listTrashEntries, moveOutOfTrash, moveToTrash, newTrashId, purgeTrashEntry, readTrashEntry } from '../hub.js'
// 预算 / 保留场景名 / 段渲染常量（抽到 ./constants.ts：投影函数与本服务共用，
// 留在这里会让 projection.ts 反向 import 本文件，形成运行时循环依赖）。
import {
  ATTACHMENT_LIST_MAX, bundleDocName, byteLen, DEFAULT_GROUP_ORDER, DEFAULT_MAX_BYTES, DEFAULT_ORDER,
  DROPPED_HEADING, GLOBAL_SCENE, GLOBAL_SCENE_LABEL, INDEX_VERSION, INLINE_BODY_MAX, LEGACY_BUNDLE_DOC,
  MAX_ATTACH_ENTRIES, MAX_ATTACH_ENTRY_BYTES, MAX_ATTACH_TOTAL_BYTES, MAX_DESCRIPTION_LENGTH,
  MAX_DIRECTORIES, MAX_ENTRIES, MAX_GROUP_SEGMENT_LENGTH, MAX_SOURCE_DEPTH,
  SCENE_CATALOG_MAX_BYTES, SCENE_MEMORY_NOTE, SCENE_MEMORY_NOTE_PARTIAL, SEGMENT_RULE_HINT, SHARED_GROUP, SNAPSHOT_TTL_MS,
  TRUNCATION_MARKER, isValidGroupPath, isValidGroupSegment, message, MEMORIES_TRASH_DIR, fail,
} from './constants.js'
// 对外契约保持在原路径：本文件此前直接 export 这两个，index.ts 等已按此 import。
export { GLOBAL_SCENE, GLOBAL_SCENE_LABEL } from './constants.js'
export { isValidGroupSegment, isValidGroupPath, MEMORIES_INDEX_FILE, MEMORIES_TRASH_DIR } from './constants.js'
// parseModeState 搬到了 index-io.ts，但 test/contracts.test.mjs 按原路径引它 —— 契约不能断。
export { parseModeState } from './index-io.js'
// 投影 / 渲染纯函数（抽到 ./projection.ts）：索引 → 界面与注入看到的那份文本。
import {
  attachmentLine, attachmentNamesSync, attachmentSummarySync, collapseActiveForNewScene,
  compareSceneBuckets, enabledSceneOf, ensureSceneRecords,
  bodyBlock, memoryBlock, normalizeActive, resolveActiveScenes, sceneHeading, sceneLabel,
  sceneOf, sceneOrderOf, signatureOfIndex,
} from './projection.js'
// 索引 IO 组与发现/快照组（抽出）。
import { writeFileAtomically, writeFileAtomicBinary, isIndexQuarantined, readIndex, readIndexSync, writeIndex, repairFromQuarantine, sceneRecordOf, normalizeScenePromptId, pathExists, isAbsentError } from './index-io.js'
import type { SceneIndexEntry, RuleIndexEntry, GroupIndexEntry } from './index-io.js'
import { deriveFromDoc, projectRule, relocateLegacyLayout, buildSnapshot, probeSceneFilesSync, renderSceneCatalog, renderSceneMemory, renderWorkspaceMemory } from './snapshot.js'
import { buildCatalog, catalogPathOf } from './catalog.js'
import { autoNotesRootOf, migrateLegacyAutoNotes } from '../evolution/notes.js'
import { watchDirectories } from '../skills/dir-watch.js'
import type { ParsedSkillDoc, DiscoveredEntry, Snapshot } from './snapshot.js'

// ── 目录常量与失败约定 ─────────────────────────────────────────────────────
// 其余跨文件共用的常量与无依赖小工具（message / isValidGroupSegment / isValidGroupPath /
// MEMORIES_INDEX_FILE）已下沉到 ./constants.ts，避免 index-io / snapshot 反向引本文件。


/**
 * 场景/记忆根目录名（$DSH_HOME 下），集中在 `tool-management/` 一个目录内：
 *   - `memories/<场景>/…`    记忆正文真源
 *   - `..`（即 tool-management 根）侧车：memories-index.json（内含 `scenes` 切片 = 场景记录
 *     的**真源**）/ skills-state.json / trash/（六类回收站，含 `trash/memories-trash/`）
 *
 * `scenes/`（`SCENES_DIR`）是 v0.3 遗留的**空壳**：只创建、只回显路径，没有任何读写。
 * 别把场景记录的位置写成它。
 *
 * 历史位置 `$DSH_HOME/scene-memory/` 由 `relocateLegacyLayout()` 在首次读写前搬入。
 */
export const HUB_DIR = 'tool-management'

/** 场景记录所在子目录名（相对 hub 根）。 */
export const SCENES_DIR = 'scenes'

/** 记忆正文真源所在子目录名（相对 hub 根）。 */
export const MEMORIES_DIR = 'memories'


/** 提示词预设库目录名（hub 根下；域 = 提示词，工具 `prompt_manager_*`）。 */
export const PRESETS_DIR = 'prompts'


/** 记忆域服务门面：索引、场景档案、注入用的投影读口与迁移都在这里。 */
export function createMemoriesService(ctx: any, deps: MemoriesDeps): MemoriesService {
  // 仅测试注入绝对路径；生产按 $DSH_HOME 解析（与核心技能目录同源）。
  // v0.4：全部落到 $DSH_HOME/tool-management/ 一个目录内（memories/ + scenes/ + 侧车），
  // 旧的 $DSH_HOME/scene-memory 与更旧的 $DSH_HOME/rules 由 relocateLegacyLayout() 搬入。
  const stateDir = deps.stateDir && deps.stateDir.trim() !== '' ? resolve(deps.stateDir) : join(resolveDshHome(), HUB_DIR)
  const memoriesRoot = deps.memoriesRoot && deps.memoriesRoot.trim() !== '' ? resolve(deps.memoriesRoot) : join(stateDir, MEMORIES_DIR)
  // 自主记忆的独立根：正文与它自己的启停索引都住这里，不进用户记忆的场景体系。
  const autoNotesRoot = autoNotesRootOf(stateDir)
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
      await mkdir(autoNotesRoot, { recursive: true })
      await mkdir(scenesRoot, { recursive: true })
    } catch {
      /* 目录建不出来时后面的 op 会各自报错，这里不提前抛 */
    }
  }

  let snapCache: { at: number; value: Snapshot } | null = null
  /**
   * 同一拍里的并发读合流。`rules-list` 被斜杠菜单、场景写入后的刷新、记忆页轮询
   * 同时问到时，各建一份快照等于把同一棵目录树扫好几遍；而写操作之后在飞的那份是写之前的，
   * 不能拿它当新鲜数据。`generation` 只让**写之后发起**的扫描落缓存。
   */
  let snapGeneration = 0
  let snapInflight: { gen: number; promise: Promise<Snapshot> } | null = null
  const snapshot = async (): Promise<Snapshot> => {
    if (snapCache && Date.now() - snapCache.at < SNAPSHOT_TTL_MS) return snapCache.value
    if (snapInflight !== null && snapInflight.gen === snapGeneration) return snapInflight.promise
    const gen = snapGeneration
    const promise = (async () => {
      await ensureLayout()
      return buildSnapshot(memoriesRoot, stateDir)
    })()
    snapInflight = { gen, promise }
    try {
      const value = await promise
      if (gen === snapGeneration) snapCache = { at: Date.now(), value }
      return value
    } finally {
      if (snapInflight !== null && snapInflight.promise === promise) snapInflight = null
    }
  }
  const invalidateSnapshot = (): void => {
    snapGeneration += 1
    snapCache = null
    snapInflight = null
  }

  // ── 场景记忆段（两相扫描 + 指纹缓存）──────────────────────────────────────
  //
  // 段文本 = 活动场景（`_shared` ∪ index.active，缺失时全部）下所有 .md 正文，
  // 按「场景顺序 → 记忆名」确定性拼接；超预算按同一顺序确定性截断并追加固定标记。
  // 禁止时间戳/计数：否则每请求都变，前缀缓存永远不命中。
  //
  // 每次装配：只做「读索引 + stat 遍历」的廉价探测；指纹不变直接返回上次结果，
  // 指纹一变（切场景 / 改文件 / 外部编辑器改文件 / 改 enabled）才重读正文并重排。
  // 见文件顶部「两相扫描」注释里为什么不选 fs.watch 方案。

  // ⚠️ 这两份缓存**必须是 Map**：会话作用域让"同一份磁盘、不同会话"能算出两份
  // 不同的段。单槽缓存下 A 算完 B 直接用 —— 症状是「A 的场景记忆出现在 B 的上下文里」，
  // 而且它不报错、只在两个会话交替使用时出现，是最难查的一类。键 = 会话作用域的指纹，
  // 上限 16 条 LRU（会话数量级远小于这个数，超了只说明有大量一次性会话）。
  const SCENE_CACHE_MAX = 16
  const sceneCache = new Map<string, { signature: string; value: SceneMemoryProjection }>()
  const sceneCatalogCache = new Map<string, { signature: string; value: SceneMemoryProjection }>()
  const wsCache = new Map<string, { signature: string; value: SceneMemoryProjection }>()
  /** 取一条缓存并把它移到队尾（Map 保序 ⇒ 头部就是最久没用的那条）。 */
  const cacheGet = <T>(cache: Map<string, T>, key: string): T | undefined => {
    const hit = cache.get(key)
    if (hit === undefined) return undefined
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  /** 写一条缓存并按上限淘汰最久没用的。 */
  const cacheSet = <T>(cache: Map<string, T>, key: string, value: T): void => {
    cache.delete(key)
    cache.set(key, value)
    while (cache.size > SCENE_CACHE_MAX) {
      const oldest = cache.keys().next()
      if (oldest.done === true) break
      cache.delete(oldest.value)
    }
  }
  /**
   * 会话作用域的缓存键：会话 id + 覆盖指纹。取不到会话 id 时按全局（空串）。
   *
   * 为什么把覆盖也编进键：同一个会话切场景之后段要重算，而它的 signature 已经变了；
   * 但"覆盖被清空回到全局"这种变化下 signature 未必变（比如覆盖只是把某条记忆关掉又打开），
   * 键里带上覆盖就能保证两种状态各自命中各自的缓存。
   */
  const scopeKeyOf = (scope: MemoryScopeOverride | undefined): string =>
    scope === undefined
      ? ''
      : [
        scope.sessionId ?? '',
        scope.scene === undefined ? '\u0002global' : scope.scene === null ? '\u0002none' : scope.scene,
        JSON.stringify(scope.memory ?? {}),
      ].join('\u0000')

  // ── 注入侧取数：读失败必须出声────────────────────────
  //
  // 注入通道把 `text()` 返回的空串读成"这一轮没有内容"；若该域此前发布过，它会据此发一条
  // 「已清空 —— 此前注入的同类内容不再有效」。但空串有两个来源：**真的没内容**与**读失败**。
  // 后者发「已清空」就是对模型说谎（第一性目的是"让模型看见现在是什么"），而且这条谎在界面上
  // 被报成正常的 `empty`（琥珀只留给"该投却没投"），唯一痕迹是模型行为异常。
  //
  // 所以下面 `require*` 那几个出口在 **非 ENOENT** 的 IO 失败上抛异常 —— 注入通道据此报
  // `error`、跳过该域、**不发「已清空」**，上一轮内容原样留着，恢复可读后自动重发。
  // `ENOENT`（文件 / 目录不存在 = 全新用户或刚删掉）仍按正常空处理，不误报。
  //
  // 判据只有一份（`isAbsentError` 与 `readIndexSync` 的不可信标记），差别只在**处置**：
  // 界面投影（`rulesList` 的内存占用条、`scenePrompt`）走下面**不抛**的包装 —— 一次读失败
  // 不该把整个记忆列表页弄崩，那种处置由注入实况的琥珀来承担。
  //
  // 边界（写清楚免得后来者以为漏改）：技能 / MCP / 子智能体三个域**结构上不会**出现这种假
  // 「已清空」—— 它们是 SWR 缓存，计算失败时保留上一次的值，因此只可能"没能更新"，
  // 不可能从"有内容"变成"空串"；`''` 只在真的渲染不出东西时出现。
  const emptySceneMemory = (): SceneMemoryProjection =>
    ({ text: '', body: '', tail: '', bytes: 0, truncated: false, maxBytes, scenes: [], items: [], dropped: [], blocks: [] })

  /** 索引读不到 / 解析不了 → 注入侧必须报「取数失败」，而不是把"全部未启用"当成"用户清空了记忆"。 */
  const assertIndexReadable = (): void => {
    if (isIndexQuarantined(stateDir)) throw new Error('记忆索引当前读不到，无法确定哪些记忆处于启用状态')
  }

  // ── 探测结果缓存（目录监听 + TTL 兜底）────────────────────────────────────
  //
  // 为什么需要：`probeSceneFilesSync` 是一次**完整目录树**的 readdirSync + 每文件 statSync，
  // 而注入通道每个 step 都要同步取一次文本（scene 与 memory 两域各一次，入参相同）。
  // 实测 2000 个记忆文件 ≈ 23 ms/次，每步 46 ms 全在事件循环上。
  //
  // 为什么不能只靠监听：worker 崩溃 / 某个目录挂不上都**不会**回报（`attached()` 只说
  // "有没有挂上过"），把"监听还在"当成前提，静默失效就会变成永久返回旧内容 —— 那正是
  // 本模块一直在避免的形态。所以监听只用来**提前**失效，TTL 才是兜底：
  //   · 监听挂着 → 命中缓存，watcher 一报变化立刻清；最坏 TTL 过期。
  //   · 监听没挂上 → 不进缓存，保持原来的每次探测。
  //
  // 键 = memoriesRoot + 索引指纹 + 会话覆盖指纹（`probeSceneFilesSync` 的入参三要素），
  // 值 = probe 结果。会话覆盖不同 → 不同条目，与两份段缓存同一口径。
  const PROBE_CACHE_TTL_MS = 5000
  const probeCache = new Map<string, { at: number; value: ReturnType<typeof probeSceneFilesSync> }>()
  /**
   * 监听没挂上时多久重试一次。
   *
   * 为什么不能"试一次就认命"：`watchDirectories` 在目录**当时不存在**时直接返回未挂上，
   * 而全新用户的记忆根目录是在第一次写记忆时才建出来的 —— 一次性的装配会让这个进程
   * 从此永远拿不到缓存（每步仍全树 stat）。也不能每步都重试：没挂上时每步新建一个
   * worker。30s 是两者的折中：最坏多付 30s 的无缓存，之后自动回到稳态。
   *
   * 同时兼作"worker 已崩"的复活间隔 —— 崩溃同样只表现为 `attached()` 为 false。
   */
  const WATCH_RETRY_MS = 30000
  let memoriesWatch: { dispose(): void; attached(): boolean } | null = null
  let memoriesWatchAt = 0
  /** 清空探测缓存（watcher 报变化 / 写操作后 / 索引不可信时）。 */
  const clearProbeCache = (): void => { probeCache.clear() }
  /**
   * 取数时确保监听在。**推迟到首次使用**：apply 期 `roots()` / 目录物化会读宿主目录，
   * 而这里只需要一个已存在的目录。
   *
   * `attached()` 是异步回来的：刚建出来的那一两拍必然读到 false。所以"没挂上"的重试
   * 只在距上次装配超过 `WATCH_RETRY_MS` 时发生 —— 否则每步都会拆了重建一个 worker。
   */
  const ensureMemoriesWatch = (): void => {
    const now = Date.now()
    if (memoriesWatch !== null) {
      if (memoriesWatch.attached()) return
      if (now - memoriesWatchAt < WATCH_RETRY_MS) return
      try { memoriesWatch.dispose() } catch { /* 旧的拆不掉也不挡新建 */ }
      memoriesWatch = null
    }
    memoriesWatchAt = now
    try {
      memoriesWatch = watchDirectories([memoriesRoot], clearProbeCache)
    } catch {
      memoriesWatch = null // 建不出 worker = 没有监听，缓存靠 TTL（见上面的取舍）
    }
  }
  /** 探测：监听挂着时走缓存，否则直连（`clearProbeCache` 之后必然直连一次）。 */
  function probeWithCache(
    index: Parameters<typeof probeSceneFilesSync>[1],
    override: { scene?: string | null; memory?: Record<string, boolean> },
  ): ReturnType<typeof probeSceneFilesSync> {
    ensureMemoriesWatch()
    const watched = memoriesWatch !== null && memoriesWatch.attached()
    if (!watched) return probeSceneFilesSync(memoriesRoot, index, false, override)
    const key = memoriesRoot + '\u0000' + signatureOfIndex(index) + '\u0000' + scopeKeyOf(override as MemoryScopeOverride | undefined)
    const hit = probeCache.get(key)
    if (hit !== undefined && Date.now() - hit.at < PROBE_CACHE_TTL_MS) return hit.value
    const value = probeSceneFilesSync(memoriesRoot, index, false, override)
    probeCache.set(key, { at: Date.now(), value })
    // 上限：键里带会话覆盖，会话多时会有很多条；100 条 LRU 足够（同一时刻活跃的会话远少于此）。
    while (probeCache.size > 100) {
      const oldest = probeCache.keys().next()
      if (oldest.done === true) break
      probeCache.delete(oldest.value)
    }
    return value
  }

  /** 记忆段：注入侧口径（索引不可信或目录读不动 → 抛）。 */
  function requireSceneMemory(scope?: MemoryScopeOverride): SceneMemoryProjection {
    const index = readIndexSync(stateDir)
    assertIndexReadable() // 抛在这里 ⇒ 下面必然处于「索引可信」状态，无需再传 forceDisabled
    const override = { scene: scope?.scene, memory: scope?.memory }
    const probe = probeWithCache(index, override)
    const key = scopeKeyOf(scope)
    const hit = cacheGet(sceneCache, key)
    if (hit !== undefined && hit.signature === probe.signature) return hit.value
    const value = renderSceneMemory(probe, index, maxBytes, override.scene)
    cacheSet(sceneCache, key, { signature: probe.signature, value })
    return value
  }

  /**
   * 记忆段（界面 / CRUD 口径）：读失败**不抛**，退回上一轮算出来的那份（没有才退空投影）。
   *
   * 为什么退上一轮而不是空投影：界面上的内存占用条突然归零会让用户以为记忆没了；上一轮那个数
   * 是**已知的最后一份真相**，与注入侧"保留上一轮内容"同一取向。故障本身由注入实况报 `error`。
   */
  function sceneMemory(scope?: MemoryScopeOverride): SceneMemoryProjection {
    try { return requireSceneMemory(scope) } catch {
      // 退回**本会话**上一轮算出来的那份（没有才退空投影）：退到别的会话那份就是串内容。
      return cacheGet(sceneCache, scopeKeyOf(scope))?.value ?? emptySceneMemory()
    }
  }

  /**
   * 工作区记忆段：`_ws/<hash16>` 下的用户手写条目，只在本项目成立。
   *
   * 与场景段分开成一条消息：一条"这个仓库用 pnpm"混进"任何对话都成立"的块里，模型会把它
   * 当成通用规则。段内容只由本工作区那一组决定，与"当前启用哪个场景"无关。
   *
   * @param workspaceGroup 目标组；空串 = 本会话没有工作区身份，整段为空（不注入）。
   * @param scope 会话覆盖（只影响缓存分桶与逐条开关）。
   */
  function workspaceMemory(workspaceGroup: string, scope?: MemoryScopeOverride, budgetBytes?: number): SceneMemoryProjection {
    if (workspaceGroup === '') return emptySceneMemory()
    // 预算可以与场景记忆段不同：两块共用一个总盘时，工作区那段只能拿剩下的部分。
    const limit = Number.isFinite(budgetBytes) && (budgetBytes as number) > 0 ? (budgetBytes as number) : maxBytes
    const index = readIndexSync(stateDir)
    assertIndexReadable()
    const override = { scene: scope?.scene, memory: scope?.memory }
    const probe = probeWithCache(index, override)
    const key = 'ws\u0000' + workspaceGroup + '\u0000' + limit + '\u0000' + scopeKeyOf(scope)
    const hit = cacheGet(wsCache, key)
    if (hit !== undefined && hit.signature === probe.signature) return hit.value
    const value = renderWorkspaceMemory(probe, workspaceGroup, limit)
    cacheSet(wsCache, key, { signature: probe.signature, value })
    return value
  }

  /**
   * 「场景 + 场景记忆」合并段：场景说明行紧跟着它的记忆条目，同一个域发出去。
   *
   * 为什么合并：场景说明回答「现在在哪个场景、这个场景是干什么的」，场景记忆是「这个场景下
   * 记了哪些条目」—— 两者是同一个问题的框架与内容。拆成两个域时模型读到的顺序是
   * 「场景说明 …（隔一段全局记忆）… 场景记忆」，中间夹着任何别的东西都会让 `## Scene Memories: X`
   * 与它的说明分成两处，模型得自己回头对齐。
   *
   * 全局记忆与自主·全局仍留在 `memoryGlobal` 域：它们在**任何**对话里都成立，不属于某个
   * 场景，混进来会让「全局」与「本场景」的边界消失。
   *
   * 预算：场景说明行固定先扣，剩下的给条目 —— 说明是框架，永远该在场。
   */
  function sceneWithMemoryProjection(scope?: MemoryScopeOverride): SceneMemoryProjection {
    const catalog = sceneCatalog(scope)
    const memory = memoryProjection(scope)
    // 只取**非全局桶**的条目：全局记忆留在 `memoryGlobal` 域（它在任何对话里都成立，
    // 不属于某个场景）。留着会让这一域的顺序变成「场景说明 → 全局记忆 → 场景记忆」，
    // 场景说明与它的条目又被隔开 —— 那正是这次要修的东西。
    const sceneBlocks = memory.blocks.filter(function (b) { return b.scene !== GLOBAL_SCENE })
    // 没有启用任何场景（catalog 为空）→ 这一域没有任何东西可发。
    // 不退回整段记忆：全局记忆归 `memoryGlobal`，两边都发会让它出现两遍。
    if (catalog.text === '' || sceneBlocks.length === 0) {
      if (catalog.text === '') return { text: '', body: '', tail: '', bytes: 0, truncated: catalog.truncated, maxBytes: catalog.maxBytes, scenes: [], items: [], dropped: [], blocks: [] }
    }
    // 场景说明行在前，该场景的条目紧跟其后：先读「在哪个场景」，再读这个场景记了什么。
    const catalogText = catalog.text.replace(/\s+$/, '')
    // 逐块重建正文：`blocks[].block` 只有条目本身，分组标题在 `group` 里（`Scene Memories: <名>`）。
    // 同一个场景的标题只在**首条**出现 —— 与 `renderSceneMemory` 的 `header` 语义一致。
    const chunks: string[] = []
    let lastGroup: string | null = null
    for (const b of sceneBlocks) {
      if (b.group !== lastGroup) {
        lastGroup = b.group
        chunks.push('## ' + b.group)
      }
      chunks.push(b.block)
    }
    const body = chunks.join('\n\n').replace(/\n{3,}/g, '\n\n')
    const parts: string[] = [catalogText]
    if (body !== '') parts.push(body)
    const note = catalog.truncated || memory.truncated ? SCENE_MEMORY_NOTE_PARTIAL : SCENE_MEMORY_NOTE
    const text = parts.join('\n\n') + '\n\n' + note
    return {
      text,
      body: parts.join('\n\n'),
      tail: '',
      bytes: byteLen(text),
      truncated: catalog.truncated || memory.truncated,
      maxBytes: catalog.maxBytes,
      scenes: catalog.scenes,
      items: memory.items.filter(function (it) { return it.scene !== GLOBAL_SCENE }),
      dropped: memory.dropped.filter(function (it) { return it.scene !== GLOBAL_SCENE }),
      blocks: sceneBlocks,
    }
  }
  /** 场景段：只有注入侧一个消费者，直接按注入口径（读失败抛）。 */
  function sceneCatalog(scope?: MemoryScopeOverride): SceneMemoryProjection {
    const index = readIndexSync(stateDir)
    assertIndexReadable()
    const override = { scene: scope?.scene, memory: scope?.memory }
    const probe = probeWithCache(index, override)
    const key = scopeKeyOf(scope)
    const hit = cacheGet(sceneCatalogCache, key)
    if (hit !== undefined && hit.signature === probe.signature) return hit.value
    const value = renderSceneCatalog(probe, index, SCENE_CATALOG_MAX_BYTES, override.scene)
    cacheSet(sceneCatalogCache, key, { signature: probe.signature, value })
    return value
  }

  // ── 场景提示词（绑定预设正文；读盘、只读；写文件由 scene-prompt-sync.ts 负责）──
  //
  // 语义：
  //   - 场景可绑定**一个**提示词预设（`scenes[].prompt` → `prompts/<id>/AGENTS.md`）；
  //   - 除保留场景 `global` 外**同时只能启用一个场景**，所以同一时刻至多一份提示词在场；
  //   - 没有启用其它场景时才轮到 `global` 自己的绑定（它恒常生效，覆盖"永远在场的提示词"）；
  //   - 预设文件不存在 / 未绑定 → 返回 `''`（renderPrompt 会删掉空段，不产生空标题）；
  //     **文件在但读不动** → 抛异常（见上面「注入侧取数」那一节，F7）。
  //
  // 为什么不用 fs.watch 也不用每请求读盘：段契约要求**同步返回**且逐字节稳定，
  // 因此按 `mtimeMs + size` 做一次 stat 缓存 —— 命中时零读盘，外部编辑器改了预设
  // 也会在下一个请求自动刷新（与记忆段的"两相扫描"同一哲学）。
  const promptFileCache = new Map<string, { key: string; text: string }>()

  /**
   * 读一个预设正文（同步、带 stat 指纹缓存）；**不存在**返回 `''`，读失败**抛异常**。
   *
   * 抛的理由见上面「注入侧取数：读失败必须出声」那一节：调用方（`resolveScenePreset` →
   * `resolvePrompt` → 提示词域）必须能把"预设读不动"与"预设为空/已删"分开，否则前者会
   * 变成一条假的「已清空」。界面侧由 `scenePrompt()` 自己接住（它本来就把失败当"没绑"）。
   */
  function readPresetTextSync(id: string): string {
    const file = join(stateDir, PRESETS_DIR, id, 'AGENTS.md')
    let key: string
    let isFile = false
    try {
      const st = statSync(file)
      isFile = st.isFile()
      key = `${st.mtimeMs}:${st.size}`
    } catch (e) {
      promptFileCache.delete(id)
      if (!isAbsentError(e)) throw e
      return ''
    }
    // 路径上**有东西但不是普通文件**（目录 / 设备）→ 也是故障，不能当成"预设不存在"：
    // 后者会让提示词域静默退回基线、或在该域此前发布过时发一条假的「已清空」。
    if (!isFile) throw new Error(`预设正文不是一个文件：${file}`)
    const cached = promptFileCache.get(id)
    if (cached && cached.key === key) return cached.text
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (e) {
      if (!isAbsentError(e)) throw e
      return ''
    }
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
   *
   * 读失败**抛异常**（同 `readPresetTextSync`）：注入侧必须能把"基线文件读不动"与"基线为空"
   * 分开 —— 后者是正常的（用户没写过 AGENTS.md），前者会让提示词域发出一句假的「已清空」。
   */
  let globalAgentsCache: { key: string; text: string } | null = null
  function readGlobalAgentsMdSync(): string {
    // 优先用宿主实际读的那一份（`deps.globalAgentsMdPath`，与写侧同源）；拿不到时退回
    // `resolveDshHome()`（`$DSH_HOME` ‖ `~/.dsh`）—— 那是**另一条独立来源**，两边不同时
    // 会取到另一个文件。
    const file = deps.globalAgentsMdPath?.() || join(resolveDshHome(), 'AGENTS.md')
    let key: string
    let isFile = false
    try {
      const st = statSync(file)
      isFile = st.isFile()
      key = `${st.mtimeMs}:${st.size}`
    } catch (e) {
      globalAgentsCache = null
      if (!isAbsentError(e)) throw e
      return ''
    }
    // 有东西但不是普通文件 → 故障（同 `readPresetTextSync`）：当成"基线为空"会让提示词域
    // 在该域此前发布过时发一条假的「已清空」。
    if (!isFile) throw new Error(`AGENTS.md 不是一个文件：${file}`)
    if (globalAgentsCache && globalAgentsCache.key === key) return globalAgentsCache.text
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (e) {
      if (!isAbsentError(e)) throw e
      return ''
    }
    globalAgentsCache = { key, text }
    return text
  }

  /**
   * 当前生效的场景提示词：启用场景的绑定优先，其次 `global` 的绑定；都没有 → `null`。
   * 「绑了但预设为空/已删」按没绑处理（不注入空段），继续找下一个；
   * 「绑了但预设**读不动**」抛异常 —— 注入侧要的是"故障"而不是"没绑"（见上面 F7 那一节）。
   */
  function resolveScenePreset(
    /**
     * 会话层钉住的场景：`string` = 取**这个场景**绑定的预设，而不是全局当前场景的
     * `null` = 钉住"没有场景"（已脱离且基线无场景）→ 场景预设这一层整层不参与。
     *
     * 语义差别必须写清：全局那条走的是"启用场景 → 其绑定 → 退化到 global"这条链（进场景
     * 会改写 AGENTS.md，所以文件里本来就是它）；会话层那条是"本会话要看到哪个场景的提示词"
     * —— 只读预设正文，**不写 AGENTS.md**。
     */
    pinnedScene?: string | null,
  ): { scene: string; presetId: string; text: string } | null {
    // 钉住"没有场景"：不取任何场景绑定（global 的绑定也属于场景层，不参与）。
    if (pinnedScene === null) return null
    const index = readIndexSync(stateDir)
    // 索引读不到 → 连"哪个场景绑了哪个预设"都无从得知，这必须报故障而不是报"没有提示词"。
    assertIndexReadable()
    // 会话层钉住了场景 → 直接取它绑的那份（没有绑定就返回 null，由调用方退化到用户级）。
    if (pinnedScene !== undefined && pinnedScene !== '') {
      const id = index.scenes?.[pinnedScene]?.prompt
      if (!id) return null
      const text = readPresetTextSync(id)
      return text.trim() === '' ? null : { scene: pinnedScene, presetId: id, text }
    }
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
   *
   * **界面口径：读失败不抛**（接住 `resolveScenePreset` / `readGlobalAgentsMdSync` 的异常）。
   * 退回「没有生效的场景提示词」正是这次读失败下界面此前给出的答案（那两个读函数曾把失败吞成
   * 空串），所以这里没有行为变化；**故障由注入侧如实报出**（提示词域报 `error` 并发琥珀）。
   * 反过来，让这里抛会把 `rules-list` 整个读 op 带崩 —— 一次读不到预设不该让记忆页打不开。
   */
  function scenePrompt(): ScenePromptProjection {
    try {
      const found = resolveScenePreset()
      if (!found) return { scene: null, presetId: null, text: '', missing: false }
      const globalText = readGlobalAgentsMdSync().trim()
      if (globalText !== '' && found.text.trim() === globalText) {
        return { scene: found.scene, presetId: found.presetId, text: '', missing: false, duplicate: true }
      }
      return { scene: found.scene, presetId: found.presetId, text: found.text, missing: false }
    } catch {
      return { scene: null, presetId: null, text: '', missing: false }
    }
  }

  // ── 写操作串行队列（避免并发覆盖同一索引/文件）──
  let mutationQueue: Promise<unknown> = Promise.resolve()
  const enqueueMutation = <T>(task: () => Promise<T>): Promise<T> => {
    const queued = mutationQueue.then(task, task)
    mutationQueue = queued.catch(() => undefined)
    return queued
  }

  /**
   * 在跨进程写锁里跑一段读-改-写（锁由宿主注入；缺席时原地执行）。
   *
   * 为什么锁要套在**队列内层**：`mutationQueue` 只串行本进程，web 与 desktop 共用同一个
   * `$DSH_HOME` 时，两边各自 readIndex → 改 → writeIndex 会整份覆盖对方。队列在外、锁在内
   * 保证同一进程内先到先得，锁只覆盖真正的临界区（不把等待时间叠进队列）。
   *
   * 锁在同一异步调用链上可重入：MCP 改名 / 删台会在锁内回调本域的 `patchIndex`，那一条
   * 直接并入外层临界区，不会排在**自己**后面。代价是重入方共享外层的持锁时长 ——
   * 所以临界区里仍然只做索引与记忆文件的读写，不夹带目录扫描之类的大动作。
   */
  const withProcessLock = <T>(task: () => Promise<T>): Promise<T> =>
    deps.withWriteLock === undefined ? task() : deps.withWriteLock(task)

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

  function serializeRuleFile(fields: Record<string, string | boolean>, body: string): string {
    const lines: string[] = ['---']
    for (const [key, value] of Object.entries(fields)) lines.push(...yamlFieldLines(key, value))
    lines.push('---', '')
    return lines.join('\n') + String(body ?? '')
  }

  /**
   * update 时重写文件：只替换 name 的取值行，其余字段、嵌套、注释与顺序逐字保留。
   * 盘上残留的旧 `description:` 行**不主动删**：记忆文件是用户资产，读侧已忽略它。
   */
  function serializeUpdatedFile(text: string, newName: string, body: string): string {
    return rewriteFrontmatterFields(text, { name: newName }, body)
  }

  /**
   * 写操作成功后：失效快照 + 丢弃场景记忆段缓存 + 通知 provider。
   * 指纹本身已能发现变化，这里显式丢弃是为了让写操作返回后**必然**是新鲜结果。
   * 不再写 ~/.dsh/AGENTS.md（原始终层投影已下线）：
   * 公共基线改由 `_shared/` 场景承担，统一走 systemPrompt 段。
   */
  const refresh = async (): Promise<void> => {
    invalidateSnapshot()
    // 两份段缓存**全清**（不是清某一条）：写操作改变的是磁盘事实，它对每个会话的作用
    // 都可能不同（比如某条记忆被本会话覆盖关掉），逐条算哪几条受影响只会漏。
    sceneCache.clear()
    sceneCatalogCache.clear()
    // 探测缓存同样清：写操作刚改了磁盘，下一拍必须重扫（监听会晚 200ms 才报，别等它）。
    clearProbeCache()
    // 顺带重建自动记忆的派生索引：删除 / 编辑一条自动记忆走的是本服务的 op，
    // 它不知道 catalog 的存在，而注入只读 catalog —— 不在这里重建，用户就会看到
    // "删了还在注入"。全量重建 300 条约 40ms，写操作本来就不频繁，值得。
    await rebuildCatalog().catch(() => {})
  }

  /**
   * 全量重建 `evolution/catalog.json`（派生数据：丢了可重建）。
   *
   * 两个入口共用：启动时（补齐历史条目 / 版本不符 / 文件缺失）与每次记忆写之后。
   * 失败一律吞掉 —— 派生索引坏了的后果是"这轮注入少几条"，而抛出去会让写操作假失败。
   */
  const rebuildCatalog = async (): Promise<void> => {
    // 一次性迁移放在重建之前：老版本把自动条目写在 memories/ 下，不搬过来它们就永远
    // 不进这份 catalog。marker 让这一步整体幂等，写后每次重建也不会重复搬。
    await migrateLegacyAutoNotes({ memoriesRoot, stateDir, autoRoot: autoNotesRoot }).catch(() => undefined)
    // 读**自主库自己那份**索引，不是用户记忆的 memories-index.json：启停 / 置顶是两码事，
    // 共用一份就会出现「用户停用了一个场景，自动条目跟着消失」。
    await mkdir(autoNotesRoot, { recursive: true })
    const index = await readIndex(autoNotesRoot)
    const built = await buildCatalog(autoNotesRoot, index)
    await mkdir(join(stateDir, 'evolution'), { recursive: true })
    await writeFileAtomically(catalogPathOf(stateDir), JSON.stringify(built, null, 2) + '\n', { mode: 0o600 })
  }

  /**
   * 场景档案引擎专用：读-改-写 mode/archives/active 切片（写队列内，保持与其余索引写串行）。
   *
   * `fields` 是**意图声明**：不传 = 老行为（按 `patch` 里出现的字段
   * 全写）。传了就只写列出的那几项 —— 引擎的每条路径各自动的是哪一片是明确的（"只落 mode"
   * 与"落 mode + active"是两件事），而"我没打算改的字段"必须留给**队列内刚读出来**的值，
   * 否则一次陈旧的整片回写会把窗口期里别人改的东西抹掉。
   */
  const patchIndex = (
    patch: { mode?: ModeState; archives?: Record<string, SceneArchive>; active?: string[] | null },
    fields?: ReadonlyArray<'mode' | 'active' | 'archives'>,
  ): Promise<void> =>
    enqueueMutation(() => withProcessLock(async () => {
      const index = await readIndex(stateDir)
      const want = (f: 'mode' | 'active' | 'archives'): boolean => (fields ? fields.indexOf(f) >= 0 : patch[f] !== undefined)
      if (want('mode') && patch.mode !== undefined) index.mode = patch.mode
      if (want('archives') && patch.archives !== undefined) index.archives = patch.archives
      // active 复用「记忆启用集」语义（null = 全部启用）；进入模式时引擎收窄为 [S]。
      if (want('active') && patch.active !== undefined) index.active = patch.active
      await writeIndex(stateDir, index)
      await refresh()
    }))

  /**
   * 场景档案引擎专用：只写**一个场景**的档案（队列内按**逐场景增量**落盘）。
   *
   * 为什么不能走 `patchIndex({ archives })`：那个接口拿到的是
   * 一份**整表**，而整表是在队外读出来的 —— 引擎保存场景 A 的档案期间，另一个写者（HTTP op /
   * 模型工具 / 另一条引擎路径）保存了场景 B 的档案，前者落盘时会把 B 的整份覆盖掉。
   * 逐场景增量只动自己那一条，其余键保留队列内读到的值。
   */
  const saveArchive = (scene: string, archive: SceneArchive | null): Promise<void> =>
    enqueueMutation(() => withProcessLock(async () => {
      const index = await readIndex(stateDir)
      const archives = index.archives ?? {}
      if (archive === null) delete archives[scene]
      else archives[scene] = archive
      index.archives = archives
      await writeIndex(stateDir, index)
      await refresh()
    }))

  /** 场景档案引擎专用：读 mode/archives/active 切片（容忍缺失，缺省 = 无档案 + 自由模式 + 全部启用）。 */
  const readArchiveSlice = async (): Promise<{ mode: ModeState; archives: Record<string, SceneArchive>; active: string[] | null }> => {
    const index = await readIndex(stateDir)
    return { mode: index.mode ?? { scene: null, snapshot: null }, archives: index.archives ?? {}, active: normalizeActive(index.active) }
  }

  /**
   * 某个场景的完整档案（同步）：会话的**场景层**按它实时计算（档案改了，下一个
   * 请求就跟着变）。读不到索引时返回 `undefined`（= 这一层没话说，按全局算）—— 失败的方向
   * 必须是"少过滤"，不能是"把本会话的东西整个关光"。
   */
  const sceneArchiveOf = (scene: string): SceneArchive | undefined => {
    try {
      const archive = readIndexSync(stateDir).archives?.[scene]
      return archive === undefined ? undefined : archive
    } catch {
      return undefined
    }
  }

  /**
   * 某个场景档案里的人设绑定（同步）。读不到索引时返回 `undefined`（= 不过滤）——
   * 这里失败的方向必须是"多列几个人设"，不能是"把人设目录整个清空"。
   */
  const sceneSubagentsOf = (scene: string): string[] | undefined => {
    try {
      const archive = readIndexSync(stateDir).archives?.[scene]
      const list = archive && Array.isArray(archive.subagents) ? archive.subagents : undefined
      return list === undefined ? undefined : list.map((name) => String(name))
    } catch {
      return undefined
    }
  }

  // ── 场景行（UI 用：启用/停用开关）──────────────────────────────────────

  /**
   * 场景行：**以索引的场景记录为准**（空场景也在列表里），记忆条数由快照统计。
   *
   * `override`= 本会话钉住的场景。给了就按它算 `active` / `selectable` —— 少了这一步
   * `rules-list` 里 `activeScene` 已经按会话投影了，而 `scenes[]` 每一行还报着全局值：
   * 场景页的「当前」标签、记忆页的场景卡、单选置灰全都不动，表现就是「切换场景没反应」
   * 。
   */
  function sceneRows(snap: Snapshot, index: RulesIndex, override?: string | null): SceneRow[] {
    const names = new Set<string>([GLOBAL_SCENE, ...Object.keys(index.scenes || {}), ...snap.scenes])
    const counts = new Map<string, number>()
    for (const rule of snap.rules) {
      if (rule.shadowed) continue
      const scene = sceneOf(rule.group)
      if (scene === '') continue // 无场景归属的记忆（旧根层遗留）不归属任何场景
      counts.set(scene, (counts.get(scene) || 0) + 1)
    }
    const known = [...names]
    const { active } = resolveActiveScenes(index, known, override)
    const enabledScene = enabledSceneOf(index, override)
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

  // 注入文本出口。
  //
  // 历史：本服务先后把场景记忆做成"系统提示词段"（会被 persona complete 压掉）与
  // "写 AGENTS.md 文件"（预设不挂 dsh-agent-instructions 时到不了模型）。现在两条都交给
  // 注入通道（src/context-inject.ts）：每个 step 前把文本并进一条注入消息，任何预设都到得了。
  // 这里只留**同步取文本**的两个出口，注册/生命周期由 index.ts 的注入器统一管。
  //
  //   - `memoryText`：场景记忆段（记忆正文；`''` = 没有可注入的内容）。走**注入侧口径**
  //     （`requireSceneMemory`）：读失败抛异常，由注入通道报 `error` 并保留上一轮内容。
  //     界面投影用的是 `sceneMemory()`（不抛、退回上一轮），两者共用同一个 `requireSceneMemory`。
  //   - `promptText`：全局提示词正文 = 场景期间用场景提示词、平时用 AGENTS.md 正文。
  //     **不判"与文件重复"** —— 预设挂了官方 agent-instructions 时那份正文已经由文件送达
  //     （注入侧会跳过整个域），没挂时（极简）才需要注入兜底；判定在注入器的 `selectInjections` 里。
  const memoryProjection = (scope?: MemoryScopeOverride): SceneMemoryProjection => requireSceneMemory(scope)
  const workspaceMemoryText = (group: string, scope?: MemoryScopeOverride, budgetBytes?: number): string => workspaceMemory(group, scope, budgetBytes).text
  const workspaceMemoryProjection = (group: string, scope?: MemoryScopeOverride, budgetBytes?: number): SceneMemoryProjection => workspaceMemory(group, scope, budgetBytes)
  const memoryText = (scope?: MemoryScopeOverride): string => memoryProjection(scope).text
  // 场景段。与记忆段是**两次探测**：`probeSceneFilesSync` 没有内部缓存（signature 本身就是
  // 扫描的结果，缓存不了），代价是有界的一次目录树 stat（**不读正文**），换来两段各自渲染、
  // 各自去重 —— 只改场景描述时不会连带重发整段记忆正文。
  // 渲染本身在 `sceneCatalog()`（见上面「注入侧取数」那一节，读失败抛）。
  const sceneCatalogText = (scope?: MemoryScopeOverride): string => sceneCatalog(scope).text
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
   * `text` 是**模型侧**正文，开头一行 `Instructions from: <展示路径>` —— 与官方 agent-instructions
   * 逐字同形（`render.js` 的 `sectionText`；由 `Source:` 改过来：官方注入本来就用
   * 这个措辞，模型对它有现成的先验）。模型据此知道这些规则写在哪个文件里：用户说"把这条记下来"
   * 时它知道该改哪份文件，而不是只能凭印象回答。
   */
  const resolvePrompt = (scope?: PromptScopeOverride, pinnedScene?: string | null): { path: string; digest: string; text: string } | null => {
    // 场景提示词与 AGENTS.md 正文在用户眼里就是同一件事（"全局提示词"）：场景期间前者取代后者，
    // 与官方语义一致（进场景改写文件、退出恢复）。所以一个域、一份文本，取到非空的场景提示词就用它。
    // 项目链：与官方同构，**永远跟着走**（未钉住时官方自己送它，钉住时由我们送）。
    // 取不到 cwd（冷会话 / 子代理）→ 空链，退化成"只有用户级"，与既有行为一致。
    const project = scope === undefined || scope.cwd === undefined ? null : renderProjectInstructions(discoverProjectInstructions(scope.cwd), AGENTS_MD_MAX_BYTES)
    if (project !== null && project.text.trim() !== '') {
      // 有项目链时把它拼在用户级**之后**（官方顺序：用户级 → 项目链，宽 → 窄）。
      // 用户级那一槽由调用方决定用哪一份（场景预设 / ~/.dsh/AGENTS.md）。
      // ⚠️ 拼的是 `user.text` 而不是 `user` 本身：`resolveUserLevelPrompt` 回的是
      // `{ path, digest, text }`，把整个对象 join 进数组会得到字面量 `[object Object]`
      // —— 用户级那一槽就这样被吃掉了（极简下只剩项目级那一段，实测）。
      const user = resolveUserLevelPrompt(pinnedScene, scope?.override, scope?.baseline)
      const combined = [user === null ? '' : user.text, project.text].filter((part) => part !== '').join('\n\n')
      if (combined.trim() === '') return null
      return {
        path: user === null ? project.files[0].path : user.path,
        digest: createHash('sha1').update(combined).digest('hex'),
        text: combined,
      }
    }
    return resolveUserLevelPrompt(pinnedScene, scope?.override, scope?.baseline)
  }
  /**
   * 把一份用户级正文夹到预算内（与 `~/.dsh/AGENTS.md` 的 64 KiB 同闸）。
   * 预设 / 会话覆盖 / 文件三条路共用，避免"绑定预设绕过预算"那类口子。
   */
  const clampPromptBody = (text: string, label: string): string => (
    Buffer.byteLength(text, 'utf8') <= AGENTS_MD_MAX_BYTES
      ? text
      : Buffer.from(text, 'utf8').subarray(0, AGENTS_MD_MAX_BYTES).toString('utf8') +
        `\n\n(Truncated: ${label} is over ${Math.floor(AGENTS_MD_MAX_BYTES / 1024)} KiB.)`
  )
  /**
   * 用户级那一条（会话覆盖 > 场景预设 > 本会话冻结快照 > 当前 `~/.dsh/AGENTS.md`）。
   *
   * 从 `resolvePrompt` 里拆出来是因为项目链要**拼在它前面**：两段来源不同、判定不同
   * （预设 / 会话覆盖 / 快照 vs 文件），但用户看到的是同一件事（"全局提示词"）。
   *
   * 会话覆盖取代的正是**这一槽**：
   *   · `content` 直接用（来源行标成侧车，模型能看出这是会话级覆盖）；
   *   · `presetId` 去读那份预设；删了 / 读不动 → 退化到下一层，不报错、不清侧车。
   *
   * 冻结快照：`baseline !== undefined` 时 AGENTS.md 槽位换成它 ——
   * 全局文件之后怎么改都与这个会话无关。**快照为空串也算一层**（返回 null）：
   * 创建时没有 AGENTS.md 的会话，不该因为后来全局应用了预设就突然多出提示词。
   * 只有从来没有快照时才读当前文件（退化路径）。
   */
  const resolveUserLevelPrompt = (
    pinnedScene?: string | null,
    override?: { presetId?: string; content?: string },
    baseline?: string,
  ): { path: string; digest: string; text: string } | null => {
    const sessionContent = override?.content !== undefined && override.content.trim() !== '' ? override.content : undefined
    if (sessionContent !== undefined) {
      const path = `${dshHomeDisplay()}/${HUB_DIR}/scope-overrides.json`
      return {
        path,
        digest: createHash('sha1').update(sessionContent).digest('hex'),
        // 来源行点名"session override"：模型能看出这份取代了全局基线。
        text: `Instructions from: ${path} (session override)\n\n${clampPromptBody(sessionContent, 'the session override')}`,
      }
    }
    const scene = resolveScenePreset(pinnedScene)
    const hasBaseline = baseline !== undefined
    // 有快照时**不读**当前文件：既不需要它的内容，也不需要它此刻读不读得动。
    // 没有快照时仍按老口径读：它是最后一层，读失败必须出声，不能被当成"没有提示词"。
    let raw = ''
    let rawError: unknown = null
    if (!hasBaseline) {
      try { raw = readGlobalAgentsMdSync() } catch (e) { rawError = e }
    }
    const hasGlobalFile = !hasBaseline && raw.trim() !== ''
    let choice = chooseUserPromptLayer({
      sessionContent: false,
      sessionPreset: override?.presetId !== undefined,
      scenePreset: scene !== null,
      sessionBaseline: hasBaseline,
      globalFile: hasGlobalFile,
    })
    if (choice === 'session-preset' && override?.presetId !== undefined) {
      let text = ''
      try { text = readPresetTextSync(override.presetId) } catch { text = '' /* 读不动 = 退化，不报错 */ }
      if (text.trim() !== '') {
        const path = `${dshHomeDisplay()}/${HUB_DIR}/${PRESETS_DIR}/${override.presetId}/AGENTS.md`
        return {
          path,
          digest: createHash('sha1').update(text).digest('hex'),
          text: `Instructions from: ${path} (session override)\n\n${clampPromptBody(text, 'the session preset body')}`,
        }
      }
      // 预设被全局删除 / 为空 → 当次退化回下一层（场景预设 / 快照 / 当前文件）。
      choice = chooseUserPromptLayer({
        sessionContent: false,
        sessionPreset: false,
        scenePreset: scene !== null,
        sessionBaseline: hasBaseline,
        globalFile: hasGlobalFile,
      })
    }
    if (choice === 'scene-preset' && scene !== null) {
      const path = `${dshHomeDisplay()}/${HUB_DIR}/${PRESETS_DIR}/${scene.presetId}/AGENTS.md`
      return {
        path,
        digest: createHash('sha1').update(scene.text).digest('hex'),
        text: `Instructions from: ${path}\n\n${clampPromptBody(scene.text, 'the preset body')}`,
      }
    }
    if (choice === 'session-baseline' && baseline !== undefined) {
      if (baseline.trim() === '') return null
      const path = `${dshHomeDisplay()}/AGENTS.md`
      return {
        path,
        digest: createHash('sha1').update(baseline).digest('hex'),
        text: `Instructions from: ${path}\n\n${clampPromptBody(baseline, 'the frozen session baseline')}`,
      }
    }
    if (choice === 'global-file') {
      if (rawError !== null) throw rawError
      const path = `${dshHomeDisplay()}/AGENTS.md`
      return {
        path,
        digest: createHash('sha1').update(raw).digest('hex'),
        text: `Instructions from: ${path}\n\n${clampPromptBody(raw, 'the file')}`,
      }
    }
    return null
  }
  /**
   * 模型侧的提示词正文（`''` = 没有可注入的内容）。
   *
   * **不判"与文件重复"** —— 预设挂了官方 agent-instructions 时那份正文已经由文件送达
   * （注入侧会跳过整个域），没挂时（极简）才需要注入兜底；判定在注入器的 `selectInjections` 里。
   */
  const promptText = (scope?: PromptScopeOverride): string => resolvePrompt(scope, scope?.scene)?.text ?? ''
  /**
   * `promptText()` 的**来源文件**（同步）：注入通道把它当作 instructions 形态的
   * `changes` 交给界面（文件清单 + 已载入/已更新），见 context-inject.ts 的 `files`。
   * 与文本同源（都走 `resolvePrompt`），所以两边不会分叉；`[]` = 无正文。
   *
   * 路径用**展示形态**（见 `dshHomeDisplay`）：界面里官方 agent-instructions 那条行写的是
   * `~/.dsh/AGENTS.md`，我们写绝对路径的话，同一个界面上会出现两种风格。
   */
  const promptFiles = (scope?: PromptScopeOverride): Array<{ path: string; digest: string }> => {
    const resolved = resolvePrompt(scope, scope?.scene)
    return resolved === null ? [] : [{ path: resolved.path, digest: resolved.digest }]
  }

  /** 写操作：串行队列内执行，成功后触发 refresh（失效缓存，下一请求即生效）。 */
  const runWrite = (task: () => Promise<any>) =>
    enqueueMutation(async () => {
      // 临界区只包写本身，refresh 放锁外：它只读盘，多挂一会儿只会让另一个宿主空等。
      const result = await withProcessLock(task)
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
    ...(deps.skillsTrashDir ? { skillsTrashDir: deps.skillsTrashDir } : {}),
    snapshot, invalidateSnapshot, sceneMemory, scenePrompt,
    scopeOverrideOf: (sessionId: string) => deps.scopeOverrideOf?.(sessionId),
    ...(deps.workspacesOf === undefined ? {} : { workspacesOf: deps.workspacesOf }),
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
    // 只读搜索：与 rules-list / rules-read 同一条队列（snapshot 可能触发索引清理写）。
    'rules-search': (args) => enqueueMutation(() => memoryOps.rulesSearch(args || {})),
    'rules-budget': () => memoryOps.rulesBudget(),
    'rules-diagnose': () => enqueueMutation(() => memoryOps.rulesDiagnose()),
    'rules-create': (args) => runWrite(() => memoryOps.rulesCreate(args || {})),
    'rules-import': (args) => runWrite(() => memoryOps.rulesImport(args || {})),
    'rules-update': (args) => runWrite(() => memoryOps.rulesUpdate(args || {})),
    'rules-remove': (args) => runWrite(() => trashOps.rulesRemove(args || {})),
    'rules-restore': (args) => runWrite(() => trashOps.rulesRestore(args || {})),
    'rules-trash-list': () => trashOps.rulesTrashList(),
    // 回收站「详情」：跨域只读预览（记忆 / 技能 / 提示词 / 人设 / 场景五类的条目都能查）。
    // 只 lstat + 递归读文件，不写任何东西 ⇒ 不进写队列、也不 refresh 快照。
    // 登记在 op-registry 的 `readonly` 一档：**锁定期间照样能看**（锁的是写，不是看）。
    'trash-preview': (args) => trashOps.trashPreview(args || {}),
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

    // 一键修复：索引被隔离后唯一的出口。它不"改"状态，是把已被改名移走的
    // 索引装回原位，所以**不走 runWrite / 也不进普通写队列之外的保护** —— 但必须入队：
    // 隔离期间其它 op 全被 writeIndex 拒着，队列里可能正排着几个失败的写，让修复与它们
    // 串行比让它在中间插入更安全（修完的那一刻，队列前面的失败项已经各自报过错）。
    'memories-index-repair': () => enqueueMutation(async () => {
      const repaired = await repairFromQuarantine(stateDir)
      if (repaired === null) {
        return {
          ok: false,
          error: '修复失败：隔离留存的索引文件仍无法解析，已保留现场。'
            + '请手工检查 .corrupt-* 文件后重启 DSH，或删除它与隔离标记从零开始。',
        }
      }
      return {
        ok: true,
        message: '已修复：记忆索引已从隔离留存文件恢复，写入保护已解除。',
        scenes: Object.keys(repaired.scenes || {}).length,
        rules: Object.keys(repaired.rules || {}).length,
      }
    }),
  }

  const service: MemoriesService = {
    ops,
    writeOps,
    memoryText,
    memoryProjection,
    sceneWithMemoryProjection,
    workspaceMemoryText,
    workspaceMemoryProjection,
    sceneCatalogText,
    promptText,
    promptFiles,
    promptBaselineText: readGlobalAgentsMdSync,
    refresh,
    dispose: () => {
      try { memoriesWatch?.dispose() } catch { /* 卸载路径上不留抛错 */ }
      memoriesWatch = null
      probeCache.clear()
    },
    patchIndex,
    saveArchive,
    readArchiveSlice,
    sceneArchiveOf,
    sceneSubagentsOf,
    sceneLocks: async (): Promise<Record<string, boolean>> => {
      const index = await readIndex(stateDir)
      const out: Record<string, boolean> = {}
      for (const [name, rec] of Object.entries(index.scenes || {})) {
        if (rec && rec.locked === true) out[name] = true
      }
      return out
    },
    // 自动记忆管线的第二个调用方（见接口注释）：四样都是本域内部已有的能力，这里只是
    // 明确地交出去，不新增实现。
    autoAccess: {
      snapshot,
      // 笔记库有自己的根与自己的索引；门禁读它，不能拿用户记忆快照顶替。
      // 不写索引清理：预演在写锁外跑，写清理会与真正的写入并发。
      autoSnapshot: () => buildSnapshot(autoNotesRoot, autoNotesRoot, { writeCleanup: false }),
      serializeRuleFile,
      // 同步版：注入的 `text(agent)` 没有 await 的位置。读不到索引就当"没有启用场景"，
      // 失败方向是"少注入场景层"而不是"把工作区层也关掉"。
      activeSceneSync: (scope?: MemoryScopeOverride): string | null => {
        try {
          return enabledSceneOf(readIndexSync(stateDir), scope?.scene)
        } catch {
          return null
        }
      },
      memoriesRoot,
      /** 自主记忆自己的根目录（装配 learner 时传它，别再传 memoriesRoot）。 */
      autoNotesRoot,
      stateDir,
      // 自动段与手写段共用同一个盘：两块都进同一次对话的上下文，各算一份就没人说得清
      // "一共能吃多少"。
      maxBytes,
      invalidateSnapshot,
      rebuildCatalog,
    },
  }
  return service
}
