// 运行时降级上报通道 —— 「插件自己发现自己降级了」的统一出口。
//
// 为什么需要它：有一批降级**没有抛错可挂**：它们发生在装配期或探测期（第三方包装接管了本插件的
// 运行时适配、注入域装配失败、启动期表达式或服务名解析出问题），失败当下的表现只是"某个功能
// 少了一半"或者"静默失效"。此前这些点只落 console / logger，用户在界面上看不到，要等事故之后
// 才倒查（审查报告 §3 记了多处）。这里给它们一个共用出口：`noteRuntime` 记一条，
// `compat-status` 把全部条目并进 findings —— 兼容页因此成为"降级总账"。
//
// 与 `probe.ts` 的 CAPABILITY_SPECS 分工：那张表是**写死的宿主能力清单**（每次探测重算），
// 这里是**运行时事件**（谁在什么时候发现了什么），两者在 compat-status 里合并展示。
//
// 键是 `id`：同一主题重复上报只覆盖不堆积（它表达的是"现在的状态"，不是日志）。

/** 一条运行时降级。字段与 `CapabilityFinding` 对齐，便于 compat-status 直接并进 findings。 */
export interface RuntimeNote {
  /** 稳定 id（兼容页按它去重与定位）。 */
  readonly id: string
  /** 短标签（中文，与插件其它界面一致）。 */
  readonly label: string
  /**
   * 与 `CapabilityFinding.kind` 同一套取值。装配层的降级（B3 的挂载/注入类）取最接近的
   * `'read'` —— 界面不渲染这一列，它是给日志与筛选用的。
   */
  readonly kind: 'read' | 'write' | 'delete'
  /** 与 `CapabilityFinding.fallback` 同一套取值（界面按它显示胶囊文案）。 */
  readonly fallback: 'native-entry' | 'refuse-operation' | 'disable-destructive' | 'inform-only'
  /** 一句话说清"现在是怎样、少的是什么"。 */
  readonly detail: string
  /** 上报时刻（毫秒）。 */
  readonly at: number
}

const notes = new Map<string, RuntimeNote>()

/** 记一条（同 id 覆盖）。 */
export function noteRuntime(note: Omit<RuntimeNote, 'at'>): void {
  notes.set(note.id, { ...note, at: Date.now() })
}

/** 该主题已恢复正常 → 收掉这一行。 */
export function clearRuntimeNote(id: string): void {
  notes.delete(id)
}

/** 当前全部运行时降级（`compat-status` 取用）。 */
export function runtimeNotes(): RuntimeNote[] {
  return [...notes.values()]
}
