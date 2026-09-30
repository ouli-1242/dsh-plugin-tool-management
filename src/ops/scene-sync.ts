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
  /**
   * 模型工具表方案绑定落在**当前启用场景**时的即时生效（0.15.0）：
   * 把关停名单整体换成那份方案。缺席或抛错都不拦保存本身（与 AGENTS.md 同步同口径）。
   */
  onToolTablePresetChanged?(scene: string, value: string): Promise<void>
  /**
   * 快捷提示词勾选集落在**当前启用场景**时的即时生效（0.18.0）：与「改档案 = 立刻生效」
   * 同一条路（走 `scene-archive-save`，含 stale 清理与快照并入）。`null` = 解绑 = 这一域
   * 回到"保持现状"，运行时不回滚（进场景前那批开关仍在快照里，退出照常还原）。
   */
  onQuickPromptsChanged?(scene: string, value: string[] | null): Promise<void>
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
    'rules-update-scene': async (args: any) => {
      const res: any = await deps.rulesOps['rules-update-scene'](args)
      // 工具表方案绑定改动（0.15.0）：改的是**当前启用场景**且这次真的带了这一参数时即时生效；
      // 改名在场景处于模式中时会被拦（rulesUpdateScene 的 sceneInMode），所以这里 args.name 就是生效场景的名字。
      if (res && res.ok !== false && deps.onToolTablePresetChanged && args && args.toolTablePreset !== undefined) {
        try { await deps.onToolTablePresetChanged(String(args.name || ''), String(args.toolTablePreset)) } catch { /* 即时生效失败不拦保存；下次进/退场景会对齐 */ }
      }
      // 快捷提示词勾选集同理：只有这次真的带了这一参数才动（不传 = 不碰这一域）。
      if (res && res.ok !== false && deps.onQuickPromptsChanged && args && args.quickPrompts !== undefined) {
        try {
          await deps.onQuickPromptsChanged(String(args.name || ''), Array.isArray(args.quickPrompts) ? args.quickPrompts.map((x: unknown) => String(x)) : null)
        } catch { /* 同上 */ }
      }
      return deps.withAgentsMdSync(res)
    },
    'rules-create-scene': async (args: any) => deps.withAgentsMdSync(await deps.rulesOps['rules-create-scene'](args)),
    'rules-remove-scene': async (args: any) => deps.withAgentsMdSync(await deps.rulesOps['rules-remove-scene'](args)),
  }
}
