// dsh-plugin-tool-management —— Agent Preset（场景来源）服务。
//
// 场景（scene）以 DSH 的 agent preset 为标识。本服务负责 preset 的磁盘目录管理：
//   - roster：扫 $DSH_HOME/.agent-presets/ 列出 user preset，并合并内置系统 preset。
//   - create：整目录复制（user preset 的唯一入口；D7：绝不编辑 agent.cordis.yml）。
//   - remove：仅 user 根可删；系统 preset 拒绝（error.scenes.systemPreset）。
//   - setDefault：默认值记录在插件 settings sidecar（DSH 官方写入机制待 spike 验证，
//     见 PLAN-v0.2 附录 B S2；UI 提示在会话创建界面手动选择亦生效）。
//
// 目录约定（DSH 官方）：$DSH_HOME/.agent-presets/<id>/ 内含 agent.cordis.yml
// （preset 的 loader patch 组装定义）。本服务只读该文件做健康检查与元数据展示，
// 绝不改写；系统 preset 没有磁盘目录，create 时生成空壳供用户手动填充。

import { mkdir, readFile, readdir, rm, cp, writeFile, lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { KEBAB_RE, resolveDshHome } from '../skills/core.js'

export interface PresetInfo {
  id: string
  name: string
  description?: string
  order?: number
  trust: 'user' | 'system'
  path: string
  healthy: boolean
  reason?: string
}

export interface PresetsDeps {
  /** preset 根目录（绝对路径；空串/未提供时按 $DSH_HOME/.agent-presets 解析）。 */
  presetsRoot: string
}

export interface PresetsService {
  list: () => Promise<PresetInfo[]>
  get: (id: string) => Promise<PresetInfo | null>
  create: (args: { from: string; id: string; name?: string; description?: string }) => Promise<
    { ok: true; preset: PresetInfo } | { ok: false; error: string; code: string }
  >
  remove: (id: string) => Promise<{ ok: true } | { ok: false; error: string; code: string }>
  isSystem: (id: string) => boolean
}

const message = (e: unknown): string => String((e && (e as Error).message) || e)
const fail = (code: string, error: string): { ok: false; error: string; code: string } => ({ ok: false, error, code })
const PRESET_ID_RE = KEBAB_RE

/** 内置系统 preset（只读；无磁盘目录，path 为空串）。 */
const SYSTEM_PRESETS: PresetInfo[] = [
  {
    id: 'standard',
    name: '标准（standard）',
    description: 'DSH 内置标准 preset：通用对话与工具组装',
    order: 0,
    trust: 'system',
    path: '',
    healthy: true,
  },
]

/** 从系统 preset 新建时生成的最小 agent.cordis.yml 占位（DSH 各版本结构可能不同）。 */
const SYSTEM_PRESET_TEMPLATE = (id: string, name: string): string =>
  [
    '# agent preset: ' + id,
    '# 由 dsh-plugin-tool-management 从系统 preset 复制生成。',
    '# 注意：DSH 各版本 preset 的 agent.cordis.yml 结构可能不同，请按需编辑以定义本 preset 的组装。',
    '',
    '# name: ' + name,
  ].join('\n')

export function createPresetsService(_ctx: any, deps: PresetsDeps): PresetsService {
  const presetsRoot =
    deps.presetsRoot && deps.presetsRoot.trim() !== '' ? resolve(deps.presetsRoot) : join(resolveDshHome(), '.agent-presets')

  const isSystem = (id: string): boolean => SYSTEM_PRESETS.some((p) => p.id === id)

  /** 读单个 user preset 的健康与元数据；目录缺失返回 null。 */
  async function readUserPreset(id: string): Promise<PresetInfo | null> {
    if (!id || !PRESET_ID_RE.test(id)) return null
    const dir = join(presetsRoot, id)
    const doc = join(dir, 'agent.cordis.yml')
    let docText = ''
    try {
      docText = await readFile(doc, 'utf8')
    } catch {
      try {
        await readdir(dir)
        return { id, name: id, trust: 'user', path: dir, healthy: false, reason: '缺少 agent.cordis.yml' }
      } catch {
        return null
      }
    }
    const name = (docText.match(/^name\s*:\s*(.+)$/m) || [])[1]?.trim?.() || id
    const desc = (docText.match(/^description\s*:\s*(.+)$/m) || [])[1]?.trim?.()
    return {
      id,
      name,
      ...(desc ? { description: desc } : {}),
      trust: 'user',
      path: dir,
      healthy: true,
    }
  }

  async function list(): Promise<PresetInfo[]> {
    const out: PresetInfo[] = []
    let dirs: string[] = []
    try {
      dirs = await readdir(presetsRoot)
    } catch {
      /* presetsRoot 不存在 → 仅系统 preset */
    }
    for (const d of dirs) {
      if (d.startsWith('.')) continue
      const p = await readUserPreset(d)
      if (p) out.push(p)
    }
    out.sort((a, b) => (a.order || 1000) - (b.order || 1000) || a.id.localeCompare(b.id))
    return [...SYSTEM_PRESETS, ...out]
  }

  async function get(id: string): Promise<PresetInfo | null> {
    if (isSystem(id)) return SYSTEM_PRESETS.find((p) => p.id === id) || null
    return readUserPreset(id)
  }

  async function create(args: { from: string; id: string; name?: string; description?: string }): Promise<
    { ok: true; preset: PresetInfo } | { ok: false; error: string; code: string }
  > {
    const id = String(args && args.id ? args.id : '').trim()
    const from = String(args && args.from ? args.from : '').trim() || 'standard'
    if (!PRESET_ID_RE.test(id)) return fail('error.rules.invalidName', 'preset id 需为 kebab-case（小写字母、数字、连字符）。')
    if (await get(id)) return fail('error.scenes.duplicate', 'preset「' + id + '」已存在。')
    const src = await get(from)
    if (!src) return fail('error.rules.notFound', '来源 preset「' + from + '」不存在。')

    const dir = join(presetsRoot, id)
    try {
      await mkdir(dir, { recursive: true })
      if (src.trust === 'user' && src.path) {
        // 整目录复制：原样拷贝（含附件），绝不改写任何 agent.cordis.yml。
        await cp(src.path, dir, { recursive: true, force: false })
      } else {
        // 系统 preset 无目录 → 生成占位，标记待配置（healthy:false 由缺 agent.cordis.yml 派生）。
        const name = String((args && args.name) || id).trim()
        await writeFile(join(dir, 'agent.cordis.yml'), SYSTEM_PRESET_TEMPLATE(id, name), 'utf8')
      }
    } catch (e) {
      return fail('error.rules.writeFailed', 'preset 创建失败: ' + message(e))
    }
    const preset = await readUserPreset(id)
    return { ok: true, preset: preset || { id, name: id, trust: 'user', path: dir, healthy: true } }
  }

  async function remove(id: string): Promise<{ ok: true } | { ok: false; error: string; code: string }> {
    id = String(id || '').trim()
    if (isSystem(id)) {
      return fail('error.scenes.systemPreset', '系统 preset「' + id + '」为只读，不能删除；可「复制为自定义场景」后编辑。')
    }
    const dir = join(presetsRoot, id)
    try {
      await lstat(dir)
    } catch {
      return fail('error.rules.notFound', 'preset「' + id + '」不存在。')
    }
    try {
      await rm(dir, { recursive: true, force: true })
    } catch (e) {
      return fail('error.rules.removeFailed', 'preset 删除失败: ' + message(e))
    }
    return { ok: true }
  }

  return { list, get, create, remove, isSystem }
}
