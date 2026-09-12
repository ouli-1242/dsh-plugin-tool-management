// dsh-plugin-tool-management —— 场景（Scenes）服务。
//
// 场景 = 把一个 agent preset 与一组可见规则分组绑定（scenes.json）。绑定只影响
// 规则的**按需层投影**（provider 按会话 agentPreset 过滤），绝不修改 preset 本身
// （D7：绝不编辑 agent.cordis.yml）。
//
// scenes.json（$DSH_HOME/tool-management/scenes.json）：
//   { version, includeSharedDefault, presets: { <presetId>: { groups: [], note } } }
// 解析规则（与 rules/service.ts 的 readScenes 一致）：
//   命中 → 可见分组 = groups ∪（includeSharedDefault 时 _shared）；未命中 → ["_shared"]。
//
// 本服务同时协调 presets 服务（create/remove 时同步 preset 目录）与插件 settings
// sidecar（setDefault 落点，DSH 官方写入机制待 spike 验证，见 PLAN-v0.2 附录 B S2）。

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveDshHome } from '../skills/core.js'
import type { PresetInfo, PresetsService } from '../presets/service.js'

export interface SceneRow {
  presetId: string
  label: string
  groups: string[]
  note: string
  isDefault: boolean
}

export interface ScenesDeps {
  /** 侧车目录（scenes.json 所在；空串/未提供时按 $DSH_HOME/tool-management 解析）。 */
  stateDir: string
  /** preset 管理服务（roster / create / remove）。 */
  presets: PresetsService
  /** 读取当前"默认 preset"（settings sidecar 的 defaultAgentPreset）。 */
  readDefault: () => Promise<string>
  /** 写入"默认 preset"（settings sidecar）。 */
  writeDefault: (id: string) => Promise<void>
  /** 规则服务句柄（用于 scene-create/remove 后失效 provider 缓存）。 */
  invalidateRules?: () => void
  /** 全部规则分组（供场景勾选可见分组）：返回 [{ key, label, count }]。 */
  listRuleGroups: () => Promise<Array<{ key: string; label: string; count?: number }>>
}

export interface ScenesService {
  ops: Record<string, (args: any) => Promise<any>>
}

interface ScenesFile {
  version: number
  includeSharedDefault: boolean
  presets: Record<string, { groups: string[]; note?: string }>
}

const SCENES_VERSION = 1
const message = (e: unknown): string => String((e && (e as Error).message) || e)
const fail = (code: string, error: string): { ok: false; error: string; code: string } => ({ ok: false, error, code })

const defaultScenes = (): ScenesFile => ({ version: SCENES_VERSION, includeSharedDefault: true, presets: {} })

async function readScenesFile(stateDir: string): Promise<ScenesFile> {
  try {
    const raw = await readFile(join(stateDir, 'scenes.json'), 'utf8')
    const parsed = JSON.parse(raw) as Partial<ScenesFile>
    if (!parsed || parsed.version !== SCENES_VERSION || typeof parsed.presets !== 'object' || parsed.presets === null) {
      throw new Error('bad scenes')
    }
    return {
      version: SCENES_VERSION,
      includeSharedDefault: parsed.includeSharedDefault !== false,
      presets: parsed.presets as ScenesFile['presets'],
    }
  } catch {
    return defaultScenes()
  }
}

/** 同目录临时文件 + rename 原子写。 */
async function writeFileAtomically(path: string, content: string): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.dsh-scenes-${randomUUID()}.tmp`)
  try {
    await writeFile(temp, content, 'utf8')
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

export function createScenesService(_ctx: any, deps: ScenesDeps): ScenesService {
  const stateDir =
    deps.stateDir && deps.stateDir.trim() !== '' ? deps.stateDir : join(resolveDshHome(), 'tool-management')

  // 写操作串行队列（避免并发覆盖 scenes.json）。
  let mutationQueue: Promise<unknown> = Promise.resolve()
  const enqueueMutation = <T>(task: () => Promise<T>): Promise<T> => {
    const queued = mutationQueue.then(task, task)
    mutationQueue = queued.catch(() => undefined)
    return queued
  }

  async function writeScenes(scenes: ScenesFile): Promise<void> {
    await mkdir(stateDir, { recursive: true })
    // force 重读后合并，避免覆盖用户手工编辑（与 index.ts sidecar 语义一致）。
    await writeFileAtomically(join(stateDir, 'scenes.json'), JSON.stringify(scenes, null, 2))
  }

  async function sceneList(_args: any): Promise<any> {
    const [scenes, presets, def, ruleGroups] = await Promise.all([
      readScenesFile(stateDir),
      deps.presets.list(),
      deps.readDefault(),
      deps.listRuleGroups().catch(() => []),
    ])
    const rows: SceneRow[] = presets.map((p: PresetInfo) => {
      const rec = scenes.presets[p.id]
      return {
        presetId: p.id,
        label: p.name || p.id,
        groups: rec ? rec.groups || [] : [],
        note: (rec && rec.note) || '',
        isDefault: def === p.id,
      }
    })
    return { ok: true, scenes: rows, presets, ruleGroups }
  }

  async function sceneSetGroups(args: any): Promise<any> {
    const presetId = String((args && args.presetId) || '').trim()
    if (!presetId) return fail('error.rules.notFound', '缺少 presetId。')
    if (!(await deps.presets.get(presetId))) return fail('error.rules.notFound', 'preset「' + presetId + '」不存在。')
    const groups = Array.isArray(args && args.groups) ? args.groups.map((g: any) => String(g).trim()).filter(Boolean) : []
    // 分组合法性：_shared 与 kebab 段可接受；其余交给 rules 服务校验（列表已过滤）。
    for (const g of groups) {
      if (g === '_shared') continue
      if (!/^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/.test(g) || g.length > 64) {
        return fail('error.rules.invalidGroup', '分组名「' + g + '」非法（小写字母、数字、连字符）。')
      }
    }
    return enqueueMutation(async () => {
      const scenes = await readScenesFile(stateDir)
      scenes.presets[presetId] = Object.assign({}, scenes.presets[presetId], { groups })
      await writeScenes(scenes)
      if (deps.invalidateRules) deps.invalidateRules()
      const rec = scenes.presets[presetId]
      return { ok: true, scene: { presetId, groups: rec.groups || [], note: rec.note || '' } }
    })
  }

  async function sceneCreate(args: any): Promise<any> {
    const id = String((args && args.id) || '').trim()
    const from = String((args && args.from) || '').trim() || 'standard'
    const name = String((args && args.name) || '').trim() || id
    const description = String((args && args.description) || '').trim() || undefined
    const created = await deps.presets.create({ from, id, name, description })
    if (!created.ok) return created
    return enqueueMutation(async () => {
      const scenes = await readScenesFile(stateDir)
      scenes.presets[id] = scenes.presets[id] || { groups: [] }
      await writeScenes(scenes)
      return { ok: true, preset: created.preset }
    })
  }

  async function sceneRemove(args: any): Promise<any> {
    const id = String((args && args.id) || '').trim()
    if (!id) return fail('error.rules.notFound', '缺少 id。')
    const removed = await deps.presets.remove(id)
    if (!removed.ok) return removed
    return enqueueMutation(async () => {
      const scenes = await readScenesFile(stateDir)
      if (scenes.presets[id]) {
        delete scenes.presets[id]
        await writeScenes(scenes)
      }
      if (deps.invalidateRules) deps.invalidateRules()
      return { ok: true }
    })
  }

  async function sceneSetDefault(args: any): Promise<any> {
    const id = String((args && args.id) || '').trim()
    if (!id) return fail('error.rules.notFound', '缺少 id。')
    if (!(await deps.presets.get(id))) return fail('error.rules.notFound', 'preset「' + id + '」不存在。')
    try {
      await deps.writeDefault(id)
    } catch (e) {
      return fail('error.rules.writeFailed', '默认 preset 保存失败: ' + message(e))
    }
    return { ok: true, default: id }
  }

  const ops: Record<string, (args: any) => Promise<any>> = {
    'scene-list': sceneList,
    'scene-set-groups': sceneSetGroups,
    'scene-create': sceneCreate,
    'scene-remove': sceneRemove,
    'scene-set-default': sceneSetDefault,
  }
  return { ops }
}
