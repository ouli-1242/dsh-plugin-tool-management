// rules 域里需要包装的那四个 op（2026-09-19 从 index.ts 的 handlers 表抽出）。
//
// rules 域的**其余 op 由 ./memories/service.ts 直接 spread 进表**，不经过本文件 —— 这里只放
// 四个要走「场景 ↔ 全局基线同步」包装的写 op。

import { GLOBAL_SCENE, SHARED_GROUP } from '../memories/constants.js'

/** 参数形态不归本层管（多场景 / 非法名 / `all`）：交给原 op 校验并报错，运行时一律不动。 */
const SKIP = Symbol('skip')

/**
 * 「启用集合」与「当前模式」是同一个意图的两片状态：`active` 决定记忆与绑定的提示词按哪个
 * 场景注入，`mode.scene` 决定运行时（MCP / 技能 / 人设 / 工具表 / 快捷词）停在哪份档案上。
 * 两者必须恒等 —— 历史上每次只有一个动，就出现过一个方向各坏一次：拨开关不应用档案（面板
 * 0.9.x 的旧账，见 45-scenes.js 的 ⚠️ 注释），以及 `/` 菜单进 / 出场景只写 `active`
 * （用户 2026-10-01 报，图见 CHANGELOG）。
 *
 * 所以这里**在服务端兜住这条不变量**，而不是要求每个调用方各开两枪：`rules-set-active` 是
 * "我要让哪个场景生效"的那个 op，四个调用方（面板开关、`/` 菜单、模型工具、以后新增的入口）
 * 只要调它，运行时就会跟着对齐。
 *
 * 顺序是**先切运行时、后写启用集合**：引擎会校验场景存在、没被锁、绑的工具表方案还在，
 * 它拒绝时启用集合必须一个字都不动。反过来（先写 active）留下的正是"开关过去了、运行时没切"
 * 那个半截状态 —— 也就是这一版要消灭的东西。
 */
async function syncModeToActive(args: any, deps: SceneSyncOpsDeps): Promise<any | null> {
  const want = targetSceneOf(args)
  if (want === SKIP) return null
  if (want === (await deps.currentModeScene())) return null
  return deps.sceneModeSet({ scene: want })
}

/**
 * 从 `scenes:[...]` 里取出"这一次要让哪个场景生效"（`null` = 一个都不让 = 退出模式）。
 *
 * 保留名的过滤与去重和 `rulesSetActive` **同源**（同一份常量，不是抄一份）：`_shared` 与
 * `global` 恒常生效，不进显式集合 —— 所以 `['global','_shared']` 与原 op 一样读成"清空"。
 * 收敛后仍多于一个 = 单选模型下的非法请求，原 op 会拒，这里回 SKIP 让运行时一动不动
 * （宁可少切一次，也不要按一个原 op 马上要拒绝的参数去改运行时）。
 */
function targetSceneOf(args: any): string | null | typeof SKIP {
  if (args && args.all === true) return SKIP
  const raw = args && args.scenes
  if (!Array.isArray(raw)) return SKIP
  const names: string[] = []
  for (const item of raw) {
    const name = String(item == null ? '' : item).trim()
    if (!name || name === SHARED_GROUP || name === GLOBAL_SCENE) continue
    if (names.indexOf(name) < 0) names.push(name)
  }
  return names.length > 1 ? SKIP : (names[0] ?? null)
}

export interface SceneSyncOpsDeps {
  /**
   * 场景 ↔ 全局基线（AGENTS.md）同步包装：先执行原逻辑，成功后把当前场景绑定的提示词
   * 写进 `~/.dsh/AGENTS.md`（或关掉场景时恢复进场景前的基线）。
   */
  withAgentsMdSync(res: any): Promise<any>
  /** 当前模式停在哪个场景（`null` = 自由模式）。 */
  currentModeScene(): Promise<string | null>
  /**
   * 引擎的 `scene-mode-set`，**必须是包过一层的那份**（带锁定守卫与人设 / 技能目录重算）：
   * 直调未包装的会让"从 `/` 进场景"绕过锁定拒绝，与面板行为分叉。
   */
  sceneModeSet(args: { scene: string | null }): Promise<any>
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
    //
    // `rules-set-active` 额外承担「两轴恒等」（见文件头）：先把运行时切到位，再写启用集合。
    'rules-set-active': async (args: any) => {
      const mode = await syncModeToActive(args, deps)
      if (mode && mode.ok === false) return mode
      const res = await deps.rulesOps['rules-set-active'](args)
      if (!res || res.ok === false) return res
      // 引擎跳过的档案键（本机已不存在的服务器 / 技能键）并进来给调用方 —— 面板与 `/` 都要
      // 那句"进了，但没全进"。
      const stale = mode && Array.isArray(mode.stale) && mode.stale.length ? mode.stale : null
      return deps.withAgentsMdSync(stale ? Object.assign({}, res, { modeStale: stale }) : res)
    },
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
