// model 工具（ctx.tools.register + defineTool）各域共用的依赖与 helper。
//
// 为什么单独一个文件：五个域的工具都要同一批依赖（defineTool 包装、注册出口、场景锁定
// 守卫、注入边界提示），各写一份会漂移。

import { defineTool as hostDefineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

export type TextPart = Array<{ type: 'text'; text: string }>

/** 每个工具 output.render 的统一出口：把字符串包成宿主要的 content 数组。 */
export function text(value: string): TextPart {
  return [{ type: 'text', text: value }]
}

/**
 * 名单渲染：超过 `TOOL_NAME_LIST_CAP` 项就截断，并把总数写在后面（"等 N 项"）。
 *
 * 为什么两个地方都要它：`scene_manager_list` 用它列档案，`scene_manager_save` 用它
 * 在回执里回显"这一次替换挤掉了什么"。两处都必须**点名、不能只给数量** —— 只给数量
 * 答不了"我这次给出去的段会不会盖掉原来勾着的那些"，而那正是会静默出错的地方。
 * 截断则是因为这些文字都要进上下文，不能无上限。
 */
export const TOOL_NAME_LIST_CAP = 6
export function toolNameList(list: readonly string[]): string {
  if (!list.length) return '空'
  const head = list.slice(0, TOOL_NAME_LIST_CAP).join('、')
  return list.length > TOOL_NAME_LIST_CAP ? head + ' 等 ' + list.length + ' 项' : head
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
