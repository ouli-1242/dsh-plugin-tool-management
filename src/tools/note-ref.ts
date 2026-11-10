// 工具面的笔记引用前缀。
//
// 用户记忆 id 是 `<scene>/<name>`，笔记的磁盘 id 也是 `<layer>/<slug>` —— 两者同形，
// 模型在会话里正是据此把 `global/<name>` 当成笔记（或反过来）。工具面加一个前缀，
// 让「这是哪一族」在字符串本身就能看出来；磁盘格式与 `evolution-*` op 一律不动。

/** 工具面笔记引用的前缀。 */
export const NOTE_REF_PREFIX = 'note:'

/** 磁盘 id → 工具面引用。 */
export function noteRefOf(id: string): string {
  return NOTE_REF_PREFIX + String(id ?? '')
}

/** 工具面引用 → 磁盘 id；没有前缀时原样返回（兼容模型直接给磁盘 id）。 */
export function stripNoteRef(ref: string): string {
  const s = String(ref ?? '').trim()
  return s.startsWith(NOTE_REF_PREFIX) ? s.slice(NOTE_REF_PREFIX.length) : s
}

/** 这个字符串是不是工具面的笔记引用。 */
export function isNoteRef(ref: string): boolean {
  return String(ref ?? '').trim().startsWith(NOTE_REF_PREFIX)
}
