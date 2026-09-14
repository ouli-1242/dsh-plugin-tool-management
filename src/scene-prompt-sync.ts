// dsh-plugin-tool-management —— 场景绑定提示词 ⇄ 全局基线（`~/.dsh/AGENTS.md`）同步。
//
// 用户裁定（2026-09-15）：「切换场景，对应的提示词直接把 AGENTS.md 直接修改」。
// 因此场景绑定的提示词不再作为 systemPrompt 段注入，而是**真写全局基线文件**，
// 与「提示词」页的「应用」走同一条路（覆盖前多代备份到 `agents-md/__last-applied__/`）。
//
// 四个动作会触发同步（调用方在 op 层包一层 `withSync`）：
//   ① 启用/切换场景    ② 关掉场景（恢复进场景前的基线）
//   ③ 改场景绑定的预设  ④ 编辑"正在驱动基线的那份预设"的正文
//
// 「进场景前的基线」快照存在 hub 的 `scene-baseline.json`：进场景时记下当时的
// AGENTS.md 正文（以及当时匹配到的预设 id），关掉场景时**按原文**写回 ——
// 那份内容可能是用户手写的，不一定对应任何预设。恢复后把快照清空，避免之后再关一次
// 场景时复活旧基线。
//
// 幂等与如实：文件已经是那份（`duplicate`）时不写盘；没有场景驱动、也没有快照时什么都不做；
// 写失败**不改**原操作的成功结论，而是把原因放进 `error` 交给界面显示成警告。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 场景侧提示词的只读投影（由 rules 服务的 `rules-list` 提供）。 */
export interface ScenePromptState {
  scene: string | null
  presetId: string | null
  /** 绑了预设但文件不存在/为空。 */
  missing: boolean
  /** 文件内容已经是这份预设（无需写盘）。 */
  duplicate: boolean
}

export interface SyncResult {
  /** 刚写进 AGENTS.md 的预设 id。 */
  applied?: string
  /** 刚把进场景前的基线恢复回去了。 */
  restored?: boolean
  /** 不需要动文件（已同步 / 无场景驱动且无快照）。 */
  unchanged?: boolean
  /** 写盘失败的原因（原操作本身仍算成功）。 */
  error?: string
}

export interface ScenePromptSyncDeps {
  agentsMd: {
    apply(id: string): Promise<{ ok: true; id: string; backedUp: boolean } | { ok: false; error: string }>
    restore(content: string): Promise<{ ok: true; backedUp: boolean } | { ok: false; error: string }>
    getCurrent(): Promise<{ ok: true; content: string; presetId: string | null; exists: boolean } | { ok: false; error: string }>
  }
  rules: { ops: Record<string, (args: any) => Promise<any>> }
  /** 基线快照文件（hub 内绝对路径）。 */
  baselineFile: string
  logger?: { warn?: (message: string) => void }
}

interface SceneBaseline {
  v: number
  at: number
  presetId: string | null
  content: string | null
}

export interface ScenePromptSync {
  /** 按当前场景状态同步全局基线；幂等。 */
  sync(): Promise<SyncResult>
  /** 把同步结果并进 op 响应（原操作失败时原样透传）。 */
  withSync<T>(res: T): Promise<T & { agentsMd?: SyncResult }>
  /** 读取当前场景侧状态（探测失败返回 null）。 */
  state(): Promise<ScenePromptState | null>
}

export function createScenePromptSync(deps: ScenePromptSyncDeps): ScenePromptSync {
  const warn = (message: string): void => { try { deps.logger?.warn?.(message) } catch { /* ignore */ } }

  async function readBaseline(): Promise<SceneBaseline | null> {
    try {
      const raw = await readFile(deps.baselineFile, 'utf8')
      const obj = JSON.parse(raw) as Partial<SceneBaseline>
      if (!obj || typeof obj !== 'object') return null
      return {
        v: 1,
        at: Number.isFinite(obj.at) ? Number(obj.at) : 0,
        presetId: typeof obj.presetId === 'string' ? obj.presetId : null,
        content: typeof obj.content === 'string' ? obj.content : null,
      }
    } catch { return null }
  }

  async function writeBaseline(next: SceneBaseline): Promise<void> {
    try {
      await mkdir(dirname(deps.baselineFile), { recursive: true })
      await writeFile(deps.baselineFile, JSON.stringify(next), 'utf8')
    } catch (e) { warn(`scene-prompt: could not persist baseline: ${String(e)}`) }
  }

  async function state(): Promise<ScenePromptState | null> {
    try {
      const r: any = await deps.rules.ops['rules-list']({})
      const sp = r && r.ok ? r.scenePrompt : null
      if (!sp) return null
      return {
        scene: sp.scene ? String(sp.scene) : null,
        presetId: sp.presetId ? String(sp.presetId) : null,
        missing: sp.missing === true,
        duplicate: sp.duplicate === true,
      }
    } catch (e) {
      warn(`scene-prompt: probe failed: ${String(e)}`)
      return null
    }
  }

  async function sync(): Promise<SyncResult> {
    const current = await state()
    if (!current) return { unchanged: true }
    const driving = current.scene !== null && !current.missing && current.presetId !== null
    if (driving) {
      if (current.duplicate) return { applied: current.presetId as string, unchanged: true }
      // 进场景的第一笔写入之前，先记下当时的基线（已有快照就不覆盖：连续切场景时
      // 基线始终是"进场景之前"那一份）。
      const baseline = await readBaseline()
      if (!baseline || baseline.content === null) {
        const cur: any = await deps.agentsMd.getCurrent()
        await writeBaseline({
          v: 1,
          at: Date.now(),
          presetId: cur && cur.ok && cur.presetId ? String(cur.presetId) : null,
          content: cur && cur.ok && cur.exists ? String(cur.content) : null,
        })
      }
      const res: any = await deps.agentsMd.apply(current.presetId as string)
      if (res && res.ok === false) return { error: String(res.error || '写入 AGENTS.md 失败') }
      return { applied: current.presetId as string }
    }
    // 没有场景驱动 → 如果刚从驱动态退出，把进场景前的基线写回去。
    const baseline = await readBaseline()
    if (!baseline || baseline.content === null) return { unchanged: true }
    const res: any = await deps.agentsMd.restore(baseline.content)
    if (res && res.ok === false) return { error: String(res.error || '恢复 AGENTS.md 失败') }
    await writeBaseline({ v: 1, at: Date.now(), presetId: null, content: null })
    return { restored: true }
  }

  async function withSync<T>(res: T): Promise<T & { agentsMd?: SyncResult }> {
    const anyRes = res as unknown as { ok?: boolean } | null
    if (!anyRes || anyRes.ok === false) return res as T & { agentsMd?: SyncResult }
    const agentsMd = await sync()
    return { ...(res as object), agentsMd } as T & { agentsMd?: SyncResult }
  }

  return { sync, withSync, state }
}
