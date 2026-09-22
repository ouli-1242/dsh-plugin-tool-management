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
}

export const OP_REGISTRY: Readonly<Record<string, OpClass>> = Object.freeze({

  // ── MCP 域（16）────────────────────────────────────────────────────────────
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
  'mcpm-settings': { write: true, frozen: true },
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

  // ── 技能域（21，含内联的 skill-open）───────────────────────────────────────
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

  // ── 兼容 / 注入 / 备份域（7）───────────────────────────────────────────────
  'compat-status': { readonly: true },
  'feature-overview': { readonly: true },
  'preset-reach': { readonly: true },
  // 五个域当前正文的**全文**都从这里出去。今天不带令牌就能读，是这批只读里披露面最大的一条；
  // 要不要上门禁是产品决定，登记在这里是为了让它可数。
  'injection-live': { readonly: true },
  'backups-list': { readonly: true },
  // 注入设置（五域开关 / 压制型预设口径）写侧车。它是"配置"不是"宿主状态"，但改的是
  // 投递语义，按写操作门禁。
  'inject-settings': { write: true },
  // 模型工具表（哪些工具根本不发给模型）也写侧车，改的是每轮请求的内容 —— 同上按写门禁。
  'tool-table': { write: true },
  // 场景页的界面设置（进入场景前要不要弹「会改什么」的预览卡）：写侧车，按写门禁。
  // **刻意不冻结**：它只是界面提示，锁着场景的人在场景页照样该能关掉提醒 —— 冻结的是五个
  // 管理域的改动，不是这个页面的显示偏好（判据见文件头 write/frozen 两段的边界）。
  'scene-settings': { write: true },
  // 清理 patch 备份：删磁盘文件（备份里含明文凭据副本），按写操作门禁。
  'backups-clean': { write: true },

  // ── 场景候选源（3）与内联（1）──────────────────────────────────────────────
  'model-candidates': { readonly: true },
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

/** 自相矛盾的条目：既声明只读又声明要令牌 / 泄露明文。（登记时手滑的兜底。） */
export function contradictoryEntries(): string[] {
  return Object.entries(OP_REGISTRY)
    .filter(([, cls]) => cls.readonly === true && (cls.write === true || cls.sensitive === true))
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
  ]
}
