// 记忆正文搜索（0.21.2 Phase 4.3）—— 纯函数，不碰磁盘。
//
// 为什么单独一层：搜索的排序与截断是**契约**（模型侧工具与界面共用同一份结果），
// 埋在 op 里就没法用纯函数测试钉住；而它又足够简单，不需要索引或分词器。
//
// 判据（刻意保持"可解释"）：
//   · 多词 AND：每个词都要在某个字段里出现（大小写不敏感），不做 OR 兜底；
//   · 排序：名称精确 > 名称前缀 > 名称包含 > 描述 > 标签 > 正文，多词累加；
//   · 返回片段而不是全文：模型一次调用的预算有限，全文交给 `rules-read`。
export interface SearchDoc {
  id: string
  name: string
  /** 场景（记忆的一级归属）。 */
  group: string
  description: string
  tags: string[]
  body: string
  /** 会话投影后的生效值（调用方负责合成）。 */
  enabled: boolean
}

export interface SearchHit {
  id: string
  scene: string
  name: string
  description: string
  enabled: boolean
  score: number
  snippet: string
}

const SNIPPET_MAX = 160
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

/** 单词语义权重：命中的字段越"像名字"，分越高。 */
function termScore(term: string, doc: SearchDoc): number {
  const name = doc.name.toLowerCase()
  const id = doc.id.toLowerCase()
  if (name === term) return 100
  if (name.startsWith(term)) return 60
  if (name.includes(term)) return 40
  if (id.includes(term)) return 30
  if (doc.description.toLowerCase().includes(term)) return 20
  if (doc.tags.some((tag) => String(tag).toLowerCase().includes(term))) return 15
  if (doc.body.toLowerCase().includes(term)) return 10
  return 0
}

/** 命中位置附近的片段（把换行压平，前后加省略号），总长不超过 `SNIPPET_MAX`。 */
export function snippetOf(text: string, terms: string[]): string {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  if (flat.length <= SNIPPET_MAX) return flat
  const lower = flat.toLowerCase()
  let at = -1
  for (const term of terms) {
    const i = lower.indexOf(term)
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  if (at < 0) return flat.slice(0, SNIPPET_MAX - 1) + '…'
  const room = SNIPPET_MAX - 2
  let start = Math.max(0, at - Math.floor(room / 3))
  let end = Math.min(flat.length, start + room)
  // 靠近结尾时把窗口往左挪，尽量填满（否则末尾的命中只剩一小截上下文）。
  start = Math.max(0, Math.min(start, end - room))
  const head = start > 0 ? '…' : ''
  const tail = end < flat.length ? '…' : ''
  return head + flat.slice(start, end) + tail
}

/** `query` 为空 = 不搜索（返回空数组，不是"全部"）。 */
export function searchMemories(docs: SearchDoc[], query: string, limit?: number): SearchHit[] {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter((t) => t !== '')
  if (terms.length === 0) return []
  const cap = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(Math.floor(Number(limit)), MAX_LIMIT)
    : DEFAULT_LIMIT
  const hits: SearchHit[] = []
  for (const doc of docs) {
    let score = 0
    let matchedAll = true
    for (const term of terms) {
      const s = termScore(term, doc)
      if (s === 0) { matchedAll = false; break }
      score += s
    }
    if (!matchedAll) continue
    // 片段优先取正文（信息量最大），正文没命中时退回描述。
    const bodyHit = terms.some((t) => doc.body.toLowerCase().includes(t))
    const snippet = bodyHit ? snippetOf(doc.body, terms) : snippetOf(doc.description, terms)
    hits.push({
      id: doc.id,
      scene: doc.group,
      name: doc.name,
      description: doc.description,
      enabled: doc.enabled,
      score,
      snippet,
    })
  }
  hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  return hits.slice(0, cap)
}
