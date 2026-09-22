// 场景页的界面设置（侧车 `scene-settings.json`，界面在场景页右上的按钮）。
//
// 目前只有一项：进入场景前要不要先弹那张「会改什么」的卡。它是**界面提示**，不是管理动作 ——
// 所以它既不受场景锁定影响（锁着场景照样能关提醒），也不参与任何门禁判定；改了只影响下一次
// 点「启用这个场景」时弹不弹卡。
//
// 为什么放在服务端而不是浏览器本地：与其余设置同一个家（侧车 + op + 登记表），换浏览器
// 也在；写在 localStorage 里就只有那个浏览器认，而这个开关的意义正是"我不想每次都被拦一下"，
// 换了浏览器又冒出来会显得是 bug。

/** 侧车 `scene-settings.json` 的形状。 */
export interface SceneSettings {
  /** 进入场景前弹「会改什么」的预览卡（默认 true）。 */
  enterPreview: boolean
}

export const DEFAULT_SCENE_SETTINGS: SceneSettings = { enterPreview: true }

/** 把任意输入夹成合法设置（缺项/类型不对一律退回默认：默认不阻止任何确认）。 */
export function normalizeSceneSettings(raw: unknown): SceneSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    enterPreview: typeof obj.enterPreview === 'boolean' ? obj.enterPreview : DEFAULT_SCENE_SETTINGS.enterPreview,
  }
}
