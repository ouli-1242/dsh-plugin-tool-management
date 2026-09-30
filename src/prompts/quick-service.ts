// dsh-plugin-tool-management —— 快捷提示词库（hub/quick-prompts/）。
//
// 与「全局提示词预设」（`./service.ts`）是**两件事**，别混着看：
//   预设 = 一份会覆盖写 `~/.dsh/AGENTS.md` 的指令基线，进上下文、被场景绑定、模型能在之间挑；
//   快捷 = 用户存好的一段现成文字，只由**用户自己**在对话框 `/` 菜单里点出来贴进草稿。
//
// 所以它**不注入上下文、不进场景**，实现上靠"另起一份存储"来保证：预设服务的
// `list()` 只扫 `hub/prompts/` 下的合法目录，注入取的是场景绑定的那份正文，模型工具
// `prompt_manager_list` 复用的又是 `agentsmd-list` —— 四条路径各自只认 `hub/prompts/`，
// 快捷词放在隔壁目录里就天然进不去。**不要**为了少一个目录把它塞进 prompts/ 加个标记位：
// 那等于让四条路径各自学会过滤，漏一条就是"快捷词被当成基线注入"。
// 条目那颗开关（`enabled`）只管"在不在对话框 `/` 菜单里出现"，同样不碰上面四条路径。
//
// `list()` 连**正文一起给**，不是偷懒省一次请求：宿主的 `settle()` 拿到 onPick 的返回值后
// **同步**执行插入（input-trigger client.js），异步读正文来不及 —— 点的时候手里就得有那段字。
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isValidPresetId, normalizePresetId } from './preset-id.js'
import { listTrashEntries, moveOutOfTrash, moveToTrash, purgeTrashEntry, readTrashEntry, type TrashEntry } from '../hub.js'

/** 快捷提示词正文的文件名。与预设的 `AGENTS.md` 刻意不同名：这两个库不该被互换过。 */
const FILENAME = 'PROMPT.md'
/** 侧车（说明 + 启停），与正文同目录：正文本身一个字都不该被这些元信息污染。 */
const META_FILE = 'meta.json'

export interface QuickPromptsDeps {
  /** 快捷提示词库根目录（已解析的绝对路径，`hub/quick-prompts`）。 */
  dir: string
}

export interface QuickPromptRow {
  id: string
  description: string
  content: string
  /** 是否在对话框 `/` 菜单里出现。缺侧车字段 = 开（见 `readMeta`）。 */
  enabled: boolean
}

export interface QuickPromptsService {
  list(): Promise<{ ok: true; prompts: QuickPromptRow[] } | { ok: false; error: string }>
  create(id: string, content: string, description?: string): Promise<{ ok: true; id: string } | { ok: false; error: string }>
  /** 保存：正文必写；`nextId` 与 `id` 不同 = 改名（目录改名）。 */
  update(id: string, content: string, nextId?: string, description?: string): Promise<{ ok: true; id: string; renamedFrom?: string } | { ok: false; error: string }>
  /** 只改「在不在 `/` 菜单里出现」，正文与说明一个字都不动。 */
  setEnabled(id: string, enabled: boolean): Promise<{ ok: true; id: string; enabled: boolean } | { ok: false; error: string }>
  remove(id: string): Promise<{ ok: true; id: string } | { ok: false; error: string }>
  trashList(): Promise<{ ok: true; trash: TrashEntry[] }>
  trashRestore(id: string): Promise<{ ok: true; id: string } | { ok: false; error: string }>
  trashDelete(id: string): Promise<{ ok: true; id: string } | { ok: false; error: string }>
}

export function createQuickPromptsService(deps: QuickPromptsDeps): QuickPromptsService {
  const message = (e: unknown): string => String((e && (e as Error).message) || e)
  const idError = (raw: unknown): string | null => {
    const result = normalizePresetId(raw)
    return result.ok ? null : result.error
  }

  /** 侧车读回来的形状：缺字段一律按"没动过"解释（说明为空、开关为开）。 */
  async function readMeta(id: string): Promise<{ description: string; enabled: boolean }> {
    try {
      const parsed = JSON.parse(await readFile(join(deps.dir, id, META_FILE), 'utf8')) as { description?: unknown; enabled?: unknown }
      return {
        description: typeof parsed.description === 'string' ? parsed.description : '',
        // 只有明确写着 false 才算关：这颗开关之前的老库根本没有这个字段，默认必须是"照常在 / 里出现"。
        enabled: parsed.enabled !== false,
      }
    } catch {
      return { description: '', enabled: true }
    }
  }

  /**
   * 侧车写：`undefined` = 那一项不动（空串 / `true` 才是明确回到默认）。
   * 两项都回到默认时连文件一起删 —— 不留空壳（原来"说明清空就删侧车"那条纪律照旧）。
   */
  async function writeMeta(id: string, patch: { description?: string; enabled?: boolean }): Promise<void> {
    const cur = await readMeta(id)
    const description = patch.description === undefined ? cur.description : String(patch.description).trim()
    const enabled = patch.enabled === undefined ? cur.enabled : patch.enabled === true
    const body: Record<string, unknown> = {}
    if (description !== '') body.description = description
    if (enabled !== true) body.enabled = false
    const file = join(deps.dir, id, META_FILE)
    try {
      if (!Object.keys(body).length) { await rm(file, { force: true }); return }
      await writeFile(file, JSON.stringify(body, null, 2) + '\n', 'utf8')
    } catch { /* 元信息写不进去不该让保存失败：正文才是本体 */ }
  }

  async function list(): Promise<{ ok: true; prompts: QuickPromptRow[] } | { ok: false; error: string }> {
    try {
      let entries: import('node:fs').Dirent[] = []
      try { entries = await readdir(deps.dir, { withFileTypes: true }) } catch { /* 库还没建过 = 空 */ }
      const ids = entries.filter((e) => e.isDirectory() && isValidPresetId(e.name)).map((e) => e.name)
      const prompts = await Promise.all(ids.map(async (id) => {
        const meta = await readMeta(id)
        return {
          id,
          description: meta.description,
          enabled: meta.enabled,
          // 读不到的那条（正文被外部删了）给空串：界面上仍然列出来，用户能看见"它在但没内容"，
          // 而不是凭空少一条却查不出为什么。
          content: await readFile(join(deps.dir, id, FILENAME), 'utf8').catch(() => ''),
        }
      }))
      prompts.sort((a, b) => a.id.localeCompare(b.id))
      return { ok: true, prompts }
    } catch (e) {
      return { ok: false, error: message(e) }
    }
  }

  async function create(id: string, content: string, description?: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const bad = idError(id)
    if (bad) return { ok: false, error: '非法 id：' + bad }
    const safeId = String(id ?? '').trim()
    const dir = join(deps.dir, safeId)
    try { await stat(dir); return { ok: false, error: 'id 已存在：' + safeId } } catch { /* 不存在，继续 */ }
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, FILENAME), String(content ?? ''), 'utf8')
    await writeMeta(safeId, { description })
    return { ok: true, id: safeId }
  }

  async function update(id: string, content: string, nextId?: string, description?: string): Promise<{ ok: true; id: string; renamedFrom?: string } | { ok: false; error: string }> {
    const bad = idError(id)
    if (bad) return { ok: false, error: '非法 id：' + bad }
    const safeId = String(id ?? '').trim()
    try { await stat(join(deps.dir, safeId)) } catch { return { ok: false, error: '快捷提示词不存在：' + safeId } }
    let targetId = safeId
    if (nextId !== undefined && String(nextId).trim() !== safeId) {
      const badNext = idError(nextId)
      if (badNext) return { ok: false, error: '非法新 id：' + badNext }
      targetId = String(nextId).trim()
      try { await stat(join(deps.dir, targetId)); return { ok: false, error: '新 id 已存在：' + targetId } } catch { /* 可用 */ }
      try { await rename(join(deps.dir, safeId), join(deps.dir, targetId)) } catch (e) { return { ok: false, error: '改名失败：' + message(e) } }
    }
    await writeFile(join(deps.dir, targetId, FILENAME), String(content ?? ''), 'utf8')
    await writeMeta(targetId, { description })
    return { ok: true, id: targetId, ...(targetId === safeId ? {} : { renamedFrom: safeId }) }
  }

  /**
   * 启停：只写侧车那一个字段，正文与说明一律不动。
   * 目录不存在时照实拒绝 —— 静默"成功"会在界面上留下一颗凭空出现的开关。
   */
  async function setEnabled(id: string, enabled: boolean): Promise<{ ok: true; id: string; enabled: boolean } | { ok: false; error: string }> {
    const safeId = String(id ?? '').trim()
    const bad = idError(safeId)
    if (bad) return { ok: false, error: '非法 id：' + bad }
    try { await stat(join(deps.dir, safeId)) } catch { return { ok: false, error: '快捷提示词不存在：' + safeId } }
    await writeMeta(safeId, { enabled })
    return { ok: true, id: safeId, enabled }
  }

  /** 删除 = 整个目录进回收站（与预设同一条纪律：不静默删用户写的东西）。 */
  async function remove(id: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const safeId = String(id ?? '').trim()
    const bad = idError(safeId)
    if (bad) return { ok: false, error: '非法 id：' + bad }
    const dir = join(deps.dir, safeId)
    try { await stat(dir) } catch { return { ok: false, error: '快捷提示词不存在：' + safeId } }
    const moved = await moveToTrash('quick-prompts', safeId, [{ from: dir, dest: 'prompt' }])
    if (moved.ok === false) return { ok: false, error: '移入回收站失败：' + moved.error }
    return { ok: true, id: safeId }
  }

  async function trashList(): Promise<{ ok: true; trash: TrashEntry[] }> {
    return { ok: true, trash: await listTrashEntries('quick-prompts') }
  }

  async function trashRestore(id: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const entry = await readTrashEntry('quick-prompts', String(id ?? '').trim())
    if (!entry) return { ok: false, error: '回收站条目不存在：' + String(id ?? '').trim() }
    const bad = idError(entry.name)
    if (bad) return { ok: false, error: '回收站里的 id 不合法：' + bad }
    const target = join(deps.dir, entry.name)
    try { await stat(target); return { ok: false, error: '无法恢复，同 id 已存在：' + entry.name } } catch { /* 可用 */ }
    try {
      await mkdir(deps.dir, { recursive: true })
      await moveOutOfTrash('quick-prompts', entry.id, 'prompt', target)
    } catch (e) {
      return { ok: false, error: '恢复失败：' + message(e) }
    }
    await purgeTrashEntry('quick-prompts', entry.id)
    return { ok: true, id: entry.name }
  }

  async function trashDelete(id: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const clean = String(id ?? '').trim()
    if (!(await purgeTrashEntry('quick-prompts', clean))) return { ok: false, error: '回收站条目不存在：' + clean }
    return { ok: true, id: clean }
  }

  return { list, create, update, setEnabled, remove, trashList, trashRestore, trashDelete }
}
