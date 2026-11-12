// 显示宽度：汉字 / 全角 / emoji 占两个半角单位，字母占一个。
//
// 为什么不用 `text.length`：字符数不等于信息量。400 个汉字约等于 800–1000 个英文字母，
// 按字符数设上限会让英文笔记只有中文的一半内容。名称、正文与标题统一按这一套口径。

/** 这个码点是否按两个半角单位显示。区间覆盖 CJK、全角、常见 emoji 与扩展汉字。 */
export function isWideCodePoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    // BMP 里的图形符号：☀ ✅ ⭐ ❤ 这类常见 emoji 不在补充平面，漏掉会让按宽度
    // 截断的标题 / 摘要比上限多出几个单位。区间里有窄符号，按宽算只是把上限估严一点。
    (code >= 0x2600 && code <= 0x27bf) ||
    (code >= 0x2b00 && code <= 0x2bff) ||
    // 补充平面上的图形符号整段按宽算：emoji 散落在几十个块里（火箭、乐器、棋子、
    // 区域指示符、符号扩展……），只挑几段必然漏。区间内少量未分配码点按宽算是把上限
    // 估严一点，不会把字符切坏。
    (code >= 0x1f000 && code <= 0x1fbff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

/** 单个字符的显示宽度（2 = 宽字符，1 = 其它）。 */
export function charWidth(ch: string): number {
  return isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1
}

/** 整段文本的显示宽度。 */
export function textWidthOf(text: string): number {
  let width = 0
  for (const ch of text) width += charWidth(ch)
  return width
}

/**
 * 按显示宽度截断。
 *
 * 用 `for...of` 按码点走，不会把代理对劈成半个字符。
 */
export function truncateToWidth(text: string, maxWidth: number): string {
  let out = ''
  let width = 0
  for (const ch of text) {
    const w = charWidth(ch)
    if (width + w > maxWidth) break
    out += ch
    width += w
  }
  return out
}

/**
 * 单行摘要：压平空白后按显示宽度截断，超限补 `…`。
 *
 * 只用于界面扫读（列表行、清单），**不用于注入** —— 注入用完整正文。截断留出 `…`
 * 自身的宽度，否则摘要会比上限多一个单位。
 */
export function excerptOf(text: string, maxWidth = 160): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (textWidthOf(flat) <= maxWidth) return flat
  return truncateToWidth(flat, Math.max(1, maxWidth - 1)) + '…'
}
