// 对话内「这条记忆放哪」卡片的纯函数层：文案、答案映射、失败分类。
//
// 为什么单独一层：卡片文案是**答案值**（`ctx.userQuestions` 按 label 回传），映射错一个字符
// 就会把「全局」读成「未识别」；失败分类又决定「不保存」还是「退回待确认」。两者都不依赖
// 宿主对象，单独放这里才能用测试钉住。
//
// 为什么中英双语：`ctx.userQuestions` 没有 locale 协商，服务端拿不到界面语言；只写中文会
// 让英文界面出现中文按钮，只写英文则相反。两种都写，代价是标签长一点。

export type ScopeLayer = 'global' | 'workspace'

/** 卡片上的三个答案。`skip` = 用户明确不加入（关掉卡片也归到这里）。 */
export interface ScopeChoice {
  choice: ScopeLayer | 'skip'
  /** 用户通过「其它」输入的文字；原样回给模型，不拿它猜层。 */
  custom?: string
}

export interface ScopeAskRequest {
  /** 将要保存的正文（已按上限截断）。 */
  text: string
  boundary?: string
  /** 推荐层：排在选项第一位，描述里标「推荐」。 */
  recommended: ScopeLayer
  /** 可选的层（受 writeTarget 上限与工作区身份裁剪），至少一项。 */
  allowed: ScopeLayer[]
  /** 会合并到的已有条目 id（有就写进 detail）。 */
  mergeInto?: string
  /** 会被取代的旧条目 id。 */
  supersedes?: string[]
  /** 工具调用的取消信号：用户取消本轮时卡片跟着结束。 */
  signal?: AbortSignal
}

/** 卡片的答案标签。改字符串等于改协议：映射函数与测试都读这三个常量。 */
export const SCOPE_GLOBAL_LABEL = '全局记忆 / Global'
export const SCOPE_WORKSPACE_LABEL = '本工作区记忆 / Workspace'
export const SCOPE_SKIP_LABEL = '不加入 / Don\'t save'
export const SCOPE_QUESTION = '记住这条？ / Save this?'
export const SCOPE_HEADER = '自主记忆 / Memory'

/** 答案 → 请求的层；认不出的答案返回 null（调用方退回待确认，不猜）。 */
export function scopeChoiceOf(answer: unknown): ScopeChoice | null {
  const a = answer as { answers?: Array<{ selected?: unknown; custom?: unknown }> } | null | undefined
  const item = Array.isArray(a?.answers) ? a!.answers[0] : undefined
  const selected = Array.isArray(item?.selected)
    ? (item!.selected as unknown[]).filter((x): x is string => typeof x === 'string')
    : []
  const rawCustom = typeof item?.custom === 'string' ? item.custom.trim() : ''
  const custom = rawCustom === '' ? undefined : rawCustom
  const hit = selected.find((label) =>
    label === SCOPE_GLOBAL_LABEL || label === SCOPE_WORKSPACE_LABEL || label === SCOPE_SKIP_LABEL)
  if (hit === SCOPE_GLOBAL_LABEL) return { choice: 'global', ...(custom !== undefined ? { custom } : {}) }
  if (hit === SCOPE_WORKSPACE_LABEL) return { choice: 'workspace', ...(custom !== undefined ? { custom } : {}) }
  if (hit === SCOPE_SKIP_LABEL) return { choice: 'skip', ...(custom !== undefined ? { custom } : {}) }
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
  const order: ScopeLayer[] = [req.recommended, ...req.allowed.filter((l) => l !== req.recommended)]
  const options = order.map((layer) => {
    const recommended = layer === req.recommended
    if (layer === 'global') {
      return {
        label: SCOPE_GLOBAL_LABEL,
        description: recommended
          ? '推荐：所有项目都生效 / Recommended — applies in every project'
          : '所有项目都生效 / Applies in every project',
      }
    }
    return {
      label: SCOPE_WORKSPACE_LABEL,
      description: recommended
        ? '推荐：只在这个项目生效 / Recommended — applies only in this project'
        : '只在这个项目生效 / Applies only in this project',
    }
  })
  options.push({ label: SCOPE_SKIP_LABEL, description: '这次不记 / Do not save this note' })

  const lines = [req.text]
  if (req.boundary !== undefined && req.boundary !== '') lines.push('', `边界 / Boundary: ${req.boundary}`)
  if (req.mergeInto !== undefined && req.mergeInto !== '') lines.push('', `将合并到已有记忆 / Will merge into: ${req.mergeInto}`)
  if (req.supersedes !== undefined && req.supersedes.length > 0) {
    lines.push('', `将取代 / Will replace: ${req.supersedes.join(', ')}`)
  }
  return {
    id: 'memory-scope',
    header: SCOPE_HEADER,
    question: SCOPE_QUESTION,
    detail: lines.join('\n'),
    options,
    multiSelect: false,
  }
}
