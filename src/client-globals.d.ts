// 宿主在浏览器里注入的 ModuleLoader 全局（client.js 的加载入口）。
// client.js 由 tsconfig.client.json 以 checkJs 松弛检查（DOM lib + 本声明给出
// window.__ModuleLoader__ 的边界形状）；主 tsconfig 不含本文件，互不影响。
interface Window {
  __ModuleLoader__: {
    load(spec: { id: string, factory: (require: (id: string) => unknown) => void }): void
  }
}

// 宿主通过 ModuleLoader 注入的 UI 基础组件（Switch 等）。本仓库不直接依赖它的类型包，
// 这里做最小声明：只用形状里的 Switch，且保持 any —— 宿主组件的行为由宿主保证。
declare module '@deepseek-ai/dsh-client-ui-primitives';
