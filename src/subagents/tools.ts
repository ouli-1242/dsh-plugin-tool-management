// src/subagents/tools.ts —— 模型工具：subagent_manager_list / subagent_manager_run（人设清单 + 官方 ctx.subagents 委派）。
// 本文件返回的是 **author 侧 tool 定义**（parameters 是 property-spec 形态），装配处必须经
// defineTool() 编译后再 register —— 裸 register 会把未编译的参数声明直接发给模型 API。
// 参数与 output schema 用 as const 保留字面量类型，defineTool 才能推断出参数表。
import { CONTINUABLE_MARK } from './service.js'
import type { PersonaDoc, SubagentService, ToolFilterDecision } from './service.js'

/** 把一段文本包成工具回执要的内容块数组（各工具域共用这一份形状）。 */
export function text(v: string) {
  return [{ type: 'text' as const, text: v }]
}

/**
 * 可见性过滤（两道闸，按序）：
 *   ① 人设开关（全局）：停用的绝不进上下文 —— 即便它被场景绑定（场景启动时会自动把
 *      绑定的人设启用，见 archive-engine 的 applySubagentSwitches）。
 *   ② 场景绑定校验：启用场景的 subagents 并集；空并集 = 全部可用。
 * 之前只有②：全局默认所有子智能体都进上下文，没有开关可言。
 *
 * `includeUnavailable`**只给 `subagent_manager_list` 的
 * `all=true` 用**，两道闸一起放开：停用的人设此前**在任何地方都查不到** —— 注入目录只列可用的，
 * `subagent_manager_switch` 又默认关着，于是模型既发现不了它、也就无从提示用户去启用。
 * 另外三个 `*_list`（MCP / 技能 / 记忆）早就有 `all=true` 这个出口，人设是缺的那一个。
 * 注意放开的只是**可见性**：`subagent_manager_run` 仍然按完整两道闸判"能不能委派"，
 * 列出来 ≠ 可委派（回执里那句「人设不可用」照旧成立）。
 */
export function filterBySceneBinding(
  docs: PersonaDoc[],
  enabledSceneLists: string[][],
  includeUnavailable = false,
): { allowed: PersonaDoc[]; reason: string | null } {
  const live = includeUnavailable ? docs : docs.filter((d) => d.enabled !== false)
  const bound = new Set(enabledSceneLists.flat())
  if (includeUnavailable || !bound.size) return { allowed: live, reason: null }
  const allowed = live.filter((d) => bound.has(d.name))
  return { allowed, reason: allowed.length ? null : `the enabled scene's subagent bindings: ${[...bound].join(', ')}` }
}

/**
 * 本会话这一格怎么说：四层并值（覆盖 → 场景层 → 基线）优先；层里没话说时按
 * **全局口径**判（场景绑定 ∩ 全局启停）。
 *
 * 与旧版的关键差别：那时的会话覆盖只能"关"（场景绑定先过滤、覆盖再过滤
 * 两者叠加），现在**能救回**场景绑定的排除项 —— 进入场景之后还想开什么就开什么。
 */
function decideInSession(
  persona: PersonaDoc,
  flag: ((name: string) => boolean | undefined) | undefined,
  boundSet: ReadonlySet<string>,
): boolean {
  const f = flag ? flag(persona.name) : undefined
  if (typeof f === 'boolean') return f
  if (persona.enabled === false) return false
  return boundSet.size === 0 || boundSet.has(persona.name)
}

/** 从 exec 取本会话的某一格解析（解析失败 = 跟随全局，绝不把异常抛给模型）。 */
function flagOfExec(
  resolve: ((exec: unknown) => ((name: string) => boolean | undefined) | undefined) | undefined,
  exec: unknown,
): ((name: string) => boolean | undefined) | undefined {
  if (resolve === undefined) return undefined
  try { return resolve(exec) } catch { return undefined }
}

/** 从 exec 取本会话的人设**原始覆盖表**（只用于"本会话显式关了几条"那句统计）。 */
function overridesOfExec(
  resolve: ((exec: unknown) => Record<string, boolean> | undefined) | undefined,
  exec: unknown,
): Record<string, boolean> | undefined {
  if (resolve === undefined) return undefined
  try { return resolve(exec) } catch { return undefined }
}

/**
 * `subagent_manager_list` 的工具定义：列出人设目录。
 *
 * 与注入进上下文的「Current subagents」提醒是同一份目录的两种视图 —— 那条提醒只带当前可委派
 * 的那部分，这条工具负责给出全量（`all=true` 时含停用与场景外的），所以两边都必须能被模型找到。
 *
 * @param subagents 宿主侧注入的人设清单、场景绑定与会话层实现
 * @returns 可直接交给工具注册器的工具对象
 */
export function defineSubagentManagerListTool(subagents: {
  list(): Promise<PersonaDoc[]>
  /**
   * 启用场景绑定的人设名单（每组 = 一个启用场景的档案 `subagents` 段）。
   *
   * `agent`：会话钉住场景时取**那个场景**的绑定，而不是全局正在用的那个。
   */
  sceneLists(agent?: unknown): Promise<string[][]>
  /**
   * 本会话人设那一格的四层并值。`undefined`（函数本身）= 没有会话层。
   * 为什么按 `exec` 取而不是全局：会话层是**每个会话一套**，而这条工具是同一个注册实例。
   */
  flagFor?: (exec: unknown) => ((name: string) => boolean | undefined) | undefined
  /** 本会话的**原始覆盖表**：只用于"本会话显式关了几条"那句统计。 */
  overridesFor?: (exec: unknown) => Record<string, boolean> | undefined
  /**
   * 预设注入边界提示（可选）。人设目录段在 persona complete 的预设下被压制，此时模型
   * 只看得到工具、看不到任何人设 —— 挂上这条提示，它才不会把「被压制」读成「插件没有
   * 这项能力」。缺省（未注入）时行为与从前一致。
   */
  noticeFor?: (exec: unknown) => Promise<string>
}) {
  return {
    name: 'subagent_manager_list',
    // `depth-filtered` 删掉：注入深度是**注入侧**的实现细节
    // 模型看到的是"目录里有哪些人设"，`catalogDepth` 那个词对它没有任何可操作性。
    description: 'List personas (pre-configured subagent profiles) with descriptions and the file holding each body (read it with your file tools). The "Current subagents" reminder carries a view of the same catalog; call this for the always-current full list, or all=true to include disabled personas and ones outside the active scene.',
    parameters: {
      all: { type: 'boolean', description: 'Include disabled personas and ones outside the active scene (default false). Listed ≠ delegable: `run` still refuses those.' },
    } as const,
    output: {
      schema: { type: 'string' } as const,
      render: (_a: unknown, v: unknown) => text(String(v)),
    },
    async execute(args: unknown, exec: unknown) {
      const includeUnavailable = Boolean((args as { all?: unknown } | null)?.all === true)
      const docs = await subagents.list()
      const sceneLists = await subagents.sceneLists(exec)
      const bound = filterBySceneBinding(docs, sceneLists, includeUnavailable)
      // 会话层：四层并值优先（本会话显式开的**能救回**场景绑定之外的人设）
      // 层里没话说时按全局口径（场景绑定 ∩ 全局启停）判。`all=true` 放开可见性，
      // 但仍逐条标出"现在不可委派"。
      const flag = flagOfExec(subagents.flagFor, exec)
      const overrides = overridesOfExec(subagents.overridesFor, exec)
      const boundSet = new Set<string>(sceneLists.flat())
      const allowed = includeUnavailable
        ? docs
        : docs.filter((p) => decideInSession(p, flag, boundSet))
      const reason = allowed.length === 0 ? bound.reason : null
      // 这里**不再按深度过滤**：`catalogDepth` 只决定常驻目录
      // 注入到哪些会话，与"能不能委派"无关 —— 委派由官方决定（`dsh-tool-subagent` 默认能嵌套
      // 到 3 层）。此前按深度过滤等于把可用人设藏起来：目录不注入时模型只能靠这个工具查，
      // 而工具又不列全，结果是"明明能委派却查不到人设"。
      // `all=true` 时**标出哪些不可用**：只列名字的话，模型照样分不清哪个能直接委派
      // （与技能列表标 `shadowed-by:` 同一条理由 —— 列出来不等于能用）。
      // 每行带**正文文件路径**。这个域刻意没有 `subagent_manager_read`（正文是文件，不是
      // 另一份存储），但模型手里有通用文件工具 —— 不给路径，用户说「读一下这个人设的完整
      // 定义」时它只能回「做不到」。清单本来只有 description，正文在 `PersonaDoc.path`
      // （`service.ts` 扫目录时一起记下的绝对路径），这里原样带出去，零额外读取。
      //
      // 放在行尾而不是表头给一个目录模板：模型拼 `<dir>/<name>.md` 要多一步推理，路径里
      // 有空格或非 ASCII 目录名时还可能拼错；每条一个完整路径是零歧义，代价只在调用时付
      // （不是每轮的 schema 成本）。
      const lines = allowed.map((p) => '- ' + p.name + ' — ' + (p.description || '(no description)') +
        (p.continuable === true ? CONTINUABLE_MARK : '') +
        (includeUnavailable ? (!decideInSession(p, flag, boundSet) ? ' (disabled — turn it on first)' : '') : '') +
        (p.path ? ' · ' + p.path : ''))
      // 默认口径下有多少个没列出来（停用的 + 不在启用场景里的）：不报的话，模型看到一份短名单
      // 会当成"本机只有这些人设"。数量照报，与另外三个 list 的表头同一口径。
      const hiddenCount = includeUnavailable ? 0 : docs.length - allowed.length
      let notice = ''
      try {
        notice = typeof subagents.noticeFor === 'function' ? await subagents.noticeFor(exec) : ''
      } catch { notice = '' }
      // 会话层（`subagent_manager_list` 按会话过滤）：本会话关掉的人设
      // 与全局停用**同形**（默认不列、all=true 标 disabled），但换个对话就回来了 ——
      // 不说清的话，模型会把这份短名单当成「本机只有这些人设」。
      const offHere = overrides === undefined
        ? 0
        : Object.keys(overrides).filter((name) => {
          const doc = docs.find((d) => d.name === name)
          return overrides[name] === false && doc !== undefined && doc.enabled !== false
        }).length
      const header = 'persona subagents (' + allowed.length + ')' +
        (hiddenCount > 0 ? ' (' + hiddenCount + ' more are disabled or outside the current scene; pass all=true to see them)' : '') +
        (offHere > 0 ? ' (' + offHere + ' switched off here only)' : '') + ':\n'
      return header + (lines.join('\n') || '(none)') + (reason ? '\nnote: ' + reason : '') + notice
    },
  }
}

/** `subagent_manager_run` 的依赖：服务本体 + 场景绑定 + 按当前预设决定工具限制。 */
export interface RunToolDeps extends SubagentService {
  /** 启用场景绑定的人设名单（`agent` 用于会话进入的场景）。 */
  sceneLists(agent?: unknown): Promise<string[][]>
  /** 本会话人设那一格的四层并值：与 list 工具同一份判据。 */
  flagFor?: (exec: unknown) => ((name: string) => boolean | undefined) | undefined
  /**
   * 按当前会话的 Agent 预设决定这次委派的工具限制（宿主侧实现：读预设名单 +
   * 枚举该预设的工具名，见 index.ts 的 subagentToolFilterFor）。
   */
  toolFilterFor?(persona: PersonaDoc, agentCtx: unknown): Promise<ToolFilterDecision>
}

/**
 * `subagent_manager_run` 的工具定义：把一个人设当子智能体跑一次。
 *
 * @param subagents 宿主侧注入的人设清单、场景绑定与工具限制实现
 * @returns 可直接交给工具注册器的工具对象
 */
export function defineSubagentManagerRunTool(subagents: RunToolDeps) {
  return {
    name: 'subagent_manager_run',
    // 描述按「是什么 → 两种模式 → 何时用（含与官方两个委派工具的分界）→ 何时改用别的」组织。
    //
    // 与官方 `subagent` / `subagent_fork` 的分界必须写明：上下文里只有「先在这里选人设…
    // 用 subagent_manager_run 执行」这一句时，模型读完 README 仍会选 `subagent_fork`
    // （它能继承已读内容、不必复述）。人设通道也有 fork（`inherit`）之后，差别只剩
    // 「要不要后台跑」一件事 —— 所以规则能写成"贴合人设的一律走这里"。
    //
    // 「何时不用」写成**带替代工具**的具体清单（具体路径 → Read；找定义 → Grep/Glob），
    // 比笼统说"这个很贵"有用得多（参照 Claude Code 的 `AgentTool/prompt.ts:232-240`）。
    //
    // 篇幅纪律：工具表每轮都发，描述里每一句都在付 token。`how` 行
    // （context-inject.ts 的 `DOMAIN_FRAME.subagents`）已经逐字说过一遍，两份都在每轮上下文里
    // = 同一件事付两次 token，所以留注入那份（它出现在"正在选工具"的那一刻），这里只留参数段
    // 独有的信息。判据是"删掉的那句在描述里已经有了吗"。
    // 代价如实记下：子智能体域被关掉、或走压制型预设时上下文里没有那条 how 行，模型只剩本
    // 描述与 `agent` 参数说明 —— 够它认出这条是带人设的委派通道，但"没有人设贴合时才用官方
    // 那两个"这层分界就没人说了。
    //
    // `inherit` 那句"轮中委派拿不到当前轮"必须留 —— 它是这条参数唯一会让人写错 task 的地方。
    description: 'Run a named persona as a subagent: it gets the persona as its system prompt, works on `task`, and returns only its final output. A persona marked `(continuable)` returns an agent id and runs in the background — continue it with `send_message`.\n\nBy default the child cannot see this conversation, so `task` must be self-contained; `inherit: true` also hands it this conversation\'s **finished** turns (never the current one). `task` = the goal plus the context it needs; leave method and output format to the persona.\n\nUse it when the work matches a persona in the "Current subagents" reminder and the detail should not sit in your own context. Not for reading a file (Read), finding a definition (Grep/Glob), or touching two or three files.',
    parameters: {
      agent: { type: 'string', required: true, description: 'Persona name — see the "Current subagents" reminder.' },
      // `task` 的说明只留"这是什么"：描述里已经写过"把方法与输出格式留给人设"，
      // 模型填这个参数时两处都在手上 —— 同一件事付两次 token。
      task: { type: 'string', required: true, description: 'The task for the subagent.' },
      inherit: { type: 'boolean', description: 'Inherit this conversation\'s finished turns (current turn excluded). Default false.' },
    } as const,
    output: {
      schema: { type: 'string' } as const,
      render: (_a: unknown, v: unknown) => text(String(v)),
    },
    async execute(args: { agent: string; task: string; inherit?: boolean }, exec: any) {
      const name = String((args && args.agent) || '').trim()
      const task = String((args && args.task) || '').trim()
      const inherit = args && args.inherit === true
      if (!task) throw new Error('task must not be empty')
      // 官方 SubagentStartRequest.parent 必填：调用方 agent 缺失时给结构化错误，不把 undefined 透传下去。
      if (!exec || !exec.agent) throw new Error('no caller agent (exec.agent is unavailable): cannot create a subagent run')
      const docs = await subagents.list()
      const sceneLists = await subagents.sceneLists(exec)
      const bound = filterBySceneBinding(docs, sceneLists)
      // 会话层：四层并值优先（本会话显式开的能救回场景绑定之外的人设）
      // 层里没话说时按全局口径（场景绑定 ∩ 全局启停）。看不见的人设**调不动** ——
      // 否则会话层就等于只改了目录（对 MCP 用的是同一条口径）。
      const flag = flagOfExec(subagents.flagFor, exec)
      const boundSet = new Set<string>(sceneLists.flat())
      const allowed = docs.filter((p) => decideInSession(p, flag, boundSet))
      const reason = allowed.length === 0 ? bound.reason : null
      const persona = allowed.find((p) => p.name === name)
      if (!persona) {
        // 关掉的人设要单独说清 —— 否则模型会以为"这个人设不存在"，转而去编一个名字。
        const offHere = docs.some((p) => p.name === name)
        if (offHere) throw new Error('persona unavailable: ' + name + ' (turned off — here, by its global switch, or outside the active scene; the user can enable it)')
        const available = allowed.map((p) => p.name).join(', ') || '(none)'
        throw new Error('persona unavailable: ' + name + (reason ? ' (' + reason + ')' : ' (available: ' + available + ')'))
      }
      // 这里**刻意没有**"深度不够就拒绝"的检查。
      // 它此前基于一个错误假设：以为传 `maxDepth: 1` 会让子会话再委派必然失败。实际上官方
      // 的 `maxDepth` 只用**宿主配置**那一档（0.2.1 默认 1）、provider 只在**传了值**时才校验，
      // 所以能不能继续委派问官方就行。那个检查的唯一净效果是让**我们的**工具比官方严 ——
      // 同一个子会话里官方工具能委派、我们的被自己拦下 —— 而用户真想禁止嵌套也禁止不了
      // （官方工具照样能）。
      // `catalogDepth` 现在只管"目录注入到哪些会话"，不参与委派可行性判断。
      // 按当前会话的 Agent 预设算工具限制：判断不了当前预设、或名单里的工具已经不存在时，
      // 结论里会带一句实话，跟着结果一起返回——不静默改变限制的强度。
      const decision = typeof subagents.toolFilterFor === 'function'
        ? await subagents.toolFilterFor(persona, exec.agent && exec.agent.ctx)
        : undefined
      const r = await subagents.runSerial(exec.agent, persona, task, exec.signal, decision === undefined ? undefined : decision.filter, inherit)
      const prefix = r.stopReason && r.stopReason !== 'completed' ? `[stopReason: ${r.stopReason}]\n` : ''
      const note = decision && decision.note ? `⚠ ${decision.note}\n\n` : ''
      // 允许追问通道（人设 `continuable: true`）：产出是**异步**到达的，这里只拿到子会话 id。
      // 回执必须把"id + 产出怎么回来 + 怎么追问 + 怎么中止"写全 —— 少写一句，模型就会把
      // "没拿到结果"读成"委派失败"而重试一次（那会再起一个后台子代理，白白翻倍）。
      // "产出怎么回来"说的是**宿主的结算通知**（0.2.1 核实 `dsh-subagent/lib/types/manager.js`
      // 的 `notifySettlement` → `createSettlementMessage`）：子代理结束时父代理会收到一条
      // `subagent-settled` 通知，含收尾一行说明 + 子代理最终的非空 text 块（+ 结构化结果与
      // 诊断）。它自己发回来的 `send_message` 是**补充**（`withContinuableReturnGuidance`
      // 要求它在收尾前把自包含结果发给父代理），不是产出的唯一来路 —— 回执不能只说前者，
      // 否则子代理没主动发消息时父代理会把"还没收到结果"当成"还在跑"。
      if (r.continuable === true) {
        return note + 'started the continuable subagent "' + name + '" (running in the background)\n'
          + 'agent_id: ' + r.runId + '\n\n'
          + 'you will get a notification carrying its final output when it settles. To follow up: '
          + 'send_message({ agent_id: "' + r.runId + '", message: "..." }), '
          + 'To stop it: interrupt_agent({ agent_id: "' + r.runId + '" }).'
      }
      return note + prefix + r.text
    },
  }
}
