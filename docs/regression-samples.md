# 回归样例：藏在字符串里的 CSS，静默失效的两类坑

> 目的：`lib/client.js` 是 `src/client/*.js` 按 `scripts/sync-client.mjs` 拼接出来的，CSS 全在字符串里。
> 这类改动有个共同点：**语法合法、构建全绿、页面照常渲染，样式只是不生效** —— 靠 `node --check`、`npm run test`、截图都看不出来。
> 下面两例是实际踩到的，附「怎么复现」与「怎么判」两段，判据一律用**计算值 + 几何读数**，不看源码也不看截图。

---

## 例 1 · 样式串里出现"孤立表达式"→ 整条链从未进文档

### 长什么样

```js
const CSS = `.a{color:red}`

  '.b{color:blue}' +            // ← 前面没有 const / let / 赋值 / 调用 ✗
  '.c{color:green}' + ''

function ensureCss() {
  const tag = document.createElement('style')
  tag.textContent = CSS          // 只插了 CSS，.b / .c 一次都没进去 ✗
  document.head.appendChild(tag)
}
```

### 为什么拦不住

```console
$ node --check lib/client.js
# 退出码 0 ✓ —— 裸表达式是合法语句，"未使用"属于 lint 语义，不属于语法
```

### 怎么判

```js
document.querySelector('style[data-plugin-css="…"]').textContent.includes('.b{')
// → false ✗  规则从未生效
```

### 怎么快速找

```bash
# 嫌疑行 = 以引号开头、但上一行不是 + / = / ( 的字符串块
grep -n -B1 "^  *['\"\`]" src/client/*.js | grep -A1 -vE "(\+|=|\(|,)$"
```

`scripts/check-css-chain.mjs` 把这条做成了可跑的检查（启发式，命中即非 0 退出）。

### 建议防线

对构建产物或 `src/client/*.js` 跑 ESLint 并开 `no-unused-expressions: error`（一行配置，正好覆盖这一类）。

---

## 例 2 · `scrollbar-width` / `scrollbar-color` 会关掉 `::-webkit-scrollbar` 自绘

### 长什么样

```css
.scroll{scrollbar-width:thin;scrollbar-color:#ddd transparent}   /* 本来是为 Firefox 写的 ✗ */
.scroll::-webkit-scrollbar{width:9px}
.scroll::-webkit-scrollbar-thumb{border-radius:99px;background:#ccc}
```

### 为什么"看着没问题"

Chromium 只要见到 **非 `auto`** 的 `scrollbar-width`，就改用系统经典滚动条，`::-webkit-scrollbar` 那套**整片被忽略** —— 于是细圆头的自绘滚动条变成带箭头的灰条 ✗。

### 怎么判

```js
getComputedStyle(document.querySelector('.scroll')).scrollbarWidth
// → "thin" ✗  自绘那套已被旁路
// 注意：别只看 ::-webkit-scrollbar 规则在不在文档里 —— 它在，只是不生效
```

### 两种修法

```css
/* ① 给 Firefox 单独留一条通道（推荐）*/
@supports not selector(::-webkit-scrollbar){
  .scroll{scrollbar-width:thin;scrollbar-color:#ddd transparent}
}
/* ② 或在自绘那套之后显式还原 */
.scroll{scrollbar-width:auto;scrollbar-color:auto}
```

---

## 这两例的共性（值得写成检查清单）

1. **判据要落在计算值 / 几何读数上**：`getComputedStyle` 取值、`getBoundingClientRect` / `scrollHeight` 取几何；源码对、截图对，都可能与事实不符。
2. **"在不在文档里" ≠ "生不生效"**：例 1 的规则整段缺失、例 2 的规则在文档里却被旁路 —— 两种都要靠上面那套判。
3. **改 CSS 字符串后，务必确认那份样式表真的被插进文档**：`document.querySelector('style[data-plugin-css]')` 应存在，且 `textContent` 含本次新增的选择器。
