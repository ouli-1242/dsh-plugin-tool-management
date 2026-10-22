// 侧栏入口的开关（侧车 `sidebar-settings.json`，按钮在「兼容」页页头）。
//
// 与 `slash-settings.ts` 同一档：它是个**入口开关**，不是管理动作 —— 所以不进场景冻结
// （锁着场景的人照样能把它关掉），也不参与任何门禁判定。
//
// 为什么存服务端而不是 localStorage：与其余入口开关同一个家，换浏览器也在；存本地就
// 只有那个浏览器认，而这条开关的用途正是"这台机器上我不想在侧栏看到它"。

/** 侧车 `sidebar-settings.json` 的形状。 */
export interface SidebarSettings {
  /** 侧栏里挂出本插件的入口行（默认 true）。 */
  enabled: boolean
}

/** 侧栏入口出厂值：默认显示。 */
export const DEFAULT_SIDEBAR_SETTINGS: SidebarSettings = { enabled: true }

/** 把任意输入夹成合法设置：读不到 / 形状不对一律按默认开启。 */
export function normalizeSidebarSettings(raw: unknown): SidebarSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return { enabled: typeof obj.enabled === 'boolean' ? obj.enabled : DEFAULT_SIDEBAR_SETTINGS.enabled }
}
