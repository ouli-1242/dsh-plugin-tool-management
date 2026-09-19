// 规则/记忆域的**索引 IO**（2026-09-19 从 memories/service.ts 抽出）。
//
// memories-index.json 的解析、校验、原子落盘与损坏隔离都在这里。索引是「启停/排序/标签/
// 启用场景集合」的真源（记忆文件只负责正文），所以这一层必须 fail-closed：解析不出来就隔离
// 坏文件并回退默认索引，绝不让半截数据流进界面。
//
// 对 service.ts 只做 type-only 引用（`import type`），避免与它形成运行时循环依赖。

import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, statSync } from 'node:fs'
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { renameWithRetry } from '../skills/core.js'
import { normalizePresetId } from '../prompts/preset-id.js'
import { normalizeArchive } from './archive.js'
import type { ModeState, SceneArchive } from './archive.js'
import { DEFAULT_GROUP_ORDER, GLOBAL_SCENE, GLOBAL_SCENE_LABEL, INDEX_VERSION, isValidGroupPath, MEMORIES_INDEX_FILE } from './constants.js'
import { normalizeActive } from './projection.js'
import type { RulesIndex, SceneRecord } from './service.js'

/** 索引里的场景镜像条目。 */
export interface SceneIndexEntry {
  label?: string
  description?: string
  prompt?: string
  order?: number
  createdAt?: string
  /**
   * 场景锁定（v0.8）：锁定后五个管理域（MCP/技能/子智能体/记忆/提示词）整体只读 ——
   * 场景页的档案编辑与功能页的启停/编辑都被拒（index.ts 的 handlers 守卫 +
   * 界面按钮禁用）；场景自身的启停（进/退模式）不受影响。任意一个场景锁定即全局冻结。
   */
  locked?: boolean
}

export interface RuleIndexEntry {
  order?: number
  tags?: string[]
  pinned?: boolean
  enabled?: boolean
  note?: string
  updatedAt?: string
}

export interface GroupIndexEntry {
  order?: number
  label?: string
}

/**
 * 同目录临时文件 + rename 原子写（临时名 `.xxx.dsh-rules-<uuid>.tmp`）。
 * rename 走 `renameWithRetry`：Windows 上杀软/索引器会短暂占住目标文件报
 * EPERM/EACCES/EBUSY（用户实测：进入/退出模式时 memories-index.json 被 rename 撞上，
 * 运行时已切换但状态落盘失败，界面开关停在旧状态、还得再点一次）。这种占用是
 * 瞬时的，重试几轮就能过去；全失败才清理临时文件并把错误抛出。
 */
export async function writeFileAtomically(path: string, content: string): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.dsh-rules-${randomUUID()}.tmp`)
  try {
    await writeFile(temp, content, 'utf8')
    await renameWithRetry(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

/** 二进制版原子写（附件用）：临时文件 + rename（同样带瞬时占用重试），失败清理临时文件。 */
export async function writeFileAtomicBinary(path: string, data: Buffer): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.dsh-rules-${randomUUID()}.tmp`)
  try {
    await writeFile(temp, data)
    await renameWithRetry(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

// ── 递归发现 ───────────────────────────────────────────────────────────────

export const defaultIndex = (): RulesIndex => ({ version: INDEX_VERSION, rules: {}, groups: {}, scenes: {}, active: null, archives: {}, mode: { scene: null, snapshot: null } })

/** 场景镜像条目归一化：只保留已知字段，非法值丢弃（容忍脏数据）。 */
export function parseSceneEntry(raw: unknown): SceneIndexEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const out: SceneIndexEntry = {}
  if (typeof obj.label === 'string' && obj.label.trim() !== '') out.label = obj.label
  if (typeof obj.description === 'string' && obj.description !== '') out.description = obj.description
  if (typeof obj.prompt === 'string') {
    const prompt = normalizeScenePromptId(obj.prompt)
    if (prompt) out.prompt = prompt
  }
  if (typeof obj.order === 'number' && Number.isFinite(obj.order)) out.order = obj.order
  if (typeof obj.createdAt === 'string' && obj.createdAt !== '') out.createdAt = obj.createdAt
  // 场景锁定（v0.8）：读盘必须原样保留 —— 这里曾只重建已知字段，锁了也会被剥成未锁。
  if (obj.locked === true) out.locked = true
  return out
}

export function parseScenes(raw: unknown): Record<string, SceneIndexEntry> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, SceneIndexEntry> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isValidGroupPath(name)) continue
    const entry = parseSceneEntry(value)
    if (entry) out[name] = entry
  }
  return out
}

/** 档案切片归一化：未知形态 → 空对象（容忍脏数据，与 §9.3 同哲学）。 */
export function parseArchives(raw: unknown): Record<string, SceneArchive> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, SceneArchive> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const archive = normalizeArchive(value)
    if (Object.keys(archive).length) out[name] = archive
  }
  return out
}

export function parseModeState(raw: unknown): ModeState {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const scene = typeof obj.scene === 'string' && obj.scene.trim() !== '' ? obj.scene : null
  const snapshotRaw = (obj.snapshot && typeof obj.snapshot === 'object' ? obj.snapshot : {}) as Record<string, unknown>
  const toFlagMap = (v: unknown): Record<string, boolean> => {
    const out: Record<string, boolean> = {}
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, b] of Object.entries(v as Record<string, unknown>)) if (typeof b === 'boolean') out[k] = b
    }
    return out
  }
  // v2 快照：mcp = 停用表原文（serverName → ['*'] / 工具名）；skills = 启停布尔表。
  const mcp: Record<string, string[]> = {}
  const mcpRaw = snapshotRaw.mcp
  if (mcpRaw && typeof mcpRaw === 'object' && !Array.isArray(mcpRaw)) {
    for (const [server, list] of Object.entries(mcpRaw as Record<string, unknown>)) {
      if (Array.isArray(list)) mcp[server] = list.map((x) => String(x))
    }
  } else if (snapshotRaw.tools && typeof snapshotRaw.tools === 'object' && !Array.isArray(snapshotRaw.tools)) {
    // v1 快照兼容（升级前数据）：tools = 布尔启停表（key = `<server>/<tool>`，false = 停用）
    // → 折算成 v2 的停用名单；否则退出模式会把「快照启停」错误还原成「全部启用」。
    for (const [key, on] of Object.entries(snapshotRaw.tools as Record<string, unknown>)) {
      if (on !== false) continue
      const i = key.indexOf('/')
      if (i <= 0 || i === key.length - 1) continue
      const server = key.slice(0, i)
      const tool = key.slice(i + 1)
      const list = mcp[server] || (mcp[server] = [])
      if (list.indexOf(tool) < 0) list.push(tool)
    }
  }
  // v2 快照的**服务器级 / 来源级**名单、v0.8 的子智能体名单、v0.9.1 的人设全量映射
  // 必须原样透传 —— 这里曾把它们剥掉，结果退出模式时两张恢复名单全是空的：服务器级 MCP 与
  // 技能来源永远不回滚（用户报的「MCP 不复原」「技能目录不回退」），只有工具级 / 技能级能还原。
  const mcpServers = (Array.isArray(snapshotRaw.mcpServers) ? snapshotRaw.mcpServers : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => ({ id: String(x.id || ''), level: String(x.level || ''), disabled: x.disabled === true }))
    .filter((x) => x.id !== '' && (x.level === 'global' || x.level === 'project'))
  const skillSources = (Array.isArray(snapshotRaw.skillSources) ? snapshotRaw.skillSources : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => ({ root: String(x.root || ''), enabled: x.enabled === true }))
    .filter((x) => x.root !== '')
  const subagents = (Array.isArray(snapshotRaw.subagents) ? snapshotRaw.subagents : []).map((x) => String(x)).filter(Boolean)
  // 同 subagents 一组：进入时被档案**关掉**的人设（退出要重新打开）。漏掉它 = 用户实测的
  // 「进场景关掉了，退出却没开回来」——快照落盘后读回来就只剩「被启用」那一半名单。
  const subagentsOn = (Array.isArray(snapshotRaw.subagentsOn) ? snapshotRaw.subagentsOn : []).map((x) => String(x)).filter(Boolean)
  // v0.9.1 的人设**全量**开关映射（名字 → 进场景时是否开着）：同样必须原样透传 ——
  // 剥掉它，退出模式就只能退回上面两个部分名单，「场景里手动开过的人设」不再被还原。
  const subagentsAll = toFlagMap(snapshotRaw.subagentsAll)
  // v0.8.1 的场景备注恢复名单：**必须原样透传**——这里漏掉它，退出模式时备注永不回退
  //（与历史上 mcpServers / skillSources 被剥掉是同一类 bug）。
  const mcpNotes = (Array.isArray(snapshotRaw.mcpNotes) ? snapshotRaw.mcpNotes : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => ({ id: String(x.id || ''), note: typeof x.note === 'string' ? x.note : null }))
    .filter((x) => x.id !== '')
  return {
    scene,
    snapshot: scene
      ? {
          mcp,
          skills: toFlagMap(snapshotRaw.skills),
          ...(mcpServers.length ? { mcpServers } : {}),
          ...(skillSources.length ? { skillSources } : {}),
          ...(subagents.length ? { subagents } : {}),
          ...(subagentsOn.length ? { subagentsOn } : {}),
          ...(Object.keys(subagentsAll).length ? { subagentsAll } : {}),
          ...(mcpNotes.length ? { mcpNotes } : {}),
        }
      : null,
  }
}

/** 解析 memories-index.json 原文；任何异常/版本不符 → 默认索引（容忍缺失，§9.3）。 */
export function parseIndex(raw: string): RulesIndex {
  const parsed = JSON.parse(raw) as Partial<RulesIndex>
  if (!parsed || parsed.version !== INDEX_VERSION || typeof parsed.rules !== 'object' || parsed.rules === null) throw new Error('bad index')
  return {
    version: INDEX_VERSION,
    rules: (parsed.rules || {}) as Record<string, RuleIndexEntry>,
    groups: (parsed.groups || {}) as Record<string, GroupIndexEntry>,
    scenes: parseScenes((parsed as Record<string, unknown>).scenes),
    active: normalizeActive(parsed.active),
    archives: parseArchives((parsed as Record<string, unknown>).archives),
    mode: parseModeState((parsed as Record<string, unknown>).mode),
  }
}

// 索引损坏的进程级记录：stateDir → 损坏原文件被改名后的落点。
//
// 为什么需要它：原来 readIndex 的 catch 把「文件不存在」「读失败」「解析失败」三者合并成
// 「返回默认索引」，而索引是启停/排序/标签/场景描述/归档/模式快照的**唯一**真相源 ——
// 于是任意一次写操作都会把这份空索引落盘，一次解析失败就静默换掉用户全部配置，且没有
// 任何提示；模式快照丢了之后，运行时 MCP/技能开关再也无法回滚。
// 触发不限于文件损坏：parseIndex 对字段类型严格，跨版本降级读到新版结构同样会抛。
//
// 现在的口径分开处理两条路：
//   - 读侧降级 —— 注入路径（readIndexSync）不能抛，返回默认索引，界面表现为「记忆都没了」，
//     是可见症状而不是静默改写；
//   - 写侧 fail-closed —— 拒绝落盘并把原因回给界面，用户的数据一个字节不动。
export const corruptIndexes = new Map<string, string>()

/** 把损坏的索引改名留存并记录该 stateDir 已损坏（幂等，只记一次）。 */
export function quarantineIndex(stateDir: string): void {
  const key = resolve(stateDir)
  if (corruptIndexes.has(key)) return
  const abs = join(stateDir, MEMORIES_INDEX_FILE)
  const kept = `${abs}.corrupt-${Date.now()}`
  try {
    renameSync(abs, kept)
    corruptIndexes.set(key, kept)
  } catch {
    // 改名失败（被占用/权限）不改判定：仍然标记损坏并拒绝写，只是没有留存副本。
    corruptIndexes.set(key, abs)
  }
  console.warn(
    `[dsh-plugin-tool-management] 记忆索引解析失败，已停止写入以免覆盖你的数据。`
    + `损坏的原文件已留存为 ${kept} —— 请检查它（或删除后重启 DSH）再继续操作。`,
  )
}

/** 该 stateDir 的索引是否已判定损坏（写侧拒绝落盘，读侧按「全部未启用」处理）。 */
export function isIndexQuarantined(stateDir: string): boolean {
  return corruptIndexes.has(resolve(stateDir))
}

/** 解析索引；失败即隔离该文件并返回默认索引（写侧由 writeIndex 拦截）。 */
export function parseOrQuarantine(stateDir: string, raw: string): RulesIndex {
  try {
    return parseIndex(raw)
  } catch {
    quarantineIndex(stateDir)
    return defaultIndex()
  }
}

export async function readIndex(stateDir: string): Promise<RulesIndex> {
  let raw: string
  try {
    raw = await readFile(join(stateDir, MEMORIES_INDEX_FILE), 'utf8')
  } catch {
    // 文件不存在 = 全新用户；其余 IO 错误也按「没有索引」处理（与既有语义一致）。
    return defaultIndex()
  }
  return parseOrQuarantine(stateDir, raw)
}

/**
 * 同步读索引：注入文本的渲染路径不能 await（见文件内「两相扫描」注释）。
 *
 * 带 `mtimeMs:size` 指纹缓存：一次装配里这个函数会被调到 2 次以上，每个模型 step 都重读
 * 重解一遍整份索引没有意义。指纹**必须**在 —— 索引可能被别的 DSH 实例或用户手工改动，
 * 只按自身写入失效会让插件一直用旧值（表现为「记忆停不掉」）。stat 失败（文件被删 / 被
 * 隔离改名）即丢缓存。同款手法见 `readPresetTextSync` 与 subagents 的 enabledStamp。
 *
 * ⚠️ 返回的可能是**缓存实例**，调用方只许读；写索引一律走异步 `readIndex`（它每次重新解析，
 * 拿到新对象）。当前两个调用方（`sceneMemory` / `resolveScenePreset`）及其下游
 * （`signatureOfIndex` / `resolveActiveScenes` / `sceneHeader` / `compareSceneBuckets` /
 * `sceneOrderOf`）都已确认只读 —— 新增调用方请保持这条。
 */
export const indexSyncCache = new Map<string, { key: string; value: RulesIndex }>()

export function readIndexSync(stateDir: string): RulesIndex {
  const file = join(stateDir, MEMORIES_INDEX_FILE)
  let key: string
  try {
    const st = statSync(file)
    key = `${st.mtimeMs}:${st.size}`
  } catch {
    // 文件不存在 = 全新用户；其余 IO 错误也按「没有索引」处理（与 readIndex 一致）。
    indexSyncCache.delete(stateDir)
    return defaultIndex()
  }
  const cached = indexSyncCache.get(stateDir)
  if (cached && cached.key === key) return cached.value
  const raw = readFileIfExistsSync(file)
  const value = raw === null ? defaultIndex() : parseOrQuarantine(stateDir, raw)
  indexSyncCache.set(stateDir, { key, value })
  return value
}

export async function writeIndex(stateDir: string, index: RulesIndex): Promise<void> {
  // 索引损坏时拒绝写入：这一次写会把空索引落盘，等于用一次解析失败换掉用户全部配置。
  const kept = corruptIndexes.get(resolve(stateDir))
  if (kept !== undefined) {
    throw new Error(
      `记忆索引文件损坏，已拒绝写入以免覆盖你的数据（原文件留存为 ${kept}）。`
      + `请检查或删除该损坏文件后重启 DSH，再重试本次操作。`,
    )
  }
  await mkdir(stateDir, { recursive: true })
  await writeFileAtomically(join(stateDir, MEMORIES_INDEX_FILE), JSON.stringify(index, null, 2))
}

// ── 场景记录（索引内，`memories-index.json` 的 scenes 切片）+ 旧布局迁移 ────────

/** 索引条目 → 场景记录（供 UI 直接渲染）。 */
export function sceneRecordOf(name: string, entry: SceneIndexEntry | undefined): SceneRecord {
  const e = entry || {}
  return {
    name,
    ...(name === GLOBAL_SCENE ? { label: e.label || GLOBAL_SCENE_LABEL } : (e.label ? { label: e.label } : {})),
    ...(e.description ? { description: e.description } : {}),
    ...(e.prompt ? { prompt: e.prompt } : {}),
    order: e.order ?? (name === GLOBAL_SCENE ? 0 : DEFAULT_GROUP_ORDER),
    ...(e.createdAt ? { createdAt: e.createdAt } : {}),
  }
}

/** 提示词预设 id 的口径与提示词预设服务**同源**（用户裁定：id 什么都能写）。 */

/** 校验场景要绑定的提示词预设 id；返回 `''` 表示解绑，`null` 表示非法。 */
export function normalizeScenePromptId(value: unknown): string | null {
  const id = String(value ?? '').trim()
  if (id === '') return ''
  const result = normalizePresetId(id)
  return result.ok ? result.id : null
}

/** 路径是否存在（不跟随符号链接；用于迁移前置判断）。 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

export function readFileIfExistsSync(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
