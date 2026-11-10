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
// ⚠️ 删除族是**语义合并**（五条并成一条 `plugin_manager_remove`），与别的「一对一改名」
// 不是一回事：五条出厂都是关着的，所以「任意一条关着 ⇒ 合成的这条关着」正好保住了
// 出厂口径；只开过其中一条的用户会看到合成的那条仍是关着的 —— 面板上一键就能开，
// 比原来分五条开省事。

export const LEGACY_TOOL_NAME_MAP: Readonly<Record<string, string>> = Object.freeze({
  // 记忆族：只把 write + update 并成一条 `save`，名字本身没动 —— 所以只有这两条要迁移。
  // （开发中途曾把整族改叫 `scene_memory_manager_*`，但那个名字**从未发布**，用户侧
  // 不可能有它，因此不存在需要从它迁回来的数据。）
  memory_manager_write: 'memory_manager_save',
  memory_manager_update: 'memory_manager_save',
  // 读取三合一：清单 / 正文 / 搜索并成 `memory_get`（多对一，翻译后按新名去重）。
  memory_manager_list: 'memory_get',
  memory_manager_read: 'memory_get',
  memory_manager_search: 'memory_get',
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
  skill_manager_set_enabled: 'skill_manager_switch',
  subagent_manager_set_enabled: 'subagent_manager_switch',
  // 删除族：五个域各一条 → 合成一条 `plugin_manager_remove`（**多对一**）。
  // 翻译后按新名去重，五条旧名落在同一条上。
  memory_manager_remove: 'plugin_manager_remove',
  skill_manager_remove: 'plugin_manager_remove',
  subagent_manager_remove: 'plugin_manager_remove',
  scene_manager_remove: 'plugin_manager_remove',
  prompt_manager_remove: 'plugin_manager_remove',
  // 自主笔记：早期分开注册的四条，以及上一版合并后的 `memory_manager_auto`，都迁到
  // `memory_note`。盘上的 `tool-table.json` / 场景快照可能留着旧名；任意一条被关过
  // ⇒ 新工具也记成关过，别让旧名单变成一串永远认不出的死名。
  memory_manager_learn: 'memory_note',
  memory_manager_forget: 'memory_note',
  memory_manager_organize: 'memory_note',
  memory_manager_procedure_done: 'memory_note',
  memory_manager_auto: 'memory_note',
})

/** 旧名 → 新名；不是旧名就原样返回。 */
export function translateLegacyToolName(name: string): string {
  return LEGACY_TOOL_NAME_MAP[name] ?? name
}
