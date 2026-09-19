// dsh-plugin-tool-management — durable client half (web bundle, ModuleLoader CJS format).
// Registers the "MCP 管理" settings page. Talks to the host half through the
// exact-path HTTP route /dsh-plugin-tool-management/api (same origin) instead of the
// dynamic-only host.call channel.
//
// 取词三件套（design-plan D25）——改文案前先确认当前处落在哪一支：
//   * `t`   —— apply 开头「取词服务」段绑定的那份取词（导航标题等**注册期**取值也走它）；
//              页面组件则经 props 拿到同一份（`pages.t`）。
//   * `mt`  —— MCP 页专用包装（定义在 apply 内）：模块作用域的 `t` 会被宿主 locale 覆盖，
//              它每次取值都取最新的那个，所以 MCP 页一律用 `mt`。
//   * `translateOrFallback(t, key, fallback)` —— 动态键（宿主回传的错误码等）缺失时的兜底文案。
// 三者共用同一份 DICT：键必须在 zh / en 两侧都存在（`npm run check:i18n` 会拦）。
window.__ModuleLoader__.load({
  id: 'dsh-plugin-tool-management',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    // 本插件自己的设计变量（宿主那套是 `--dsw-*`）。告警色此前在 12 条规则里各写一遍
    // 十六进制字面量，换主题要改 12 次 —— 收敛成 `--dsm-warn`，字面量只留下面那一处。