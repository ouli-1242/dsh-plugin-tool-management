// 自动记忆的注入索引（`evolution/catalog.json`）。
//
// 为什么需要它：注入热路径不能读正文。300 条 × 2 KB 全读约 100–300ms，而只读这份派生索引
// 约 10ms。条数再多，注入成本也应该基本不变 —— 这是"记忆多了也不会变慢"的那一半。
//
// 为什么是**派生**数据：它全部可以从「磁盘文件 + evolution/state.json」重建。所以损坏了
// 直接重建，不做修复、不做迁移、不写墓碑。真源永远是文件与 state（见 docs 02-storage §4）。
//
// 为什么一条记忆一个 md 文件而不是合成一个大文件：合并省的是读取，丢的是单条回滚、并发写
// 和条目级回收；而且合并会诱导"读整文件 → 改 → 写整文件"，那正是 ACE 实测的 context
// collapse 条件。读取的问题由这份索引解决，不用合并解决。

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSkillDoc } from '../skills/core.js'
import { AUTO_ONELINE_MAX, LAYER_SCENE, LAYER_SESSION, LAYER_WORKSPACE, layerOfGroup, type MemoryLayer } from './constants.js'
import { deriveFromDoc, discover, type ParsedSkillDoc } from './discovery.js'
import { sceneOf } from './projection.js'
import { excerptOf } from '../text-width.js'
import type { RulesIndex } from './service.js'

/** hub 内相对路径。 */
export const CATALOG_FILE = 'evolution/catalog.json'
export const CATALOG_VERSION = 1

/**
 * catalog 的绝对落点。
 *
 * 由 `stateDir` 拼出来而不是走 `hubPath()`：服务可以注入自定义 stateDir（测试与多实例），
 * 而 `hubPath()` 永远指向 `$DSH_HOME/tool-management`。两边各拼一次的话，注入 stateDir
 * 时会出现"写在一处、读在另一处"——症状是学了但注入里永远看不见。
 */
export const catalogPathOf = (stateDir: string): string => join(stateDir, CATALOG_FILE)

/**
 * "会进上下文"的状态（P4 起含 playbook）。
 *
 * 散落在各处的 `status === 'active' || status === 'core'` 每加一级状态就要改一遍，漏一处
 * 的症状很隐蔽：条目在清单里显示"生效"，注入里却永远看不见。统一收在这里。
 */
export const INJECTABLE_STATUSES: readonly string[] = ['active', 'core', 'playbook']
export const isInjectableStatus = (status: string): boolean => INJECTABLE_STATUSES.includes(status)

/** 一条自动记忆的注入卡片。字段全为标量，便于稳定序列化与界面直读。 */
export interface CatalogEntry {
  id: string
  layer: MemoryLayer
  /** 工作区层：hash16；其余为空串。 */
  workspace: string
  /** 场景层：场景名；其余为空串。 */
  scene: string
  /** 会话层：sid；其余为空串。 */
  session: string
  /** preference / fact / correction / procedure；手写条目为空串。 */
  kind: string
  /** 语义槽位：同 key 视为同一件事。 */
  key: string
  /** candidate / active / core / superseded / archived。 */
  status: string
  /**
   * 注入用的正文（完整，不截断）。
   *
   * 与 `oneLine` 分工：这条进上下文，`oneLine` 只给列表扫读与 `memory_get` 清单。
   * 早先注入的是 `oneLine`，等于每条笔记只进前 160 字 —— 正文后半截被静默丢掉。
   */
  body: string
  /** 列表与清单用的单行摘要（压平后按显示宽度截断）。 */
  oneLine: string
  /** playbook 的标题：升为 playbook 后注入**只放这一行**，不展开步骤。 */
  title?: string
  /**
   * 「什么时候可能不成立」—— 注入行末尾会带上它。
   *
   * 这一条不进正文而是单列：`oneLine` 是「结论」，边界是「例外」。压成一行时两者必须
   * 分得开，否则模型会把例外读成结论的一部分。
   */
  boundary?: string
  bytes: number
  estTokens: number
  enabled: boolean
  mtime: number
  size: number
  /** 正文的 sha256（变化检测；损坏/读不到时为空串）。 */
  hash: string
}

export interface CatalogFile {
  version: 1
  builtAt: string
  entries: Record<string, CatalogEntry>
}

/** UTF-8 字节 → 估算 token。按 3 bytes/token（中文）算：对英文是高估，高估是安全的。 */
export const estimateTokens = (bytes: number): number => Math.max(1, Math.ceil(bytes / 3))

/** 正文压成一行并按显示宽度截断；空正文返回空串。只用于列表扫读，注入用完整正文。 */
export function oneLineOf(text: string, max = AUTO_ONELINE_MAX): string {
  return excerptOf(text, max)
}

/** 一条记忆是否该进 catalog：只看来源，不看目录（目录只决定层）。 */
function isAutoOrigin(origin: string | undefined, layer: MemoryLayer): boolean {
  if (origin === 'auto') return true
  if (origin === 'user') return false
  // 没写 origin 时按目录判：工作区/会话层的文件默认就是 agent 写的（手写入口不会往这两层放，
  // 除非用户显式指定，那时 save 会写 origin: user）。
  return layer === LAYER_WORKSPACE || layer === LAYER_SESSION
}

/** 目录名 → 归属键。 */
function ownerOf(group: string): { workspace: string; session: string } {
  const parts = String(group ?? '').split('/')
  const head = parts[0]
  const second = parts[1] ?? ''
  if (head === '_ws') return { workspace: second, session: '' }
  if (head === '_session') return { workspace: '', session: second }
  return { workspace: '', session: '' }
}

/**
 * 全量重建。
 *
 * 只在启动、版本不符、或条目数变化时跑（300 条约 40ms）。日常写入走增量更新 —— 那条路径
 * 在 P1 的写入管线里（只改一条卡片再原子写）。
 */
export async function buildCatalog(memoriesRoot: string, index: RulesIndex): Promise<CatalogFile> {
  const discovery = await discover(memoriesRoot)
  const entries: Record<string, CatalogEntry> = {}
  for (const entry of discovery.entries.values()) {
    const layer = layerOfGroup(entry.group)
    let text: string
    let info: { mtimeMs: number; size: number }
    try {
      const [raw, st] = await Promise.all([readFile(entry.docPath, 'utf8'), stat(entry.docPath)])
      text = raw
      info = { mtimeMs: st.mtimeMs, size: st.size }
    } catch {
      // 扫描与读取之间被删 / 读不动：跳过。下次重建会再校正。
      continue
    }
    const doc = parseSkillDoc(text) as ParsedSkillDoc
    const derived = deriveFromDoc(entry, doc)
    if (!isAutoOrigin(derived.origin, layer)) continue
    const idx = index.rules[entry.id]
    const { workspace, session } = ownerOf(entry.group)
    // 注入用完整正文；`oneLine` 只是列表摘要。字节按正文算 —— 进上下文的是它。
    const body = String(doc.body ?? '').trim()
    const oneLine = oneLineOf(body)
    const bytes = Buffer.byteLength(body, 'utf8')
    // `auto_title` 是 P4 才有的字段；旧条目没有时留空，注入侧会退回 key / 文件名。
    const autoTitle = typeof doc.map.auto_title === 'string' ? String(doc.map.auto_title).trim() : ''
    entries[entry.id] = {
      id: entry.id,
      layer,
      workspace,
      scene: layer === LAYER_SCENE ? sceneOf(entry.group) : layer === LAYER_WORKSPACE ? (derived.autoScene ?? '') : '',
      session,
      kind: derived.autoKind ?? '',
      key: derived.autoKey ?? '',
      ...(autoTitle !== '' ? { title: autoTitle } : {}),
      ...(derived.autoBoundary !== undefined ? { boundary: derived.autoBoundary } : {}),
      // 自动条目缺省 candidate：没有证据链的条目不该被当成 active 注入。
      status: derived.autoStatus ?? 'candidate',
      body,
      oneLine,
      bytes,
      estTokens: estimateTokens(bytes),
      enabled: idx?.enabled !== false,
      mtime: info.mtimeMs,
      size: info.size,
      hash: createHash('sha256').update(text).digest('hex'),
    }
  }
  return { version: CATALOG_VERSION, builtAt: new Date().toISOString(), entries }
}

/** 宽松读：结构不对就当没有（catalog 是派生数据，重建即可）。 */
export function normalizeCatalog(raw: any): CatalogFile {
  const r = raw && typeof raw === 'object' ? raw : {}
  if (r.version !== CATALOG_VERSION || !r.entries || typeof r.entries !== 'object') {
    return { version: CATALOG_VERSION, builtAt: '', entries: {} }
  }
  const entries: Record<string, CatalogEntry> = {}
  for (const [id, v] of Object.entries<any>(r.entries)) {
    if (!v || typeof v !== 'object' || typeof v.oneLine !== 'string') continue
    entries[id] = {
      id,
      layer: v.layer,
      workspace: typeof v.workspace === 'string' ? v.workspace : '',
      scene: typeof v.scene === 'string' ? v.scene : '',
      session: typeof v.session === 'string' ? v.session : '',
      kind: typeof v.kind === 'string' ? v.kind : '',
      key: typeof v.key === 'string' ? v.key : '',
      status: typeof v.status === 'string' ? v.status : 'candidate',
      // 旧 catalog 没有 `body`（那时注入的是 `oneLine`）：退回它，别让条目在升级后
      // 变成"有摘要、没正文"而注入失败。下次重建会写回完整正文。
      body: typeof v.body === 'string' ? v.body : v.oneLine,
      oneLine: v.oneLine,
      bytes: typeof v.bytes === 'number' ? v.bytes : estimateTokens(0),
      estTokens: typeof v.estTokens === 'number' ? v.estTokens : estimateTokens(0),
      enabled: v.enabled !== false,
      mtime: typeof v.mtime === 'number' ? v.mtime : 0,
      size: typeof v.size === 'number' ? v.size : 0,
      hash: typeof v.hash === 'string' ? v.hash : '',
      // 只在有值时加键：深比较时多出 undefined 会被当成"变了"。
      ...(typeof v.title === 'string' && v.title !== '' ? { title: v.title } : {}),
      ...(typeof v.boundary === 'string' && v.boundary !== '' ? { boundary: v.boundary } : {}),
    }
  }
  return { version: CATALOG_VERSION, builtAt: typeof r.builtAt === 'string' ? r.builtAt : '', entries }
}

/**
 * 按当前会话选可见条目。
 *
 * 过滤是**结构性的**：`session` 层只认自己的 sid，别的 sid 一条都选不到 —— 它们在磁盘上
 * 也是独立目录，扫描阶段就进不来。这里再判一次是第二道保险（防止 catalog 被手工改过）。
 */
export function visibleEntries(
  catalog: CatalogFile,
  scope: { workspaceHash?: string; sessionId?: string; enabledScenes?: Set<string> },
): CatalogEntry[] {
  const out: CatalogEntry[] = []
  for (const e of Object.values(catalog.entries)) {
    if (!e.enabled) continue
    if (!isInjectableStatus(e.status)) continue
    if (e.layer === LAYER_WORKSPACE) {
      if (scope.workspaceHash === undefined || e.workspace !== scope.workspaceHash) continue
    } else if (e.layer === LAYER_SESSION) {
      if (scope.sessionId === undefined || e.session !== scope.sessionId) continue
    } else if (e.layer === LAYER_SCENE) {
      if (!scope.enabledScenes || !scope.enabledScenes.has(e.scene)) continue
    }
    out.push(e)
  }
  return out
}

/** 写盘前的形状校验（P1 的写入管线与 UI 都会调用）。 */
export function catalogEntryOf(
  id: string,
  layer: MemoryLayer,
  fields: Partial<CatalogEntry> & { body: string },
): CatalogEntry {
  const body = String(fields.body ?? '').trim()
  const oneLine = fields.oneLine !== undefined ? oneLineOf(fields.oneLine) : oneLineOf(body)
  const bytes = Buffer.byteLength(body, 'utf8')
  const { workspace, session } = ownerOf(id.slice(0, id.lastIndexOf('/')))
  return {
    id,
    layer,
    workspace: fields.workspace ?? workspace,
    scene: fields.scene ?? '',
    session: fields.session ?? session,
    kind: fields.kind ?? '',
    key: fields.key ?? '',
    ...(fields.title !== undefined && fields.title !== '' ? { title: fields.title } : {}),
    ...(fields.boundary !== undefined && fields.boundary !== '' ? { boundary: fields.boundary } : {}),
    status: fields.status ?? 'candidate',
    body,
    oneLine,
    bytes,
    estTokens: estimateTokens(bytes),
    enabled: fields.enabled !== false,
    mtime: fields.mtime ?? 0,
    size: fields.size ?? bytes,
    hash: fields.hash ?? '',
  }
}
