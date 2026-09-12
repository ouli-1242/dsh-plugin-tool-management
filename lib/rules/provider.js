// dsh-plugin-tool-management —— 规则「按需层」投影（skill provider 注册）。
//
// 把规则投影为 skill 目录条目，注册进每个活动 agent 的 skills provider：
// 可见分组由会话的 agentPreset 动态决定（scenes.json），provider.list() 时实时
// 计算，因此切换 preset 后无需重载插件。
//
// 为什么照抄 skills/service.ts 的 registerAgentSkillProviders 形态：用户级技能
// 由 agent-preset 的 scoped 层解析，只有在 agent 自己的层里注册，候选 rank 覆盖
// 才能对它们生效（上游机制如此，规则投影复用同一通道）。
const PROVIDER_NAME = 'dsh-plugin-tool-management-rules';
/** 注册 agent-scope 规则 provider；返回清理函数（配合 ctx.effect）。 */
export function createRuleProviderRegistrar(ctx, facade) {
    const on = ctx && ctx.on;
    if (typeof on !== 'function')
        return () => { };
    const registrations = new Map();
    const skillsOf = (agent) => {
        const agentCtx = agent && agent.ctx;
        if (!agentCtx)
            return null;
        const skills = typeof agentCtx.get === 'function' ? agentCtx.get('skills') : agentCtx.skills;
        return skills && typeof skills.registerProvider === 'function' ? skills : null;
    };
    const makeProvider = (agent) => ({
        name: PROVIDER_NAME,
        list: async (options) => {
            // preset 优先取 list options（宿主注入），其次 agent.header.agentPreset。
            const preset = (options && typeof options.preset === 'string' ? options.preset : undefined) ||
                (agent && agent.header && typeof agent.header.agentPreset === 'string' ? agent.header.agentPreset : undefined);
            return facade.list(preset);
        },
        get: async (candidate) => facade.get(candidate),
    });
    const install = (agent) => {
        if (!agent || agent.id == null || registrations.has(agent.id))
            return;
        const skills = skillsOf(agent);
        if (!skills)
            return;
        try {
            const dispose = skills.registerProvider((_control) => makeProvider(agent));
            registrations.set(agent.id, typeof dispose === 'function' ? dispose : () => { });
        }
        catch (e) {
            console.error('[dsh-plugin-tool-management] agent-scoped rules provider registration failed:', String((e && e.message) || e));
        }
    };
    const uninstall = (agent) => {
        const id = agent && agent.id;
        if (id == null)
            return;
        const dispose = registrations.get(id);
        registrations.delete(id);
        if (typeof dispose === 'function') {
            try {
                dispose();
            }
            catch { /* ignore */ }
        }
    };
    const stopCreated = on('agent/created', (payload) => install(payload && payload.agent));
    const stopDisposed = on('agent/disposed', (payload) => uninstall(payload && payload.agent));
    try {
        const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
        if (agents && typeof agents.list === 'function') {
            for (const agent of agents.list())
                install(agent);
        }
    }
    catch { /* agents 服务不可用 → 仅靠事件 */ }
    return () => {
        if (typeof stopCreated === 'function')
            stopCreated();
        if (typeof stopDisposed === 'function')
            stopDisposed();
        for (const dispose of registrations.values()) {
            try {
                dispose();
            }
            catch { /* ignore */ }
        }
        registrations.clear();
    };
}
