// rules 域里需要包装的那四个 op（2026-09-19 从 index.ts 的 handlers 表抽出）。
//
// rules 域的**其余 op 由 ./memories/service.ts 直接 spread 进表**，不经过本文件 —— 这里只放
// 四个要走「场景 ↔ 全局基线同步」包装的写 op。

export interface SceneSyncOpsDeps {
  /**
   * 场景 ↔ 全局基线（AGENTS.md）同步包装：先执行原逻辑，成功后把当前场景绑定的提示词
   * 写进 `~/.dsh/AGENTS.md`（或关掉场景时恢复进场景前的基线）。
   */
  withAgentsMdSync(res: any): Promise<any>
  /** rules service 的四个原 op；写死名字，rules 域改名会立刻红而不是静默 undefined。 */
  rulesOps: {
    'rules-set-active'(args: any): Promise<any>
    'rules-update-scene'(args: any): Promise<any>
    'rules-create-scene'(args: any): Promise<any>
    'rules-remove-scene'(args: any): Promise<any>
  }
}

export function buildSceneSyncOps(deps: SceneSyncOpsDeps): Record<string, (args: any) => Promise<any>> {
  return {
    // 场景 ↔ 全局基线（AGENTS.md）同步：用户裁定「切换场景，对应的提示词直接把 AGENTS.md
    // 直接修改」，所以这四个 rules 写 op 走包装 —— 先执行原逻辑，成功后把当前场景绑定的
    // 提示词写进 `~/.dsh/AGENTS.md`（或关掉场景时恢复进场景前的基线），结果并进响应
    // 的 `agentsMd` 字段（`applied` / `restored` / `unchanged` / `error`）。
    // 组装时放在 memoriesService.ops 的 spread **之后**，显式覆盖同名 op。
    'rules-set-active': async (args: any) => deps.withAgentsMdSync(await deps.rulesOps['rules-set-active'](args)),
    'rules-update-scene': async (args: any) => deps.withAgentsMdSync(await deps.rulesOps['rules-update-scene'](args)),
    'rules-create-scene': async (args: any) => deps.withAgentsMdSync(await deps.rulesOps['rules-create-scene'](args)),
    'rules-remove-scene': async (args: any) => deps.withAgentsMdSync(await deps.rulesOps['rules-remove-scene'](args)),
  }
}
