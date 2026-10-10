// dsh-plugin-tool-management —— 场景绑定提示词 ⇄ 全局基线（`~/.dsh/AGENTS.md`）同步。
//
// 用户裁定（2026-09-15）：「切换场景，对应的提示词直接把 AGENTS.md 直接修改」。
// 因此场景绑定的提示词不再作为提示词段/注入发送，而是**真写全局基线文件**，
// 与「提示词」页的「应用」走同一条路（覆盖前多代备份到 `prompts/__last-applied__/`）。
// 例外（2026-09-16）：预设**挂不到**官方 `dsh-agent-instructions` 行时（极简），文件没人读，
// 注入通道会拿同一份正文兜底送达（rules 服务的 `promptText()`）。
//
// 六个动作会触发同步（调用方在 op 层包一层 `withSync`）：
//   ① 启用/切换场景    ② 关掉场景（恢复进场景前的基线）
//   ③ 改场景绑定的预设  ④ 编辑"正在驱动基线的那份预设"的正文
//   ⑤ 从回收站恢复预设（绑定重新变活）  ⑥ 应用提示词（**应用别的份 = 换掉当前场景的绑定**，
//      改完绑定再走一次同步；见 index.ts 的 `applyPresetGuarded`）
//
// 「进场景前的基线」快照存在 hub 的 `scene-baseline.json`：进场景时记下当时的
// AGENTS.md 正文（以及当时匹配到的预设 id），关掉场景时**按原文**写回 ——
// 那份内容可能是用户手写的，不一定对应任何预设。恢复后把快照清空，避免之后再关一次
// 场景时复活旧基线。
//
// 幂等与如实：文件已经是那份（`duplicate`）时不写盘；没有场景驱动、也没有快照时什么都不做；
// 写失败**不改**原操作的成功结论，而是把原因放进 `error` 交给界面显示成警告。
//
// 这里同时是**三条状态的事实源**（用户实测反馈「显示 A、实际注入 B、A 还能删 B 不能删」后加的）：
//   `driver()`     —— 谁在驱动基线（提示词页「应用」据此判断：应用别的份 = 换掉该场景的绑定）；
//   `refs()`       —— 每个预设被谁引用（删除保护的唯一依据：场景绑定 / 基线当前内容 / 退出恢复目标）；
//   `baseline()`   —— 进场景前的基线快照（退出场景后要恢复的那一份）。
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
// 基线快照走原子写（temp + rename）：它是「退出场景时恢复 AGENTS.md」的**唯一依据**，
// 裸写中断留下半截 JSON 会让 `readBaseline` 解析失败（审查 P2-16）。
import { writeFileAtomically } from './memories/index-io.js'

/** 场景侧提示词的只读投影（由 rules 服务的 `rules-list` 提供）。 */
export interface ScenePromptState {
  scene: string | null
  presetId: string | null
  /** 场景显示名（`global` → 「全局」）；用于给用户指路「去哪个场景改绑定」。 */
  label: string
  /** 绑了预设但文件不存在/为空。 */
  missing: boolean
  /** 文件内容已经是这份预设（无需写盘）。 */
  duplicate: boolean
}

/** 正在驱动全局基线的场景（提示词基线由它绑定的预设接管）。 */
export interface ScenePromptDriver {
  scene: string
  /** 场景显示名（索引 label；`global` → 「全局」）。 */
  label: string
  presetId: string
}

/**
 * 一条「谁在引用这个提示词预设」的记录（删除保护与界面标记共用）。
 *   - `scene`   场景绑定（含恒常的 `_shared` / `global`；`active` = 该场景当前启用）
 *   - `file`    `~/.dsh/AGENTS.md` 的**当前内容**就是它（实际被注入的那一份）；
 *               `applied` 另标「是由「应用」写进去的」还是「内容碰巧相同」（播种出来的副本）
 *   - `restore` 进场景前保存的基线 = 退出场景后要恢复的那一份
 */
export type PresetRef =
  | { kind: 'scene'; scene: string; label: string; active: boolean }
  /**
   * `~/.dsh/AGENTS.md` 的当前内容就是它。
   *
   * `applied` = 这份内容**是由「应用」写进去的**（`__applied__.json` 指向它），而不是
   * "内容碰巧相同"。两者在首次打开提示词页时自动播种出来的 `default` 上分道扬镳：它内容与
   * AGENTS.md 相同、界面上也标「文件里是它」，却从未发生过写入。
   *
   * 删除保护要的是 `applied`（用户主动做过这个选择，所以拦住并要求先取消应用）；
   * 播种态那份副本必须放行 —— 拦它没有任何出路（取消应用也关不掉），就是死路
   * （2026-10-10 用户反馈「当前应用的提示词应该不能删除」，同一次改动里把这条边界钉住）。
   */
  | { kind: 'file'; applied?: boolean }
  | { kind: 'restore' }

export interface SyncResult {
  /** 刚写进 AGENTS.md 的预设 id。 */
  applied?: string
  /** 刚把进场景前的基线恢复回去了。 */
  restored?: boolean
  /** 不需要动文件（已同步 / 无场景驱动且无快照）。 */
  unchanged?: boolean
  /** 写盘失败的原因（原操作本身仍算成功）。 */
  error?: string
  /**
   * 进场景前的**基线快照没能写入**：AGENTS.md 已经切到场景态，但退出场景时恢复不回来。
   *
   * 与 `error` 分开，因为两者说的是相反的事：`error` 是「AGENTS.md 没写成」，
   * 这里是「AGENTS.md 写成了，但没有退路」。合成一个字段会让界面把「已切进场景」
   * 说成「未写入」（2026-09-30 审查 F14）。
   */
  baselineError?: string
}

export interface ScenePromptSyncDeps {
  prompts: {
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
  /** 正在驱动基线的场景（无驱动 / 探测失败 → null）。 */
  driver(): Promise<ScenePromptDriver | null>
  /**
   * 被引用中的预设：id → 引用处（删除保护的唯一依据）。
   * 探测失败返回 null（调用方放行 + warn）——绝不因一次读盘失败把删除堵死。
   */
  refs(): Promise<Map<string, PresetRef[]> | null>
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

  /** 快照文件是否**存在**（不看内容）。用来把「没有快照」与「快照读不出来」分开。 */
  async function baselineExists(): Promise<boolean> {
    try { return (await stat(deps.baselineFile)).isFile() } catch { return false }
  }

  /**
   * 写基线快照。**失败必须让调用方看得见**（2026-09-30 审查 F14）。
   *
   * 原来这里 catch 后只 `warn` 并返回 void，于是「快照没写成」与「写成了」在调用方眼里
   * 完全一样 —— 结果就是：AGENTS.md 被切到场景态、而退出场景时恢复不回来，用户看到的是
   * 「没场景驱动所以什么都没做」。这正是「看起来成功」那类失败。
   * @returns 失败原因（原样回给调用方拼进提示）；成功返回 null。
   */
  async function writeBaseline(next: SceneBaseline): Promise<string | null> {
    try {
      await mkdir(dirname(deps.baselineFile), { recursive: true })
      // 原子写（2026-09-30 审查 P2-16）：裸写在中断/断电时会留下半截 JSON → `readBaseline`
      // 解析失败返回 null → 退出场景**不恢复** AGENTS.md，用户的提示词基线悄悄留在场景态。
      await writeFileAtomically(deps.baselineFile, JSON.stringify(next))
      return null
    } catch (e) {
      const reason = String(e)
      warn(`scene-prompt: could not persist baseline: ${reason}`)
      return reason
    }
  }

  async function state(): Promise<ScenePromptState | null> {
    try {
      const r: any = await deps.rules.ops['rules-list']({})
      const sp = r && r.ok ? r.scenePrompt : null
      if (!sp) return null
      const scene = sp.scene ? String(sp.scene) : null
      return {
        scene,
        presetId: sp.presetId ? String(sp.presetId) : null,
        // 显示名缺失时退回场景名（老载荷 / 桩），宁可粗糙也不要空字符串。
        label: sp.label ? String(sp.label) : (scene || ''),
        missing: sp.missing === true,
        duplicate: sp.duplicate === true,
      }
    } catch (e) {
      warn(`scene-prompt: probe failed: ${String(e)}`)
      return null
    }
  }

  /** 一个场景是否真的在驱动基线：有场景、绑定非空且预设正文读得到。 */
  const drives = (s: ScenePromptState | null): s is ScenePromptState & { scene: string; presetId: string } =>
    !!s && s.scene !== null && !s.missing && s.presetId !== null

  async function driver(): Promise<ScenePromptDriver | null> {
    const current = await state()
    if (!drives(current)) return null
    return { scene: current.scene, label: current.label || current.scene, presetId: current.presetId }
  }

  async function refs(): Promise<Map<string, PresetRef[]> | null> {
    const out = new Map<string, PresetRef[]>()
    const add = (id: string, ref: PresetRef): void => {
      const list = out.get(id)
      if (!list) { out.set(id, [ref]); return }
      const dup = list.some((x) => {
        if (x.kind !== ref.kind) return false
        if (x.kind === 'scene' && ref.kind === 'scene') return x.scene === ref.scene
        return true
      })
      if (!dup) list.push(ref)
    }
    // 三类探测各自失败都算「没探全」→ 整体返回 null（放行删除 + warn），
    // 与原有「探测失败不拦删除、最坏少一份副本」的口径一致。
    let complete = true
    try {
      const r: any = await deps.rules.ops['rules-list']({})
      if (!r || r.ok !== true) { complete = false } else {
        for (const s of (Array.isArray(r.scenes) ? r.scenes : [])) {
          const id = s && typeof s.prompt === 'string' ? s.prompt : ''
          if (id === '') continue
          const scene = String((s && s.name) || '')
          add(id, { kind: 'scene', scene, label: String((s && s.label) || scene), active: s && s.active === true })
        }
      }
    } catch (e) { complete = false; warn(`scene-prompt: refs probe (scenes) failed: ${String(e)}`) }
    try {
      const cur: any = await deps.prompts.getCurrent()
      if (!cur || cur.ok !== true) complete = false
      else if (cur.presetId) add(String(cur.presetId), { kind: 'file', applied: cur.lastApplied === cur.presetId })
    } catch (e) { complete = false; warn(`scene-prompt: refs probe (baseline file) failed: ${String(e)}`) }
    try {
      const saved = await readBaseline()
      if (saved && saved.content !== null && saved.presetId) add(saved.presetId, { kind: 'restore' })
    } catch (e) { complete = false; warn(`scene-prompt: refs probe (snapshot) failed: ${String(e)}`) }
    return complete ? out : null
  }

  async function sync(): Promise<SyncResult> {
    const current = await state()
    if (!current) return { unchanged: true }
    if (drives(current)) {
      if (current.duplicate) return { applied: current.presetId, unchanged: true }
      // 进场景的第一笔写入之前，先记下当时的基线（已有快照就不覆盖：连续切场景时
      // 基线始终是"进场景之前"那一份）。
      let baselineError: string | undefined
      const saved = await readBaseline()
      if (!saved || saved.content === null) {
        const cur: any = await deps.prompts.getCurrent()
        const failed = await writeBaseline({
          v: 1,
          at: Date.now(),
          presetId: cur && cur.ok && cur.presetId ? String(cur.presetId) : null,
          content: cur && cur.ok && cur.exists ? String(cur.content) : null,
        })
        // 基线写不进去 = 退出场景时恢复不回来。**照旧进场景**（那是用户的要求），
        // 但必须当场说出来，别让用户以为还能退回去（审查 F14）。
        if (failed !== null) {
          baselineError = `进场景前的提示词基线没能写入（${failed}）：AGENTS.md 已切到场景「${current.scene}」绑定的预设，但退出场景时恢复不回原来的内容（${deps.baselineFile}）。`
        }
      }
      const res: any = await deps.prompts.apply(current.presetId)
      if (res && res.ok === false) return { error: String(res.error || '写入 AGENTS.md 失败'), ...(baselineError ? { baselineError } : {}) }
      return { applied: current.presetId, ...(baselineError ? { baselineError } : {}) }
    }
    // 没有场景驱动 → 如果刚从驱动态退出，把进场景前的基线写回去。
    const saved = await readBaseline()
    if (!saved || saved.content === null) {
      // 「没有快照」是常态（没进过场景）；「快照文件在、但读不出来」是**故障** ——
      // 那意味着恢复目标丢了，AGENTS.md 的提示词基线会悄悄留在场景态。这里曾经一律
      // 静默 `unchanged`，用户看到的是"没场景驱动所以什么都没做"（审查 P2-16）。
      if (await baselineExists()) {
        warn(`scene-prompt: baseline snapshot exists but is unreadable: ${deps.baselineFile}`)
        return { error: `基线快照读不出来（文件可能损坏），未能恢复 AGENTS.md：${deps.baselineFile}` }
      }
      return { unchanged: true }
    }
    const res: any = await deps.prompts.restore(saved.content)
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

  return { sync, withSync, state, driver, refs }
}
