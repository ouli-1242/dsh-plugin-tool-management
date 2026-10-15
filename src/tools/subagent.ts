// 子智能体域的 model 工具（2026-09-19 从 index.ts 的注册区抽出；2026-09-23 合并）：
// subagent_manager_list / subagent_manager_run / _switch / _save。
//
// exec.agent / exec.signal 由工具运行时提供（parent 与取消信号的官方通道）。
//
// 两个工具**各自** try/catch：一个注册失败不该把另一个也带走，而且失败必须说得出
// 「是哪一个没注册上」——只打一行日志时，模型侧只会「查无此工具」、界面毫无痕迹。

import { defineSubagentManagerListTool, defineSubagentManagerRunTool } from '../subagents/tools.js'
import { text, type ToolDomainDeps } from './deps.js'

/**
 * 高频高级字段：`subagent_manager_save` 与 op 之间原样透传的那几个（省略 = 不出现 = op 侧保持）。
 *
 * 2026-10-15：从"面板专有"里挑出**配置人设时最常改的三类**交给模型 —— `model`（换模型）、
 * `continuable`（允许追问）、`tools` / `toolsDeny`（工具黑白名单）。此前模型看得见却改不了
 * （`subagent_manager_save` 只读回它们防止冲掉，旧注释把这条写成"留给面板"）。
 *
 * **刻意不加** `provider` / `reasoningEffort` / `catalogDepth`：都是低频（用户裁定
 * "使用频率高的才需要，太多功能反而冗余、浪费 token"）。`toolsByPreset`（嵌套对象）同理。
 */
const ADVANCED_FIELDS = ['model', 'continuable', 'tools', 'toolsDeny'] as const

function advancedArgs(args: any): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of ADVANCED_FIELDS) if (args && args[k] !== undefined) out[k] = args[k]
  return out
}

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
    // 与其余 19 个工具同一条注册通道：defineTool 负责编译 parameters（object root + required），
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
    // ⚠️ 必须 `Object.create`，**不能**用对象展开 —— 这是 0.15.0 起就存在的实际故障：
    // `deps.subagentService` 是 index.ts 用 `Object.assign(Object.create(真实服务), { ops })`
    // 造的**包装层**，只有 `ops` 落在自有属性上，`list` / `runSerial` 都挂在原型链上。对象展开
    // 只复制**自有可枚举**属性，展开后只剩 `{ ops }` —— 于是 `subagent_manager_run` 每次一进
    // execute 就在 `subagents.list()` 上抛 `subagents.list is not a function`（人设查不到就
    // 谈不上委派；0.19.0 测「允许追问」时才被暴露出来，因为那条通道同样要过这一步）。
    // `Object.create` 保持同一条原型链：`ops` 仍是审计过的那份，`list` / `runSerial` 回真实服务。
    // 与 index.ts 造这个包装层时用的是同一个写法（那边注释写的是「原型链回真实服务，其余读法一字不动」）。
    register(defineTool(defineSubagentManagerRunTool(Object.assign(
      Object.create(deps.subagentService),
      { sceneLists: deps.sceneLists, toolFilterFor: deps.toolFilterFor },
    ))))
  } catch (e) {
    recordFailure('subagent_manager_run', e)
  }
  // ── 管理侧的三个（启停 / 建 / 改）────────────────────────────────────────────
  // 与上面两个不同，这三个**不依赖** provider：动的只是 hub 里的人设文件与启停名单，
  // 宿主没挂 `dsh-subagent-*` 也照样该能用（恰恰那时更需要：能把人设建好、开关拨对，
  // 等 provider 回来就可用）。所以各自单独 try/catch，不与 `_run` 绑在一起失败。
  //
  // 参数表（2026-10-15 扩）：基础四项（name / description / body / output）之外，把高级字段
  // 也接上 —— 此前工具限制（tools / toolsDeny）与 provider / model / reasoningEffort /
  // catalogDepth / continuable 只读回防止冲掉、模型改不了，于是"给这个人设换个便宜模型"
  // 这类要求模型手里没有出口，描述里也没写"去面板"。现在能设的都在参数里说清，
  // 只留 `toolsByPreset`（嵌套对象，schema 带不动）给面板。
  const ops = () => deps.subagentService.ops as Record<string, (args: any) => Promise<any>>
  try {
    register(deps.defineTool({
      name: 'subagent_manager_switch',
      description: 'Enable or disable one persona. Only enabled personas appear in the「当前子智能体」catalog and can be given work. Reversible. Only when the user asks or approves.',
      parameters: {
        name: { type: 'string', required: true, description: 'Persona name.' },
        enabled: { type: 'boolean', required: true, description: 'true = enable, false = disable; omission is refused.' },
      },
      output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => text(String(v)) },
      async execute(args: any) {
        const blocked = await deps.lockedSceneGuard()
        if (blocked) throw new Error(blocked)
        const name = String((args && args.name) || '').trim()
        const r: any = await ops()['subagent-toggle']({ name, enabled: args.enabled === true })
        if (!r || r.ok === false) throw new Error((r && r.error) || '切换人设启停失败')
        // 场景内改开关要同步进当前场景档案（与 HTTP 层 syncsArchive 同一口径 —— 模型工具
        // 直接调 service op，绕过了那一层包装，所以这里自己叫一声）。
        const syncErr = await deps.syncSwitchToScene('subagent-toggle', { name, enabled: args.enabled === true })
        return 'OK: persona ' + name + ' ' + (args.enabled === true ? 'enabled' : 'disabled') +
          (syncErr ? '\nWARN: 当前场景档案未同步（' + syncErr + '）' : '')
      },
    }))
  } catch (e) {
    recordFailure('subagent_manager_switch', e)
  }
  try {
    register(deps.defineTool({
      name: 'subagent_manager_save',
      // 为什么不是直通 `subagent-update`：那个 op 走 serializePersona **整份重写**文件，
      // 缺席的字段一律按空处理。界面每次都带全量表单所以没事，模型只改一句 description
      // 却直通过去，就会把人设正文与工具限制一起冲掉。这里先读现状再合并 —— 合并发生在
      // 工具这一侧，op 的语义不动。
      //
      // 0.14.0：create 与 update 并成一条 upsert。判定也只能在这里做 —— `subagent-create`
      // 对同名是拒绝的、`subagent-update` 对不存在的名字报错，而模型手里的目录可能已经过期。
      //
      // 落点路径（`at ~/.dsh/tool-management/subagents/<name>.md`）删掉（2026-10-15 注入文本
      // 审查）：模型不按路径行动，这条工具也没有"给我路径"的用法（要读正文有 `list` +
      // 宿主的文件工具，而人设正文本来就是给它自己当系统提示词用的）。
      description: 'Create a persona, or update the one that already has this name — the receipt says which. Omitted fields keep their current values. Write `body` as who this is and how it judges its own work — not the steps or paths, those belong to the task; put hard output requirements in `output` (one per line), not buried in prose. The three settings changed most often are settable here too: `model` (route this persona to another model; \'\' = inherit), `continuable` (allow follow-up), and the tool allow/deny lists `tools`/`toolsDeny` ([] = clear). Other routing/limit fields stay panel-only. Blocked while the active scene is locked. Only on the user\'s instruction.',
      parameters: {
        name: { type: 'string', required: true, description: 'Persona name (= file name); ≤64 chars, one path segment — no / \\ or < > : " | ? *, no leading dot, no reserved device name, no trailing dot or space.' },
        description: { type: 'string', description: 'One-line routing description — this is what shows up in the delegation catalog. Required when creating; omit = keep.' },
        body: { type: 'string', description: 'Markdown role definition. Required when creating; omit = keep.' },
        output: { type: 'string', description: 'Output contract, one requirement per line. Empty string clears it; omit = keep.' },
        nextName: { type: 'string', description: 'New name (rename); re-points scene-profile bindings. Omit = keep. Refused if a persona already has that name.' },
        model: { type: 'string', description: "Model id for this persona's runs. '' = inherit the main session's model; omit = keep." },
        continuable: { type: 'boolean', description: 'true = this persona may be followed up (runs in the background and returns an agent id); false = one-shot. Omit = keep.' },
        tools: { type: 'array', items: { type: 'string' }, description: 'Tool allowlist — the subagent keeps only these tools. [] = clear; omit = keep.' },
        toolsDeny: { type: 'array', items: { type: 'string' }, description: 'Tool denylist — removed from the subagent; wins over the allowlist. [] = clear; omit = keep.' },
      },
      output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => text(String(v)) },
      async execute(args: any) {
        const blocked = await deps.lockedSceneGuard()
        if (blocked) throw new Error(blocked)
        const name = String((args && args.name) || '').trim()
        // 高级字段的形状校验：填错会在 op 侧**静默**（`serializePersona` 对非数组 `tools`
        // 是"当空处理"，等于把用户原有的名单清掉）。在这里先挡一句。
        if (args && args.continuable !== undefined && typeof args.continuable !== 'boolean') {
          throw new Error('continuable 必须是 true 或 false')
        }
        for (const k of ['tools', 'toolsDeny']) {
          if (args && args[k] !== undefined && !Array.isArray(args[k])) {
            throw new Error(k + ' 必须是字符串数组（[] = 清空）')
          }
        }
        const current: any = await ops()['subagent-get']({ name })
        if (!current || current.ok === false) {
          // 建的分支：description 与 body 都必填。`subagent-create` 自己会拒（人设名不合法 /
          // 已存在），但那两条是给用户看的 op 错；模型需要的是"这条工具要什么"。
          const description = String((args && args.description) || '').trim()
          const body = String((args && args.body) || '').trim()
          const missing = [
            description === '' ? 'description' : '',
            body === '' ? 'body' : '',
          ].filter((x) => x !== '')
          if (missing.length) throw new Error('新建人设必须给 ' + missing.join(' 与 ') + '（' + name + ' 还不存在）')
          const r: any = await ops()['subagent-create']({ name, description: args.description, body: args.body, output: args.output, ...advancedArgs(args) })
          if (!r || r.ok === false) throw new Error((r && r.error) || '创建人设失败')
          // 新建的人设默认停用（与 MCP / 技能同口径）。这句必须留：不说的话模型会直接去委派，
          // 然后收到"人设不可用"，而它并不知道自己少拨了一个开关。点名的 subagent_manager_switch
          // 在出厂默认名单里就是关着的 —— 关着就改说"用户启用后才能委派"，别指一条模型没有的
          // 工具（与 mcp/skill 的 listHint 同一条纪律）。
          const enableHint = deps.toolVisible('subagent_manager_switch')
            ? '（默认未启用，要委派它先 subagent_manager_switch）'
            : '（默认未启用，用户启用后才能委派）'
          return 'OK: persona ' + String(r.name || name) + ' created' + enableHint
        }
        const keep = current.persona || {}
        // 省略 = 保持（读回现值），给了 = 覆盖。高级字段走同一套 —— 不在工具侧合并，
        // `subagent-update` 的整份重写就会把没给的那些冲掉。
        const pick = (k: string, fallback: unknown): unknown => (args && args[k] !== undefined ? args[k] : fallback)
        const touched: string[] = []
        for (const k of ['nextName', 'description', 'body', 'output', ...ADVANCED_FIELDS]) {
          if (args && args[k] !== undefined) touched.push(k)
        }
        if (!touched.length) throw new Error('没有要改的东西：description / body / output / nextName 或任一高级字段至少给一个')
        const merged = {
          name,
          nextName: args.nextName,
          description: pick('description', String(keep.description ?? '')),
          body: pick('body', String(keep.body ?? '')),
          output: pick('output', Array.isArray(keep.output) ? keep.output.join('\n') : String(keep.output ?? '')),
          // ⚠️ 不加参数的三项（provider / reasoningEffort / catalogDepth）**只负责别冲掉**：
          // `subagent-update` 走 `serializePersona` 整份重写，少带一个就是静默清掉它。
          provider: String(keep.provider ?? ''),
          reasoningEffort: String(keep.reasoningEffort ?? ''),
          model: pick('model', String(keep.model ?? '')),
          continuable: pick('continuable', keep.continuable === true) === true,
          tools: pick('tools', keep.tools ?? []),
          toolsDeny: pick('toolsDeny', keep.toolsDeny ?? []),
          // `toolsByPreset` 也留给面板（嵌套对象，schema 带不动）：这里只负责别把它冲掉。
          toolsByPreset: keep.toolsByPreset ?? {},
          catalogDepth: keep.catalogDepth,
        }
        const r: any = await ops()['subagent-update'](merged)
        if (!r || r.ok === false) throw new Error((r && r.error) || '更新人设失败')
        return 'OK: persona ' + String(r.name || name) + ' updated（改了 ' + touched.join('、') + '）' +
          (r.renamedFrom ? ' — 原名「' + r.renamedFrom + '」,场景档案里的绑定已一起改名' : '')
      },
    }))
  } catch (e) {
    recordFailure('subagent_manager_save', e)
  }
}
