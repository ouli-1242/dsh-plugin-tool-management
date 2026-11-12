// 对话内「这条记忆放哪」卡片的纯函数层：文案、答案映射、失败分类。
//
// 为什么单独一层：卡片文案是**答案值**（`ctx.userQuestions` 按 label 回传），映射错一个字符
// 就会把「全局」读成「未识别」；失败分类又决定「不保存」还是「退回待确认」。两者都不依赖
// 宿主对象，单独放这里才能用测试钉住。
//
// 为什么按正文语言只写一种：`ctx.userQuestions` 没有 locale 协商，服务端拿不到界面语言；
// 双语并排会让卡片显得啰嗦。正文是用户/模型在对话里写的，它的语言就是最可靠的信号 ——
// 中文正文配中文卡片，英文正文配英文卡片。代价是「中文界面 + 英文笔记」会出英文卡片，
// 这是宿主契约缺 locale 时能做到的最好一档。

export type ScopeLayer = 'global' | 'workspace'
export type CardLang = 'zh' | 'en'

/** 卡片上的答案。`skip` = 明确不加入；`revise` = 用户自己写了新说法。 */
export interface ScopeChoice {
  choice: ScopeLayer | 'skip' | 'revise'
  /** 用户通过「其它」输入的文字。`revise` 时是用户希望改成的说法。 */
  custom?: string
}

export interface ScopeAskRequest {
  /** 将要保存的正文（已按上限截断）。 */
  text: string
  boundary?: string
  /** 推荐层：排在选项第一位，描述里标「推荐」。模型不确定时不传。 */
  recommended?: ScopeLayer
  /** 可选的层（由两个自主记忆开关与工作区身份裁剪），至少一项。 */
  allowed: ScopeLayer[]
  /** 会合并到的已有条目 id（有就写进 detail）。 */
  mergeInto?: string
  /** 会被取代的旧条目 id。 */
  supersedes?: string[]
  /**
   * 这条记忆的类型。决定保质期（`ttlDaysOf`：事实 / 做法 30 天后提醒复核，偏好 / 纠正
   * 不过期），所以卡片必须写明 —— 用户在决定「要不要这条」时，看不到类型就不知道
   * 自己批准的东西会不会过一阵被催着复核。
   */
  kind?: 'preference' | 'fact' | 'correction' | 'procedure'
  /** 工具调用的取消信号：用户取消本轮时卡片跟着结束。 */
  signal?: AbortSignal
}

/** 正文语言：含 CJK 统一表意文字即中文，否则英文。 */
export function cardLangOf(text: string): CardLang {
  return /[㐀-鿿]/.test(String(text ?? '')) ? 'zh' : 'en'
}

interface CardLabels {
  header: string
  question: string
  global: string
  workspace: string
  skip: string
  recommended: string
  globalDesc: string
  workspaceDesc: string
  skipDesc: string
  reviseHint: string
  kindLabel: string
  kindNames: Record<'preference' | 'fact' | 'correction' | 'procedure', string>
  kindTtl30: string
  kindTtlForever: string
}

const LABELS: Record<CardLang, CardLabels> = {
  zh: {
    header: '自主记忆',
    question: '记住这条？',
    global: '全局记忆',
    workspace: '本工作区记忆',
    skip: '不加入',
    recommended: '推荐：',
    globalDesc: '所有项目都生效',
    workspaceDesc: '只在这个项目生效',
    skipDesc: '这次不记',
    reviseHint: '想改措辞？在下方输入你的说法，模型会按你的话重写后再问你一次。',
    kindLabel: '类型：',
    kindNames: { preference: '偏好', fact: '事实', correction: '纠正', procedure: '做法' },
    kindTtl30: '30 天后提醒复核',
    kindTtlForever: '不会过期',
  },
  en: {
    header: 'Memory',
    question: 'Save this?',
    global: 'Global memory',
    workspace: 'This workspace',
    skip: 'Don\'t save',
    recommended: 'Recommended — ',
    globalDesc: 'Applies in every project',
    workspaceDesc: 'Applies only in this project',
    skipDesc: 'Do not save this note',
    reviseHint: 'Want different wording? Type your version below; the model will rewrite it and ask again.',
    kindLabel: 'Type: ',
    kindNames: { preference: 'preference', fact: 'fact', correction: 'correction', procedure: 'procedure' },
    kindTtl30: 'review reminder after 30 days',
    kindTtlForever: 'no expiry',
  },
}

/**
 * 答案 → 请求的层。认不出的答案返回 null（调用方退回待确认，不猜）。
 *
 * 用户自己输入文字时（官方单选的 custom 会清空 selected），返回 `revise`：不写盘，
 * 把用户的话交回模型重写，再走一次 learn 弹卡。这比在同一次工具调用里循环更符合
 * 「用户的想法可能是一句修改要求，而不是完整正文」的实际用法。
 */
export function scopeChoiceOf(answer: unknown): ScopeChoice | null {
  const a = answer as { answers?: Array<{ selected?: unknown; custom?: unknown }> } | null | undefined
  const item = Array.isArray(a?.answers) ? a!.answers[0] : undefined
  const selected = Array.isArray(item?.selected)
    ? (item!.selected as unknown[]).filter((x): x is string => typeof x === 'string')
    : []
  const rawCustom = typeof item?.custom === 'string' ? item.custom.trim() : ''
  const custom = rawCustom === '' ? undefined : rawCustom
  if (custom !== undefined) return { choice: 'revise', custom }
  for (const labels of Object.values(LABELS)) {
    if (selected.includes(labels.global)) return { choice: 'global' }
    if (selected.includes(labels.workspace)) return { choice: 'workspace' }
    if (selected.includes(labels.skip)) return { choice: 'skip' }
  }
  return null
}

export type ScopeFailureAction = 'skip' | 'fallback' | 'abort'

/**
 * 卡片失败怎么收尾。
 *
 * - `ASK_CANCELLED`：用户关掉了卡片 → 当作「不加入」，不写任何东西；
 * - `ASK_ABORTED`：本轮被取消 → 不写，调用方向上抛；
 * - 其余（`NO_PROVIDER` / `CALLER_NOT_LIVE` / `DELEGATED_CALLER` / 未知异常）→ 退回待确认。
 *   卡片只是「直接生效」的加速器，拿不到答案不该把这条笔记丢掉。
 *
 * 客户端的取消是 `waterfall.reject("ASK_CANCELLED")`，抛出来是**字符串**而不是 Error，
 * 所以这里同时认字符串与 `.code`。
 */
export function scopeFailureOf(error: unknown): ScopeFailureAction {
  const code = typeof error === 'string'
    ? error
    : (error as { code?: unknown } | null | undefined)?.code
  if (code === 'ASK_CANCELLED') return 'skip'
  if (code === 'ASK_ABORTED') return 'abort'
  return 'fallback'
}

/**
 * 拼出 `AskUserQuestionItem` 形状的普通对象（不引官方类型，纯数据便于测试）。
 * 第一项是推荐层；最后一项永远是「不加入」。
 */
export function buildScopeQuestion(req: ScopeAskRequest): {
  id: string
  header: string
  question: string
  detail: string
  options: Array<{ label: string; description: string }>
  multiSelect: false
} {
  const lang = cardLangOf(req.text)
  const labels = LABELS[lang]
  // 不确定时不标推荐；选项把工作区放前面 —— 用户按习惯点第一项时，宁可少记到全局，
  // 也不要默认跨项目。
  const order: ScopeLayer[] = req.recommended !== undefined
    ? [req.recommended, ...req.allowed.filter((l) => l !== req.recommended)]
    : req.allowed.slice().sort((a, b) => (a === 'workspace' ? -1 : b === 'workspace' ? 1 : 0))
  const options = order.map((layer) => {
    const recommended = req.recommended !== undefined && layer === req.recommended
    const desc = layer === 'global' ? labels.globalDesc : labels.workspaceDesc
    return {
      label: layer === 'global' ? labels.global : labels.workspace,
      description: recommended ? labels.recommended + desc : desc,
    }
  })
  options.push({ label: labels.skip, description: labels.skipDesc })

  const lines = [req.text]
  // 类型写在正文之后、边界之前：先看结论，再看它是什么类型，最后看适用条件。
  // 与复核卡片同一套措辞（`evo.review.kind`），两处说的是同一件事。
  if (req.kind !== undefined) {
    const ttl = req.kind === 'fact' || req.kind === 'procedure' ? labels.kindTtl30 : labels.kindTtlForever
    // 括号跟语言走：英文卡片用全角括号会与拉丁字母混排得很怪。
    const open = lang === 'zh' ? '（' : ' ('
    const close = lang === 'zh' ? '）' : ')'
    lines.push('', labels.kindLabel + labels.kindNames[req.kind] + open + ttl + close)
  }
  if (req.boundary !== undefined && req.boundary !== '') lines.push('', (lang === 'zh' ? '边界：' : 'Boundary: ') + req.boundary)
  if (req.mergeInto !== undefined && req.mergeInto !== '') lines.push('', (lang === 'zh' ? '将合并到已有记忆：' : 'Will merge into: ') + req.mergeInto)
  if (req.supersedes !== undefined && req.supersedes.length > 0) {
    lines.push('', (lang === 'zh' ? '将取代：' : 'Will replace: ') + req.supersedes.join(', '))
  }
  lines.push('', labels.reviseHint)
  return {
    id: 'memory-scope',
    header: labels.header,
    question: labels.question,
    detail: lines.join('\n'),
    options,
    multiSelect: false,
  }
}
