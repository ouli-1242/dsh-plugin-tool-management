// AGENTS.md 预设域的 model 工具（2026-09-19 从 index.ts 的注册区抽出）：
// prompt_manager_list / prompt_manager_apply。
//
// 模型可查、可切；**不能造** —— 预设正文是用户自己写的一份长文（`AGENTS.md`），
// 模型没有创建入口，要新建只能由用户在面板里写。
//
// 删除在 `tools/remove.ts` 的 `prompt_manager_remove`（2026-10-15 加）。此前这里写的是
// 「不能造 / **不能删** —— 避免模型乱删用户预设」，那条理由针对的是**不可恢复**的删除：
// 预设正文是用户手写的、删了就得重写。回收站把它的前提消掉了 —— 五条 `*_manager_remove`
// 一律「进回收站、可恢复、需用户指令、过场景冻结守卫」，永久删除仍只留在面板。
// 换句话说：**能删的是可恢复的那一步，不可逆的那一步照旧不给模型。**

import { join } from 'node:path'
import { normalizePresetDescription } from '../prompts/service.js'
import { hasPromptOverride, type SessionScope } from '../scope/scope-overrides.js'
import { sessionScopeOf, text, type ToolDomainDeps } from './deps.js'

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
  /**
   * 取消应用（0.20.0）：把 `~/.dsh/AGENTS.md` 恢复到这一串应用/取消开始之前的状态 ——
   * 起点有内容就写回、起点没有文件就把文件删掉（`removed: true`）。场景正驱动基线时
   * op 自己拒绝（撤销也会被下一次场景同步写回去），这里只负责把拒绝原因原样抛给模型，
   * 与界面给用户的出路同一句。
   */
  unapplyPreset(): Promise<{ ok: boolean; error?: string; removed?: boolean }>
  promptsDir: string
}

export function buildPromptTools(deps: PromptToolDeps): void {
  const { defineTool, register } = deps
  register(defineTool({
    name: 'prompt_manager_list',
    // 那句 `(that reminder is absent when the preset carries the official instructions line)`
    // 删掉（2026-10-15 注入文本审查）：模型**观测不到**"official instructions line"这个条件，
    // 拿它做不了任何决定 —— reminder 在不在，它抬头就能看见，不必由描述来预告。
    description: 'List AGENTS.md presets (id, description, active state, file path); read that file for a body. The one in effect is in the "Current prompt" reminder. Defaults to the one in effect; all=true for the whole library.',
    parameters: {
      all: { type: 'boolean', description: 'Include inactive presets (default false).' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any, exec: any) {
      const showAll = Boolean(args && args.all === true)
      const r: any = await deps.promptOps['agentsmd-list']({})
      if (!r || r.ok === false) throw new Error((r && r.error) || 'failed to read the AGENTS.md presets')
      const all: any[] = r.presets || []
      // 默认只列「这份 AGENTS.md 来自哪个预设」（用户裁定 2026-09-16）。
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
      // 会话层（0.21.2，决策 5）：提示词**不进**会话域 —— 预设写的是全局基线 ~/.dsh/AGENTS.md，
      // 宿主每轮只读一份。会话能改的是生效场景，而场景绑哪个预设是场景自己的事。
      // 这句只在模型真会读错时才值钱：它会拿这份清单回答「本会话现在用哪份提示词」，
      // 而本会话钉住场景时，答案来自那个场景的绑定，不是这份 active 标记。
      const pinned = sessionScopeOf(deps, exec && exec.agent)?.scope?.scene
      const sessionLine = pinned === undefined
        ? '\n(prompts are global: this scope has no preset of its own)'
        : '\n(prompts are global; this scope pins scene "' + pinned + '", so the preset in effect here is that scene\'s binding — not necessarily the [active] one below)'
      const header = 'AGENTS.md presets: ' + (showAll
        ? all.length + ' in the library'
        : fallback.length
          ? fallback.length + (active.length ? ' active' : ' last applied') + ' of ' + all.length +
            (fallback.length === all.length ? '' : ' (pass all=true for the whole library)')
          : '0 active of ' + all.length + ' (pass all=true for the whole library)') + sessionLine + '\n'
      // 同上：AGENTS.md 由官方 dsh-agent-instructions 行承载（极简没挂这一行），
      // 这一行不在时文件内容不会进上下文。
      const notice = await deps.reachNoticeForAgent(deps.presetRoster(), exec && exec.agent && exec.agent.ctx, deps.injectNoticeOptions())
      return header + (summary.join('\n') || '(none)') + notice
    },
  }))
  register(defineTool({
    name: 'prompt_manager_apply',
    description: 'Apply one AGENTS.md preset by id; effective next turn. When a scene drives the baseline this does not refuse — it rebinds that scene, so tell the user which one. A locked scene blocks the call. apply=false cancels instead: AGENTS.md goes back to what it was before this run of applies (removed if there was none), which a scene-driven baseline refuses — rebind the scene instead. Only on the user\'s instruction.',
    parameters: {
      // `id` 从 required 摘掉（2026-10-15 smoke-test P1-5）：描述一直写着 "Ignored when
      // apply=false"，schema 却把它标成必填 —— 模型照描述「取消不用给 id」操作，先被 schema
      // 拒掉（missing required property "id"），只能编一个 dummy id 才过得去。条件必填由
      // execute 里那句守卫表达，与 `skill_manager_switch` 的 enabled / prefer 同一形状。
      id: { type: 'string', description: 'Preset id (lowercase letters, digits, hyphens). Required unless apply=false.' },
      apply: { type: 'boolean', description: 'Omit or true = apply the preset in `id`; false = cancel — undo the run of applies (no `id` needed).' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any, exec: any) {
      const blocked = await deps.lockedSceneGuard()
      if (blocked) throw new Error(blocked)
      // 会话层（0.21.2，决策 5）：提示词永远全局。本会话钉了场景时，这里改的是**那个场景**
      // 的绑定（`applyPresetGuarded` 的 viaScene 分支）—— 别的对话只要没钉同一个场景就不受影响，
      // 但这不是「本会话的提示词」，回执必须按那条路说清。
      // 提示词**不进**会话域（决策 5），所以这里没有 scope 参数，也**不做**
      // `requireGlobalScope` 守卫（2026-10-21 审查 P2-2）：守卫读 `args.scope`，而参数表里
      // 没有这个字段 —— 模型按 schema 不可能传它，守卫只在「模型自己编了一个未声明参数」时
      // 才触发，等于靠运气。留着这行还让 deps.ts 的清单以为这条被守住了。
      // 提示词确实只有全局一层，参数表已经把这件事说完了。
      const scoped = sessionScopeOf(deps, exec && exec.agent)
      const pinned = scoped?.scope?.scene
      if (args.apply === false) {
        // 取消方向：`agentsmd-unapply` 自带两条护栏（场景驱动时拒绝、没有链起点时给确定
        // 错误码），原样透传。回执要说清恢复成哪种 —— 起点没有文件时是**删文件**，
        // 不说的话用户以为 AGENTS.md 还在（0.19.1 界面弹窗报的就是这两种）。
        const r = await deps.unapplyPreset()
        if (!r.ok) throw new Error(r.error || 'failed to cancel the application')
        return (r.removed === true
          ? 'OK: application cancelled — ~/.dsh/AGENTS.md did not exist before the run started, so the file was removed (effective next turn).'
          : 'OK: application cancelled — ~/.dsh/AGENTS.md is back to what it was before the run started (effective next turn).') +
          promptScopeTail(scoped?.scope)
      }
      const id = String((args && args.id) || '').trim()
      if (id === '') throw new Error('missing argument: id (only optional when apply=false cancels)')
      const r = await deps.applyPresetGuarded(id)
      if (!r.ok) throw new Error(r.error)
      // 场景驱动时写的是「场景绑定」，回执必须说清改的是哪个场景 —— 只说「已应用到
      // AGENTS.md」会让模型对用户谎报（用户不知道自己的场景绑定被换掉了）。
      if (r.viaScene) {
        return 'OK: preset ' + id + ' is now the prompt binding of scene "' + (r.scene || '') + '" and the scene was re-synced (effective next turn; ~/.dsh/AGENTS.md now carries that scene\'s binding).' +
          // 会话层：这个场景可能只是**本会话**钉住的那个（别的对话钉别的场景），所以「绑到了场景」
          // 与「所有对话都变成这份提示词」不是一回事。
          (pinned === undefined || pinned !== String(r.scene || '')
            ? ''
            : '\nnote: that is this scope\'s pinned scene. Other conversations only pick this up if they pin the same scene; the machine-wide baseline is whatever the global scene binds.')
      }
      // 生效时机与宿主行为对齐（index.ts 提示词服务一节考证过）：dsh-agent-instructions
      // 每个 pre-step 都 stat 比对版本，写文件即下一轮重读 —— 不是"下个会话"。说错了
      // 模型会劝用户重开会话，而其实下一句话就已经在新基线下跑。
      return 'OK: preset ' + id + ' applied to ~/.dsh/AGENTS.md — effective next turn' + (r.backedUp ? ' (previous backed up to __last-applied__)' : '') +
        // 成功分支也要带尾注（2026-10-21 审查 P0-2）：`applyPresetGuarded` 走的是**全局**
        // driver，本会话钉着的场景/会话级覆盖都不在其中 —— 不带的话，模型会照回执说
        // 「提示词已换」，而用户在这个对话里看到的是原来那份。
        promptScopeTail(scoped?.scope)
    },
  }))
}

/**
 * 提示词回执的会话尾注（0.21.2，决策 5；2026-10-21 审查 P0-2 由「钉场景」扩成三路）。
 *
 * 提示词**不进**会话域：预设写的是全局基线 `~/.dsh/AGENTS.md`，宿主每轮只读一份。
 * 但**生效来源**按会话走 —— 本会话可能钉了场景（`scene-preset`），也可能带会话级
 * 提示词覆盖（`session-preset` / `session-content`），两者都排在 `global-file` 之上。
 * 不说清的话，模型会回一句「提示词已换」，而用户在自己的对话里看到的是别的。
 *
 * 为什么必须三路：`prompt_manager_apply` 走的是**全局** driver（`applyPresetGuarded`），
 * 会话钉的场景不在其中。「全局没有场景 + 本会话钉了场景」是日常形态，而这条路此前
 * 只在 `apply=false` 分支带了尾注，成功分支漏了 —— 用户按回执去验证，必然发现没变。
 */
function promptScopeTail(scope: SessionScope | undefined): string {
  if (scope === undefined) return ''
  if (hasPromptOverride(scope)) {
    return '\nnote: prompts are global — this changed the machine-wide baseline. This scope carries its own prompt override, so what it gets here stays the same until that override is cleared.'
  }
  const pinned = scope.scene
  if (pinned === undefined) return ''
  return '\nnote: prompts are global — this changed the machine-wide baseline. This scope pins scene "' + pinned + '", so what it actually gets is that scene\'s binding.'
}
