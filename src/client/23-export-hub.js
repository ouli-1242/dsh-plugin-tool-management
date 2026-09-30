    // 曾经把导出写成 apply 方法体的最后两条语句（`module.exports.DICT = ...` /
    // `module.exports._pages = ...`），而 apply 开头是
    // `const slots = ctx.get('slots'); if (slots === undefined) return`。
    // 对象字面量在 factory 求值时就定了型，方法体里的追加却可能永远不执行——
    // 于是导出里查无 _pages。**任何导出都必须在 factory 作用域落地。**
    const _pages = {}
    // 中英两份词典。声明在 factory 作用域：apply 里的 ctx.locale 只是把它交给宿主，
    // 契约测试则直接从导出里读它（apply 提前返回也必须拿得到）。