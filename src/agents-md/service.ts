// dsh-plugin-tool-management —— AGENTS.md 预设库 + 切换 服务层。
//
// DSH 全局指令基线只有一个文件 ~/.dsh/AGENTS.md（USER_GLOBAL_FILE 固定），
// 没有内置的「多份全局 AGENTS.md 切换」机制。本服务在 hub 内维护一个
// 预设库（每套一个子目录 + AGENTS.md），「应用」= 把选中预设内容写入
// ~/.dsh/AGENTS.md，新会话生效（当前会话不变，DSH 本身如此）。
//
// id 即目录名：字符集口径见 `./preset-id.ts`（用户裁定「什么都能写」，只留
// 文件系统安全约束）；`__last-applied__` 是备份槽，不算用户预设。
// 「当前生效」靠比对 ~/.dsh/AGENTS.md 的 sha256 与各预设 sha256 推断，
// 无状态文件——用户手改全局文件也能如实反映。
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { isValidPresetId, LAST_APPLIED_PRESET_ID, normalizePresetId } from './preset-id.js'

const FILENAME = 'AGENTS.md'
const LAST_APPLIED_ID = LAST_APPLIED_PRESET_ID
/** 新建预设的初始正文（空模板）；用户也可以直接粘贴自己的内容。 */
const BLANK_TEMPLATE = '# AGENTS.md\n\n（DSH 全局指令基线预设，待编辑）\n'
/** 全局 AGENTS.md 的备份代际上限：与 mcpm patch 的 KEEP_PATCH_BACKUPS 同纪律。 */
const KEEP_GLOBAL_BACKUPS = 5

export interface AgentsMdDeps {
  /** 预设库根目录（已解析的绝对路径）。 */
  presetsDir: string
  /** 解析当前 DSH 全局 AGENTS.md 的绝对路径（~/.dsh/AGENTS.md）。 */
  getGlobalAgentsMdPath: () => Promise<string>
}

export interface AgentsMdPresetRow {
  id: string
  active: boolean
}

export interface AgentsMdService {
  list(): Promise<{ ok: true; presets: AgentsMdPresetRow[] } | { ok: false; error: string }>
  read(id: string): Promise<{ ok: true; content: string } | { ok: false; error: string }>
  create(id: string, options?: { from?: string; content?: string }): Promise<{ ok: true; id: string } | { ok: false; error: string }>
  /**
   * 保存预设：正文必写；`nextId` 与 `id` 不同时**改名（= 目录改名）**。
   * @returns 改名时带回 `renamedFrom`，调用方据此把场景绑定一起改名。
   */
  update(id: string, content: string, nextId?: string): Promise<{ ok: true; id: string; renamedFrom?: string } | { ok: false; error: string }>
  apply(id: string): Promise<{ ok: true; id: string; backedUp: boolean } | { ok: false; error: string }>
  /** 按原文写回全局基线（备份纪律同 apply）；用于场景关闭时恢复进场景前的内容。 */
  restore(content: string): Promise<{ ok: true; backedUp: boolean } | { ok: false; error: string }>
  getCurrent(): Promise<{ ok: true; content: string; presetId: string | null; exists: boolean } | { ok: false; error: string }>
  remove(id: string): Promise<{ ok: true; id: string } | { ok: false; error: string }>
  importPreset(id: string, content: string): Promise<{ ok: true; id: string } | { ok: false; error: string }>
}

export function createAgentsMdService(_ctx: unknown, deps: AgentsMdDeps): AgentsMdService {
  const message = (e: unknown): string => String((e && (e as Error).message) || e)

  /** 校验 id 并返回错误文本（合法时返回 `null`）。 */
  const idError = (raw: unknown): string | null => {
    const result = normalizePresetId(raw)
    return result.ok ? null : result.error
  }

  async function sha256OfFile(abs: string): Promise<string | null> {
    try {
      const buf = await readFile(abs, 'utf8')
      return createHash('sha256').update(buf).digest('hex')
    } catch {
      return null
    }
  }

  // 幂等初始化：仅当库完全无预设且全局 AGENTS.md 存在时，拷贝全局为 default
  // 预设（首次运行引导）。用户已 create/apply 过任何预设则不插手，避免把
  // 当前生效内容误存成 default 与真正生效的预设冲突。
  async function ensureInit(): Promise<void> {
    const [presetsDir, globalPath] = await Promise.all([deps.presetsDir, deps.getGlobalAgentsMdPath()])
    let existing: import('node:fs').Dirent[] = []
    try { existing = await readdir(presetsDir, { withFileTypes: true }) } catch { /* 库不存在 */ }
    const hasPreset = existing.some((e) => e.isDirectory() && isValidPresetId(e.name) && e.name !== LAST_APPLIED_ID)
    if (hasPreset) return
    let globalContent: string
    try { globalContent = await readFile(globalPath, 'utf8') } catch { return }
    try {
      await mkdir(presetsDir, { recursive: true })
      const defaultDir = join(presetsDir, 'default')
      await mkdir(defaultDir, { recursive: true })
      await writeFile(join(defaultDir, FILENAME), globalContent, 'utf8')
    } catch { /* best effort */ }
  }

  async function list(): Promise<{ ok: true; presets: AgentsMdPresetRow[] } | { ok: false; error: string }> {
    try {
      await ensureInit()
      const [presetsDir, globalPath] = await Promise.all([deps.presetsDir, deps.getGlobalAgentsMdPath()])
      let entries: import('node:fs').Dirent[] = []
      try {
        entries = await readdir(presetsDir, { withFileTypes: true })
      } catch {
        // 库目录不存在视作空（首次运行尚未创建）
      }
      const globalHash = await sha256OfFile(globalPath)
      const ids = entries
        .filter((e) => e.isDirectory() && isValidPresetId(e.name) && e.name !== LAST_APPLIED_ID)
        .map((e) => e.name)
      const presets = await Promise.all(
        ids.map(async (id) => {
          const contentHash = await sha256OfFile(join(presetsDir, id, FILENAME))
          return {
            id,
            active: globalHash !== null && contentHash !== null && globalHash === contentHash,
          }
        }),
      )
      presets.sort((a, b) => a.id.localeCompare(b.id))
      return { ok: true, presets }
    } catch (e) {
      return { ok: false, error: message(e) }
    }
  }

  async function read(id: string): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
    const bad = idError(id)
    if (bad) return { ok: false, error: '非法 id：' + bad }
    const safeId = String(id ?? '').trim()
    try {
      const content = await readFile(join(deps.presetsDir, safeId, FILENAME), 'utf8')
      return { ok: true, content }
    } catch {
      return { ok: false, error: '预设不存在：' + safeId }
    }
  }

  /** 新建预设：`content` 优先（用户在新建弹窗里直接写的内容），否则用 `from` 复制，否则空模板。 */
  async function create(id: string, options?: { from?: string; content?: string }): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const bad = idError(id)
    if (bad) return { ok: false, error: '非法 id：' + bad }
    const safeId = String(id ?? '').trim()
    const dir = join(deps.presetsDir, safeId)
    try { await stat(dir); return { ok: false, error: 'id 已存在：' + safeId } } catch { /* 不存在，继续 */ }
    const explicit = options && typeof options.content === 'string' ? options.content : undefined
    let content: string
    if (explicit !== undefined) {
      content = explicit
    } else {
      const srcId = String(options && options.from ? options.from : '').trim()
      if (srcId) {
        const badFrom = idError(srcId)
        if (badFrom) return { ok: false, error: '非法来源 id：' + badFrom }
        try { content = await readFile(join(deps.presetsDir, srcId, FILENAME), 'utf8') }
        catch { return { ok: false, error: '来源预设不存在：' + srcId } }
      } else {
        content = BLANK_TEMPLATE
      }
    }
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, FILENAME), content, 'utf8')
    return { ok: true, id: safeId }
  }

  /**
   * 保存预设：正文写入 + 可选**改名**（目录改名，内容随目录一起走）。
   * 改名冲突（目标已存在）直接拒绝，不合并、不覆盖。
   */
  async function update(id: string, content: string, nextId?: string): Promise<{ ok: true; id: string; renamedFrom?: string } | { ok: false; error: string }> {
    const bad = idError(id)
    if (bad) return { ok: false, error: '非法 id：' + bad }
    const safeId = String(id ?? '').trim()
    const dir = join(deps.presetsDir, safeId)
    try { await stat(dir) } catch { return { ok: false, error: '预设不存在：' + safeId } }
    let targetId = safeId
    if (nextId !== undefined && String(nextId).trim() !== safeId) {
      const badNext = idError(nextId)
      if (badNext) return { ok: false, error: '非法新 id：' + badNext }
      targetId = String(nextId).trim()
      const nextDir = join(deps.presetsDir, targetId)
      try { await stat(nextDir); return { ok: false, error: '新 id 已存在：' + targetId } } catch { /* 可用 */ }
      try { await rename(dir, nextDir) } catch (e) { return { ok: false, error: '改名失败：' + message(e) } }
    }
    await writeFile(join(deps.presetsDir, targetId, FILENAME), String(content ?? ''), 'utf8')
    return { ok: true, id: targetId, ...(targetId === safeId ? {} : { renamedFrom: safeId }) }
  }

  /**
   * 覆盖写全局 `~/.dsh/AGENTS.md` 前的备份（多代 + `__last-applied__` 维护）。
   * **必须留多代**：只有单个 `__last-applied__` 槽位时，连续写两次就会把用户原始手写内容
   * 永久覆盖掉（第一次备份原始内容 → 第二次备份第一个预设），而「应用」只是点两下按钮。
   * @returns 是否真的备份了（当前文件存在才备份）。
   */
  async function backupGlobal(current: string | null): Promise<boolean> {
    if (current === null) return false
    const backupDir = join(deps.presetsDir, LAST_APPLIED_ID)
    await mkdir(backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await writeFile(join(backupDir, `${FILENAME}.bak-${stamp}`), current, 'utf8')
    await writeFile(join(backupDir, FILENAME), current, 'utf8')
    try {
      const gens = (await readdir(backupDir)).filter((n) => n.startsWith(FILENAME + '.bak-')).sort()
      for (const stale of gens.slice(0, Math.max(0, gens.length - KEEP_GLOBAL_BACKUPS))) {
        await rm(join(backupDir, stale), { force: true })
      }
    } catch { /* 轮转失败不影响本次写入 */ }
    return true
  }

  async function readGlobal(): Promise<string | null> {
    try { return await readFile(await deps.getGlobalAgentsMdPath(), 'utf8') } catch { return null }
  }

  async function apply(id: string): Promise<{ ok: true; id: string; backedUp: boolean } | { ok: false; error: string }> {
    const bad = idError(id)
    if (bad) return { ok: false, error: '非法 id：' + bad }
    const safeId = String(id ?? '').trim()
    let content: string
    try { content = await readFile(join(deps.presetsDir, safeId, FILENAME), 'utf8') }
    catch { return { ok: false, error: '预设不存在：' + safeId } }
    const prev = await readGlobal()
    const backedUp = await backupGlobal(prev)
    await writeFile(await deps.getGlobalAgentsMdPath(), content, 'utf8')
    return { ok: true, id: safeId, backedUp }
  }

  /**
   * 按**原文**写回全局基线（不经过任何预设）。
   * 用途：场景切换的「关掉场景 → 恢复进场景之前的基线」——那份内容可能是用户手写的，
   * 不一定对应任何预设。备份纪律与 `apply` 完全相同。
   */
  async function restore(content: string): Promise<{ ok: true; backedUp: boolean } | { ok: false; error: string }> {
    const text = String(content ?? '')
    const prev = await readGlobal()
    const backedUp = await backupGlobal(prev)
    try {
      await writeFile(await deps.getGlobalAgentsMdPath(), text, 'utf8')
    } catch (e) {
      return { ok: false, error: '写入全局 AGENTS.md 失败：' + message(e) }
    }
    return { ok: true, backedUp }
  }

  async function getCurrent(): Promise<{ ok: true; content: string; presetId: string | null; exists: boolean } | { ok: false; error: string }> {
    try {
      await ensureInit()
      const [globalPath, presetsDir] = await Promise.all([deps.getGlobalAgentsMdPath(), deps.presetsDir])
      let content: string
      try { content = await readFile(globalPath, 'utf8') }
      catch { return { ok: true, content: '', presetId: null, exists: false } }
      const globalHash = createHash('sha256').update(content).digest('hex')
      let presetId: string | null = null
      let entries: import('node:fs').Dirent[] = []
      try { entries = await readdir(presetsDir, { withFileTypes: true }) } catch { /* 库不存在 */ }
      for (const e of entries) {
        if (!e.isDirectory() || !isValidPresetId(e.name) || e.name === LAST_APPLIED_ID) continue
        let c: string
        try { c = await readFile(join(presetsDir, e.name, FILENAME), 'utf8') } catch { continue }
        if (createHash('sha256').update(c).digest('hex') === globalHash) { presetId = e.name; break }
      }
      return { ok: true, content, presetId, exists: true }
    } catch (e) {
      return { ok: false, error: message(e) }
    }
  }

  async function remove(id: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const safeId = String(id ?? '').trim()
    if (safeId === LAST_APPLIED_ID) return { ok: false, error: '备份槽不可删除' }
    const bad = idError(safeId)
    if (bad) return { ok: false, error: '非法 id：' + bad }
    const dir = join(deps.presetsDir, safeId)
    try { await stat(dir) } catch { return { ok: false, error: '预设不存在：' + safeId } }
    await rm(dir, { recursive: true, force: true })
    return { ok: true, id: safeId }
  }

  // 从外部文本内容（如导入的 .md 文件）建预设：id 校验 + 重复检查 + 写 AGENTS.md。
  async function importPreset(id: string, content: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const bad = idError(id)
    if (bad) return { ok: false, error: '非法 id：' + bad }
    const safeId = String(id ?? '').trim()
    const dir = join(deps.presetsDir, safeId)
    try { await stat(dir); return { ok: false, error: 'id 已存在：' + safeId } } catch { /* 不存在，继续 */ }
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, FILENAME), String(content ?? ''), 'utf8')
    return { ok: true, id: safeId }
  }

  return { list, read, create, update, apply, restore, getCurrent, remove, importPreset }
}
