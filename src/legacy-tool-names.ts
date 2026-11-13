// 工具改名的迁移表：旧名 → 新名。
//
// 为什么单独一个文件：这张表有三个使用方 —— 全局侧车 `tool-table.json`（读侧翻译一次、
// 回写盘；见 `tools/table.ts` 的 `migrateLegacyToolNames`）、会话侧车 `scope-overrides.json`
// 的工具表名单（`scope/scope-overrides.ts` 的 `normalizeToolNameList`）、以及场景档案
// 快照里抄的那份（`memories/index-io.ts`）。三处都是同一类问题：「工具改名了，盘上还是
// 旧名」。各写一份必然漂移 —— 一处漏了就是"用户关掉的那条在新名字上静默失效"。
//
// 为什么放在根目录这一叶（零依赖）：`scope/` 与 `memories/` 都是低层，反向引
// `tools/table.ts` 会把工具表那一层的依赖链（注入契约、工具依赖）接回来 —— 运行时环
// 是这么接上的。与 `trash-id.ts` 同一层：根目录的跨层共享叶子。
//
// ⚠️ 删除族是**语义合并**（五条并成一条 `plugin_manager_trash`），与别的「一对一改名」
// 不是一回事：五条出厂都是关着的，所以「任意一条关着 ⇒ 合成的这条关着」正好保住了
// 出厂口径；只开过其中一条的用户会看到合成的那条仍是关着的 —— 面板上一键就能开，
// 比原来分五条开省事。

export const LEGACY_TOOL_NAME_MAP: Readonly<Record<string, string>> = Object.freeze({
  // 记忆族：第一代 write + update + save 三条并成一条写入工具，第二代叫 `memory_remember`，
  // 现在统一到 `memory_manager_remember`。所有 value 直接写最终名 —— 翻译只做单跳。
  // （开发中途曾把整族改叫 `scene_memory_manager_*`，但那个名字**从未发布**，用户侧
  // 不可能有它，因此不存在需要从它迁回来的数据。）
  memory_manager_write: 'memory_manager_remember',
  memory_manager_update: 'memory_manager_remember',
  memory_manager_save: 'memory_manager_remember',
  memory_remember: 'memory_manager_remember',
  // 清单并进读取入口：用户显式关过清单的，升级后读取入口仍保持关闭。
  // `memory_manager_read` / `_search` **不映射**：它们出厂就是关着的，映射到读取入口
  // 会让升级用户的合并读取入口也变关 —— 那是唯一的发现路径。
  // 旧名留在名单里只是死名，不影响任何工具。
  memory_manager_list: 'memory_manager_get',
  memory_get: 'memory_manager_get',
  mcp_manager_set_enabled: 'mcp_manager_switch',
  mcp_manager_restart: 'mcp_manager_switch',
  mcp_manager_add: 'mcp_manager_save',
  skill_manager_create: 'skill_manager_save',
  subagent_manager_create: 'subagent_manager_save',
  subagent_manager_update: 'subagent_manager_save',
  // 「拨一个开关」六域同形 —— `_set_enabled` → `_switch`（与 `mcp_manager_set_enabled`
  // → `mcp_manager_switch` 同一条路）。**改的只是名字，参数不动**（仍是 `enabled` 布尔），
  // 所以这里是一对一翻译、不涉及语义合并。
  memory_manager_set_enabled: 'memory_manager_switch',
  // 第一代的 `memory_manager_switch` 与现在同名、同义，不再需要映射。
  memory_switch: 'memory_manager_switch',
  skill_manager_set_enabled: 'skill_manager_switch',
  subagent_manager_set_enabled: 'subagent_manager_switch',
  // 删除族：五个域各一条 → 合成一条 `plugin_manager_trash`（**多对一**）。
  // 翻译后按新名去重，五条旧名落在同一条上。`plugin_manager_remove` 是合并后的第二代名，
  // 现在也迁到 `plugin_manager_trash`。
  memory_manager_remove: 'plugin_manager_trash',
  skill_manager_remove: 'plugin_manager_trash',
  subagent_manager_remove: 'plugin_manager_trash',
  scene_manager_remove: 'plugin_manager_trash',
  prompt_manager_remove: 'plugin_manager_trash',
  plugin_manager_remove: 'plugin_manager_trash',
  // 自主笔记：早期分开注册的四条，以及上一版合并后的 `memory_manager_auto`，都迁到
  // 合并后的那条工具；第二代叫 `memory_note`，现在统一到 `memory_manager_note`。
  // 盘上的 `tool-table.json` / 场景快照可能留着旧名；任意一条被关过
  // ⇒ 新工具也记成关过，别让旧名单变成一串永远认不出的死名。
  memory_manager_learn: 'memory_manager_note',
  memory_manager_forget: 'memory_manager_note',
  memory_manager_organize: 'memory_manager_note',
  memory_manager_procedure_done: 'memory_manager_note',
  memory_manager_auto: 'memory_manager_note',
  memory_note: 'memory_manager_note',
})

/** 旧名 → 新名；不是旧名就原样返回。 */
export function translateLegacyToolName(name: string): string {
  return LEGACY_TOOL_NAME_MAP[name] ?? name
}
