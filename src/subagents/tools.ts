// src/subagents/tools.ts —— 模型工具：subagent_list / subagent_run（人设清单 + 官方 ctx.subagents 委派）。
// 本文件返回的是 **author 侧 tool 定义**（parameters 是 property-spec 形态），装配处必须经
// defineTool() 编译后再 register（C4：裸 register 会把未编译的参数声明直接发给模型 API）。
// 参数与 output schema 用 as const 保留字面量类型，defineTool 才能推断出参数表。
import type { PersonaDoc, SubagentService, ToolFilterDecision } from './service.js'

export function text(v: string) {
  return [{ type: 'text' as const, text: v }]
}

/** 场景绑定校验（设计 §3.3）：启用场景的 subagents 并集；空并集 = 全部可用。 */
export async function filterBySceneBinding(
  docs: PersonaDoc[],
  enabledSceneLists: string[][],
): Promise<{ allowed: PersonaDoc[]; reason: string | null }> {
  const bound = new Set(enabledSceneLists.flat())
  if (!bound.size) return { allowed: docs, reason: null }
  const allowed = docs.filter((d) => bound.has(d.name))
  return { allowed, reason: allowed.length ? null : `当前启用场景的子智能体绑定: ${[...bound].join('、')}` }
}

export function defineSubagentListTool(subagents: { list(): Promise<PersonaDoc[]>; sceneLists(): Promise<string[][]> }) {
  return {
    name: 'subagent_list',
    description: 'List available personas (pre-configured subagent profiles) with their descriptions. Call before subagent_run.',
    parameters: {
      scene: { type: 'string', description: 'Optional scene name filter (informational; the tool already reflects scene binding).' },
    } as const,
    output: {
      schema: { type: 'string' } as const,
      render: (_a: unknown, v: unknown) => text(String(v)),
    },
    async execute() {
      const { allowed, reason } = await filterBySceneBinding(await subagents.list(), await subagents.sceneLists())
      const lines = allowed.map((p) => '- ' + p.name + ' — ' + (p.description || '(无描述)'))
      return '人设子智能体（' + allowed.length + '）：\n' + (lines.join('\n') || '(无)') + (reason ? '\n注意：' + reason : '')
    },
  }
}

/** `subagent_run` 的依赖：服务本体 + 场景绑定 + 按当前预设决定工具限制。 */
export interface RunToolDeps extends SubagentService {
  sceneLists(): Promise<string[][]>
  /**
   * 按当前会话的 Agent 预设决定这次委派的工具限制（宿主侧实现：读预设名单 +
   * 枚举该预设的工具名，见 index.ts 的 subagentToolFilterFor）。
   */
  toolFilterFor?(persona: PersonaDoc, agentCtx: unknown): Promise<ToolFilterDecision>
}

export function defineSubagentRunTool(subagents: RunToolDeps) {
  return {
    name: 'subagent_run',
    description: 'Run a named persona as a one-shot subagent: it receives the persona as its own system prompt, works on `task` in a fresh context, and returns only its final output. Discover personas with subagent_list first. Each run is stateless and ephemeral; it does not see this conversation.',
    parameters: {
      agent: { type: 'string', required: true, description: 'Persona name from subagent_list.' },
      task: { type: 'string', required: true, description: 'Complete, self-contained task for the subagent (include all context it needs).' },
    } as const,
    output: {
      schema: { type: 'string' } as const,
      render: (_a: unknown, v: unknown) => text(String(v)),
    },
    async execute(args: { agent: string; task: string }, exec: any) {
      const name = String((args && args.agent) || '').trim()
      const task = String((args && args.task) || '').trim()
      if (!task) throw new Error('task 不能为空')
      // 官方 SubagentStartRequest.parent 必填：调用方 agent 缺失时给结构化错误，不把 undefined 透传下去。
      if (!exec || !exec.agent) throw new Error('缺少调用方 agent（exec.agent 不可用）：无法创建子代理运行')
      const docs = await subagents.list()
      const { allowed, reason } = await filterBySceneBinding(docs, await subagents.sceneLists())
      const persona = allowed.find((p) => p.name === name)
      if (!persona) {
        const available = allowed.map((p) => p.name).join('、') || '(无)'
        throw new Error('人设不可用: ' + name + (reason ? '（' + reason + '）' : '（可用: ' + available + '）'))
      }
      // 按当前会话的 Agent 预设算工具限制：判断不了当前预设、或名单里的工具已经不存在时，
      // 结论里会带一句实话，跟着结果一起返回——不静默改变限制的强度。
      const decision = typeof subagents.toolFilterFor === 'function'
        ? await subagents.toolFilterFor(persona, exec.agent && exec.agent.ctx)
        : undefined
      const r = await subagents.runSerial(exec.agent, persona, task, exec.signal, decision === undefined ? undefined : decision.filter)
      const prefix = r.stopReason && r.stopReason !== 'completed' ? `[stopReason: ${r.stopReason}]\n` : ''
      const note = decision && decision.note ? `⚠ ${decision.note}\n\n` : ''
      return note + prefix + r.text
    },
  }
}
