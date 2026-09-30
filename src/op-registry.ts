// HTTP op 登记表 —— 每个 op 一条判据声明，机器可数的那一份。
//
// 为什么要有这个文件：门禁今天靠**五张手写清单**（`WRITE_OPS`、`SENSITIVE_OPS`、
// `guardLockedOps`、`syncSceneArchiveOnSwitch`、`annotateLocked` 的 op 列表）。它们各自
// 回答一个不同的问题，作用在同一批 op 名字上，中间没有任何约束 —— 新加一个 op 只写
// handler，编译器一声不吭。这条纪律反复失守过四次（0.6.0 / 0.7.0 / 0.10.0 两次），
// 症状都不是报错，而是"没配令牌也能写"或"锁定的场景能被改"。
//
// 判据（一个 op 可以同时占多条，所以这是**标志集合**不是单一分类）：
//   serviceWrite  写门禁的一部分，但**由所属 service 自报**（`writeOps`）。这里登记一份
//                 是为了让对账能双向查：service 加了写 op 而登记表没条目 → 红；登记表有条目
//                 而 service 不再自报 → 也红。两边谁改了都必须动另一边。
//   write         需要访问令牌。判据是"会不会改**宿主或外部系统**的状态" —— 注意这**不是**
//                 "会不会写盘"：见下方 readonly 那一段。
//   writeWhen     仅对"两态 op"（一个名字兼读与写）生效：**这次调用**算不算写。判据不成立
//                 = 纯读，免令牌也不记流水。没带这一项的 op，标了 write 就一律按写处理。
//   sensitive     会泄露明文凭据 / 完整配置。**必须**带对的令牌，没配令牌就一律拒绝。
//   frozen        任一场景 locked=true 时整体拒绝（五个管理域冻结）。
//   frozenScope   frozen 的三种口径，默认 'all'：
//                   all          只要有场景锁着就拒。
//                   self-scene   只挡"被锁的那个场景"自己（别的场景照常）。
//                   active-scene 只在"锁着的场景正在生效"时拒（它能把当前场景清空）。
//   syncsArchive  成功后把改动同步进当前场景档案。与 frozen **正交**：锁定冻结全部写操作，
//                 这条只是把页面开关的意图也写进档案。
//   annotatesLock 响应里附加 anyLocked / activeScene（界面横幅的数据源）。
//   readonly      明确声明"这条就是只读，上面几项都不需要"。**归不进上面任何一条的必须显式
//                 写这一条** —— 漏登记和"确实只读"在编译器眼里长得一样，这正是四次失守的成因。
//
// readonly 的判据边界（原样保留在 request-gate.ts 的注释里，这里重申一遍）：
// 有若干只读 op **会写盘** —— `history-list` / `history-sessions` 每次写工作区快照，
// `rules-list` / `rules-read` / `rules-diagnose` 整份覆盖写 `memories-index.json`，
// `mcpm-list` / `mcpm-tools` 回写 `mcp-known-tools.json`。它们都**不**算写操作：判据是
// "会不会改宿主或外部系统的状态"，而上面那些写的是插件自己的侧车（丢了可重建）。
// 想要它们也带令牌就显式改成 write，别靠"读操作带副作用"这句话推。

/** frozen 的三种口径，见文件头。 */
export type FrozenScope = 'all' | 'self-scene' | 'active-scene'

export interface OpClass {
  serviceWrite?: boolean
  write?: boolean
  sensitive?: boolean
  frozen?: boolean
  frozenScope?: FrozenScope
  syncsArchive?: boolean
  annotatesLock?: boolean
  readonly?: boolean
  /**
   * **两态 op** 的写判据：同一个 op 名同时承担读与写。标了 `write` 又带这一项的 op，
   * 只有判据成立才按写门禁（要求令牌、记流水）；不成立 = 这次是纯读，免令牌、不记流水。
   * 没带这一项的 op，只要标了 `write` 就一律按写处理 —— 即"不知道就别放行"。
   *
   * 为什么必须声明在**这里**：这四条 op 的读侧与写侧共用一个名字，于是整条 op 被列进
   * `WRITE_OPS`，读侧也一起被拦（界面表现是"没填令牌时整块设置消失"）。此前靠 index.ts
   * 里一句手写的 `readOnlyCall` 打补丁，判据只认 `args.set === true` —— 而 `tool-table`
   * 的 `presetSave` / `presetDelete` **不写 `hidden`**、绕过 `set`，于是配了令牌的宿主上
   * 一次免令牌请求就能改侧车（审查 F2，0.17.0 修）。判据搬进登记表后，写侧与读侧的定义
   * 挨着放，加一个新的写触发键时不会漏在另一个文件里。
   *
   * 判据抛错按"写"处理（fail-closed）：见 `isReadCall`。
   */
  writeWhen?: (args: Record<string, unknown>) => boolean
}

export const OP_REGISTRY: Readonly<Record<string, OpClass>> = Object.freeze({

  // ── MCP 域（17）────────────────────────────────────────────────────────────
  'mcpm-list': { annotatesLock: true },
  // reveal 返回**未打码**的凭据。它是读操作，但按写门禁 —— 局域网暴露的端口上，令牌对
  // 明文凭据必须是最后一道防线，而不只对着写操作。
  'mcpm-reveal': { write: true, sensitive: true, annotatesLock: true },
  'mcpm-export': { write: true, sensitive: true },
  'mcpm-add': { write: true, frozen: true },
  'mcpm-edit': { write: true, frozen: true },
  'mcpm-remove': { write: true, frozen: true },
  'mcpm-import': { write: true, frozen: true },
  'mcpm-compact': { write: true, frozen: true },
  'mcpm-note': { write: true, frozen: true },
  'mcpm-settings': { write: true, frozen: true, writeWhen: (a) => a.set === true },
  'mcpm-set-enabled': { write: true, frozen: true, syncsArchive: true },
  'mcpm-set-all': { write: true, frozen: true, syncsArchive: true },
  'mcpm-tool-enabled': { write: true, frozen: true, syncsArchive: true },
  // restart 不是"只重连"：实现里两次 `writePatch`（先强制停用、轮询、再按重启前状态恢复），
  // 恢复失败会停在停用态。锁定期间它是唯一能落盘改补丁的入口，所以按写门禁、但**不冻结**
  // —— 它同时是"卡住了重连一下"这条恢复路径。
  'mcpm-restart': { write: true },
  // 为了拿实时工具表会临时启用目标服务器、结束后恢复原状（两次 writePatch），恢复失败还
  // 会停在启用态 —— 是写不是读。（0.6.0 / 0.7.0 各有漏列前科，见文件头。）
  'mcpm-tools-refresh': { write: true },
  'mcpm-tools': { readonly: true },
  // 配置体检：只读补丁文件 + 一次 PATH 查询（`where`/`which`，不执行配置里的命令）。
  // 回的是检查项 id + 少量**打码后**的字段值（URL 查询串走 `maskUrlQuery`，与 `mcpm-list`
  // 同口径；`command` 明文，理由同 `mcpm-list`：命令名不是凭据，`args` 两边都不回）。
  // 与 `mcpm-list` 同档，不带令牌 —— 0.16.6 之前这里回的是 URL 原文，等于让免令牌的请求
  // 拿到 `?api_key=…`，绕过了 `mcpm-reveal` 那道防线（审查 P0-5，0.17.0 修）。
  'mcpm-inspect': { readonly: true },

  // ── 技能域（22，含内联的 skill-open）───────────────────────────────────────
  'skill-state': { annotatesLock: true },
  'skill-detail': { readonly: true },
  'skill-browse': { readonly: true },
  'skill-enable': { serviceWrite: true, frozen: true, syncsArchive: true },
  'skill-disable': { serviceWrite: true, frozen: true, syncsArchive: true },
  'skill-set-all': { serviceWrite: true, frozen: true, syncsArchive: true },
  'skill-source-enable': { serviceWrite: true, frozen: true, syncsArchive: true },
  'skill-source-disable': { serviceWrite: true, frozen: true, syncsArchive: true },
  // 移除 / 恢复来源会改写本地来源状态（候选清单随之变化，模型侧的技能目录也变），是写。
  'skill-source-remove': { serviceWrite: true, frozen: true },
  'skill-source-restore': { serviceWrite: true, frozen: true },
  'skill-prefer': { serviceWrite: true, frozen: true },
  'skill-unprefer': { serviceWrite: true, frozen: true },
  'skill-create': { serviceWrite: true, frozen: true },
  // 改写 hub 里已存在的那一份技能（`skill_manager_save` 的改分支）。与 create 同规格：
  // 都是往 hub 落文件。它**不动**官方根里的技能 —— 那层边界在 service 的胜出者判定里。
  'skill-update': { serviceWrite: true, frozen: true },
  'skill-import': { serviceWrite: true, frozen: true },
  'skill-upload': { serviceWrite: true, frozen: true },
  'skill-delete': { serviceWrite: true, frozen: true },
  'skill-trash-restore': { serviceWrite: true, frozen: true },
  'skill-trash-delete': { serviceWrite: true, frozen: true },
  'skill-custom-add': { serviceWrite: true, frozen: true },
  'skill-custom-remove': { serviceWrite: true, frozen: true },
  // 打开系统编辑器改文件：不改宿主状态，但它是"界面按钮"性质的写入口，按写门禁。
  'skill-open': { write: true },

  // ── 记忆与场景域（27：memories 24 + archive-engine 3）──────────────────────
  'rules-list': { readonly: true },
  'rules-read': { readonly: true },
  'rules-budget': { readonly: true },
  'rules-diagnose': { readonly: true },
  'rules-trash-list': { readonly: true },
  'rules-create': { serviceWrite: true, frozen: true },
  'rules-update': { serviceWrite: true, frozen: true },
  'rules-remove': { serviceWrite: true, frozen: true },
  'rules-restore': { serviceWrite: true, frozen: true },
  'rules-toggle': { serviceWrite: true, frozen: true },
  'rules-import': { serviceWrite: true, frozen: true },
  'rules-attach': { serviceWrite: true, frozen: true },
  'rules-detach': { serviceWrite: true, frozen: true },
  'rules-trash-remove': { serviceWrite: true, frozen: true },
  'rules-set-index': { serviceWrite: true, frozen: true },
  // 场景启停本身要可用（否则进不去也出不来），但它能把**当前场景清空** —— 而"当前场景已
  // 锁定"是模型侧 `lockedSceneGuard` 唯一的判据，场景一空它就返回 null，四个写工具全放开，
  // 运行时却仍是那个场景的档案态（2026-09-19 审计 T-32）。所以单独一刀，见 frozenScope。
  'rules-set-active': { serviceWrite: true, frozen: true, frozenScope: 'active-scene' },
  'rules-remove-scene': { serviceWrite: true, frozen: true, frozenScope: 'self-scene' },
  'rules-rebind-prompt': { serviceWrite: true },
  // 锁定开关自己**不能**被冻结挡住，否则锁上了解不开。
  'rules-scene-lock': { serviceWrite: true },
  // ⚠️ 口径不一致，登记时才看得出来：`rules-remove-scene` 冻结，而 `rules-create-scene` /
  // `rules-update-scene` 不冻结 —— 都是改场景集合，三缺一。今天按现状登记（A1 只登记不改
  // 行为），要统一得单独判一次，记在这里别丢。
  'rules-create-scene': { serviceWrite: true },
  'rules-update-scene': { serviceWrite: true },
  'scene-trash-list': { readonly: true },
  'scene-trash-restore': { serviceWrite: true },
  'scene-trash-delete': { serviceWrite: true },
  'scene-mode-get': { readonly: true },
  // 进入场景前的「会改什么」预览：与 `scene-mode-set` 走同一批纯计划函数，但只读现状、
  // 不落盘也不应用 —— 登记成 readonly 就是这条承诺的机器可查版本（改这个 op 的人
  // 若往里加了 apply* / saveSlice，登记表与实现就对不上了）。
  'scene-mode-preview': { readonly: true },
  'scene-archive-save': { serviceWrite: true, frozen: true, frozenScope: 'self-scene' },
  'scene-mode-set': { serviceWrite: true },

  // ── 子智能体域（10）────────────────────────────────────────────────────────
  'subagent-list': { annotatesLock: true },
  'subagent-get': { readonly: true },
  'subagent-trash-list': { readonly: true },
  'subagent-create': { serviceWrite: true, frozen: true },
  'subagent-update': { serviceWrite: true, frozen: true },
  'subagent-delete': { serviceWrite: true, frozen: true },
  'subagent-import': { serviceWrite: true, frozen: true },
  'subagent-toggle': { serviceWrite: true, frozen: true, syncsArchive: true },
  'subagent-trash-restore': { serviceWrite: true, frozen: true },
  'subagent-trash-delete': { serviceWrite: true, frozen: true },

  // ── 提示词域（11）──────────────────────────────────────────────────────────
  'agentsmd-list': { annotatesLock: true },
  'agentsmd-read': { readonly: true },
  'agentsmd-get-current': { readonly: true },
  'agentsmd-trash-list': { readonly: true },
  'agentsmd-create': { write: true, frozen: true },
  'agentsmd-update': { write: true, frozen: true },
  // apply 写全局 AGENTS.md = 换掉生效基线。
  'agentsmd-apply': { write: true, frozen: true },
  'agentsmd-remove': { write: true, frozen: true },
  'agentsmd-import': { write: true, frozen: true },
  'agentsmd-trash-restore': { write: true, frozen: true },
  'agentsmd-trash-delete': { write: true, frozen: true },

  // ── 快捷提示词域（8）───────────────────────────────────────────────────────
  // 只改插件自己的侧车（`hub/quick-prompts/`），不写 AGENTS.md、不进场景、不进注入；
  // 但"改用户存好的东西"按本文件口径就是写操作（判据不是"会不会写盘"，见文件头）。
  // frozen 与五个管理域同一条：**锁定期间整体只读**（用户裁定 2026-09-30，不给它开例外，
  // 免得"锁定"这件事要分两套话术解释）。
  'quickprompt-list': { readonly: true },
  'quickprompt-trash-list': { readonly: true },
  'quickprompt-create': { write: true, frozen: true },
  'quickprompt-update': { write: true, frozen: true },
  // 那颗开关改的是"这条在不在对话框 `/` 菜单里出现"，动的仍是用户自己的东西 ——
  // 与 create/update 同档，不因为它不碰正文就免了令牌。`syncsArchive`：场景绑了快捷词时，
  // 在场景里手动开关一条要跟着改进那份勾选集（未绑定的场景不跟，见 index.ts 那一支的注释）。
  'quickprompt-toggle': { write: true, frozen: true, syncsArchive: true },
  'quickprompt-remove': { write: true, frozen: true },
  'quickprompt-trash-restore': { write: true, frozen: true },
  'quickprompt-trash-delete': { write: true, frozen: true },

  // ── 历史会话域（16）────────────────────────────────────────────────────────
  'history-list': { readonly: true },
  'history-sessions': { readonly: true },
  'history-export-defaults': { readonly: true },
  'history-retention-get': { readonly: true },
  'dir-list': { readonly: true },
  'history-archive': { write: true },
  'history-unarchive': { write: true },
  'history-delete': { write: true },
  'history-archive-batch': { write: true },
  'history-unarchive-batch': { write: true },
  'history-delete-batch': { write: true },
  'history-retention-set': { write: true },
  'history-import': { write: true },
  'history-export': { write: true },
  // 通用导出：往**用户指定的目录**写文件，按写操作门禁。
  'bundle-export': { write: true },
  // 新增一条宿主工作区登记 —— 改的是宿主侧的登记，不是插件自己的侧车。
  'history-workspace-register': { write: true },

  // ── 兼容 / 注入 / 备份 / 流水 / 迁移快照（11）────────────────────────────────
  'compat-status': { readonly: true },
  // 「最近改动」流水的读侧：只读 hub 里的 `audit.jsonl`（内容只有对象名，见 audit-log.ts 第 ① 条）。
  'audit-list': { readonly: true },
  // 清空流水：删的是插件自己的文件，但它是**一次改动**（清完还会留下一条 `audit-clear`），按写门禁。
  'audit-clear': { write: true },
  // 整机迁移快照（0.15.0 C2）。export 标 sensitive 与 `mcpm-export` 同档：`includeSecrets` 时
  // 它交出的就是明文凭据；不配令牌时不设防（判据见 http-fence.ts 的 secretOpRejection）。
  'snapshot-export': { write: true, sensitive: true },
  'snapshot-preview': { readonly: true },
  // 逐域调各域自己的 import op —— 那些 op 本来就被场景冻结挡着，这里不重复标 frozen，
  // 免得两道锁口径分家（预览与执行都走同一套门禁）。
  'snapshot-import': { write: true },
  'feature-overview': { readonly: true },
  'preset-reach': { readonly: true },
  // 全部注入域的当前正文**全文**都从这里出去。今天不带令牌就能读，是这批只读里披露面最大的一条；
  // 要不要上门禁是产品决定，登记在这里是为了让它可数。
  'injection-live': { readonly: true },
  'backups-list': { readonly: true },
  // 注入设置（各域开关 / 压制型预设口径）写侧车。它是"配置"不是"宿主状态"，但改的是
  // 投递语义，按写操作门禁。读侧（不带 `set:true`）只回当前设置，是纯读。
  'inject-settings': { write: true, writeWhen: (a) => a.set === true },
  // 模型工具表（哪些工具根本不发给模型）也写侧车，改的是每轮请求的内容 —— 同上按写门禁。
  // 三条写触发：`set` 换名单；`presetSave` / `presetDelete` 只动 `presets`、**不动 `hidden`**
  // —— 后两条不经过 `set`，只认 `set` 的判据会把它们当成读放行（审查 F2）。
  'tool-table': {
    write: true,
    writeWhen: (a) => a.set === true || a.presetSave !== undefined || a.presetDelete !== undefined,
  },
  // 场景页的界面设置（进入场景前要不要弹「会改什么」的预览卡）：写侧车，按写门禁。
  // **刻意不冻结**：它只是界面提示，锁着场景的人在场景页照样该能关掉提醒 —— 冻结的是五个
  // 管理域的改动，不是这个页面的显示偏好（判据见文件头 write/frozen 两段的边界）。
  'scene-settings': { write: true, writeWhen: (a) => a.set === true },
  // 斜杠命令入口的开关（侧车 `slash-settings.json`）：与 `scene-settings` 同规格 —— 写侧车所以
  // 按写门禁，但**刻意不冻结**（关掉一个界面入口不属于五个管理域的改动）。读侧不带 `set` 是纯读：
  // 客户端 boot 时必问一次决定挂不挂 `/` 菜单，那一次不能要令牌，否则没配令牌的宿主上这个功能
  // 永远出不来。
  'slash-settings': { write: true, writeWhen: (a) => a.set === true },
  // 清理 patch 备份：删磁盘文件（备份里含明文凭据副本），按写操作门禁。
  'backups-clean': { write: true },

  // ── 场景候选源（4）与内联（1）──────────────────────────────────────────────
  'model-candidates': { readonly: true },
  // 思考强度档位：要问 adapter（`llm.resolveModelInfo`，异步、可能联网），但只读不写任何状态
  // —— 与 model-candidates 同一档。它不进 scene-inventory，是**按需**拉取的。
  'model-reasoning': { readonly: true },
  'scene-inventory': { readonly: true },
  // 跨域悬空引用体检：只读对账（索引走 readIndexSync，权威集合各读一次）。
  'state-doctor': { readonly: true },
  // preset-tools 是只读枚举，但枚举会为预设建立 standing mount（官方语义：每进程只挂一次）。
  // 未授权调用者不该触发挂载 —— 按写门禁。
  'preset-tools': { write: true },
  'plugin-version': { readonly: true },
})

/** 登记表里所有带某个标志的 op（按登记顺序，不去排序 —— 顺序稳定便于比对 diff）。 */
export function opsWith(flag: 'write' | 'sensitive' | 'syncsArchive' | 'annotatesLock'): string[] {
  const out: string[] = []
  for (const [op, cls] of Object.entries(OP_REGISTRY)) if (cls[flag] === true) out.push(op)
  return out
}

/** 冻结类 op。`scope` 省略 = 全部三种口径都要挡。 */
export function frozenOps(scope?: FrozenScope): string[] {
  const out: string[] = []
  for (const [op, cls] of Object.entries(OP_REGISTRY)) {
    if (cls.frozen !== true) continue
    if (scope !== undefined && (cls.frozenScope ?? 'all') !== scope) continue
    out.push(op)
  }
  return out
}

/**
 * 这次调用是不是「读侧」（免令牌、不记流水）。
 *
 * 判据只有一个来源：登记表的 `writeWhen`。**没带 `writeWhen` 的 op 一律返回 false**
 * —— 即"标了 write 就是写"，不知道就别放行。
 *
 * 判据抛错也返回 false（按写处理）：一个会抛的谓词说明这次调用的形状没人设计过，
 * 那种时候**要求令牌**才是安全的方向 —— 反过来会让"某个畸形 args 恰好免门禁"成为漏洞。
 */
export function isReadCall(op: string, args: unknown): boolean {
  const cls = OP_REGISTRY[op]
  if (!cls || cls.writeWhen === undefined) return false
  const bag = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  try {
    return cls.writeWhen(bag) !== true
  } catch {
    return false
  }
}

/**
 * 对账：真实 op 表里**没在登记表出现**的键。
 *
 * 这就是 A1 要的那台机器 —— 新加一个 op 而忘了归类，这里立刻数得出来。判据是"要么登记过，
 * 要么所属 service 自报过写 op 且登记过"，两者都指向同一个条件：登记表里有这一条。
 */
export function unclassifiedOps(opNames: Iterable<string>): string[] {
  return [...opNames].filter((op) => OP_REGISTRY[op] === undefined).sort()
}

/** 反方向：登记表里有条目、真实 op 表里却没有 → 改名或删 op 时忘了同步（幽灵条目）。 */
export function staleRegistryEntries(opNames: Iterable<string>): string[] {
  const live = new Set(opNames)
  return Object.keys(OP_REGISTRY).filter((op) => !live.has(op)).sort()
}

/**
 * `serviceWrite` 的双向核对：登记表说"这条由 service 自报"，service 真自报了吗？
 * 反过来，service 自报的写 op 都在登记表里吗？两个方向都查，谁改了必须动另一边。
 */
export function serviceWriteMismatch(reported: Iterable<string>): { missing: string[]; extra: string[] } {
  const declared = new Set(
    Object.entries(OP_REGISTRY).filter(([, cls]) => cls.serviceWrite === true).map(([op]) => op),
  )
  const actual = new Set(reported)
  return {
    missing: [...actual].filter((op) => !declared.has(op)).sort(),
    extra: [...declared].filter((op) => !actual.has(op)).sort(),
  }
}

/** 自相矛盾的条目：既声明只读又声明要令牌 / 泄露明文 / 带写判据。（登记时手滑的兜底。） */
export function contradictoryEntries(): string[] {
  return Object.entries(OP_REGISTRY)
    .filter(([, cls]) => cls.readonly === true && (cls.write === true || cls.sensitive === true || cls.writeWhen !== undefined))
    .map(([op]) => op)
    .sort()
}

/**
 * 标了 `writeWhen` 却没标 `write` 的条目：写判据写了，可这条 op 根本不进写门禁
 * —— 那份判据永远不会被问一次，等于没写（静默失效，正是 F2 的形状）。
 */
export function writeWhenUnwritten(): string[] {
  return Object.entries(OP_REGISTRY)
    .filter(([, cls]) => cls.writeWhen !== undefined && cls.write !== true)
    .map(([op]) => op)
    .sort()
}

export interface OpRegistryAudit {
  /** 真实 op 表里有、登记表里没归类 → 这条 op 不受任何门禁约束。 */
  unclassified: string[]
  /** 登记表有条目、真实 op 表里没有 → op 改名或删除时忘了同步（幽灵条目）。 */
  stale: string[]
  /** service 自报的写 op，登记表却没标 serviceWrite。 */
  serviceWriteMissing: string[]
  /** 登记表标了 serviceWrite，service 却没自报。 */
  serviceWriteExtra: string[]
  /** readonly 与 write / sensitive 同时出现。 */
  contradictory: string[]
  /** 带 `writeWhen` 却没标 `write`（写判据永远不会被问到）。 */
  writeWhenUnwritten: string[]
  /** 真实 op 表的键数（界面与日志报"多少条里出了几处问题"用）。 */
  total: number
}

/**
 * 一次性对账（纯函数，无副作用）：把登记表与**真实** op 表四个方向都比一遍。
 *
 * 为什么用真实 op 表而不是再抄一份清单：登记表本身也可能烂。只有拿 `handlers` 的键集合来
 * 对，"加了 op 忘了登记"才会当场暴露 —— 这正是 F-4 那四次失守的共同形状。
 */
export function auditOpRegistry(opNames: Iterable<string>, serviceWriteOps: Iterable<string>): OpRegistryAudit {
  const names = [...opNames]
  const mismatch = serviceWriteMismatch(serviceWriteOps)
  return {
    unclassified: unclassifiedOps(names),
    stale: staleRegistryEntries(names),
    serviceWriteMissing: mismatch.missing,
    serviceWriteExtra: mismatch.extra,
    contradictory: contradictoryEntries(),
    writeWhenUnwritten: writeWhenUnwritten(),
    total: names.length,
  }
}

/** 对账结果里所有问题项（空数组 = 全绿）。 */
export function auditProblems(audit: OpRegistryAudit): string[] {
  return [
    ...audit.unclassified.map((op) => op + '（未归类）'),
    ...audit.stale.map((op) => op + '（幽灵条目）'),
    ...audit.serviceWriteMissing.map((op) => op + '（service 自报写、登记表未标）'),
    ...audit.serviceWriteExtra.map((op) => op + '（登记表标了写、service 未自报）'),
    ...audit.contradictory.map((op) => op + '（只读与写自相矛盾）'),
    ...audit.writeWhenUnwritten.map((op) => op + '（有写判据却没标写）'),
  ]
}
