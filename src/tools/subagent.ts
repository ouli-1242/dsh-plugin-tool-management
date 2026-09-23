// 子智能体域的 model 工具（2026-09-19 从 index.ts 的注册区抽出；2026-09-23 合并）：
// subagent_manager_list / subagent_manager_run / _set_enabled / _save。
//
// exec.agent / exec.signal 由工具运行时提供（parent 与取消信号的官方通道）。
//
// 两个工具**各自** try/catch：一个注册失败不该把另一个也带走，而且失败必须说得出
// 「是哪一个没注册上」——只打一行日志时，模型侧只会「查无此工具」、界面毫无痕迹。

import { defineSubagentManagerListTool, defineSubagentManagerRunTool } from '../subagents/tools.js'
import { text, type ToolDomainDeps } from './deps.js'

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
    register(defineTool(defineSubagentManagerRunTool({ ...deps.subagentService, sceneLists: deps.sceneLists, toolFilterFor: deps.toolFilterFor })))
  } catch (e) {
    recordFailure('subagent_manager_run', e)
  }
  // ── 管理侧的三个（启停 / 建 / 改）────────────────────────────────────────────
  // 与上面两个不同，这三个**不依赖** provider：动的只是 hub 里的人设文件与启停名单，
  // 宿主没挂 `dsh-subagent-*` 也照样该能用（恰恰那时更需要：能把人设建好、开关拨对，
  // 等 provider 回来就可用）。所以各自单独 try/catch，不与 `_run` 绑在一起失败。
  //
  // 参数表刻意只给 name / description / body / output 四个：工具限制（tools / toolsDeny /
  // toolsByPreset）与 provider/model 留给面板。理由不是"怕模型不会填"，而是填错的后果
  // 不对称 —— 一个错误的 toolsDeny 会静默改变子代理能做什么，而模型看不到自己改对了没有。
  const ops = () => deps.subagentService.ops as Record<string, (args: any) => Promise<any>>
  try {
    register(deps.defineTool({
      name: 'subagent_manager_set_enabled',
      description: 'Enable or disable one persona. Only enabled personas appear in the「可委派的子智能体」catalog and can be given work. Reversible, and the file is untouched. Only when the user asks or approves.',
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
    recordFailure('subagent_manager_set_enabled', e)
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
      description: 'Create a persona at ~/.dsh/tool-management/subagents/<name>.md, or update the one that already has this name — the receipt says which. Omitted fields keep their current values. Write `body` as who this is and how it judges its own work — not the steps or paths, those belong to the task; put hard output requirements in `output` (one per line), not buried in prose. Only on the user\'s explicit request.',
      parameters: {
        name: { type: 'string', required: true, description: 'Persona name (= file name); ≤64 chars, no path separators or < > : " | ? *.' },
        description: { type: 'string', description: 'One-line routing description — this is what shows up in the delegation catalog. Required when creating; omit = keep.' },
        body: { type: 'string', description: 'Markdown role definition. Required when creating; omit = keep.' },
        output: { type: 'string', description: 'Output contract, one requirement per line. Empty string clears it; omit = keep.' },
        nextName: { type: 'string', description: 'New name (rename); re-points scene-profile bindings. Omit = keep. Refused if a persona already has that name.' },
      },
      output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => text(String(v)) },
      async execute(args: any) {
        const blocked = await deps.lockedSceneGuard()
        if (blocked) throw new Error(blocked)
        const name = String((args && args.name) || '').trim()
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
          const r: any = await ops()['subagent-create']({ name, description: args.description, body: args.body, output: args.output })
          if (!r || r.ok === false) throw new Error((r && r.error) || '创建人设失败')
          // 新建的人设默认停用（与 MCP / 技能同口径）。这句必须留：不说的话模型会直接去委派，
          // 然后收到"人设不可用"，而它并不知道自己少拨了一个开关。
          return 'OK: persona ' + String(r.name || name) + ' created（默认未启用,要委派它先 subagent_manager_set_enabled）'
        }
        const keep = current.persona || {}
        const touched: string[] = []
        if (args.nextName !== undefined) touched.push('nextName')
        if (args.description !== undefined) touched.push('description')
        if (args.body !== undefined) touched.push('body')
        if (args.output !== undefined) touched.push('output')
        if (!touched.length) throw new Error('没有要改的东西：nextName / description / body / output 至少给一个')
        const merged = {
          name,
          nextName: args.nextName,
          description: args.description !== undefined ? String(args.description) : String(keep.description ?? ''),
          body: args.body !== undefined ? String(args.body) : String(keep.body ?? ''),
          output: args.output !== undefined ? String(args.output) : (Array.isArray(keep.output) ? keep.output.join('\n') : String(keep.output ?? '')),
          provider: keep.provider ?? '',
          model: keep.model ?? '',
          // ⚠️ 必须带回来：`subagent-update` 走 `serializePersona` **整份重写**，少带一个字段
          // 就是静默清掉它。`reasoningEffort` 是 0.14.0 新增的，最容易在这里被漏掉 ——
          // 模型只改一句 body，用户配好的思考强度就没了，而且没有任何提示。
          reasoningEffort: keep.reasoningEffort ?? '',
          tools: keep.tools ?? [],
          toolsDeny: keep.toolsDeny ?? [],
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
