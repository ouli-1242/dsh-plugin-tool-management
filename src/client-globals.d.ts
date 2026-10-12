// 宿主在浏览器里注入的 ModuleLoader 全局（client.js 的加载入口）。
// client.js 由 tsconfig.client.json 以 checkJs 松弛检查（DOM lib + 本声明给出
// window.__ModuleLoader__ 的边界形状）；主 tsconfig 不含本文件，互不影响。
interface Window {
  __ModuleLoader__: {
    load(spec: { id: string, factory: (require: (id: string) => unknown) => void }): void
  }
}

// 宿主 ModuleLoader 在浏览器里提供的 React 渲染器。**不是本包的依赖**（package.json 里
// 只有 react，没有 react-dom），所以类型解析不到 —— 但运行时拿得到：同生态的
// dsh-better-sidebar 就是这么建自己的浮层的（`react_dom_client.createRoot(host)`，
// 建一个 div 挂到 body 上）。这里用**简写环境模块**（不带 body = any）声明它，
// 只为了让 `typecheck:client` 认得这个模块名；形状不在这里钉，调用点自己有运行时守卫
// （拿不到 createRoot 就退回跳兼容页，见 40 片的 openTokenDialog）。
declare module 'react-dom/client'
