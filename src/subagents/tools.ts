// src/subagents/tools.ts —— 模型工具：subagent_list / subagent_run（人设清单 + 官方 ctx.subagents 委派）。
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PersonaDoc, SubagentService } from './service.js'

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

export function defineSubagentListTool(subagents: { list(): Promise<PersonaDoc[]>; sceneLists(): Promise<string[][]> }): ToolDefinition {
  return {
    name: 'subagent_list',
    description: 'List available personas (pre-configured subagent profiles) with their descriptions. Call before subagent_run.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => text(String(v)) },
    async execute() {
      const { allowed, reason } = await filterBySceneBinding(await subagents.list(), await subagents.sceneLists())
      const lines = allowed.map((p) => '- ' + p.name + ' — ' + (p.description || '(无描述)'))
      return '人设子智能体（' + allowed.length + '）：\n' + (lines.join('\n') || '(无)') + (reason ? '\n注意：' + reason : '')
    },
  }
}

export function defineSubagentRunTool(subagents: SubagentService & { sceneLists(): Promise<string[][]> }): ToolDefinition {
  return {
    name: 'subagent_run',
    description: 'Run a named persona as a one-shot subagent: it receives the persona as its own system prompt, works on `task` in a fresh context, and returns only its final output. Discover personas with subagent_list first. Each run is stateless and ephemeral; it does not see this conversation.',
    parameters: {
      agent: { type: 'string', required: true, description: 'Persona name from subagent_list.' },
      task: { type: 'string', required: true, description: 'Complete, self-contained task for the subagent (include all context it needs).' },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => text(String(v)) },
    async execute(args: any, exec: any) {
      const name = String((args && args.agent) || '').trim()
      const task = String((args && args.task) || '').trim()
      if (!task) throw new Error('task 不能为空')
      const docs = await subagents.list()
      const { allowed, reason } = await filterBySceneBinding(docs, await subagents.sceneLists())
      const persona = allowed.find((p) => p.name === name)
      if (!persona) {
        throw new Error('人设不可用: ' + name + (reason ? '（' + reason + '）' : '（可用: ' + allowed.map((p) => p.name).join('、') || '(无)' + '）'))
      }
      const r = await subagents.runSerial(exec?.agent, persona, task, exec?.signal)
      const prefix = r.stopReason && r.stopReason !== 'completed' ? `[stopReason: ${r.stopReason}]\n` : ''
      return prefix + r.text
    },
  }
}
