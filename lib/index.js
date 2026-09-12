// dsh-plugin-tool-management — host half, written in TypeScript to the DeepSeek Harness
// plugin development standard (https://deepseek-harness.github.io/deepseek-harness/develop/basic/):
//   * object-form Cordis plugin: { name, inject, apply } (docs: "对象形式")
//   * required services declared in `inject` — the framework guarantees they are
//     ready before apply runs, and reloads the plugin if one disappears
//   * agent-facing capability exposed as registered tools (ctx.tools.register +
//     defineTool), the documented way to add model-callable abilities
//   * UI-facing capability exposed via a webServer exact route (used by the
//     client half), registered defensively
//
// Build: `tsc -p tsconfig.json` compiles this to lib/index.js (the shipped
// artifact — same convention as DSH's own packages, which ship compiled JS).
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createRequire } from 'node:module';
import { createSkillsService } from './skills/service.js';
import { createAgentsMdService } from './agents-md/service.js';
import { createRulesService } from './rules/service.js';
import { detectFormat, extractText, parseGenericText, parseJsonlTranscript, parseMarkdownTranscript } from './imports/parsers.js';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
// ---------------------------------------------------------------------------
// Transcript export helpers — mirror the import parsers (src/imports/parsers.js)
// so an exported file can be imported back losslessly. Pure Node, no ctx.
// ---------------------------------------------------------------------------
/** 从会话事件数组提取用户/助手纯文本轮次（与导入解析器对称）。 */
function extractTurnsFromEvents(events) {
    const turns = [];
    for (const ev of events || []) {
        if (!ev || typeof ev !== 'object')
            continue;
        const e = ev;
        let content;
        if (e.type === 'user/message')
            content = e.data && e.data.content;
        else if (e.type === 'assistant/message')
            content = e.data && e.data.message && e.data.message.content;
        else
            continue;
        const text = extractText(content).trim();
        if (text)
            turns.push({ role: e.type === 'user/message' ? 'user' : 'assistant', text });
    }
    return turns;
}
/** 序列化为可再导入的转录文本：Codex 风格 Markdown 或 Claude Code 风格 JSONL。 */
function serializeTurns(turns, format) {
    if (format === 'jsonl') {
        return turns.map((t) => JSON.stringify({ type: t.role, message: { role: t.role, content: t.text } })).join('\n');
    }
    return turns.map((t) => (t.role === 'user' ? '## User\n' : '### Assistant\n') + t.text).join('\n\n');
}
export default {
    name: 'dsh-plugin-tool-management-host',
    inject: ['timer', 'fs', 'settings', 'sandboxPolicy', 'webServer', 'tools', 'skills', 'sessions'],
    apply(ctx, config) {
        const fs = ctx.fs;
        const settings = ctx.settings;
        const sandboxPolicy = ctx.sandboxPolicy;
        const webServer = ctx.webServer;
        const tools = ctx.tools;
        // pluginInventory is optional: probe at use time, degrade to no live info.
        const pluginInventory = ctx.get('pluginInventory');
        // Package version, surfaced in the Settings pages and the HTTP API. Read
        // from the installed package.json so it always matches the release tag.
        let PKG_VERSION = 'unknown';
        try {
            PKG_VERSION = createRequire(import.meta.url)('../package.json').version || 'unknown';
        }
        catch (e) { /* keep unknown */ }
        // Optional access token (defense in depth for LAN exposure). Enabled by
        // setting `config.token` on this plugin's loader row (profile
        // cordis.patch.yml override) or the DSH_SKILL_MCP_MANAGER_TOKEN env var. When
        // set, every state-changing op requires `x-dsh-token: <token>`. Read-only
        // ops (plugin-version, mcpm-list, skill-state) stay open so the UI still
        // renders; mcpm-export is guarded too because it leaks full configs.
        // NOTE: the entry config arrives as the SECOND apply argument (Cordis
        // calls `callback(ctx, config)`) — never read it off `ctx.config`, which
        // is not an injected service and throws "cannot get property without
        // inject" at boot.
        const TOKEN = String(config?.token || process.env.DSH_PLUGIN_TOOL_MANAGEMENT_TOKEN || '').trim();
        const WRITE_OPS = new Set([
            'mcpm-add', 'mcpm-edit', 'mcpm-remove', 'mcpm-set-enabled', 'mcpm-set-all', 'mcpm-restart',
            'mcpm-export', 'mcpm-import', 'mcpm-note', 'mcpm-settings', 'mcpm-tool-enabled',
            // mcpm-reveal returns UNMASKED secrets; even though it is a read, it is
            // token-gated like a write — on a LAN-exposed port the token must be the
            // last line of defense for plaintext credentials too, not just writes.
            'mcpm-reveal',
            'skill-enable', 'skill-disable', 'skill-source-enable', 'skill-source-disable',
            'skill-create', 'skill-import', 'skill-upload', 'skill-delete',
            'skill-trash-restore', 'skill-trash-delete', 'skill-open',
            'skill-custom-add', 'skill-custom-remove',
            // agents-md 写操作（create/update/remove 改预设库；apply 写全局 AGENTS.md；import 从外部内容建预设）
            'agentsmd-create', 'agentsmd-update', 'agentsmd-apply', 'agentsmd-remove', 'agentsmd-import',
            // history 写操作（archive/unarchive 改归档集合；delete 永久删除；retention-set 写保留期）
            'history-archive', 'history-unarchive', 'history-delete', 'history-retention-set',
            'history-unarchive-batch', 'history-delete-batch', 'history-import', 'history-export',
            'history-archive-batch',
            // rules 写操作（v0.3：create/update/remove/restore 改记忆文件；toggle/set-index/
            // set-active 改侧车索引；create-scene/remove-scene 建删场景目录。
            // set-active = 插件内"启用场景"开关，全局持久化）
            'rules-create', 'rules-update', 'rules-remove', 'rules-restore', 'rules-toggle', 'rules-set-index', 'rules-set-active',
            'rules-create-scene', 'rules-remove-scene',
        ]);
        const wait = (ms) => ctx.timeout(ms);
        const message = (e) => String((e && e.message) || e);
        let writeChain = Promise.resolve();
        function withWriteLock(fn) {
            const run = writeChain.then(() => fn(), () => fn());
            writeChain = run.then(() => undefined, () => undefined);
            return run;
        }
        // ---------- skills management (core service, ported from dsh-skills-manager) ----------
        // 文件操作核心在 ./skills/core.js 与 ./skills/readonly-discovery.js（原样移植，
        // 来源裁剪为 dsh/agents/codex/claude）；服务层把 core 的结果适配成 { op, args }
        // 协议，并在全局层与每个活动 agent 的 scope 内注册 manager provider：
        // rank 覆盖实现不改源文件的启停；外部来源由 provider 接入。
        const skillsService = createSkillsService(ctx);
        try {
            ctx.effect(() => skillsService.registerProviders(), 'dsh-plugin-tool-management: skills providers');
        }
        catch (e) {
            console.error('[dsh-plugin-tool-management] skills provider setup failed:', message(e));
        }
        // ---------- agents-md 预设库 + 切换 ----------
        // DSH 全局指令基线只有 ~/.dsh/AGENTS.md 一个文件，无内置多预设切换；
        // 本服务在插件目录内 data/agents-md-presets/ 维护预设库，「应用」= 写入
        // ~/.dsh/AGENTS.md，新会话生效（当前会话不变，DSH 本身如此）。
        // presetsDir 可由 config 注入（测试用），否则落到插件根 data/。
        const PLUGIN_ROOT = (() => {
            try {
                return dirname(createRequire(import.meta.url).resolve('../package.json'));
            }
            catch {
                return process.cwd();
            }
        })();
        const agentsMdPresetsDir = String(config?.presetsDir || join(PLUGIN_ROOT, 'data', 'agents-md-presets'));
        const agentsMdService = createAgentsMdService(ctx, {
            presetsDir: agentsMdPresetsDir,
            getGlobalAgentsMdPath: async () => {
                const p = await ensurePaths();
                const sep = p.home.indexOf('\\') >= 0 ? '\\' : '/';
                return p.home + sep + 'AGENTS.md';
            },
        });
        // ---------- rules（规则/记忆，v0.3）----------
        // 规则真源 $DSH_HOME/rules/<场景>/<name>.md（仅用户级，D1）。**场景 = 一级目录**；
        // 单投影 = 活动场景记忆 → per-agent systemPrompt 段（自动在场，模型无需调用任何工具）。
        // 原"始终层写 ~/.dsh/AGENTS.md"已下线（变更单 01 §4/§10）：公共基线由 _shared/ 承担。
        // rulesRoot / rulesStateDir 仅测试注入，生产留空由服务按 DSH_HOME 解析。
        const rulesService = createRulesService(ctx, {
            rulesRoot: String(config?.rulesRoot || ''),
            stateDir: String(config?.rulesStateDir || ''),
            // 场景记忆段预算（字节），默认 65536；仅用于测试与特殊部署调优。
            ...(Number.isFinite(Number(config?.rulesMaxBytes))
                ? { maxBytes: Number(config.rulesMaxBytes) }
                : {}),
        });
        try {
            ctx.effect(() => rulesService.registerProviders(), 'dsh-plugin-tool-management: rules providers');
        }
        catch (e) {
            console.error('[dsh-plugin-tool-management] rules provider setup failed:', message(e));
        }
        // ---------- history（归档会话管理，折叠自 dsh-archive-manager）----------
        // cordis.patch.yml 禁用官方 workspace 与 session-projection-cache，插入本插件
        // 的归档感知子类（lib/history/workspace.js + lib/history/projcache.js）。子类
        // 经 Service.constructor 继承官方服务名（workspaceRegistry / sessionProjectionCache），
        // 因此 ctx.get('workspaceRegistry') 拿到的就是归档子类实例。
        //
        // 保留期（retentionDays）：0 = 永久不删除，7/30 = 归档满 N 天后自动永久删除。
        // archivedAt 账本由子类自身维护（data/history-archived-at.json）；保留期配置
        // 由本插件 data/history-retention.json 存储。sweeper 在 apply 时跑一次并周期
        // 复跑（默认 6h，可经 config.sweepIntervalMs 覆盖），把到期归档会话批量永久删除。
        const historyRetentionPath = String(config?.historyRetentionPath || join(PLUGIN_ROOT, 'data', 'history-retention.json'));
        const sweepIntervalMs = Number(config?.sweepIntervalMs || 0) || 6 * 60 * 60 * 1000;
        function getHistoryRegistry() {
            const r = ctx.get('workspaceRegistry');
            return r && typeof r.archiveSession === 'function' ? r : undefined;
        }
        async function readHistoryRetention() {
            try {
                const raw = await readFile(historyRetentionPath, 'utf8');
                const obj = JSON.parse(raw);
                const days = Number((obj && obj.retentionDays) ?? 0);
                const updatedAt = Number((obj && obj.updatedAt) ?? 0);
                return {
                    retentionDays: Number.isFinite(days) && days >= 0 ? days : 0,
                    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0,
                };
            }
            catch {
                return { retentionDays: 0, updatedAt: 0 };
            }
        }
        async function writeHistoryRetention(retentionDays) {
            try {
                const dir = dirname(historyRetentionPath);
                await mkdir(dir, { recursive: true });
                // updatedAt = 修改时刻：每次改保留期，已归档会话的到期基线重置为此时刻。
                await writeFile(historyRetentionPath, JSON.stringify({ retentionDays, updatedAt: Date.now() }), 'utf8');
            }
            catch (e) {
                console.error('[dsh-plugin-tool-management] write history-retention failed:', message(e));
            }
        }
        /**
         * 计算到期应删的归档会话。基线 = max(archivedAt（账本）?? createdAt（元数据),
         * updatedAt（最近一次修改保留期的时刻）)。改保留期即重置倒计时：到期时刻从
         * 修改时刻起按新天数重新计算；updatedAt 缺失（旧配置）时退回归档时刻语义。
         * retentionDays <= 0 表示永久不删除，返回空集。纯函数：便于测试。
         */
        function expiredArchivedIds(items, retentionDays, now, updatedAt = 0) {
            if (!(retentionDays > 0))
                return [];
            const cutoff = now - retentionDays * 86400000;
            const out = [];
            for (const it of items) {
                const archived = (typeof it.archivedAt === 'number' && Number.isFinite(it.archivedAt))
                    ? it.archivedAt
                    : (typeof it.createdAt === 'number' && Number.isFinite(it.createdAt) ? it.createdAt : undefined);
                if (archived === undefined)
                    continue;
                const baseline = updatedAt > 0 ? Math.max(archived, updatedAt) : archived;
                if (baseline <= cutoff)
                    out.push(it.sessionId);
            }
            return out;
        }
        async function sweepHistory() {
            const registry = getHistoryRegistry();
            if (!registry)
                return { swept: [] };
            const { retentionDays, updatedAt } = await readHistoryRetention();
            if (!(retentionDays > 0))
                return { swept: [] };
            try {
                const details = (typeof registry.archivedSessionDetails === 'function')
                    ? (await registry.archivedSessionDetails()).items
                    : (await registry.archivedSessionMetadata()).items.map((i) => ({ sessionId: i.sessionId, createdAt: i.createdAt, archivedAt: registry.archivedAt?.(i.sessionId) }));
                const expired = expiredArchivedIds(details, retentionDays, Date.now(), updatedAt);
                if (expired.length === 0)
                    return { swept: [] };
                const res = await registry.deleteArchivedSessions({ scope: 'sessions', sessionIds: expired });
                return { swept: res.deletedSessionIds || [] };
            }
            catch (e) {
                console.error('[dsh-plugin-tool-management] history sweep failed:', message(e));
                return { swept: [] };
            }
        }
        // 启动时扫一次，再周期复跑。fake-ctx 测试里 ctx.effect 立即调用并 dispose，
        // interval 未提供时退化为不挂钟（不阻塞测试）。
        try {
            void sweepHistory();
        }
        catch { /* 非致命 */ }
        try {
            ctx.effect(() => {
                const timer = ctx;
                const fn = typeof timer.interval === 'function' ? timer.interval : (typeof timer.setInterval === 'function' ? timer.setInterval : undefined);
                if (!fn)
                    return () => { };
                return fn(() => { void sweepHistory(); }, sweepIntervalMs);
            }, 'dsh-plugin-tool-management: history sweep');
        }
        catch { /* timer 缺失时静默 */ }
        // ---------- path discovery ----------
        // Known limitation: profile detection probes 'web' then 'headless' by
        // presence of profiles/<name>/cordis.patch.yml, then falls back to any
        // profile that has one, and finally to 'web'. A profile whose directory
        // name matches none of these and has no patch file yet is not detected.
        let cached = null;
        async function ensurePaths() {
            if (cached)
                return cached;
            let home = null;
            try {
                const doc = await settings.prepareDocument();
                if (typeof doc === 'string' && doc) {
                    const i = Math.max(doc.lastIndexOf('\\'), doc.lastIndexOf('/'));
                    home = i > 0 ? doc.slice(0, i) : doc;
                }
            }
            catch (e) { /* ignore */ }
            if (!home)
                throw new Error('无法确定 DSH 主目录（settings.prepareDocument 未返回路径）');
            await migrateRenamedData(home);
            const sep = home.indexOf('\\') >= 0 ? '\\' : '/';
            let profileDir = null;
            let profileName = 'web';
            for (const name of ['web', 'headless']) {
                if (await exists(home + sep + 'profiles' + sep + name + sep + 'cordis.patch.yml')) {
                    profileDir = home + sep + 'profiles' + sep + name;
                    profileName = name;
                    break;
                }
            }
            if (!profileDir) {
                try {
                    const t = await fs.resolve(home + sep + 'profiles');
                    const entries = await fs.listDir(t);
                    for (const e of entries) {
                        if (e.name === 'node_modules')
                            continue;
                        if (await exists(home + sep + 'profiles' + sep + e.name + sep + 'cordis.patch.yml')) {
                            profileDir = home + sep + 'profiles' + sep + e.name;
                            profileName = e.name;
                            break;
                        }
                    }
                }
                catch (e) { /* ignore */ }
            }
            if (!profileDir)
                profileDir = home + sep + 'profiles' + sep + 'web';
            cached = {
                home,
                profileDir,
                profileName,
                projectPatch: profileDir + sep + 'cordis.patch.yml',
                globalPatch: home + sep + 'cordis.patch.yml',
            };
            return cached;
        }
        async function exists(abs) {
            try {
                const t = await fs.resolve(abs);
                return (await fs.stat(t)) !== undefined;
            }
            catch (e) {
                return false;
            }
        }
        // ---------- one-time data migration (pre-rename sidecars & state) ----------
        // The plugin used to ship under the name dsh-skill-mcp-manager: its sidecar
        // JSON files and the skills state directory lived under the old prefix. On
        // first boot pull them to the new names so an upgraded install keeps its
        // data. Best effort — any failure just starts the new layout from scratch.
        async function migrateRenamedData(home) {
            const sep = home.indexOf('\\') >= 0 ? '\\' : '/';
            const pairs = [
                // 状态目录经历过两次改名：skill-mcp-manager → dsh-plugin-tool-management → tool-management
                ['skill-mcp-manager', 'tool-management'],
                ['dsh-plugin-tool-management', 'tool-management'],
                ['skill-mcp-manager-notes.json', 'dsh-plugin-tool-management-notes.json'],
                ['skill-mcp-manager-settings.json', 'dsh-plugin-tool-management-settings.json'],
                ['skill-mcp-manager-disabled-tools.json', 'dsh-plugin-tool-management-disabled-tools.json'],
                ['skill-mcp-manager-export.json', 'dsh-plugin-tool-management-export.json'],
            ];
            for (const [oldName, newName] of pairs) {
                try {
                    const oldAbs = home + sep + oldName;
                    const newAbs = home + sep + newName;
                    if (!(await exists(oldAbs)) || (await exists(newAbs)))
                        continue;
                    await rename(oldAbs, newAbs);
                }
                catch (e) { /* best effort */ }
            }
        }
        async function readPatch(abs) {
            try {
                const t = await fs.resolve(abs);
                return await fs.readText(t);
            }
            catch (e) {
                if (String(e.code) === 'FS_NOT_FOUND')
                    return '';
                throw e;
            }
        }
        // Timestamped copies of the previous patch content. The template upstream
        // learned this the hard way: a bad edit to cordis.patch.yml can stop DSH
        // from booting, so the pre-write file must stay recoverable without git.
        const KEEP_PATCH_BACKUPS = 5;
        function backupStamp() {
            const d = new Date();
            const p = (n) => String(n).padStart(2, '0');
            return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
        }
        async function backupPatchFile(abs, previous) {
            const i = Math.max(abs.lastIndexOf('\\'), abs.lastIndexOf('/'));
            if (i <= 0)
                return;
            const dir = abs.slice(0, i);
            const base = abs.slice(i + 1);
            await writeFile(abs + '.bak-' + backupStamp(), previous, 'utf8');
            try {
                const names = (await readdir(dir)).filter((name) => name.startsWith(base + '.bak-')).sort();
                for (const stale of names.slice(0, Math.max(0, names.length - KEEP_PATCH_BACKUPS))) {
                    await unlink(dir + abs[i] + stale);
                }
            }
            catch (e) { /* pruning is best-effort */ }
        }
        async function writePatch(abs, content) {
            const t = await fs.resolve(abs);
            const policy = await sandboxPolicy.resolve({ mode: 'danger-full-access' });
            try {
                const previous = await readPatch(abs);
                if (previous && previous !== content)
                    await backupPatchFile(abs, previous);
            }
            catch (e) { /* a failed backup must never block the write */ }
            await fs.writeText(t, content, undefined, undefined, policy);
        }
        // ---------- duplicate loader-id guard ----------
        // Two rows with the same loader id make the plugin composition fail to
        // boot (upstream hit exactly this after renaming an entry), so duplicates
        // are reported on read and new ones are refused before any write.
        function duplicateIdsOf(content) {
            const counts = new Map();
            for (const row of parseRows(content).rows) {
                if (!row.id)
                    continue;
                counts.set(row.id, (counts.get(row.id) || 0) + 1);
            }
            return [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
        }
        function duplicateGuard(before, after) {
            const known = new Set(duplicateIdsOf(before));
            const introduced = duplicateIdsOf(after).filter((id) => !known.has(id));
            if (!introduced.length)
                return null;
            return { ok: false, error: '写入会产生重复的 loader id（重复 id 会导致 DSH 无法启动）：' + introduced.join('、') };
        }
        // ---------- YAML generation ----------
        function yq(v) { return typeof v === 'string' ? JSON.stringify(v) : String(v); }
        function yplain(v) { return /^[A-Za-z0-9_.:@%+=/-]+$/.test(v) ? v : yq(v); }
        function buildInsertBlock(row) {
            const lines = [
                '# dsh-plugin-tool-management:server:' + row.id,
                '- insert:',
                '    - id: ' + yplain(row.id),
                "      name: '@deepseek-ai/dsh-mcp-client'",
                '      config:',
                '        serverName: ' + yq(row.serverName),
                '        transport: ' + yq(row.transport),
            ];
            if (row.transport === 'streamable-http') {
                lines.push('        url: ' + yq(row.url || ''));
                const headers = row.headers || {};
                const hk = Object.keys(headers);
                if (hk.length) {
                    lines.push('        headers:');
                    for (const k of hk)
                        lines.push('          ' + yq(k) + ': ' + yq(headers[k]));
                }
            }
            else {
                lines.push('        command: ' + yq(row.command || ''));
                const args = row.args || [];
                if (args.length) {
                    lines.push('        args:');
                    for (const a of args)
                        lines.push('          - ' + yq(a));
                }
                const env = row.env || {};
                const ek = Object.keys(env);
                if (ek.length) {
                    lines.push('        env:');
                    for (const k of ek)
                        lines.push('          ' + yq(k) + ': ' + yq(env[k]));
                }
            }
            if (row.toolCallTimeoutMs)
                lines.push('        toolCallTimeoutMs: ' + Number(row.toolCallTimeoutMs));
            return lines.join('\n');
        }
        function buildDisableBlock(id, disabled) {
            return [
                '# dsh-plugin-tool-management:' + (disabled ? 'disable' : 'enable') + ':' + id,
                '- id: ' + yplain(id),
                "  name: '@deepseek-ai/dsh-mcp-client'",
                '  disabled: ' + (disabled ? 'true' : 'false'),
            ].join('\n');
        }
        // ---------- YAML parsing (mini parser) ----------
        // Known limitation: this hand-rolled parser assumes the exact indentation
        // style that buildInsertBlock emits (config at 6 spaces, children at 8,
        // nested maps/lists at 10+). Hand-edited patch files using different
        // indentation may parse incorrectly — DSH itself only cares about the
        // effective YAML it reads, and this parser exists purely for the UI.
        function splitKV(text) {
            const m = text.match(/^("(?:\\.|[^"])*"|'[^']*'|[^:]+?)\s*:\s*(.*)$/);
            if (!m)
                return null;
            return { key: unquote(m[1]), value: m[2] };
        }
        function unquote(v) {
            if (v === undefined || v === null)
                return v;
            const s = String(v).trim();
            if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
                try {
                    return JSON.parse(s);
                }
                catch (e) {
                    return s.slice(1, -1);
                }
            }
            if (s.length >= 2 && s.startsWith("'") && s.endsWith("'"))
                return s.slice(1, -1).replace(/''/g, "'");
            if (/^\[.*\]$/.test(s))
                return s.slice(1, -1).split(',').map((x) => unquote(x.trim())).filter((x) => x !== '');
            if (s === 'true')
                return true;
            if (s === 'false')
                return false;
            if (/^-?\d+$/.test(s))
                return Number(s);
            return s;
        }
        function parseEntry(lines) {
            const entry = { config: {} };
            let inConfig = false;
            let configIndent = 0;
            let nested = null;
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#'))
                    continue;
                const indent = line.match(/^\s*/)[0].length;
                let t = trimmed;
                if (t.startsWith('- '))
                    t = t.slice(2).trim();
                const kv = splitKV(t);
                if (!kv) {
                    if (inConfig && nested && nested.type === 'list')
                        nested.current.push(unquote(t));
                    continue;
                }
                if (!inConfig) {
                    if (kv.key === 'config' && kv.value === '') {
                        inConfig = true;
                        configIndent = indent;
                        continue;
                    }
                    if (kv.key === 'id')
                        entry.id = unquote(kv.value);
                    else if (kv.key === 'name')
                        entry.name = unquote(kv.value);
                    else if (kv.key === 'disabled')
                        entry.disabled = kv.value === 'true';
                    continue;
                }
                if (indent <= configIndent) {
                    inConfig = false;
                    nested = null;
                    continue;
                }
                if (kv.value === '' && (kv.key === 'headers' || kv.key === 'env')) {
                    nested = { key: kv.key, indent, type: 'map', current: {} };
                    entry.config[kv.key] = nested.current;
                    continue;
                }
                if (kv.value === '' && kv.key === 'args') {
                    nested = { key: kv.key, indent, type: 'list', current: [] };
                    entry.config[kv.key] = nested.current;
                    continue;
                }
                if (nested && indent > nested.indent) {
                    if (nested.type === 'map')
                        nested.current[kv.key] = unquote(kv.value);
                    else if (nested.type === 'list')
                        nested.current.push(unquote(kv.value));
                    continue;
                }
                nested = null;
                entry.config[kv.key] = unquote(kv.value);
            }
            return entry;
        }
        function parseRows(content) {
            const lines = content.split(/\r?\n/);
            const managedIds = new Set();
            for (const line of lines) {
                // Markers written by either this plugin or the template upstream count
                // as managed (coexistence: both can edit the same patch file).
                const m = line.match(/^# (?:dsh-plugin-tool-management|dsh-mcp-manager):server:(.+)$/);
                if (m)
                    managedIds.add(m[1].trim());
            }
            const rows = [];
            const overrides = [];
            const blocks = [];
            let current = null;
            for (const line of lines) {
                if (/^- /.test(line)) {
                    current = { text: line };
                    blocks.push(current);
                }
                else if (current) {
                    current.text += '\n' + line;
                }
            }
            for (const block of blocks) {
                const head = block.text.split('\n')[0];
                if (/^- insert:/.test(head)) {
                    const parts = block.text.split('\n');
                    const children = [];
                    let j = 0;
                    while (j < parts.length) {
                        if (/^    - /.test(parts[j])) {
                            const child = { lines: [parts[j]] };
                            j++;
                            while (j < parts.length && !/^    - /.test(parts[j])) {
                                child.lines.push(parts[j]);
                                j++;
                            }
                            children.push(child);
                        }
                        else
                            j++;
                    }
                    for (const child of children) {
                        const entry = parseEntry(child.lines);
                        if (entry && entry.name === '@deepseek-ai/dsh-mcp-client') {
                            rows.push({ id: entry.id, name: entry.name, disabled: entry.disabled, config: entry.config, managed: managedIds.has(entry.id) });
                        }
                    }
                }
                else {
                    const entry = parseEntry(block.text.split('\n'));
                    if (entry && entry.name === '@deepseek-ai/dsh-mcp-client')
                        overrides.push({ id: entry.id, disabled: entry.disabled });
                }
            }
            for (const o of overrides) {
                const row = rows.find((r) => r.id === o.id);
                if (row && o.disabled !== undefined)
                    row.disabled = o.disabled;
            }
            return { rows };
        }
        // ---------- line-based block editing ----------
        function splitLines(content) { return content.split(/\r?\n/); }
        function joinLines(lines) {
            let res = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n*$/, '\n');
            if (!res.trim()) {
                res = '[]\n';
            }
            else if (!/^- /m.test(res) && !/^\[\]\s*$/m.test(res)) {
                // A patch file must stay a top-level YAML array: after removing the last
                // entry, emit [] so loadOptionalPatches never throws on a comments-only file.
                res = res.replace(/\n*$/, '\n[]\n');
            }
            return res;
        }
        function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
        function markerRanges(lines, id, ops) {
            const n = lines.length;
            // Match this plugin's markers AND the template upstream's
            // (`# dsh-mcp-manager:server|disable|enable:<id>`) so an entry written by
            // either manager can be located and cleaned up without orphan blocks —
            // the two plugins are designed to coexist.
            const re = new RegExp('^# (?:dsh-plugin-tool-management|dsh-mcp-manager):(' + ops + '):' + escRe(id) + '$');
            const ranges = [];
            for (let i = 0; i < n; i++) {
                if (!re.test(lines[i]))
                    continue;
                let j = i + 1;
                while (j < n && !/^- /.test(lines[j]))
                    j++;
                let end = j;
                if (j < n && /^- /.test(lines[j])) {
                    let k = j + 1;
                    while (k < n && !/^- /.test(lines[k]))
                        k++;
                    end = k;
                }
                ranges.push([i, end]);
            }
            return ranges;
        }
        function insertBlockRange(lines, id) {
            const n = lines.length;
            const entryRe = new RegExp('^\\s*- id: ' + escRe(id) + '\\s*$');
            for (let i = 0; i < n; i++) {
                if (!/^- insert:/.test(lines[i]))
                    continue;
                let end = i + 1;
                while (end < n && !/^- /.test(lines[end]))
                    end++;
                if (lines.slice(i, end).some((l) => entryRe.test(l)))
                    return [i, end];
            }
            return null;
        }
        function bareOverrideRanges(lines, id) {
            const n = lines.length;
            const re = new RegExp('^- id: ' + escRe(id) + '\\s*$');
            const ranges = [];
            for (let i = 0; i < n; i++) {
                if (!re.test(lines[i]))
                    continue;
                let end = i + 1;
                while (end < n && !/^- /.test(lines[end]))
                    end++;
                ranges.push([i, end]);
            }
            return ranges;
        }
        function spliceRanges(lines, ranges) {
            const remove = new Set();
            for (const r of ranges)
                for (let i = r[0]; i < r[1]; i++)
                    remove.add(i);
            return joinLines(lines.filter((_, i) => !remove.has(i)));
        }
        function removeEntryAll(content, id) {
            const lines = splitLines(content);
            const ranges = markerRanges(lines, id, 'server|disable|enable');
            const ib = insertBlockRange(lines, id);
            if (ib)
                ranges.push(ib);
            ranges.push(...bareOverrideRanges(lines, id));
            return spliceRanges(lines, ranges);
        }
        function removeMarked(content, id, op) {
            return spliceRanges(splitLines(content), markerRanges(splitLines(content), id, op));
        }
        function appendBlock(content, block) {
            let c = content;
            if (/^\[\]\s*$/m.test(c))
                c = c.replace(/^\[\]\s*$/m, block + '\n');
            else
                c = c.replace(/\s*$/, '\n' + block + '\n');
            return c;
        }
        // ---------- shared state ----------
        async function collectAll() {
            const p = await ensurePaths();
            const ids = new Set();
            const serverNames = new Set();
            const rows = [];
            for (const level of ['project', 'global']) {
                const abs = level === 'project' ? p.projectPatch : p.globalPatch;
                let content = '';
                try {
                    content = await readPatch(abs);
                }
                catch (e) {
                    continue;
                }
                const { rows: fileRows } = parseRows(content);
                for (const r of fileRows) {
                    ids.add(r.id);
                    const sn = r.config && r.config.serverName ? String(r.config.serverName) : r.id;
                    serverNames.add(sn);
                    rows.push({ id: r.id, serverName: sn, level, disabled: !!r.disabled });
                }
            }
            return { ids, serverNames, rows };
        }
        const bareEntryId = (v) => { const s = String(v); const i = s.lastIndexOf(':'); return i >= 0 ? s.slice(i + 1) : s; };
        async function liveEntry(id) {
            if (!pluginInventory)
                return null;
            try {
                const res = await pluginInventory.list();
                return res.entries.find((e) => e.moduleName === '@deepseek-ai/dsh-mcp-client' && bareEntryId(e.entryId) === id) || null;
            }
            catch (e) {
                return null;
            }
        }
        async function waitFor(pred, timeoutMs, stepMs) {
            const start = Date.now();
            for (;;) {
                const v = await pred();
                if (v)
                    return true;
                if (Date.now() - start > timeoutMs)
                    return false;
                await wait(stepMs);
            }
        }
        async function entryExists(id, level) {
            const p = await ensurePaths();
            const abs = level === 'global' ? p.globalPatch : p.projectPatch;
            let content = '';
            try {
                content = await readPatch(abs);
            }
            catch (e) {
                return false;
            }
            const { rows } = parseRows(content);
            if (rows.some((r) => r.id === id))
                return true;
            return (await liveEntry(id)) !== null;
        }
        function normalizeRow(r, level, abs) {
            const cfg = r.config || {};
            return {
                id: r.id,
                serverName: cfg.serverName || r.id,
                transport: cfg.transport || null,
                url: cfg.url || null,
                command: cfg.command || null,
                args: cfg.args || null,
                env: cfg.env || null,
                headers: cfg.headers || null,
                level,
                disabled: !!r.disabled,
                managed: !!r.managed,
            };
        }
        // ---------- import helpers ----------
        function toStrMap(v) {
            if (!v || typeof v !== 'object' || Array.isArray(v))
                return {};
            const out = {};
            for (const k of Object.keys(v))
                out[k] = String(v[k]);
            return out;
        }
        function normalizeImportItem(item) {
            if (!item || typeof item !== 'object' || Array.isArray(item))
                return { ok: false, error: '条目不是对象' };
            const it = item;
            const serverName = String(it.serverName || '').trim();
            if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName))
                return { ok: false, error: 'serverName 非法: ' + String(it.serverName) };
            const transport = it.transport === 'stdio' ? 'stdio' : 'streamable-http';
            const level = it.level === 'global' ? 'global' : 'project';
            const baseId = 'mcp-' + serverName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
            const rawId = String(it.id || '').trim();
            const id = rawId && /^[A-Za-z0-9_.:@%+=/-]+$/.test(rawId) ? rawId : baseId;
            const row = { id, serverName, transport, level, disabled: !!it.disabled };
            if (transport === 'streamable-http') {
                const url = String(it.url || '').trim();
                if (!/^https?:\/\//.test(url))
                    return { ok: false, error: serverName + ': url 非法' };
                row.url = url;
                row.headers = toStrMap(it.headers);
            }
            else {
                const command = String(it.command || '').trim();
                if (!command)
                    return { ok: false, error: serverName + ': command 缺失' };
                row.command = command;
                row.args = Array.isArray(it.args) ? it.args.map(String) : [];
                row.env = toStrMap(it.env);
            }
            return { ok: true, row };
        }
        // ---------- ops ----------
        async function pluginVersion() {
            return { ok: true, version: PKG_VERSION };
        }
        // Tool preview for one MCP server: project the model-facing schemas down to
        // a name + description + parameter-summary list. The registry prefixes every
        // MCP tool with `mcp__<serverName>__`; we filter on that and strip the prefix
        // for display. Only the direct `properties` of the parameters object are
        // summarized — nested object/array children are omitted (one level is enough
        // for a preview, keeps the dialog readable).
        // ---------- plugin-owned side-car data (notes / settings) ----------
        // The patch file carries loader config only, so user-facing extras live in
        // small JSON files under the DSH home, next to the patch files they describe.
        function sidecarPath(home, name) {
            return home + (home.indexOf('\\') >= 0 ? '\\' : '/') + name;
        }
        async function readJsonFile(abs) {
            try {
                return JSON.parse(await readFile(abs, 'utf8'));
            }
            catch (e) {
                return null;
            }
        }
        async function writeJsonFile(abs, data) {
            await writeFile(abs, JSON.stringify(data, null, 2) + '\n', 'utf8');
        }
        // User notes are keyed by loader id: they survive renames of the server
        // name and are never touched by config rewrites.
        //
        // Sidecar caches (notes / settings / disabled tools) are short-TTL: reads
        // hit the cache, but every WRITE re-reads the file (force=true) and merges
        // on top of the fresh on-disk state. Without the forced re-read, a manual
        // edit of the sidecar file would be silently overwritten by a stale cache.
        const SIDECAR_TTL_MS = 3000;
        let notesCache = null;
        async function readNotes(force = false) {
            if (notesCache && !force && Date.now() - notesCache.at < SIDECAR_TTL_MS)
                return notesCache.value;
            const p = await ensurePaths();
            const raw = await readJsonFile(sidecarPath(p.home, 'dsh-plugin-tool-management-notes.json'));
            const out = {};
            if (raw && typeof raw === 'object') {
                for (const key of Object.keys(raw)) {
                    const value = raw[key];
                    if (typeof value === 'string' && value.trim())
                        out[key] = value;
                }
            }
            notesCache = { at: Date.now(), value: out };
            return out;
        }
        async function mcpmNote(args) {
            const id = String((args && args.id) || '').trim();
            if (!id)
                return { ok: false, error: '缺少 id' };
            const note = String((args && args.note) == null ? '' : args.note).trim();
            const p = await ensurePaths();
            return withWriteLock(async () => {
                // Force re-read so an externally edited notes file is merged, not clobbered.
                const map = Object.assign({}, await readNotes(true));
                if (note)
                    map[id] = note;
                else
                    delete map[id];
                try {
                    await writeJsonFile(sidecarPath(p.home, 'dsh-plugin-tool-management-notes.json'), map);
                }
                catch (e) {
                    return { ok: false, error: '备注保存失败: ' + message(e) };
                }
                notesCache = { at: Date.now(), value: map };
                return { ok: true, notes: map };
            });
        }
        const SETTINGS_DEFAULTS = { pollIntervalMs: 5000, toolDescriptionMaxLength: 0, requireConfirmForModelRuleWrite: true };
        let pluginSettingsCache = null;
        function clampInt(value, min, max, fallback) {
            // Number(null) is 0 — treat missing/empty input as "use the default".
            if (value === null || value === undefined || value === '')
                return fallback;
            const n = Number(value);
            if (!Number.isFinite(n))
                return fallback;
            return Math.min(max, Math.max(min, Math.round(n)));
        }
        async function readPluginSettings(force = false) {
            if (pluginSettingsCache && !force && Date.now() - pluginSettingsCache.at < SIDECAR_TTL_MS)
                return pluginSettingsCache.value;
            const p = await ensurePaths();
            const raw = await readJsonFile(sidecarPath(p.home, 'dsh-plugin-tool-management-settings.json'));
            pluginSettingsCache = {
                at: Date.now(),
                value: {
                    pollIntervalMs: clampInt(raw && raw.pollIntervalMs, 2000, 60000, SETTINGS_DEFAULTS.pollIntervalMs),
                    // 0 = keep descriptions in full (the UI default); > 0 truncates.
                    toolDescriptionMaxLength: clampInt(raw && raw.toolDescriptionMaxLength, 0, 2000, SETTINGS_DEFAULTS.toolDescriptionMaxLength),
                    // 模型写规则需确认（D2）：程序化强制，只读设置供 tools/pre-execute 判定。
                    requireConfirmForModelRuleWrite: (raw && typeof raw.requireConfirmForModelRuleWrite === 'boolean')
                        ? raw.requireConfirmForModelRuleWrite
                        : SETTINGS_DEFAULTS.requireConfirmForModelRuleWrite,
                },
            };
            return pluginSettingsCache.value;
        }
        async function mcpmSettings(args) {
            const current = await readPluginSettings();
            if (!args || args.set !== true)
                return { ok: true, settings: current };
            const next = {
                pollIntervalMs: clampInt(args.pollIntervalMs, 2000, 60000, current.pollIntervalMs),
                toolDescriptionMaxLength: clampInt(args.toolDescriptionMaxLength, 0, 2000, current.toolDescriptionMaxLength),
                requireConfirmForModelRuleWrite: (args && typeof args.requireConfirmForModelRuleWrite === 'boolean')
                    ? args.requireConfirmForModelRuleWrite
                    : current.requireConfirmForModelRuleWrite,
            };
            const p = await ensurePaths();
            return withWriteLock(async () => {
                try {
                    await writeJsonFile(sidecarPath(p.home, 'dsh-plugin-tool-management-settings.json'), next);
                }
                catch (e) {
                    return { ok: false, error: '设置保存失败: ' + message(e) };
                }
                pluginSettingsCache = { at: Date.now(), value: next };
                return { ok: true, settings: next };
            });
        }
        // ---------- per-tool enable/disable (execution + visibility boundary) ----------
        // dsh-mcp-client has no per-tool config, but the DSH tool runtime exposes
        // two official seams: `tools.restrict({ deny })` removes a global tool from
        // every scope's model-visible schema list, and `tools.guard` denies the call
        // before the body runs. Disabled tools therefore become invisible AND
        // uncallable — no patch rewrite, no DSH restart.
        const DISABLED_TOOLS_FILE = 'dsh-plugin-tool-management-disabled-tools.json';
        let disabledToolsCache = null;
        async function readDisabledTools(force = false) {
            if (disabledToolsCache && !force && Date.now() - disabledToolsCache.at < SIDECAR_TTL_MS)
                return disabledToolsCache.value;
            const p = await ensurePaths();
            const raw = await readJsonFile(sidecarPath(p.home, DISABLED_TOOLS_FILE));
            const out = {};
            if (raw && typeof raw === 'object') {
                for (const serverName of Object.keys(raw)) {
                    const list = raw[serverName];
                    if (Array.isArray(list)) {
                        const names = list.map((name) => String(name)).filter((name) => /^[A-Za-z0-9_-]{1,128}$/.test(name));
                        if (names.length)
                            out[serverName] = names;
                    }
                }
            }
            disabledToolsCache = { at: Date.now(), value: out };
            return out;
        }
        /** Fully-qualified model-facing names (`mcp__<serverName>__<tool>`) of every disabled tool. */
        function disabledToolNames(map) {
            const out = [];
            for (const serverName of Object.keys(map)) {
                for (const tool of map[serverName])
                    out.push('mcp__' + serverName + '__' + tool);
            }
            return out;
        }
        async function mcpmToolEnabled(args) {
            const serverName = String((args && args.serverName) || '').trim();
            const tool = String((args && args.tool) || '').trim();
            if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName))
                return { ok: false, error: 'serverName 不合法' };
            if (!/^[A-Za-z0-9_-]{1,128}$/.test(tool))
                return { ok: false, error: 'tool 名称不合法' };
            const enabled = (args && args.enabled) !== false;
            const p = await ensurePaths();
            return withWriteLock(async () => {
                // Force re-read so an externally edited disabled-tools file is merged, not clobbered.
                const map = Object.assign({}, await readDisabledTools(true));
                const disabled = new Set(map[serverName] || []);
                if (enabled)
                    disabled.delete(tool);
                else
                    disabled.add(tool);
                if (disabled.size)
                    map[serverName] = [...disabled].sort();
                else
                    delete map[serverName];
                try {
                    await writeJsonFile(sidecarPath(p.home, DISABLED_TOOLS_FILE), map);
                }
                catch (e) {
                    return { ok: false, error: '保存失败: ' + message(e) };
                }
                disabledToolsCache = { at: Date.now(), value: map };
                await applyToolRestrictions();
                return { ok: true, serverName, disabled: map[serverName] || [] };
            });
        }
        // Visibility seam: keep one active restriction, refreshed whenever the tool
        // set or the disabled set changes. `restrict` fails on unknown names, so the
        // deny list is always intersected with the currently registered tools.
        let restrictDisposer = null;
        let restrictTimer = null;
        async function applyToolRestrictions() {
            if (typeof tools.restrict !== 'function')
                return;
            // Force re-read: this runs on the tools/change path, which is rare, so a
            // stale cache must not keep an externally edited deny list hidden.
            const map = await readDisabledTools(true);
            const wanted = disabledToolNames(map);
            let registered;
            try {
                registered = new Set((await tools.schemas()).map((schema) => String(schema.name)));
            }
            catch (e) {
                return;
            }
            const names = wanted.filter((name) => registered.has(name));
            if (restrictDisposer) {
                try {
                    restrictDisposer();
                }
                catch (e) { /* ignore */ }
                restrictDisposer = null;
            }
            if (!names.length)
                return;
            try {
                restrictDisposer = tools.restrict({ deny: names });
            }
            catch (e) { /* registry race: the next tools/change event retries */ }
        }
        function scheduleToolRestrictions() {
            if (restrictTimer)
                return;
            restrictTimer = setTimeout(() => {
                restrictTimer = null;
                applyToolRestrictions().catch(() => { });
            }, 300);
        }
        function truncateText(value, limit) {
            if (!limit || value.length <= limit)
                return value;
            return value.slice(0, Math.max(1, limit - 1)).replace(/\s+$/, '') + '…';
        }
        // ---------- secret masking (UI view only) ----------
        // Only sensitive-looking keys are masked; `$VAR` / `!!js` references are
        // indirections rather than secrets, so they stay readable. URL query strings
        // are redacted because MCP credentials often ride there.
        const SENSITIVE_KEY_RE = /(token|secret|password|passwd|auth|credential|api[_-]?key|access[_-]?key|private[_-]?key|cookie|session|signature|bearer)/i;
        function maskSecretValue(value) {
            const text = String(value == null ? '' : value);
            if (text === '')
                return '';
            if (text.startsWith('$'))
                return text;
            if (/^!!js\s/.test(text))
                return text;
            return '••••••';
        }
        function maskValueMap(map, onlySensitiveKeys) {
            if (!map || typeof map !== 'object')
                return map;
            const out = {};
            for (const key of Object.keys(map)) {
                out[key] = (!onlySensitiveKeys || SENSITIVE_KEY_RE.test(key)) ? maskSecretValue(map[key]) : String(map[key]);
            }
            return out;
        }
        function maskUrlQuery(url) {
            if (!url)
                return url;
            try {
                const parsed = new URL(url);
                if (parsed.search)
                    parsed.search = '?<redacted>';
                return parsed.toString();
            }
            catch (e) {
                return url;
            }
        }
        /** Shared UI rows: mcpmList plus notes, secrets masked unless `reveal`. */
        async function mcpmRowsWithNotes(reveal) {
            const result = await mcpmList();
            if (!result || result.ok === false)
                return result;
            const notes = await readNotes();
            const rows = (result.rows || []).map((row) => {
                const view = Object.assign({}, row, { notes: notes[row.id] || '' });
                if (!reveal) {
                    view.url = maskUrlQuery(row.url);
                    view.headers = maskValueMap(row.headers, true);
                    view.env = maskValueMap(row.env, true);
                }
                return view;
            });
            return Object.assign({}, result, { rows });
        }
        /** Default list view: secrets always masked. */
        async function mcpmListView() {
            return mcpmRowsWithNotes(false);
        }
        /**
         * Plain-text view. Split from mcpm-list into its own op so it can live in
         * WRITE_OPS: `mcpm-list` stays token-free for rendering, while revealing
         * env/headers secrets requires `x-dsh-token` when a token is configured —
         * otherwise a LAN-exposed port would leak credentials read-only.
         */
        async function mcpmReveal() {
            return mcpmRowsWithNotes(true);
        }
        async function mcpmTools(args) {
            const serverName = String(args && args.serverName || '').trim();
            if (!serverName)
                return { ok: false, error: 'serverName 不能为空' };
            const prefix = 'mcp__' + serverName + '__';
            let schemas = [];
            try {
                schemas = await tools.schemas();
            }
            catch (e) {
                return { ok: false, error: message(e) };
            }
            const descriptionLimit = (await readPluginSettings()).toolDescriptionMaxLength;
            const disabledHere = new Set((await readDisabledTools())[serverName] || []);
            const toolsList = [];
            for (const s of schemas) {
                const fullName = String(s && s.name || '');
                if (!fullName.startsWith(prefix))
                    continue;
                const rawName = fullName.slice(prefix.length);
                const params = [];
                const props = s.parameters && typeof s.parameters === 'object' ? s.parameters.properties : null;
                const requiredSet = new Set();
                if (s.parameters && Array.isArray(s.parameters.required)) {
                    for (const k of s.parameters.required)
                        if (typeof k === 'string')
                            requiredSet.add(k);
                }
                if (props && typeof props === 'object') {
                    for (const [key, spec] of Object.entries(props)) {
                        const ps = (spec && typeof spec === 'object') ? spec : {};
                        params.push({
                            key,
                            required: requiredSet.has(key),
                            type: typeof ps.type === 'string' ? ps.type : 'any',
                            ...(typeof ps.description === 'string' ? { description: ps.description } : {}),
                        });
                    }
                }
                toolsList.push({
                    name: rawName,
                    description: truncateText(typeof s.description === 'string' ? s.description : '', descriptionLimit),
                    enabled: !disabledHere.has(rawName),
                    parameters: params,
                });
            }
            // Some dsh-tools builds strip restricted tools from schemas(); without
            // this merge a disabled tool would vanish from the dialog with no way to
            // re-enable it from the UI. Names come from the sidecar, so they always
            // stay reachable; the description is unavailable once the schema is gone.
            const listed = new Set(toolsList.map((t) => t.name));
            for (const name of disabledHere) {
                if (!listed.has(name)) {
                    toolsList.push({ name, description: '（已停用；描述暂不可用）', enabled: false, parameters: [] });
                }
            }
            return { ok: true, tools: toolsList };
        }
        async function mcpmList() {
            const p = await ensurePaths();
            const rows = [];
            const errors = [];
            for (const level of ['project', 'global']) {
                const abs = level === 'project' ? p.projectPatch : p.globalPatch;
                let content = '';
                try {
                    content = await readPatch(abs);
                }
                catch (e) {
                    errors.push(level + ': ' + message(e));
                    continue;
                }
                const { rows: fileRows } = parseRows(content);
                for (const r of fileRows)
                    rows.push(normalizeRow(r, level, abs));
            }
            const toolCounts = {};
            try {
                const schemas = await tools.schemas();
                const seen = new Set();
                for (const s of schemas) {
                    const fullName = String(s && s.name || '');
                    seen.add(fullName);
                    const m = fullName.match(/^mcp__([A-Za-z0-9_-]+)__/);
                    if (m)
                        toolCounts[m[1]] = (toolCounts[m[1]] || 0) + 1;
                }
                // Restricted tools may be absent from schemas(); they still belong to
                // the per-server count so the UI does not show a phantom drop.
                for (const fullName of disabledToolNames(await readDisabledTools())) {
                    if (seen.has(fullName))
                        continue;
                    const m = fullName.match(/^mcp__([A-Za-z0-9_-]+)__/);
                    if (m)
                        toolCounts[m[1]] = (toolCounts[m[1]] || 0) + 1;
                }
            }
            catch (e) { /* ignore */ }
            let live = [];
            if (pluginInventory) {
                try {
                    const res = await pluginInventory.list();
                    live = res.entries.filter((e) => e.moduleName === '@deepseek-ai/dsh-mcp-client');
                }
                catch (e) { /* ignore */ }
            }
            for (const e of live) {
                const bid = bareEntryId(e.entryId);
                const found = rows.find((r) => r.id === bid);
                if (found)
                    found.live = { enabled: e.enabled, phase: e.fiberPhase };
                else
                    rows.push({ id: e.entryId, serverName: e.entryId, transport: null, url: null, command: null, args: null, env: null, headers: null, level: 'loader', disabled: !e.enabled, managed: false, live: { enabled: e.enabled, phase: e.fiberPhase } });
            }
            for (const row of rows) {
                if (row.toolCount === undefined)
                    row.toolCount = toolCounts[row.serverName] || 0;
            }
            // A loader id that appears twice (same id in both patch files, or twice in
            // one) makes the composition fail to boot. Surface it instead of hiding it.
            const idCounts = new Map();
            for (const row of rows)
                idCounts.set(String(row.id), (idCounts.get(String(row.id)) || 0) + 1);
            const duplicateIds = [...idCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
            for (const row of rows)
                row.duplicate = duplicateIds.indexOf(String(row.id)) >= 0;
            const warnings = [];
            if (duplicateIds.length)
                warnings.push('检测到重复的 loader id（会导致 DSH 无法启动，请手动清理补丁文件）：' + duplicateIds.join('、'));
            return {
                ok: true,
                rows,
                paths: { project: p.projectPatch, global: p.globalPatch, home: p.home, profile: p.profileName },
                errors,
                warnings,
            };
        }
        async function mcpmAdd(args) {
            const p = await ensurePaths();
            const serverName = String(args.serverName || '').trim();
            const transport = args.transport === 'stdio' ? 'stdio' : 'streamable-http';
            const level = args.level === 'global' ? 'global' : 'project';
            if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName))
                return { ok: false, error: 'serverName 需为 1-32 位 [A-Za-z0-9_-]' };
            const baseId = 'mcp-' + serverName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
            const existing = await collectAll();
            if (existing.serverNames.has(serverName))
                return { ok: false, error: 'serverName "' + serverName + '" 已存在' };
            let id = baseId;
            let n = 2;
            while (existing.ids.has(id)) {
                id = baseId + '-' + n;
                n++;
            }
            const row = { id, serverName, transport };
            if (transport === 'streamable-http') {
                const url = String(args.url || '').trim();
                if (!/^https?:\/\//.test(url))
                    return { ok: false, error: 'url 需为 http(s):// 开头的地址' };
                row.url = url;
                row.headers = parseKv(args.headers);
            }
            else {
                const command = String(args.command || '').trim();
                if (!command)
                    return { ok: false, error: 'command 不能为空' };
                row.command = command;
                row.args = parseArgs(args.args);
                row.env = parseKv(args.env);
            }
            const abs = level === 'global' ? p.globalPatch : p.projectPatch;
            return withWriteLock(async () => {
                let content = '';
                try {
                    content = await readPatch(abs);
                }
                catch (e) {
                    return { ok: false, error: '读取补丁失败: ' + message(e) };
                }
                const before = content;
                content = appendBlock(content, buildInsertBlock(row));
                if (args.enabled === false)
                    content = appendBlock(content, buildDisableBlock(id, true));
                const guard = duplicateGuard(before, content);
                if (guard)
                    return guard;
                try {
                    await writePatch(abs, content);
                }
                catch (e) {
                    return { ok: false, error: '写入补丁失败: ' + message(e) };
                }
                return { ok: true, row: { ...row, level, disabled: args.enabled === false } };
            });
        }
        async function mcpmEdit(args) {
            const p = await ensurePaths();
            const id = String(args.id || '');
            const level = args.level === 'global' ? 'global' : 'project';
            if (!id)
                return { ok: false, error: '缺少 id' };
            const all = await collectAll();
            const cur = all.rows.find((r) => r.id === id);
            if (!cur)
                return { ok: false, error: '未找到条目 ' + id };
            const serverName = String(args.serverName || '').trim();
            const transport = args.transport === 'stdio' ? 'stdio' : 'streamable-http';
            if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName))
                return { ok: false, error: 'serverName 需为 1-32 位 [A-Za-z0-9_-]' };
            if (serverName !== cur.serverName && all.serverNames.has(serverName))
                return { ok: false, error: 'serverName "' + serverName + '" 已被其他服务占用' };
            const row = { id, serverName, transport };
            if (transport === 'streamable-http') {
                const url = String(args.url || '').trim();
                if (!/^https?:\/\//.test(url))
                    return { ok: false, error: 'url 需为 http(s):// 开头的地址' };
                row.url = url;
                row.headers = parseKv(args.headers);
            }
            else {
                const command = String(args.command || '').trim();
                if (!command)
                    return { ok: false, error: 'command 不能为空' };
                row.command = command;
                row.args = parseArgs(args.args);
                row.env = parseKv(args.env);
            }
            const oldAbs = cur.level === 'global' ? p.globalPatch : p.projectPatch;
            const newAbs = level === 'global' ? p.globalPatch : p.projectPatch;
            const block = buildInsertBlock(row);
            return withWriteLock(async () => {
                // Per-tool disable state is keyed by the serverName namespace: migrate
                // it when a rename moves the tools to a new prefix.
                if (serverName !== cur.serverName) {
                    const toolMap = Object.assign({}, await readDisabledTools(true));
                    if (toolMap[cur.serverName]) {
                        toolMap[serverName] = toolMap[cur.serverName];
                        delete toolMap[cur.serverName];
                        try {
                            await writeJsonFile(sidecarPath(p.home, DISABLED_TOOLS_FILE), toolMap);
                        }
                        catch (e) { /* non-fatal */ }
                        disabledToolsCache = { at: Date.now(), value: toolMap };
                    }
                }
                if (oldAbs !== newAbs) {
                    // Level migration: remove from the old file, insert into the new one.
                    // Not atomic, so keep the old content and restore it if the second
                    // write fails — losing the entry is worse than a transient dup.
                    const origOld = await readPatch(oldAbs);
                    let c = origOld;
                    c = removeEntryAll(c, id);
                    try {
                        await writePatch(oldAbs, c);
                    }
                    catch (e) {
                        return { ok: false, error: '写入失败: ' + message(e) };
                    }
                    let c2 = await readPatch(newAbs);
                    const beforeNew = c2;
                    c2 = appendBlock(c2, block);
                    if (cur.disabled)
                        c2 = appendBlock(c2, buildDisableBlock(id, true));
                    const migrationGuard = duplicateGuard(beforeNew, c2);
                    if (migrationGuard) {
                        try {
                            await writePatch(oldAbs, origOld);
                        }
                        catch (e2) { /* best effort */ }
                        return migrationGuard;
                    }
                    try {
                        await writePatch(newAbs, c2);
                    }
                    catch (e) {
                        try {
                            await writePatch(oldAbs, origOld);
                        }
                        catch (e2) { /* best effort */ }
                        return { ok: false, error: '写入失败（已回滚）: ' + message(e) };
                    }
                }
                else {
                    let c = await readPatch(newAbs);
                    const before = c;
                    c = removeEntryAll(c, id);
                    c = appendBlock(c, block);
                    if (cur.disabled)
                        c = appendBlock(c, buildDisableBlock(id, true));
                    const guard = duplicateGuard(before, c);
                    if (guard)
                        return guard;
                    await writePatch(newAbs, c);
                }
                return { ok: true };
            });
        }
        async function mcpmSetEnabled(args) {
            const p = await ensurePaths();
            const { id, level } = args;
            const enabled = !!args.enabled;
            if (!id || (level !== 'global' && level !== 'project'))
                return { ok: false, error: '缺少 id 或 level' };
            if (!(await entryExists(id, level)))
                return { ok: false, error: '未找到条目 ' + id };
            const abs = level === 'global' ? p.globalPatch : p.projectPatch;
            return withWriteLock(async () => {
                let c = await readPatch(abs);
                if (enabled) {
                    // Drop every `disabled: true` override for this id. If the insert row
                    // itself still says disabled (e.g. user hand-edited it), append an
                    // explicit `disabled: false` override so the effective state flips.
                    // Enable overrides are intentionally left in place — they are the
                    // mechanism that lets a disabled-by-default row be turned on.
                    c = removeMarked(c, id, 'disable');
                    const { rows } = parseRows(c);
                    const row = rows.find((r) => r.id === id);
                    if (row && row.disabled)
                        c = appendBlock(c, buildDisableBlock(id, false));
                }
                else {
                    c = removeMarked(c, id, 'enable');
                    c = appendBlock(c, buildDisableBlock(id, true));
                }
                await writePatch(abs, c);
                return { ok: true };
            });
        }
        // Bulk enable/disable for every patch-resident server row. Covers both
        // levels at once, or a single level via args.level. Loader-only rows
        // (never written to a patch file) are out of scope. Each file is rewritten
        // at most once; rows already in the target state are left untouched.
        async function mcpmSetAll(args) {
            const p = await ensurePaths();
            const enabled = !!args.enabled;
            const levelFilter = args.level === 'global' ? 'global' : args.level === 'project' ? 'project' : null;
            return withWriteLock(async () => {
                const changed = [];
                for (const level of ['project', 'global']) {
                    if (levelFilter && levelFilter !== level)
                        continue;
                    const abs = level === 'project' ? p.projectPatch : p.globalPatch;
                    let c = '';
                    try {
                        c = await readPatch(abs);
                    }
                    catch (e) {
                        continue;
                    }
                    const { rows } = parseRows(c);
                    for (const row of rows) {
                        if (!!row.disabled === !enabled)
                            continue;
                        changed.push(row.id);
                        if (enabled) {
                            c = removeMarked(c, row.id, 'disable');
                            const { rows: after } = parseRows(c);
                            const still = after.find((r) => r.id === row.id);
                            if (still && still.disabled)
                                c = appendBlock(c, buildDisableBlock(row.id, false));
                        }
                        else {
                            c = removeMarked(c, row.id, 'enable');
                            c = appendBlock(c, buildDisableBlock(row.id, true));
                        }
                    }
                    await writePatch(abs, c);
                }
                return { ok: true, enabled, changed };
            });
        }
        /** Effective disabled state of a patch row (insert-row flag merged with override blocks). */
        async function isRowDisabled(id, level) {
            const p = await ensurePaths();
            const abs = level === 'global' ? p.globalPatch : p.projectPatch;
            try {
                const { rows } = parseRows(await readPatch(abs));
                const row = rows.find((r) => r.id === id);
                return row ? !!row.disabled : false;
            }
            catch (e) {
                return false;
            }
        }
        async function mcpmRestart(args) {
            const p = await ensurePaths();
            const { id, level } = args;
            if (!id || (level !== 'global' && level !== 'project'))
                return { ok: false, error: '缺少 id 或 level' };
            if (!(await entryExists(id, level)))
                return { ok: false, error: '未找到条目 ' + id };
            const abs = level === 'global' ? p.globalPatch : p.projectPatch;
            // A restart reconnects the server; it must NOT flip the enabled state.
            // The recovery write below used to strip every disable override, which
            // silently re-enabled servers the user had disabled on purpose — so the
            // pre-restart state is captured and restored.
            const wasDisabled = await isRowDisabled(id, level);
            const warnings = [];
            // Phase 1 write (short lock): force-disable. Stale disable overrides are
            // cleared first so duplicate blocks never accumulate.
            await withWriteLock(async () => {
                let c = await readPatch(abs);
                c = removeMarked(c, id, 'enable');
                c = removeMarked(c, id, 'disable');
                c = appendBlock(c, buildDisableBlock(id, true));
                await writePatch(abs, c);
            });
            if (pluginInventory) {
                const off = await waitFor(async () => {
                    const e = await liveEntry(id);
                    return e ? e.enabled === false : false;
                }, 5000, 300);
                if (!off)
                    warnings.push('loader 未在 5 秒内停用该服务');
            }
            await wait(1000);
            // Phase 2 write (short lock): restore the pre-restart state. The polling
            // waits deliberately run OUTSIDE the write lock — holding the global
            // write lock for up to ~11s stalled every other write op.
            await withWriteLock(async () => {
                let c = await readPatch(abs);
                c = removeMarked(c, id, 'disable');
                if (wasDisabled)
                    c = appendBlock(c, buildDisableBlock(id, true));
                await writePatch(abs, c);
            });
            if (pluginInventory) {
                if (!wasDisabled) {
                    const on = await waitFor(async () => {
                        const e = await liveEntry(id);
                        return e ? e.enabled === true : false;
                    }, 5000, 300);
                    if (!on)
                        warnings.push('loader 未在 5 秒内重新启用该服务');
                }
            }
            else
                await wait(1500);
            return warnings.length ? { ok: true, warning: warnings.join('；') } : { ok: true };
        }
        async function mcpmRemove(args) {
            const p = await ensurePaths();
            const { id, level } = args;
            if (!id || (level !== 'global' && level !== 'project'))
                return { ok: false, error: '缺少 id 或 level' };
            const abs = level === 'global' ? p.globalPatch : p.projectPatch;
            return withWriteLock(async () => {
                let c = await readPatch(abs);
                c = removeEntryAll(c, id);
                await writePatch(abs, c);
                return { ok: true };
            });
        }
        async function mcpmExport() {
            const p = await ensurePaths();
            const list = await mcpmList();
            const rows = (list.rows || []).filter((r) => r.level !== 'loader').map((r) => ({
                id: r.id,
                serverName: r.serverName,
                transport: r.transport,
                url: r.url || undefined,
                command: r.command || undefined,
                args: r.args || undefined,
                env: r.env || undefined,
                headers: r.headers || undefined,
                level: r.level,
                disabled: r.disabled,
            }));
            const json = JSON.stringify({ exportedAt: new Date().toISOString(), rows }, null, 2);
            let savedTo = null;
            try {
                const abs = p.home + (p.home.indexOf('\\') >= 0 ? '\\' : '/') + 'dsh-plugin-tool-management-export.json';
                await writePatch(abs, json);
                savedTo = abs;
            }
            catch (e) { /* non-fatal */ }
            return { ok: true, json, savedTo };
        }
        async function mcpmImport(args) {
            const p = await ensurePaths();
            const overwrite = !!(args && args.conflict === 'overwrite');
            let parsed = null;
            try {
                parsed = JSON.parse(String(args.json || ''));
            }
            catch (e) {
                return { ok: false, error: 'JSON 解析失败: ' + message(e) };
            }
            const entries = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.rows) ? parsed.rows : null);
            if (!entries)
                return { ok: false, error: '导入内容格式不正确：需要数组或 { rows: [...] }' };
            const added = [];
            const overwritten = [];
            const skipped = [];
            for (const item of entries) {
                const norm = normalizeImportItem(item);
                if (!norm.ok) {
                    skipped.push({ id: (item && (item.id || item.serverName)) || '?', reason: norm.error });
                    continue;
                }
                const row = norm.row;
                // Existence checks run INSIDE the write lock so two concurrent imports
                // (or an import racing an add) cannot both pass the same-id/same-name
                // check and duplicate rows (TOCTOU).
                const res = await withWriteLock(async () => {
                    const existing = await collectAll();
                    const idTaken = existing.ids.has(row.id);
                    const nameTaken = existing.serverNames.has(row.serverName);
                    // serverName is globally unique: a DIFFERENT id owning the name is
                    // always skipped, even in overwrite mode.
                    if (nameTaken && !idTaken)
                        return { skipped: true, reason: 'serverName 已存在' };
                    if (idTaken && !overwrite)
                        return { skipped: true, reason: 'id 已存在' };
                    if (idTaken && overwrite) {
                        // Purge every trace of the id from BOTH patch files first, then
                        // insert the imported row at its own level.
                        for (const lvl of ['project', 'global']) {
                            const lAbs = lvl === 'global' ? p.globalPatch : p.projectPatch;
                            let lContent = '';
                            try {
                                lContent = await readPatch(lAbs);
                            }
                            catch (e) {
                                continue;
                            }
                            lContent = removeEntryAll(lContent, row.id);
                            try {
                                await writePatch(lAbs, lContent);
                            }
                            catch (e) {
                                return { skipped: true, reason: '覆盖旧条目失败: ' + message(e) };
                            }
                        }
                    }
                    const abs = row.level === 'global' ? p.globalPatch : p.projectPatch;
                    let c = await readPatch(abs);
                    const before = c;
                    c = appendBlock(c, buildInsertBlock(row));
                    if (row.disabled)
                        c = appendBlock(c, buildDisableBlock(row.id, true));
                    if (duplicateGuard(before, c))
                        return { skipped: true, reason: '会产生重复的 loader id' };
                    await writePatch(abs, c);
                    return { added: true, wasOverwrite: idTaken && overwrite };
                });
                if (res.added) {
                    added.push(row.id);
                    if (res.wasOverwrite)
                        overwritten.push(row.id);
                }
                else
                    skipped.push({ id: row.id, reason: (res && res.reason) || '写入失败' });
            }
            return overwrite ? { ok: true, added, overwritten, skipped } : { ok: true, added, skipped };
        }
        function parseKv(text) {
            const out = {};
            String(text || '').split(/\r?\n/).forEach((line) => {
                const t = line.trim();
                if (!t || t.startsWith('#'))
                    return;
                const i = t.indexOf('=');
                if (i <= 0)
                    return;
                out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
            });
            return out;
        }
        function parseArgs(text) {
            return String(text || '').split(/[\s,]+/).map((s) => s.trim()).filter((s) => s !== '');
        }
        // ---------- open a skill source in the OS default editor ----------
        // Fire-and-forget: the launcher detaches, so a hanging editor never blocks
        // the request. Only existing Markdown source files are accepted — the route
        // is same-origin + token gated, but it must not become a "launch anything"
        // primitive.
        function openWithSystemEditor(abs) {
            try {
                const platform = process.platform;
                const command = platform === 'win32' ? 'explorer.exe' : platform === 'darwin' ? 'open' : 'xdg-open';
                const child = spawn(command, [abs], { detached: true, stdio: 'ignore', windowsHide: true });
                child.on('error', () => { });
                child.unref();
                return true;
            }
            catch (e) {
                return false;
            }
        }
        async function skillOpen(args) {
            const abs = String((args && args.path) || '').trim();
            if (!abs)
                return { ok: false, error: '缺少 path' };
            if (!/^([A-Za-z]:[\\/]|\\\\|\/)/.test(abs))
                return { ok: false, error: '需要绝对路径' };
            if (!/\.(md|markdown|txt)$/i.test(abs))
                return { ok: false, error: '只支持打开 Markdown 源文件' };
            if (!(await exists(abs)))
                return { ok: false, error: '文件不存在：' + abs };
            if (!openWithSystemEditor(abs))
                return { ok: false, error: '无法调用系统默认打开方式' };
            return { ok: true, path: abs };
        }
        // 批量操作目标校验：scope 白名单；sessions 需非空 sessionIds；workspace 需
        // workspaceId。与 ArchiveWorkspaceRegistry.archivedBatchTargetSchema 语义一致。
        function parseHistoryBatchTarget(raw) {
            const t = raw && typeof raw === 'object' ? raw : null;
            if (!t)
                return { ok: false, error: '缺少 target' };
            const scope = t.scope;
            if (scope !== 'all' && scope !== 'ungrouped' && scope !== 'sessions' && scope !== 'workspace') {
                return { ok: false, error: 'target.scope 不合法' };
            }
            if (scope === 'sessions') {
                if (!Array.isArray(t.sessionIds) || t.sessionIds.length === 0 ||
                    t.sessionIds.some((id) => typeof id !== 'string' || !String(id).trim())) {
                    return { ok: false, error: 'scope=sessions 需要非空的 sessionIds 数组' };
                }
            }
            if (scope === 'workspace' && !(typeof t.workspaceId === 'string' && String(t.workspaceId).trim())) {
                return { ok: false, error: 'scope=workspace 需要 workspaceId' };
            }
            return {
                ok: true,
                target: {
                    scope,
                    ...(scope === 'sessions' ? { sessionIds: t.sessionIds.map((s) => String(s).trim()) } : {}),
                    ...(scope === 'workspace' ? { workspaceId: String(t.workspaceId).trim() } : {}),
                },
            };
        }
        const handlers = {
            'plugin-version': pluginVersion,
            'mcpm-list': mcpmListView,
            'mcpm-reveal': mcpmReveal,
            'mcpm-note': mcpmNote,
            'mcpm-settings': mcpmSettings,
            'mcpm-tool-enabled': mcpmToolEnabled,
            'skill-open': skillOpen,
            'mcpm-tools': mcpmTools,
            'mcpm-add': mcpmAdd,
            'mcpm-edit': mcpmEdit,
            'mcpm-set-enabled': mcpmSetEnabled,
            'mcpm-set-all': mcpmSetAll,
            'mcpm-restart': mcpmRestart,
            'mcpm-remove': mcpmRemove,
            'mcpm-export': mcpmExport,
            'mcpm-import': mcpmImport,
            // 技能管理 ops（由 ./skills/service.js 提供）：skill-state / skill-detail /
            // skill-browse / skill-enable / skill-disable / skill-source-enable /
            // skill-source-disable / skill-create / skill-import / skill-upload /
            // skill-delete / skill-trash-restore / skill-trash-delete
            // 成功返回 {ok:true, data}；core 业务失败原样透传 {ok:false, error, code?, params?}。
            ...skillsService.ops,
            // rules ops（由 ./rules/service.js 提供）：rules-list / rules-read / rules-budget /
            // rules-diagnose / rules-create / rules-update / rules-remove / rules-restore /
            // rules-trash-list / rules-trash-remove / rules-toggle / rules-set-index /
            // rules-set-active / rules-create-scene / rules-remove-scene。
            // 成功返回扁平 {ok:true, ...}（不套 data），失败 {ok:false, error, code?}。
            ...rulesService.ops,
            // AGENTS.md 预设库 ops（由 ./agents-md/service.js 提供）：agentsmd-list /
            // agentsmd-read / agentsmd-create / agentsmd-update / agentsmd-remove /
            // agentsmd-apply / agentsmd-get-current
            'agentsmd-list': () => agentsMdService.list(),
            'agentsmd-read': (args) => agentsMdService.read(String((args && args.id) || '')),
            'agentsmd-create': (args) => agentsMdService.create(String((args && args.id) || ''), args && args.from ? String(args.from) : undefined),
            'agentsmd-update': (args) => agentsMdService.update(String((args && args.id) || ''), String((args && args.content) ?? '')),
            'agentsmd-apply': (args) => agentsMdService.apply(String((args && args.id) || '')),
            'agentsmd-get-current': () => agentsMdService.getCurrent(),
            'agentsmd-remove': (args) => agentsMdService.remove(String((args && args.id) || '')),
            'agentsmd-import': (args) => agentsMdService.importPreset(String((args && args.id) || ''), String((args && args.content) ?? '')),
            // History（归档会话管理）ops。只读：history-list / history-retention-get；
            // 写：history-archive / history-unarchive / history-delete / history-retention-set。
            // workspaceRegistry 缺失（补丁未生效）时返回明确错误，不崩页面。
            'history-list': async () => {
                const registry = getHistoryRegistry();
                if (!registry)
                    return { ok: false, error: '归档服务未挂载：workspace 已被替换？请确认本插件补丁已生效。' };
                try {
                    const items = (typeof registry.archivedSessionDetails === 'function')
                        ? (await registry.archivedSessionDetails()).items
                        : (await registry.archivedSessionMetadata()).items.map((i) => ({ sessionId: i.sessionId, createdAt: i.createdAt, archivedAt: registry.archivedAt?.(i.sessionId) }));
                    const { retentionDays } = await readHistoryRetention();
                    // 分组增强（best-effort）：用 workspace 记账表反查每个归档会话的归属，
                    // 供客户端按项目分组。requireTable 缺失或任何异常都静默降级为扁平列表。
                    if (typeof registry.requireTable === 'function') {
                        try {
                            const table = registry.requireTable();
                            const state = typeof registry.requireState === 'function' ? registry.requireState() : undefined;
                            const wsIds = state && Array.isArray(state.workspaceIds) && state.workspaceIds.length
                                ? state.workspaceIds
                                : [...table.entries()].map(([id]) => id);
                            const owned = new Map();
                            const workspaces = {};
                            for (const wid of wsIds) {
                                const rec = table.get(wid);
                                if (!rec || !Array.isArray(rec.sessionIds))
                                    continue;
                                for (const sid of rec.sessionIds)
                                    if (!owned.has(sid))
                                        owned.set(sid, wid);
                                workspaces[wid] = {
                                    title: (rec.title && String(rec.title)) || String(wid),
                                    ...(typeof rec.path === 'string' && rec.path ? { path: rec.path } : {}),
                                };
                            }
                            for (const it of items) {
                                const wid = owned.get(it.sessionId);
                                if (wid !== undefined)
                                    it.workspaceId = wid;
                            }
                            return { ok: true, items, workspaces, retentionDays };
                        }
                        catch (e) { /* 降级为下方扁平返回 */ }
                    }
                    return { ok: true, items, retentionDays };
                }
                catch (e) {
                    return { ok: false, error: message(e) };
                }
            },
            // 枚举全部持久化会话（含未归档/冷会话）供导出弹窗选择；只读，不门控。
            // 标题经投影缓存 best-effort；任何一步失败只降级为缺字段。
            'history-sessions': async () => {
                const registry = getHistoryRegistry();
                if (!registry || typeof registry.listStoredHeaders !== 'function') {
                    return { ok: false, error: '当前环境不支持枚举全部会话（registry 未实现 listStoredHeaders）' };
                }
                try {
                    const headers = await registry.listStoredHeaders();
                    const archivedItems = typeof registry.archivedSessionDetails === 'function'
                        ? (await registry.archivedSessionDetails()).items
                        : (await registry.archivedSessionMetadata()).items;
                    const archived = new Set(archivedItems.map((i) => i.sessionId));
                    // 工作区归属反查（与 history-list 一致；best-effort）。
                    const table = typeof registry.requireTable === 'function' ? registry.requireTable() : undefined;
                    const state = typeof registry.requireState === 'function' ? registry.requireState() : undefined;
                    const wsIds = state && Array.isArray(state.workspaceIds) && state.workspaceIds.length
                        ? state.workspaceIds
                        : (table ? [...table.entries()].map(([id]) => id) : []);
                    const owned = new Map();
                    if (table) {
                        for (const wid of wsIds) {
                            const rec = table.get(wid);
                            if (!rec || !Array.isArray(rec.sessionIds))
                                continue;
                            for (const sid of rec.sessionIds)
                                if (!owned.has(sid))
                                    owned.set(sid, wid);
                        }
                    }
                    const cache = ctx.get('sessionProjectionCache');
                    const items = [];
                    for (const h of headers) {
                        const sessionId = h && typeof h.id === 'string' ? h.id : undefined;
                        if (!sessionId)
                            continue;
                        // 过滤子代理派生的会话：不占用用户会话列表，也不应出现在导出选择里。
                        if (h.origin === 'subagent')
                            continue;
                        const item = {
                            sessionId,
                            archived: archived.has(sessionId),
                        };
                        if (typeof h.cwd === 'string' && h.cwd)
                            item.cwd = h.cwd;
                        if (typeof h.createdAt === 'number' && Number.isFinite(h.createdAt))
                            item.createdAt = h.createdAt;
                        const wid = owned.get(sessionId);
                        if (wid !== undefined)
                            item.workspaceId = wid;
                        if (cache && typeof cache.cachedSnapshot === 'function') {
                            try {
                                const snap = cache.cachedSnapshot(h, 0, ['title']);
                                if (snap && snap.values && typeof snap.values.title === 'string')
                                    item.title = snap.values.title;
                            }
                            catch { /* title best-effort */ }
                        }
                        // 工作区目录可能已被删除/移动（孤儿会话）：best-effort 标记，供导出选择时识别。
                        if (item.cwd) {
                            try {
                                const st = await stat(item.cwd);
                                item.cwdMissing = !st.isDirectory();
                            }
                            catch {
                                item.cwdMissing = true;
                            }
                        }
                        items.push(item);
                    }
                    return { ok: true, items };
                }
                catch (e) {
                    return { ok: false, error: message(e) };
                }
            },
            // 导出默认目录：桌面（存在时）否则用户主目录。只读，不门控。
            'history-export-defaults': async () => {
                let dir = homedir();
                try {
                    const desktop = join(homedir(), 'Desktop');
                    const st = await stat(desktop);
                    if (st.isDirectory())
                        dir = desktop;
                }
                catch { /* 桌面路径不可用 → 回退主目录 */ }
                return { ok: true, defaultDir: dir };
            },
            // 列出目录的子目录，供客户端「选择文件夹」弹窗逐级浏览。dir 为空时返回根
            // 视图（Windows 枚举盘符，其他平台返回 '/'）。只读，不门控。
            'dir-list': async (args) => {
                const raw = String((args && args.dir) || '').trim();
                try {
                    if (!raw) {
                        if (process.platform !== 'win32')
                            return { ok: true, current: '/', parent: null, entries: [] };
                        const drives = [];
                        for (let c = 65; c <= 90; c++) {
                            const root = String.fromCharCode(c) + ':\\';
                            try {
                                await stat(root);
                                drives.push({ name: root, path: root });
                            }
                            catch { /* 跳过不存在的盘符 */ }
                        }
                        return { ok: true, current: '', parent: null, entries: drives };
                    }
                    const st = await stat(raw);
                    if (!st.isDirectory())
                        return { ok: false, error: '该路径不是目录' };
                    const parent = dirname(raw);
                    const names = await readdir(raw, { withFileTypes: true });
                    const entries = names
                        .filter((d) => d.isDirectory())
                        .map((d) => ({ name: d.name, path: join(raw, d.name) }))
                        .sort((a, b) => a.name.localeCompare(b.name));
                    return { ok: true, current: raw, parent: parent === raw ? null : parent, entries };
                }
                catch (e) {
                    return { ok: false, error: message(e) };
                }
            },
            'history-archive': async (args) => {
                const registry = getHistoryRegistry();
                if (!registry)
                    return { ok: false, error: '归档服务未挂载' };
                const sessionId = String((args && args.sessionId) || '').trim();
                if (!sessionId)
                    return { ok: false, error: '缺少 sessionId' };
                try {
                    await registry.archiveSession(sessionId);
                    return { ok: true, sessionId };
                }
                catch (e) {
                    return { ok: false, error: message(e) };
                }
            },
            // 批量归档（导出弹窗「归档所选」）：把选中的会话收进 History，纳入保留期管理。
            'history-archive-batch': async (args) => {
                const registry = getHistoryRegistry();
                if (!registry)
                    return { ok: false, error: '归档服务未挂载' };
                const rawIds = (args && args.sessionIds) || [];
                const ids = Array.isArray(rawIds) ? rawIds.map((s) => String(s).trim()).filter(Boolean) : [];
                if (!ids.length)
                    return { ok: false, error: '请至少选择一个会话' };
                const archived = [];
                const failed = [];
                for (const sessionId of ids) {
                    try {
                        await registry.archiveSession(sessionId);
                        archived.push(sessionId);
                    }
                    catch (e) {
                        failed.push({ sessionId, error: message(e) });
                    }
                }
                return { ok: true, archived, failed };
            },
            'history-unarchive': async (args) => {
                const registry = getHistoryRegistry();
                if (!registry)
                    return { ok: false, error: '归档服务未挂载' };
                const sessionId = String((args && args.sessionId) || '').trim();
                if (!sessionId)
                    return { ok: false, error: '缺少 sessionId' };
                try {
                    const r = await registry.unarchiveSession(sessionId);
                    return { ok: true, archivedSessionIds: r.archivedSessionIds };
                }
                catch (e) {
                    return { ok: false, error: message(e) };
                }
            },
            'history-delete': async (args) => {
                const registry = getHistoryRegistry();
                if (!registry)
                    return { ok: false, error: '归档服务未挂载' };
                const sessionId = String((args && args.sessionId) || '').trim();
                if (!sessionId)
                    return { ok: false, error: '缺少 sessionId' };
                try {
                    await registry.deleteSession(sessionId);
                    return { ok: true, sessionId, deleted: true };
                }
                catch (e) {
                    return { ok: false, error: message(e) };
                }
            },
            'history-unarchive-batch': async (args) => {
                const registry = getHistoryRegistry();
                if (!registry)
                    return { ok: false, error: '归档服务未挂载' };
                if (typeof registry.unarchiveSessions !== 'function')
                    return { ok: false, error: '当前环境不支持批量恢复（registry 未实现 unarchiveSessions）' };
                const parsed = parseHistoryBatchTarget(args && args.target);
                if (!parsed.ok)
                    return parsed;
                try {
                    const r = await registry.unarchiveSessions(parsed.target);
                    return { ok: true, unarchivedSessionIds: r.unarchivedSessionIds, archivedSessionIds: r.archivedSessionIds };
                }
                catch (e) {
                    return { ok: false, error: message(e) };
                }
            },
            'history-delete-batch': async (args) => {
                const registry = getHistoryRegistry();
                if (!registry)
                    return { ok: false, error: '归档服务未挂载' };
                const parsed = parseHistoryBatchTarget(args && args.target);
                if (!parsed.ok)
                    return parsed;
                try {
                    const r = await registry.deleteArchivedSessions(parsed.target);
                    return { ok: true, requestedSessionIds: r.requestedSessionIds, deletedSessionIds: r.deletedSessionIds, skippedSessionIds: r.skippedSessionIds, failures: r.failures };
                }
                catch (e) {
                    return { ok: false, error: message(e) };
                }
            },
            // 从其他 Agent（Claude Code / Cursor JSONL、Codex Markdown、通用文本）导入对话，
            // 通过 sessions.create 的 seed 机制生成一个可继续对话的全新会话。
            'history-import': async (args) => {
                const fileName = String((args && args.fileName) || '').trim();
                const content = String((args && args.content) ?? '');
                if (!fileName || !content.trim())
                    return { ok: false, error: '缺少文件内容' };
                let turns;
                try {
                    const format = detectFormat(fileName, content);
                    turns = format === 'jsonl' ? parseJsonlTranscript(content)
                        : format === 'markdown' ? parseMarkdownTranscript(content)
                            : parseGenericText(content);
                }
                catch (e) {
                    return { ok: false, error: '对话解析失败: ' + message(e) };
                }
                if (!turns.length)
                    return { ok: false, error: '未能从该文件中识别出对话内容' };
                const sessions = ctx.get('sessions');
                if (!sessions || typeof sessions.create !== 'function')
                    return { ok: false, error: '当前环境不支持创建会话（sessions.create 不可用）' };
                // 仅接受绝对路径的 cwd；非法或缺失时会话不带目录（归入未分组）。
                const cwdArg = String((args && args.cwd) || '').trim();
                const cwd = /^([A-Za-z]:[\\/]|\\\\|\/)/.test(cwdArg) ? cwdArg : undefined;
                // seed 事件信封：seq 从 0 连续、time 为安全整数、surface 事件必须带 surfaceOp:'append'。
                const base = Date.now();
                const seed = turns.map((turn, i) => ({
                    type: turn.role === 'user' ? 'user/message' : 'assistant/message',
                    seq: i,
                    time: base + i,
                    data: turn.role === 'user'
                        ? { id: 'msg-' + i, role: 'user', content: [{ type: 'text', text: turn.text }], source: { kind: 'typed' } }
                        : { message: { id: 'msg-' + i, role: 'assistant', content: [{ type: 'text', text: turn.text }], source: { kind: 'model', provider: 'imported', model: 'imported' } }, turn: i, step: 0, stream: [] },
                    surfaceOp: 'append',
                }));
                try {
                    const created = sessions.create(undefined, { seed, meta: { ...(cwd ? { cwd } : {}), createdAt: base } });
                    return { ok: true, sessionId: created.id, count: turns.length };
                }
                catch (e) {
                    return { ok: false, error: '创建会话失败: ' + message(e) };
                }
            },
            // 把选中的归档会话导出为可再导入的转录文件（Markdown / JSONL），写入指定目录。
            // 每个会话一个文件；读不到正文的冷会话列入 skipped，不中断其余导出。
            'history-export': async (args) => {
                const rawIds = (args && args.sessionIds) || [];
                const ids = Array.isArray(rawIds) ? rawIds.map((s) => String(s).trim()).filter(Boolean) : [];
                if (!ids.length)
                    return { ok: false, error: '请至少选择一个会话' };
                const format = String((args && args.format) || 'markdown').toLowerCase();
                if (format !== 'markdown' && format !== 'jsonl')
                    return { ok: false, error: 'format 需为 markdown 或 jsonl' };
                const outDir = String((args && args.outDir) || '').trim();
                if (!/^([A-Za-z]:[\\/]|\\\\|\/)/.test(outDir))
                    return { ok: false, error: '导出目录需为绝对路径' };
                const sessions = ctx.get('sessions');
                if (!sessions || typeof sessions.get !== 'function')
                    return { ok: false, error: '当前环境不支持读取会话（sessions.get 不可用）' };
                // 读会话事件：先取活动 store；冷会话（进程重启后）从持久化后端恢复只读句柄。
                const readEvents = async (sessionId) => {
                    const live = sessions.get(sessionId);
                    if (live && typeof live.snapshotEvents === 'function') {
                        const ev = live.snapshotEvents();
                        return Array.isArray(ev) ? ev : undefined;
                    }
                    const persistence = ctx.get('sessionPersistence');
                    if (persistence && typeof persistence.prepare === 'function') {
                        try {
                            const prep = await persistence.prepare(sessionId);
                            const ps = prep && prep.session;
                            try {
                                if (ps && typeof ps.snapshotEvents === 'function') {
                                    const ev = ps.snapshotEvents();
                                    return Array.isArray(ev) ? ev : undefined;
                                }
                            }
                            finally {
                                const dispose = prep[Symbol.dispose];
                                if (typeof dispose === 'function')
                                    dispose();
                            }
                        }
                        catch {
                            return undefined;
                        }
                    }
                    return undefined;
                };
                try {
                    await mkdir(outDir, { recursive: true });
                }
                catch (e) {
                    return { ok: false, error: '创建导出目录失败: ' + message(e) };
                }
                const ext = format === 'jsonl' ? '.jsonl' : '.md';
                const exported = [];
                const skipped = [];
                for (const sessionId of ids) {
                    const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
                    const fileName = safe + ext;
                    const path = join(outDir, fileName);
                    try {
                        const events = await readEvents(sessionId);
                        const turns = extractTurnsFromEvents(events || []);
                        if (!turns.length) {
                            skipped.push({ sessionId, error: events ? '会话中没有可导出的消息' : '无法读取会话内容（不在活动存储且无持久化句柄）' });
                            continue;
                        }
                        await writeFile(path, serializeTurns(turns, format), 'utf8');
                        exported.push({ sessionId, fileName, path, count: turns.length });
                    }
                    catch (e) {
                        skipped.push({ sessionId, error: '导出失败: ' + message(e) });
                    }
                }
                return { ok: true, exported, skipped };
            },
            'history-retention-get': async () => {
                const { retentionDays } = await readHistoryRetention();
                return { ok: true, retentionDays };
            },
            'history-retention-set': async (args) => {
                const days = Number((args && args.retentionDays) ?? -1);
                if (!Number.isFinite(days) || days < 0)
                    return { ok: false, error: 'retentionDays 需为非负整数（0=永久不删除）' };
                await writeHistoryRetention(Math.floor(days));
                // 设置变更后立即扫一次，UI 反映新策略。
                await sweepHistory().catch(() => { });
                return { ok: true, retentionDays: Math.floor(days) };
            },
        };
        // ---------- agent-facing tools (standard ctx.tools.register + defineTool) ----------
        const text = (value) => [{ type: 'text', text: value }];
        tools.register(defineTool({
            name: 'skill_mcp_manager_list',
            description: 'List all configured MCP servers (level, enabled state, live loader status, registered tool count).',
            parameters: {},
            output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
            async execute() {
                const r = await mcpmList();
                if (!r.ok)
                    throw new Error(r.error);
                const summary = (r.rows || []).map((x) => (x.id + ' | ' + x.serverName + ' | ' + x.level + ' | ' + (x.disabled ? 'disabled' : 'enabled') +
                    (x.live ? ' | loader:' + (x.live.enabled ? 'on' : 'off') + (x.live.phase ? ':' + x.live.phase : '') : '') +
                    (typeof x.toolCount === 'number' ? ' | tools:' + x.toolCount : '')));
                return 'MCP servers:\n' + (summary.join('\n') || '(none)');
            },
        }));
        tools.register(defineTool({
            name: 'skill_mcp_manager_set_enabled',
            description: 'Enable or disable one configured MCP server (writes the patch file; takes effect via HMR).',
            parameters: {
                id: { type: 'string', required: true, description: 'Entry id of the MCP server, e.g. mcp-stepfun-web-search.' },
                level: { type: 'string', required: true, description: 'project or global.' },
                enabled: { type: 'boolean', required: true, description: 'true to enable, false to disable.' },
            },
            output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
            async execute(args) {
                const r = await mcpmSetEnabled({ id: args.id, level: args.level, enabled: args.enabled });
                if (!r.ok)
                    throw new Error(r.error);
                return 'OK: ' + args.id + ' now ' + (args.enabled ? 'enabled' : 'disabled');
            },
        }));
        tools.register(defineTool({
            name: 'skill_mcp_manager_restart',
            description: 'Restart one configured MCP server (disable + re-enable; reconnect and re-sync tools).',
            parameters: {
                id: { type: 'string', required: true, description: 'Entry id of the MCP server, e.g. mcp-stepfun-web-search.' },
                level: { type: 'string', required: true, description: 'project or global.' },
            },
            output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
            async execute(args) {
                const r = await mcpmRestart({ id: args.id, level: args.level });
                if (!r.ok)
                    throw new Error(r.error);
                return 'OK: ' + args.id + ' restarted';
            },
        }));
        tools.register(defineTool({
            name: 'skill_mcp_manager_add',
            description: 'Add a new MCP server (streamable-http or stdio) at project or global level.',
            parameters: {
                serverName: { type: 'string', required: true, description: 'Unique server name (1-32 chars, [A-Za-z0-9_-]).' },
                transport: { type: 'string', required: true, description: 'streamable-http or stdio.' },
                url: { type: 'string', description: 'Server URL (required for streamable-http).' },
                command: { type: 'string', description: 'Executable (required for stdio).' },
                args: { type: 'string', description: 'Arguments, space separated (stdio).' },
                headers: { type: 'string', description: 'Extra headers as key=value lines (streamable-http).' },
                env: { type: 'string', description: 'Extra env vars as key=value lines (stdio).' },
                level: { type: 'string', description: 'project or global (default project).' },
            },
            output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
            async execute(args) {
                const r = await mcpmAdd(args);
                if (!r.ok)
                    throw new Error(r.error);
                return 'OK: added ' + r.row.id + ' at ' + r.row.level;
            },
        }));
        // Skill-facing tools: list, toggle, create. create is gated by the
        // tools/pre-execute hook below (the model must ask before writing files).
        tools.register(defineTool({
            name: 'skill_manager_list',
            description: 'List DSH skills across all sources (dsh/agents/codex/claude user roots and project roots) with their enabled state.',
            parameters: {},
            output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
            async execute() {
                const r = await skillsService.ops['skill-state']({});
                if (!r || r.ok === false)
                    throw new Error((r && r.error) || 'skill-state failed');
                const data = r.data || {};
                const lines = [];
                for (const root of data.roots || []) {
                    for (const skill of root.skills || []) {
                        lines.push((skill.name || skill.declaredName || '') + ' | ' + (root.key || '') + ' | ' + (skill.enabled ? 'enabled' : 'disabled'));
                    }
                }
                return 'Skills:\n' + (lines.join('\n') || '(none)');
            },
        }));
        tools.register(defineTool({
            name: 'skill_manager_set_enabled',
            description: 'Enable or disable one DSH skill (manager policy only; skill source files are never modified).',
            parameters: {
                name: { type: 'string', required: true, description: 'Skill name (kebab-case).' },
                enabled: { type: 'boolean', required: true, description: 'true to enable, false to disable.' },
                root: { type: 'string', description: 'Source root key (dsh/agents/codex/claude or a project key); default dsh.' },
            },
            output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
            async execute(args) {
                const op = args.enabled ? 'skill-enable' : 'skill-disable';
                const r = await skillsService.ops[op]({ name: args.name, root: args.root || 'dsh' });
                if (!r || r.ok === false)
                    throw new Error((r && r.error) || 'skill toggle failed');
                return 'OK: ' + args.name + ' now ' + (args.enabled ? 'enabled' : 'disabled');
            },
        }));
        tools.register(defineTool({
            name: 'skill_manager_create',
            description: 'Create a new local DSH skill under DSH_HOME/skills. Use only when the user explicitly asks to create or save a reusable skill.',
            parameters: {
                name: { type: 'string', required: true, description: 'Skill name; normalized to kebab-case.' },
                description: { type: 'string', required: true, description: 'A concise routing description for when to use the skill.' },
                body: { type: 'string', required: true, description: 'Markdown instructions that form the skill body.' },
            },
            output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
            async execute(args) {
                const r = await skillsService.ops['skill-create']({ name: args.name, description: args.description, body: args.body, root: 'dsh' });
                if (!r || r.ok === false)
                    throw new Error((r && r.error) || 'skill create failed');
                const data = r.data || {};
                return 'Created DSH skill ' + (data.name || args.name) + ' at ' + (data.path || '(unknown)');
            },
        }));
        // AGENTS.md 预设库：模型可查/切，不能造/删（避免模型乱删用户预设）。
        tools.register(defineTool({
            name: 'agentsmd_list',
            description: 'List AGENTS.md presets in the plugin preset library (id, active state).',
            parameters: {},
            output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
            async execute() {
                const r = await agentsMdService.list();
                if (!r.ok)
                    throw new Error(r.error);
                const summary = r.presets.map((p) => p.id + (p.active ? ' [active]' : ''));
                return 'AGENTS.md presets:\n' + (summary.join('\n') || '(none)') + '\n(Applying takes effect on the next session created; the current session is unchanged.)';
            },
        }));
        tools.register(defineTool({
            name: 'agentsmd_apply',
            description: 'Apply one AGENTS.md preset by writing it to ~/.dsh/AGENTS.md. Takes effect on the next session created; the current session is unchanged.',
            parameters: {
                id: { type: 'string', required: true, description: 'Preset id (lowercase letters, digits, hyphens).' },
            },
            output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
            async execute(args) {
                const r = await agentsMdService.apply(args.id);
                if (!r.ok)
                    throw new Error(r.error);
                return 'OK: preset ' + args.id + ' applied to ~/.dsh/AGENTS.md (next session; current session unchanged' + (r.backedUp ? '; previous backed up to __last-applied__' : '') + ')';
            },
        }));
        // ---------- rules model tools（v0.3）----------
        // 活动场景的记忆正文会自动进入系统提示词（无需调用工具读取）；这里的工具用于
        // 查询/编辑规则本身。rule_manager_write 受 tools/pre-execute 审批门禁（D2）。
        tools.register(defineTool({
            name: 'rule_manager_list',
            description: 'List rules/memories under ~/.dsh/scene-memory (id, scene, enabled, description).',
            parameters: {
                group: { type: 'string', description: 'Optional group/scene filter.' },
            },
            output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
            async execute(args) {
                const r = await rulesService.ops['rules-list'](args);
                if (!r || r.ok === false)
                    throw new Error((r && r.error) || '读取规则失败');
                const lines = (r.rules || []).map((x) => ('- ' + x.id + ' [' + (x.group || '全局') + '] ' + (x.enabled ? '已启用' : '已停用') +
                    (x.description ? ' — ' + x.description : '')));
                const scenes = (r.scenes || []).map((s) => s.name + (s.active ? '(启用)' : '(未启用)')).join('、');
                return '规则（' + (r.rules || []).length + '）：\n' + (lines.join('\n') || '(无规则)') +
                    '\n场景：' + (scenes || '(无)') + (r.activeMode === 'all' ? '（默认全部启用）' : '（已收窄）');
            },
        }));
        tools.register(defineTool({
            name: 'rule_manager_read',
            description: 'Read the full body of one rule/memory under ~/.dsh/scene-memory.',
            parameters: {
                id: { type: 'string', required: true, description: 'Rule id like <scene>/<name>.' },
            },
            output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
            async execute(args) {
                const r = await rulesService.ops['rules-read'](args);
                if (!r || r.ok === false)
                    throw new Error((r && r.error) || '读取规则失败');
                return '# ' + r.rule.id + '\n\n' + (r.rule.body || '');
            },
        }));
        tools.register(defineTool({
            name: 'rule_manager_write',
            description: 'Create a new rule/memory as ~/.dsh/scene-memory/<scene>/<name>.md. It becomes active automatically once its scene is enabled. Requires user confirmation (configurable).',
            parameters: {
                group: { type: 'string', required: true, description: 'Scene/folder name under ~/.dsh/scene-memory (any Unicode except path separators and < > : " | ? *).' },
                name: { type: 'string', required: true, description: 'Memory name = the .md file name without the extension; any Unicode is fine (Chinese included), <=64 chars, no path separators or < > : " | ? *, must not start with a dot.' },
                description: { type: 'string', required: true, description: 'One-sentence description (<=500 chars).' },
                body: { type: 'string', required: true, description: 'Markdown body (<=256 KiB).' },
            },
            output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
            async execute(args) {
                const r = await rulesService.ops['rules-create'](args);
                if (!r || r.ok === false)
                    throw new Error((r && r.error) || '创建规则失败');
                return 'OK: rule ' + r.rule.id + '（场景「' + (r.rule.group || '全局') + '」启用后自动生效）';
            },
        }));
        if (typeof ctx.on === 'function') {
            ;
            ctx.on('tools/pre-execute', (exec, next) => {
                if (exec && exec.name === 'skill_manager_create') {
                    return Promise.resolve({ kind: 'ask', reason: 'Create a new skill under DSH_HOME/skills' });
                }
                if (exec && exec.name === 'rule_manager_write') {
                    // D2：模型写规则默认需确认；设置关闭后直接放行。ask 无应答者时降级为拒绝（fail-closed），
                    // 不在此处做任何兜底放行。
                    return readPluginSettings()
                        .then((s) => (s.requireConfirmForModelRuleWrite
                        ? { kind: 'ask', reason: 'Write a rule under ~/.dsh/scene-memory' }
                        : next()))
                        .catch(() => ({ kind: 'ask', reason: 'Write a rule under ~/.dsh/scene-memory' }));
                }
                return next();
            });
        }
        // ---------- per-tool MCP switches: execution guard + visibility ----------
        try {
            readDisabledTools().then(() => applyToolRestrictions()).catch(() => { });
        }
        catch (e) { /* ignore */ }
        if (typeof tools.guard === 'function') {
            ctx.effect(() => tools.guard((exec) => {
                try {
                    // Reads the TTL cache without I/O: the guard runs on the hot path.
                    const value = disabledToolsCache ? disabledToolsCache.value : {};
                    if (disabledToolNames(value).indexOf(String((exec && exec.name) || '')) >= 0) {
                        return '该工具已在 MCP 管理页停用';
                    }
                }
                catch (e) { /* fallthrough to allow */ }
                return undefined;
            }), 'dsh-plugin-tool-management: disabled mcp tool guard');
        }
        if (typeof ctx.on === 'function') {
            try {
                // MCP servers (de)register their tools as instances come and go; the
                // visible-set restriction must track that.
                ctx.effect(() => {
                    const stop = ctx.on('tools/change', () => scheduleToolRestrictions());
                    return typeof stop === 'function' ? stop : () => { };
                }, 'dsh-plugin-tool-management: tools/change listener');
            }
            catch (e) { /* ignore */ }
        }
        ctx.effect(() => () => {
            if (restrictTimer) {
                clearTimeout(restrictTimer);
                restrictTimer = null;
            }
            if (restrictDisposer) {
                try {
                    restrictDisposer();
                }
                catch (e) { /* ignore */ }
                restrictDisposer = null;
            }
        }, 'dsh-plugin-tool-management: tool restriction cleanup');
        // ---------- HTTP API route (UI half), registered defensively ----------
        if (webServer) {
            // Cap request bodies (88 MiB): skill-upload carries Base64 folder/ZIP
            // payloads (64 MiB of raw content). The route is only reachable from
            // local/trusted origins (Host + CSRF header + optional token gate).
            // `config.maxBodyBytes` overrides the cap (tests use a small value).
            const configuredMaxBody = Number(config?.maxBodyBytes);
            const MAX_BODY = Number.isFinite(configuredMaxBody) && configuredMaxBody > 0 ? configuredMaxBody : 88 * 1024 * 1024;
            const readBody = (req) => new Promise((resolve, reject) => {
                // Accumulate Buffers and decode ONCE at the end: decoding each chunk
                // separately corrupts multi-byte UTF-8 characters that straddle a
                // chunk boundary (e.g. long Chinese skill bodies).
                const chunks = [];
                let size = 0;
                req.on('data', (c) => {
                    const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
                    size += buf.length;
                    if (size > MAX_BODY) {
                        reject(new Error('request body too large'));
                        return;
                    }
                    chunks.push(buf);
                });
                req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                req.on('error', reject);
            });
            try {
                // ctx.effect wires the route's disposer into this plugin's scope, so an
                // unload (HMR removal, disable, update) unregisters the route — the
                // documented cleanup contract (webServer.register does not auto-scope).
                ctx.effect(() => webServer.register({
                    kind: 'exact',
                    path: '/dsh-plugin-tool-management/api',
                    handler: async (req, res) => {
                        // Cross-site (CSRF) gate. This route mutates config files, so it
                        // must only be reachable from the DSH web UI (same origin) or
                        // local tooling. A browser cross-site request cannot attach a
                        // custom header without a CORS preflight, and this route never
                        // answers preflights — requiring `x-dsh-plugin` is the primary
                        // gate; POST-only and the Origin check are defense in depth.
                        const hdr = (name) => {
                            const v = req.headers?.[name];
                            return Array.isArray(v) ? v[0] ?? '' : v ?? '';
                        };
                        if (String(req.method || 'POST').toUpperCase() !== 'POST') {
                            res.writeHead(405, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
                            return;
                        }
                        if (hdr('x-dsh-plugin') !== 'dsh-plugin-tool-management') {
                            res.writeHead(403, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, error: 'missing plugin gate header' }));
                            return;
                        }
                        const origin = hdr('origin');
                        if (origin) {
                            let sameOrigin = false;
                            try {
                                const u = new URL(origin);
                                const hostHdr = hdr('host') || '';
                                sameOrigin =
                                    /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname) || u.host === hostHdr;
                            }
                            catch (e) { /* unparseable origin → rejected below */ }
                            if (!sameOrigin) {
                                res.writeHead(403, { 'content-type': 'application/json' });
                                res.end(JSON.stringify({ ok: false, error: 'cross-origin request rejected' }));
                                return;
                            }
                        }
                        res.writeHead(200, { 'content-type': 'application/json' });
                        try {
                            let payload = {};
                            try {
                                payload = JSON.parse((await readBody(req)) || '{}');
                            }
                            catch (e) {
                                if (String(e?.message).includes('body too large')) {
                                    res.end(JSON.stringify({ ok: false, error: '请求体过大' }));
                                    return;
                                }
                                /* otherwise fall through with {} */
                            }
                            const op = String(payload.op || '');
                            if (TOKEN && WRITE_OPS.has(op) && hdr('x-dsh-token') !== TOKEN) {
                                res.end(JSON.stringify({ ok: false, error: '缺少或错误的访问令牌（x-dsh-token）' }));
                                return;
                            }
                            const fn = handlers[op];
                            if (!fn) {
                                res.end(JSON.stringify({ ok: false, error: '未知操作: ' + op }));
                                return;
                            }
                            const result = await fn(payload.args || {});
                            res.end(JSON.stringify(result === undefined ? { ok: true } : result));
                        }
                        catch (e) {
                            res.end(JSON.stringify({ ok: false, error: message(e) }));
                        }
                    },
                }), 'dsh-plugin-tool-management: api route');
            }
            catch (e) {
                // A registration failure must never take down the whole entry: log and continue.
                console.error('[dsh-plugin-tool-management] webServer route registration failed:', message(e));
            }
        }
        // ---------- human chat commands (/mcp, /skills) ----------
        // The commands service is optional, so probe for it and skip silently when
        // it is missing (same defensive shape as pluginInventory above).
        try {
            const commands = (typeof ctx.get === 'function' ? ctx.get('commands') : undefined);
            if (commands && typeof commands.register === 'function') {
                ctx.effect(() => commands.register({
                    name: 'mcp',
                    description: '列出已配置的 MCP 服务（级别 / 启停 / loader 状态 / 工具数）',
                    handler: async () => {
                        const r = await mcpmList();
                        if (!r || r.ok === false)
                            return { kind: 'error', text: (r && r.error) || '读取 MCP 服务失败' };
                        // 启用的在前，同组内按名称排序。
                        const rows = (r.rows || []).slice().sort((a, b) => {
                            if (!!a.disabled !== !!b.disabled)
                                return a.disabled ? 1 : -1;
                            return String(a.serverName).localeCompare(String(b.serverName));
                        });
                        if (!rows.length)
                            return { kind: 'success', text: '未配置任何 MCP 服务。' };
                        // Human-facing command: show localized levels, not the raw keys.
                        const labels = { project: 'Profile 级', global: '全局', loader: '已加载' };
                        const text = 'MCP 服务（' + rows.length + '）：\n' + rows.map((row) => ('- ' + row.serverName + ' [' + (labels[row.level] || row.level) + '] ' + (row.disabled ? '已停用' : '已启用') +
                            (row.live ? ' · loader:' + (row.live.enabled ? 'on' : 'off') + (row.live.phase ? '/' + row.live.phase : '') : '') +
                            (typeof row.toolCount === 'number' ? ' · ' + row.toolCount + ' 工具' : ''))).join('\n');
                        return { kind: 'success', text };
                    },
                }), 'dsh-plugin-tool-management: /mcp command');
                ctx.effect(() => commands.register({
                    name: 'skills',
                    description: '列出各来源的技能及其启停状态',
                    handler: async () => {
                        const r = await skillsService.ops['skill-state']({});
                        if (!r || r.ok === false)
                            return { kind: 'error', text: (r && r.error) || '读取技能失败' };
                        const data = r.data || {};
                        const entries = [];
                        for (const root of data.roots || []) {
                            for (const skill of root.skills || []) {
                                entries.push({
                                    line: '- ' + (skill.declaredName || skill.name) + ' [' + (root.label || root.key) + '] ' + (skill.enabled === false ? '已停用' : '已启用'),
                                    enabled: skill.enabled !== false,
                                });
                            }
                        }
                        // 启用的在前，同组内保持原有顺序（来源与名称序）。
                        entries.sort((a, b) => (a.enabled === b.enabled ? 0 : a.enabled ? -1 : 1));
                        const lines = entries.map((entry) => entry.line);
                        return { kind: 'success', text: lines.length ? '技能（' + lines.length + '）：\n' + lines.join('\n') : '未发现任何技能。' };
                    },
                }), 'dsh-plugin-tool-management: /skills command');
                ctx.effect(() => commands.register({
                    name: 'agents-md',
                    description: '列出 AGENTS.md 预设及当前生效（应用后新会话生效，当前会话不变）',
                    handler: async () => {
                        const r = await agentsMdService.list();
                        if (!r || r.ok === false)
                            return { kind: 'error', text: (r && r.error) || '读取 AGENTS.md 预设失败' };
                        const presets = r.presets || [];
                        if (!presets.length)
                            return { kind: 'success', text: '未发现任何 AGENTS.md 预设。' };
                        const text = 'AGENTS.md 预设（' + presets.length + '）：\n' + presets.map((p) => ('- ' + p.id + (p.active ? ' [生效中]' : ''))).join('\n') + '\n（应用后新会话生效，当前会话不变）';
                        return { kind: 'success', text };
                    },
                }), 'dsh-plugin-tool-management: /agents-md command');
                ctx.effect(() => commands.register({
                    name: 'scene-memory',
                    description: '列出场景记忆及其场景启用状态',
                    handler: async () => {
                        const r = await rulesService.ops['rules-list']({});
                        if (!r || r.ok === false)
                            return { kind: 'error', text: (r && r.error) || '读取记忆失败' };
                        const rules = r.rules || [];
                        if (!rules.length)
                            return { kind: 'success', text: '未发现任何记忆（~/.dsh/scene-memory 为空）。' };
                        const scenes = r.scenes || [];
                        const text = '场景记忆（' + rules.length + '）：\n' + rules.map((rule) => ('- ' + rule.name + ' [' + (rule.group || '全局') + '] · ' + (rule.enabled ? '已启用' : '已停用'))).join('\n') + '\n场景：' + (scenes.map((s) => s.name + (s.active ? '(启用)' : '(未启用)')).join('、') || '(无)') +
                            (r.activeMode === 'all' ? '（默认全部启用）' : '（已收窄）') +
                            '\n（启用场景的记忆正文自动进入系统提示词，无需任何工具调用）';
                        return { kind: 'success', text };
                    },
                }), 'dsh-plugin-tool-management: /scene-memory command');
            }
        }
        catch (e) {
            console.error('[dsh-plugin-tool-management] command registration failed:', message(e));
        }
    },
};
