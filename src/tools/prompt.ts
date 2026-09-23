// AGENTS.md 预设域的 model 工具（2026-09-19 从 index.ts 的注册区抽出）：
// prompt_manager_list / prompt_manager_apply。
//
// 模型可查、可切，**不能造 / 不能删** —— 避免模型乱删用户预设。

import { join } from 'node:path'
import { normalizePresetDescription } from '../prompts/service.js'
import { text, type ToolDomainDeps } from './deps.js'

export interface PromptToolDeps extends ToolDomainDeps {
  /**
   * 提示词预设域的 op 表（`../ops/prompts.ts`）。**必须走 op，不要直调 `promptsService.list()`**：
   * 「生效中」的判定在 `agentsmd-list` 里（启用的场景绑了预设时，只有那份算生效中，另给
   * `activeVia` 与引用清单），而服务层的 `active` 只是"内容与 ~/.dsh/AGENTS.md 逐字节相同"。
   * 直调服务 = 场景驱动时工具报一个与界面不同的答案（0.14.0 修掉的正是这句假话）。
   */
  promptOps: Record<string, (args: any) => Promise<any>>
  /** 应用预设（场景接管期间只放行场景绑定的那一份）。 */
  applyPresetGuarded(id: string): Promise<{ ok: true; id: string; backedUp?: boolean; viaScene?: boolean; scene?: string } | { ok: false; error: string }>
  promptsDir: string
}

export function buildPromptTools(deps: PromptToolDeps): void {
  const { defineTool, register } = deps
  register(defineTool({
    name: 'prompt_manager_list',
    description: 'List AGENTS.md presets (id, description, active state, file path); read that file for a preset body. The one in effect is in the「本机提示词」reminder, whose「来源：」line names the file. Defaults to the one in effect; all=true for the whole library.',
    parameters: {
      all: { type: 'boolean', description: 'Include inactive presets (default false).' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any, exec: any) {
      const showAll = Boolean(args && args.all === true)
      const r: any = await deps.promptOps['agentsmd-list']({})
      if (!r || r.ok === false) throw new Error((r && r.error) || '读取提示词预设失败')
      const all: any[] = r.presets || []
      // 默认只列「当前这份 ~/.dsh/AGENTS.md 是从哪个预设来的」（用户裁定 2026-09-16）。
      // 判定分两级：`active`（场景驱动时 = 场景绑的那份；否则 = 内容逐字节相同）优先，
      // 否则看服务层记下的「最近一次应用」—— 用户手改过全局文件时，第二级仍能给出答案，
      // 不必退化成全列（那会白烧上下文）。
      const active = all.filter((p) => p.active === true)
      const fallback = active.length ? active : all.filter((p) => p.lastApplied === true)
      const shown = showAll ? all : fallback
      // 三列各有用途：
      //   · 路径 —— 「名单 → 全文」的闭环。预设正文既不进提示词、也没有读取工具，给出文件
      //     路径让模型用宿主的文件工具读，比再造一个 read 工具省一条常驻 schema。
      //   · 描述 —— 0.14.0 加的。模型要能在预设之间做选择，而 id 本身不说明用途。描述在
      //     这里按 `DEFAULT_PRESET_DESC_MAX_LENGTH` 压行截断（与 MCP 备注同一条口径），
      //     因为它从这一版起是**常驻成本**而不是"只给使用者看"。
      //   · mark —— `activeVia` 必须打出来：`fileApplied` 但场景绑着别的，说明文件里那份
      //     已经**不生效**了。0.14.0 之前这里会错报成 [active]（那正是被修掉的那句假话）。
      const summary = shown.map((p) => {
        const mark = p.active
          ? (p.activeVia === 'scene' ? ' [active via scene]' : ' [active via file]')
          : (p.fileApplied
            ? ' [matches ~/.dsh/AGENTS.md, but a scene binding drives the baseline]'
            : (p.lastApplied ? ' [last applied — ~/.dsh/AGENTS.md has changed since]' : ''))
        const desc = normalizePresetDescription(p.description)
        return p.id + mark + ' | ' + (desc || '(no description)') + ' | ' + join(deps.promptsDir, p.id, 'AGENTS.md')
      })
      const header = 'AGENTS.md presets: ' + (showAll
        ? all.length + ' in the library'
        : fallback.length
          ? fallback.length + (active.length ? ' active' : ' last applied') + ' of ' + all.length +
            (fallback.length === all.length ? '' : ' (pass all=true for the whole library)')
          : '0 active of ' + all.length + ' (pass all=true for the whole library)') + '\n'
      // 同上：AGENTS.md 由官方 dsh-agent-instructions 行承载（极简没挂这一行），
      // 这一行不在时文件内容不会进上下文。
      const notice = await deps.reachNoticeForAgent(deps.presetRoster(), exec && exec.agent && exec.agent.ctx, deps.injectNoticeOptions())
      return header + (summary.join('\n') || '(none)') + '\n(DSH re-reads ~/.dsh/AGENTS.md every turn, so applying takes effect on the next turn.)' + notice
    },
  }))
  register(defineTool({
    name: 'prompt_manager_apply',
    description: 'Apply one AGENTS.md preset by id; effective next turn. If a scene drives the baseline this does NOT refuse — it rebinds that scene to the preset and re-syncs it, so tell the user which scene was rebound. A locked scene blocks the call. Only on the user\'s instruction.',
    parameters: {
      id: { type: 'string', required: true, description: 'Preset id (lowercase letters, digits, hyphens).' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args) {
      const blocked = await deps.lockedSceneGuard()
      if (blocked) throw new Error(blocked)
      const r = await deps.applyPresetGuarded(args.id)
      if (!r.ok) throw new Error(r.error)
      // 场景驱动时写的是「场景绑定」，回执必须说清改的是哪个场景 —— 只说「已应用到
      // AGENTS.md」会让模型对用户谎报（用户不知道自己的场景绑定被换掉了）。
      if (r.viaScene) {
        return 'OK: preset ' + args.id + ' is now the prompt binding of scene 「' + (r.scene || '') + '」 and the scene was re-synced (effective next turn; ~/.dsh/AGENTS.md now carries that scene\'s binding).'
      }
      // 生效时机与宿主行为对齐（index.ts 提示词服务一节考证过）：dsh-agent-instructions
      // 每个 pre-step 都 stat 比对版本，写文件即下一轮重读 —— 不是"下个会话"。说错了
      // 模型会劝用户重开会话，而其实下一句话就已经在新基线下跑。
      return 'OK: preset ' + args.id + ' applied to ~/.dsh/AGENTS.md — effective next turn' + (r.backedUp ? ' (previous backed up to __last-applied__)' : '')
    },
  }))
}
