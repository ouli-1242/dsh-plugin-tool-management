// 宿主在浏览器里注入的 ModuleLoader 全局（client.js 的加载入口）。
// client.js 由 tsconfig.client.json 以 checkJs 松弛检查（DOM lib + 本声明给出
// window.__ModuleLoader__ 的边界形状）；主 tsconfig 不含本文件，互不影响。
interface Window {
  __ModuleLoader__: {
    load(spec: { id: string, factory: (require: (id: string) => unknown) => void }): void
  }
}
