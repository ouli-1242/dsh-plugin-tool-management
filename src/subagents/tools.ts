// src/subagents/tools.ts —— 模型工具：subagent_manager_list / subagent_manager_run（人设清单 + 官方 ctx.subagents 委派）。
// 本文件返回的是 **author 侧 tool 定义**（parameters 是 property-spec 形态），装配处必须经
// defineTool() 编译后再 register（C4：裸 register 会把未编译的参数声明直接发给模型 API）。
// 参数与 output schema 用 as const 保留字面量类型，defineTool 才能推断出参数表。
import type { PersonaDoc, SubagentService, ToolFilterDecision } from './service.js'
// 深度探针（`subagentDepthOf`）与目录判据（`catalogInjectedAt`）都不再需要：
// 2026-09-17 方案 A 之后，这两个工具都不再看会话深度 —— 委派由官方决定（默认能嵌套到 3 层），
// `catalogDepth` 只管常驻目录注入到哪些会话。

export function text(v: string) {
  return [{ type: 'text' as const, text: v }]
}

/**
 * 可见性过滤（两道闸，按序）：
 *   ① 人设开关（全局）：停用的绝不进上下文 —— 即便它被场景绑定（场景启动时会自动把
 *      绑定的人设启用，见 archive-engine 的 applySubagentSwitches）。
 *   ② 场景绑定校验（设计 §3.3）：启用场景的 subagents 并集；空并集 = 全部可用。
 * 之前只有②：全局默认所有子智能体都进上下文，没有开关可言。
 */
export async function filterBySceneBinding(
  docs: PersonaDoc[],
  enabledSceneLists: string[][],
): Promise<{ allowed: PersonaDoc[]; reason: string | null }> {
  const live = docs.filter((d) => d.enabled !== false)
  const bound = new Set(enabledSceneLists.flat())
  if (!bound.size) return { allowed: live, reason: null }
  const allowed = live.filter((d) => bound.has(d.name))
  return { allowed, reason: allowed.length ? null : `当前启用场景的子智能体绑定: ${[...bound].join('、')}` }
}

export function defineSubagentManagerListTool(subagents: {
  list(): Promise<PersonaDoc[]>
  sceneLists(): Promise<string[][]>
  /**
   * 预设注入边界提示（可选）。人设目录段在 persona complete 的预设下被压制，此时模型
   * 只看得到工具、看不到任何人设 —— 挂上这条提示，它才不会把「被压制」读成「插件没有
   * 这项能力」。缺省（未注入）时行为与从前一致。
   */
  noticeFor?: (exec: unknown) => Promise<string>
}) {
  return {
    name: 'subagent_manager_list',
    description: 'List personas (pre-configured subagent profiles) with their descriptions. The「可委派的子智能体」reminder carries the same catalog; call this for the always-current full list before subagent_manager_run.',
    parameters: {} as const,
    output: {
      schema: { type: 'string' } as const,
      render: (_a: unknown, v: unknown) => text(String(v)),
    },
    async execute(_args: unknown, exec: unknown) {
      const { allowed, reason } = await filterBySceneBinding(await subagents.list(), await subagents.sceneLists())
      // 这里**不再按深度过滤**（2026-09-17 用户裁定，方案 A）：`catalogDepth` 只决定常驻目录
      // 注入到哪些会话，与"能不能委派"无关 —— 委派由官方决定（`dsh-tool-subagent` 默认能嵌套
      // 到 3 层）。此前按深度过滤等于把可用人设藏起来：目录不注入时模型只能靠这个工具查，
      // 而工具又不列全，结果是"明明能委派却查不到人设"。
      const lines = allowed.map((p) => '- ' + p.name + ' — ' + (p.description || '(无描述)'))
      let notice = ''
      try {
        notice = typeof subagents.noticeFor === 'function' ? await subagents.noticeFor(exec) : ''
      } catch { notice = '' }
      return '人设子智能体（' + allowed.length + '）：\n' + (lines.join('\n') || '(无)') + (reason ? '\n注意：' + reason : '') + notice
    },
  }
}

/** `subagent_manager_run` 的依赖：服务本体 + 场景绑定 + 按当前预设决定工具限制。 */
export interface RunToolDeps extends SubagentService {
  sceneLists(): Promise<string[][]>
  /**
   * 按当前会话的 Agent 预设决定这次委派的工具限制（宿主侧实现：读预设名单 +
   * 枚举该预设的工具名，见 index.ts 的 subagentToolFilterFor）。
   */
  toolFilterFor?(persona: PersonaDoc, agentCtx: unknown): Promise<ToolFilterDecision>
}

export function defineSubagentManagerRunTool(subagents: RunToolDeps) {
  return {
    name: 'subagent_manager_run',
    // 描述按「是什么 → 两种模式 → 何时用（含与官方两个委派工具的分界）→ 何时改用别的」组织。
    // 2026-09-17 补了**分界规则**与 `inherit`：此前上下文里虽然注入了人设目录与「用
    // subagent_manager_run 执行」，但没有任何一句话说明它和官方 `subagent` / `subagent_fork`
    // 何时该用谁 —— 本机实测（session-ee722e23）模型读完 README 后选了官方 `subagent_fork`
    // （fork 能继承已读内容、不必复述）。现在人设通道也有 fork（`inherit`），分界只剩
    // 「要不要后台跑」一件事，所以规则能写成"贴合人设的一律走这里"。
    //
    // 「何时不用」那一段保留（2026-09-17，用户采纳的四条里的第 6 条）：参照 Claude Code 的
    // Agent 工具（`AgentTool/prompt.ts:232-240`），把"不该用"写成**带替代工具**的具体清单
    // （具体路径→Read；找定义→Grep/Glob），比笼统说"这个很贵"有用得多。
    //
    // 2026-09-23（用户裁定）：与官方两个委派工具的**分界规则**从描述里删掉 —— 注入通道的
    // `how` 行（context-inject.ts 的 `DOMAIN_FRAME.subagents`）已经逐字说过一遍，而两份都在
    // 每轮上下文里 = 同一件事付两次 token。留注入那份（它出现在"正在选工具"的那一刻）。
    // 代价如实记下：子智能体域被关掉、或走压制型预设时上下文里没有那条 how 行，模型只剩本
    // 描述与 `agent` 参数说明（"Persona name from subagent_manager_list"）—— 够它认出这条是
    // 带人设的委派通道，但"没有人设贴合时才用官方那两个"这层分界就没人说了。
    description: 'Run a named persona as a subagent: it gets the persona as its own system prompt, works on `task`, and returns only its final output.\n\nModes: by default a fresh child that cannot see this conversation, so `task` must be self-contained. With `inherit: true` it also gets this conversation\'s **finished** turns (like the host\'s `subagent_fork`) — the current turn is never included, so a mid-turn hand-off still needs a self-contained `task`.\n\n`task` = the goal plus the context it needs; leave method and output format to the persona.\n\nUse it when the work matches a persona in the「可委派的子智能体」reminder (a review, an investigation, a piece of writing) and the detail should not sit in your own context. Not for reading a file (Read), finding a definition (Grep/Glob), or touching two or three files.',
    parameters: {
      agent: { type: 'string', required: true, description: 'Persona name from subagent_manager_list.' },
      task: { type: 'string', required: true, description: 'The task for the subagent: the goal plus the context it needs. Self-contained by default; with inherit: true it only needs to state what is new. Leave method and output format to the persona.' },
      inherit: { type: 'boolean', description: 'Let the subagent inherit this conversation\'s finished turns, like the host\'s subagent_fork (default false = a fresh child that cannot see this conversation). Only finished turns are inherited — a delegation made mid-turn cannot pass the current turn\'s content, so write `task` as if it were self-contained.' },
    } as const,
    output: {
      schema: { type: 'string' } as const,
      render: (_a: unknown, v: unknown) => text(String(v)),
    },
    async execute(args: { agent: string; task: string; inherit?: boolean }, exec: any) {
      const name = String((args && args.agent) || '').trim()
      const task = String((args && args.task) || '').trim()
      const inherit = args && args.inherit === true
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
      // 这里**刻意没有**"深度不够就拒绝"的检查（2026-09-17 用户裁定，方案 A）。
      // 它此前基于一个错误假设：以为传 `maxDepth: 1` 会让子会话再委派必然失败。实际上官方
      // `dsh-tool-subagent` 的默认是 **3**、provider 只在**传了值**时才校验，所以子代理本来
      // 就能继续嵌套。那个检查的唯一净效果是让**我们的**工具比官方严 —— 同一个子会话里官方
      // 工具能委派、我们的被自己拦下 —— 而用户真想禁止嵌套也禁止不了（官方工具照样能）。
      // `catalogDepth` 现在只管"目录注入到哪些会话"，不参与委派可行性判断。
      // 按当前会话的 Agent 预设算工具限制：判断不了当前预设、或名单里的工具已经不存在时，
      // 结论里会带一句实话，跟着结果一起返回——不静默改变限制的强度。
      const decision = typeof subagents.toolFilterFor === 'function'
        ? await subagents.toolFilterFor(persona, exec.agent && exec.agent.ctx)
        : undefined
      const r = await subagents.runSerial(exec.agent, persona, task, exec.signal, decision === undefined ? undefined : decision.filter, inherit)
      const prefix = r.stopReason && r.stopReason !== 'completed' ? `[stopReason: ${r.stopReason}]\n` : ''
      const note = decision && decision.note ? `⚠ ${decision.note}\n\n` : ''
      return note + prefix + r.text
    },
  }
}
