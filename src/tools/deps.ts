// model 工具（ctx.tools.register + defineTool）各域共用的依赖与 helper。
//
// 为什么单独一个文件：各注入域的工具都要同一批依赖（defineTool 包装、注册出口、场景锁定
// 守卫、注入边界提示），各写一份会漂移。

import { defineTool as hostDefineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

export type TextPart = Array<{ type: 'text'; text: string }>

/** 每个工具 output.render 的统一出口：把字符串包成宿主要的 content 数组。 */
export function text(value: string): TextPart {
  return [{ type: 'text', text: value }]
}

/**
 * 名单渲染：超过 `TOOL_NAME_LIST_CAP` 项就截断，并把总数写在后面（"…(N total)"）。
 *
 * 为什么两个地方都要它：`scene_manager_list` 用它列档案，`scene_manager_save` 用它
 * 在回执里回显"这一次替换挤掉了什么"。两处都必须**点名、不能只给数量** —— 只给数量
 * 答不了"我这次给出去的段会不会盖掉原来勾着的那些"，而那正是会静默出错的地方。
 * 截断则是因为这些文字都要进上下文，不能无上限。
 */
export const TOOL_NAME_LIST_CAP = 6
export function toolNameList(list: readonly string[]): string {
  if (!list.length) return 'none'
  const head = list.slice(0, TOOL_NAME_LIST_CAP).join(', ')
  return list.length > TOOL_NAME_LIST_CAP ? head + ' ...(' + list.length + ' total)' : head
}

/** `locateSkillRoot` 的结论。 */
export interface SkillRootLookup {
  /** `skill-state` 探测成功了吗。false = 探不到，调用方应退回旧默认、别在这里编结论。 */
  ok: boolean
  /** 命中时：这个技能的**胜出副本**所在来源键；没命中 = null。 */
  root: string | null
  /** 探到的全部来源键（没命中时用来把错误说清楚：查过哪些地方）。 */
  roots: string[]
}

/**
 * 按名字找技能落在哪个来源（root）。
 *
 * 为什么需要它（2026-10-15 smoke-test P0-1）：`skill-create` 的默认落点是 **hub**
 * （`tool-management/skills/`，与界面「创建技能」一致），而 `skill-enable` / `skill-disable` /
 * `skill-prefer` / `skill-delete` 这些 op 的默认 root 是 **dsh**。于是「建完就启用」这条
 * 最自然的链路必然报「技能不存在」—— 同一个动作在工具侧落 hub、在开关侧查 dsh。
 * 默认值改哪边都不对（面板显式传 root，两边都依赖自己的默认），所以判定放到工具侧：
 * **没给 root 就在全部来源里按名字找胜出副本**，找到哪个就用哪个。
 *
 * 选取口径与 `skill_manager_read` 同一套（`markWinners` 已标出影子副本）：先取没被
 * `shadowedBy` 盖住的那一份（同名组里胜出的只有一个），都没有就取第一个。
 */
export async function locateSkillRoot(
  skillsOps: Record<string, (args: any) => Promise<any>>,
  name: string,
): Promise<SkillRootLookup> {
  const wanted = String(name || '').trim()
  if (wanted === '') return { ok: true, root: null, roots: [] }
  let state: any
  try {
    state = await skillsOps['skill-state']({})
  } catch {
    return { ok: false, root: null, roots: [] }
  }
  if (!state || state.ok === false) return { ok: false, root: null, roots: [] }
  const roots: string[] = []
  const hits: Array<{ rootKey: string; shadowedBy: string }> = []
  for (const root of (state.data && state.data.roots) || []) {
    roots.push(String(root.key || ''))
    for (const skill of root.skills || []) {
      // 与 list / read / save 同一套名字口径：`declaredName || name`，再比目录名。
      if (String(skill.declaredName || skill.name || '') !== wanted && String(skill.name || '') !== wanted) continue
      hits.push({
        rootKey: String(root.key || ''),
        shadowedBy: skill.shadowedBy && skill.shadowedBy.root ? String(skill.shadowedBy.root) : '',
      })
    }
  }
  const winner = hits.find((hit) => hit.shadowedBy === '') || hits[0]
  return { ok: true, root: winner ? winner.rootKey : null, roots }
}

export interface ToolDomainDeps {
  /**
   * 与宿主 defineTool **同签名的本地包装**（已包了采纳遥测，见 index.ts 的 trackAdoption）。
   *
   * 类型刻意用宿主自己的签名：重写成 `(options: unknown) => ToolDefinition` 会让每个调用点
   * 的 parameters / output 推断退化成 unknown —— 参数表写错也不再报错，等于把 18 个工具的
   * 声明校验一次性丢掉。宿主改签名时该红的地方照旧红，这才是要保住的东西。
   */
  defineTool: typeof hostDefineTool
  register(def: ToolDefinition): void
  /** 场景锁定守卫：返回拒绝文案，null = 未锁定。 */
  lockedSceneGuard(): Promise<string | null>
  /**
   * 这条工具现在**发给模型**吗（「模型工具表」关掉的与出厂默认关掉的都算不发）。
   *
   * 只为一件事：错误与回执里点名工具的那句（"用 `mcp_manager_list` 看清单"）在工具被关掉后
   * 就是把模型往墙上推 —— 它照那句去调，执行侧拦住它，白跑一趟还查不出原因。与两个目录的
   * `listToolVisible` 同一条判据，同步、只读缓存。
   */
  toolVisible(name: string): boolean
  /**
   * 同上一句，但按**这个 agent 手里有没有**判：全局开关 + 该 scope 的工具限制（人设的
   * `toolsDeny` 经官方 `tools.restrict` 装上的那层）两路并起来。
   *
   * 为什么需要它（2026-10-14 对抗性审查 P0-1/P1-8）：`toolVisible` 只读全局开关，于是
   * 「人设砍掉了 `mcp_manager_list`」这种情形下，工具回执与目录尾句照样点名一条**这个模型
   * 手里没有的**工具 —— 它照着去调，执行侧拦住，白跑一趟还查不出原因。判据与注入框架
   * `how` 行那一份同源（index.ts 的 `injectHiddenToolsFor`），不再定义第二份。
   *
   * 拿不到 agent 时**退化成 `toolVisible`**（只算全局开关）—— 问不了就不多隐藏，
   * 与"读不到 = 按还在手里算"同一条安全方向。
   */
  toolVisibleFor(name: string, agent: unknown): boolean
  /**
   * 开关类改动同步进当前场景档案（与 handlers 层同一套同步）。
   * 返回同步失败原因；undefined = 同步成功（工具回执据此决定是否带 WARN）。
   */
  syncSwitchToScene(op: string, args: any): Promise<string | null>
  /**
   * 注入边界提示：压制型预设（persona complete / 关闭运行时上下文）下本插件默认不注入，
   * 此时工具是模型唯一的入口。不说清的话，模型会把「看不到」当成「不存在」。
   */
  reachNoticeForAgent(roster: unknown, agentCtx: unknown, options: unknown): Promise<string>
  presetRoster(): unknown
  injectNoticeOptions(): unknown
  message(e: unknown): string
}
