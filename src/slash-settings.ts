// 斜杠命令入口的界面设置（侧车 `slash-settings.json`，开关在「兼容」页）。
//
// 两项：要不要在对话输入框的 `/` 菜单里挂出「工具」段与「快捷提示词」段。它们不是管理动作，
// 而是**入口开关** —— 所以与 `scene-settings.ts` 同规格：不受场景冻结影响（锁着场景的人照样能
// 关掉这个入口），也不参与任何门禁判定。
//
// 为什么两段各一颗开关：两段的用处不同（一段是"改状态"、一段是"取文字"），只想留一段的人是
// 真实需求 —— 而它们本来就各自是一个源（同一个源里的行只能跟自己排顺序），分开关不需要任何
// 额外机制。
//
// 为什么放在服务端而不是 localStorage：与其余设置同一个家（侧车 + op + 登记表），换浏览器也在；
// 存本地就只有那个浏览器认，而这条开关的用途正是"这台机器上我不想看到它"。

/** 侧车 `slash-settings.json` 的形状。 */
export interface SlashSettings {
  /** 在宿主 `/` 菜单里挂「工具」段（默认 true）。 */
  tools: boolean
  /** 在宿主 `/` 菜单里挂「快捷提示词」段（默认 true）。 */
  quickPrompts: boolean
}

export const DEFAULT_SLASH_SETTINGS: SlashSettings = { tools: true, quickPrompts: true }

/**
 * 把任意输入夹成合法设置：读不到 / 形状不对一律按默认开启。
 *
 * 旧版只有一颗 `enabled`（管整个入口）。那份文件还在的人升级后不该突然多出两段，也不该丢掉
 * "我把它关过"这个事实 —— 所以 `enabled` 仍是两段的默认值，各自显式给出时以各自为准。
 */
export function normalizeSlashSettings(raw: unknown): SlashSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const legacy = typeof obj.enabled === 'boolean' ? obj.enabled : undefined
  const one = (key: 'tools' | 'quickPrompts') =>
    typeof obj[key] === 'boolean' ? (obj[key] as boolean) : legacy === undefined ? DEFAULT_SLASH_SETTINGS[key] : legacy
  return { tools: one('tools'), quickPrompts: one('quickPrompts') }
}
