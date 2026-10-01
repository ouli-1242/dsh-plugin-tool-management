// 三份界面设置侧车（inject / scene / slash）的读写与 TTL 缓存。
//
// 正文从 index.ts 的 apply 闭包里整段搬来，一字未改（只去一层缩进，并把五个 apply 作用域
// 名字改成走 deps —— moved-verify 按这三类容差机检）。
//
// 为什么三份缓存仍留在闭包里：本工厂在 apply 的同一位置只调用一次，`let *Cache` 还是
// 「每次 apply 一份」。搬到模块级就变成每进程一份，热更新重进 apply 时旧缓存会被复用 ——
// 那是语义翻转，不是搬家。
import { hubPath } from './hub.js'
import { DEFAULT_INJECT_SETTINGS, normalizeInjectSettings, type InjectSettings } from './context-inject.js'
import { normalizeSceneSettings, type SceneSettings } from './scene-settings.js'
import { normalizeSlashSettings, type SlashSettings } from './slash-settings.js'

export interface SettingsSidecarDeps {
  /** apply 里的路径发现（懒建目录）；本层所有调用点都在 await 之后，不依赖它的定义顺序。 */
  ensurePaths(): Promise<unknown>
  readJsonFile(abs: string): Promise<any>
  writeJsonFile(abs: string, data: any): Promise<void>
  /** apply 的串行写锁：设置写入与其余写操作共用同一条队列。 */
  withWriteLock<T>(fn: () => Promise<T>): Promise<T>
  message(e: unknown): string
}

export interface SettingsSidecars {
  readInjectSettings(force?: boolean): Promise<InjectSettings>
  injectSettingsSync(): InjectSettings
  injectNoticeOptions(): { underSuppressingPresets: boolean; domains: Record<string, boolean> }
  injectSettingsOp(args: any): Promise<any>
  readSceneSettings(force?: boolean): Promise<SceneSettings>
  sceneSettingsOp(args: any): Promise<any>
  readSlashSettings(force?: boolean): Promise<SlashSettings>
  slashSettingsOp(args: any): Promise<any>
}

export function createSettingsSidecars(deps: SettingsSidecarDeps): SettingsSidecars {

  // 注入设置（侧车 `inject-settings.json`，界面在「兼容」页）：
  //   - underSuppressingPresets：压制型预设（persona complete / 关运行时上下文，如极简）
  //     下是否仍然注入。默认 false = 跟随预设。
  //   - domains：各域开关（任何预设下都生效；界面五个勾选）。
  // 注入器每个 step 都要同步读一次设置 → 走 TTL 缓存；未加载时先给默认值并异步预热。
  const INJECT_SETTINGS_FILE = 'inject-settings.json'
  const INJECT_SETTINGS_TTL_MS = 3000
  let injectSettingsCache: { at: number; value: InjectSettings } | null = null
  async function readInjectSettings(force = false): Promise<InjectSettings> {
    if (injectSettingsCache && !force && Date.now() - injectSettingsCache.at < INJECT_SETTINGS_TTL_MS) return injectSettingsCache.value
    await deps.ensurePaths()
    const raw = await deps.readJsonFile(hubPath(INJECT_SETTINGS_FILE))
    injectSettingsCache = { at: Date.now(), value: normalizeInjectSettings(raw) }
    return injectSettingsCache.value
  }
  /** 同步快照（注入器取用）；还没加载时先返回默认值，并顺手预热一次。 */
  function injectSettingsSync(): InjectSettings {
    if (injectSettingsCache) return injectSettingsCache.value
    void readInjectSettings().catch(() => {})
    return DEFAULT_INJECT_SETTINGS
  }
  /** 边界提示要的注入设置快照（总开关 + 各域开关）。 */
  const injectNoticeOptions = (): { underSuppressingPresets: boolean; domains: Record<string, boolean> } => {
    const s = injectSettingsSync()
    return { underSuppressingPresets: s.underSuppressingPresets, domains: s.domains }
  }
  async function injectSettingsOp(args: any): Promise<any> {
    const current = await readInjectSettings()
    if (!args || args.set !== true) return { ok: true, settings: current }
    const next = normalizeInjectSettings({
      underSuppressingPresets: typeof args.underSuppressingPresets === 'boolean'
        ? args.underSuppressingPresets
        : current.underSuppressingPresets,
      domains: { ...current.domains, ...(args.domains && typeof args.domains === 'object' ? args.domains : {}) },
    })
    await deps.ensurePaths()
    return deps.withWriteLock(async () => {
      try {
        await deps.writeJsonFile(hubPath(INJECT_SETTINGS_FILE), next)
      } catch (e) {
        return { ok: false, error: '设置保存失败: ' + deps.message(e) }
      }
      injectSettingsCache = { at: Date.now(), value: next }
      return { ok: true, settings: next }
    })
  }

  // 场景页的界面设置（侧车 `scene-settings.json`）：目前只有一项 —— 进入场景前要不要先弹
  // 那张「会改什么」的卡。它纯粹是界面提示，所以**不进场景冻结**（锁着场景的人在场景页
  // 照样能关掉提醒，那与五个管理域的只读无关）。
  const SCENE_SETTINGS_FILE = 'scene-settings.json'
  const SCENE_SETTINGS_TTL_MS = 3000
  let sceneSettingsCache: { at: number; value: SceneSettings } | null = null
  async function readSceneSettings(force = false): Promise<SceneSettings> {
    if (sceneSettingsCache && !force && Date.now() - sceneSettingsCache.at < SCENE_SETTINGS_TTL_MS) return sceneSettingsCache.value
    await deps.ensurePaths()
    const raw = await deps.readJsonFile(hubPath(SCENE_SETTINGS_FILE))
    const value = normalizeSceneSettings(raw)
    sceneSettingsCache = { at: Date.now(), value }
    return value
  }
  async function sceneSettingsOp(args: any): Promise<any> {
    const current = await readSceneSettings()
    if (!args || args.set !== true) return { ok: true, settings: current }
    const next = normalizeSceneSettings({
      enterPreview: typeof args.enterPreview === 'boolean' ? args.enterPreview : current.enterPreview,
    })
    await deps.ensurePaths()
    return deps.withWriteLock(async () => {
      try {
        await deps.writeJsonFile(hubPath(SCENE_SETTINGS_FILE), next)
      } catch (e) {
        return { ok: false, error: '设置保存失败: ' + deps.message(e) }
      }
      sceneSettingsCache = { at: Date.now(), value: next }
      return { ok: true, settings: next }
    })
  }

  // 斜杠命令入口的开关（侧车 `slash-settings.json`）：两段各一颗 —— 「工具」与「快捷提示词」。
  // 判据与 `scene-settings` 同一条 —— 它是入口开关、不是管理动作，所以不冻结；读侧不带 `set`
  // 时是纯读（客户端 boot 时必问一次，不能要令牌）。
  const SLASH_SETTINGS_FILE = 'slash-settings.json'
  const SLASH_SETTINGS_TTL_MS = 3000
  let slashSettingsCache: { at: number; value: SlashSettings } | null = null
  async function readSlashSettings(force = false): Promise<SlashSettings> {
    if (slashSettingsCache && !force && Date.now() - slashSettingsCache.at < SLASH_SETTINGS_TTL_MS) return slashSettingsCache.value
    await deps.ensurePaths()
    const raw = await deps.readJsonFile(hubPath(SLASH_SETTINGS_FILE))
    const value = normalizeSlashSettings(raw)
    slashSettingsCache = { at: Date.now(), value }
    return value
  }
  async function slashSettingsOp(args: any): Promise<any> {
    const current = await readSlashSettings()
    if (!args || args.set !== true) return { ok: true, settings: current }
    const next = normalizeSlashSettings({
      tools: typeof args.tools === 'boolean' ? args.tools : current.tools,
      quickPrompts: typeof args.quickPrompts === 'boolean' ? args.quickPrompts : current.quickPrompts,
    })
    await deps.ensurePaths()
    return deps.withWriteLock(async () => {
      try {
        await deps.writeJsonFile(hubPath(SLASH_SETTINGS_FILE), next)
      } catch (e) {
        return { ok: false, error: '设置保存失败: ' + deps.message(e) }
      }
      slashSettingsCache = { at: Date.now(), value: next }
      return { ok: true, settings: next }
    })
  }
  return {
    readInjectSettings,
    injectSettingsSync,
    injectNoticeOptions,
    injectSettingsOp,
    readSceneSettings,
    sceneSettingsOp,
    readSlashSettings,
    slashSettingsOp,
  }
}
