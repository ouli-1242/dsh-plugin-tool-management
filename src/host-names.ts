/**
 * 宿主身份常量：插件在文件里认的这几个名字只在这里写一次。
 *
 * 以前 `@deepseek-ai/dsh-mcp-client` 在 `index.ts` 里有 6 份副本（2 份写给补丁的 YAML、
 * 2 份解析补丁时的比对、2 份运行时清单匹配），`preset-reach.ts` 里还有第 7 份 —— 官方改包名时
 * 少改一处就是「开关点了没反应」或「列表凭空少一行」。档案目录名同理。
 */
export const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'

/** `ensurePaths()` 的档案探测顺序（先 web 后 headless）；都不在才退到「任意带 patch 的档案」。 */
export const PROFILE_CANDIDATES = ['web', 'headless'] as const

/** 探测不到任何档案时的兜底目录名（历史上的默认档案）。 */
export const DEFAULT_PROFILE_NAME = 'web'
