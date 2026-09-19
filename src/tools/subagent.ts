// 子智能体域的 model 工具（2026-09-19 从 index.ts 的注册区抽出）：
// subagent_manager_list / subagent_manager_run。
//
// exec.agent / exec.signal 由工具运行时提供（parent 与取消信号的官方通道）。
//
// 两个工具**各自** try/catch：一个注册失败不该把另一个也带走，而且失败必须说得出
// 「是哪一个没注册上」——只打一行日志时，模型侧只会「查无此工具」、界面毫无痕迹。

import { defineSubagentManagerListTool, defineSubagentManagerRunTool } from '../subagents/tools.js'
import type { ToolDomainDeps } from './deps.js'

export interface SubagentToolDeps extends ToolDomainDeps {
  // 三个字段的形状由 subagents/tools.ts 的两个 define*Tool 定义，这里只是原样透传；
  // 在 deps 里重声明一遍会与官方签名形成第二份真相，改一处忘一处。
  subagentService: any
  sceneLists: any
  toolFilterFor: any
  /**
   * 注册失败的记录（可变，用对象持有）：`list` 会被子智能体页的黄条与 preset-tools 的
   * `unavailable` 读走，`logged` 保证控制台只报一次。
   */
  failures: { list: Array<{ name: string; reason: string }>; logged: boolean }
}

export function buildSubagentTools(deps: SubagentToolDeps): void {
  const { defineTool, register } = deps
  const recordFailure = (name: string, e: unknown): void => {
    deps.failures.list.push({ name, reason: deps.message(e) })
    if (deps.failures.logged) return
    deps.failures.logged = true
    console.error('[dsh-plugin-tool-management] subagent tool registration failed:', name, deps.message(e))
  }
  try {
    // 与其余 12 个工具同一条注册通道：defineTool 负责编译 parameters（object root + required），
    // 裸 register 会把未编译的参数声明直接发给模型 API。
    register(defineTool(defineSubagentManagerListTool({
      list: () => deps.subagentService.list(),
      sceneLists: deps.sceneLists,
      // 与其余发现型工具同口径：压制型预设下不注入时，人设目录不在模型上下文里，
      // 只有工具可用。挂上边界提示，模型才不会把「看不到人设」当成「没有人设」。
      noticeFor: (exec: unknown) => deps.reachNoticeForAgent(
        deps.presetRoster(),
        exec && (exec as { agent?: { ctx?: unknown } }).agent && (exec as { agent?: { ctx?: unknown } }).agent!.ctx,
        deps.injectNoticeOptions(),
      ),
    })))
  } catch (e) {
    recordFailure('subagent_manager_list', e)
  }
  try {
    // 工具限制按**当前会话的 Agent 预设**下发：父会话跑在哪个预设，就用那个预设那一行的
    // 白/黑名单（`decideToolFilter`），名单里已消失的工具名会被丢掉并在结果里如实说明。
    register(defineTool(defineSubagentManagerRunTool({ ...deps.subagentService, sceneLists: deps.sceneLists, toolFilterFor: deps.toolFilterFor })))
  } catch (e) {
    recordFailure('subagent_manager_run', e)
  }
}
