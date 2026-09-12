// dsh-plugin-tool-management —— AGENTS.md 预设库 + 切换 服务层。
//
// DSH 全局指令基线只有一个文件 ~/.dsh/AGENTS.md（USER_GLOBAL_FILE 固定），
// 没有内置的「多份全局 AGENTS.md 切换」机制。本服务在插件目录内维护一个
// 预设库（每套一个子目录 + AGENTS.md），「应用」= 把选中预设内容写入
// ~/.dsh/AGENTS.md，新会话生效（当前会话不变，DSH 本身如此）。
//
// 约定镜像 @deepseek-ai/dsh-agent-presets：id 即目录名，正则
// /^[a-z0-9][a-z0-9-]*$/；__last-applied__ 是备份槽，不算用户预设。
// 「当前生效」靠比对 ~/.dsh/AGENTS.md 的 sha256 与各预设 sha256 推断，
// 无状态文件——用户手改全局文件也能如实反映。
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const PRESET_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const FILENAME = 'AGENTS.md';
const LAST_APPLIED_ID = '__last-applied__';
export function createAgentsMdService(_ctx, deps) {
    const message = (e) => String((e && e.message) || e);
    async function sha256OfFile(abs) {
        try {
            const buf = await readFile(abs, 'utf8');
            return createHash('sha256').update(buf).digest('hex');
        }
        catch {
            return null;
        }
    }
    // 幂等初始化：仅当库完全无预设且全局 AGENTS.md 存在时，拷贝全局为 default
    // 预设（首次运行引导）。用户已 create/apply 过任何预设则不插手，避免把
    // 当前生效内容误存成 default 与真正生效的预设冲突。
    async function ensureInit() {
        const [presetsDir, globalPath] = await Promise.all([deps.presetsDir, deps.getGlobalAgentsMdPath()]);
        let existing = [];
        try {
            existing = await readdir(presetsDir, { withFileTypes: true });
        }
        catch { /* 库不存在 */ }
        const hasPreset = existing.some((e) => e.isDirectory() && PRESET_ID_RE.test(e.name) && e.name !== LAST_APPLIED_ID);
        if (hasPreset)
            return;
        let globalContent;
        try {
            globalContent = await readFile(globalPath, 'utf8');
        }
        catch {
            return;
        }
        try {
            await mkdir(presetsDir, { recursive: true });
            const defaultDir = join(presetsDir, 'default');
            await mkdir(defaultDir, { recursive: true });
            await writeFile(join(defaultDir, FILENAME), globalContent, 'utf8');
        }
        catch { /* best effort */ }
    }
    async function list() {
        try {
            await ensureInit();
            const [presetsDir, globalPath] = await Promise.all([deps.presetsDir, deps.getGlobalAgentsMdPath()]);
            let entries = [];
            try {
                entries = await readdir(presetsDir, { withFileTypes: true });
            }
            catch {
                // 库目录不存在视作空（首次运行尚未创建）
            }
            const globalHash = await sha256OfFile(globalPath);
            const ids = entries
                .filter((e) => e.isDirectory() && PRESET_ID_RE.test(e.name) && e.name !== LAST_APPLIED_ID)
                .map((e) => e.name);
            const presets = await Promise.all(ids.map(async (id) => {
                const contentHash = await sha256OfFile(join(presetsDir, id, FILENAME));
                return {
                    id,
                    active: globalHash !== null && contentHash !== null && globalHash === contentHash,
                };
            }));
            presets.sort((a, b) => a.id.localeCompare(b.id));
            return { ok: true, presets };
        }
        catch (e) {
            return { ok: false, error: message(e) };
        }
    }
    async function read(id) {
        const safeId = String(id || '');
        // id 即目录名，严格校验防目录穿越：仅允许小写字母/数字/连字符。
        // __last-applied__ 含下划线会被拒（它是备份槽，不走 read，由 apply 内部直写）。
        if (!PRESET_ID_RE.test(safeId))
            return { ok: false, error: '非法 id（仅允许小写字母、数字、连字符）：' + safeId };
        try {
            const content = await readFile(join(deps.presetsDir, safeId, FILENAME), 'utf8');
            return { ok: true, content };
        }
        catch {
            return { ok: false, error: '预设不存在：' + safeId };
        }
    }
    async function create(id, from) {
        const safeId = String(id || '');
        if (!PRESET_ID_RE.test(safeId))
            return { ok: false, error: '非法 id（仅允许小写字母、数字、连字符）：' + safeId };
        const dir = join(deps.presetsDir, safeId);
        try {
            await stat(dir);
            return { ok: false, error: 'id 已存在：' + safeId };
        }
        catch { /* 不存在，继续 */ }
        let content;
        const srcId = String(from || '');
        if (srcId) {
            if (!PRESET_ID_RE.test(srcId))
                return { ok: false, error: '非法 from id：' + srcId };
            try {
                content = await readFile(join(deps.presetsDir, srcId, FILENAME), 'utf8');
            }
            catch {
                return { ok: false, error: '来源预设不存在：' + srcId };
            }
        }
        else {
            content = '# AGENTS.md\n\n（DSH 全局指令基线预设，待编辑）\n';
        }
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, FILENAME), content, 'utf8');
        return { ok: true, id: safeId };
    }
    async function update(id, content) {
        const safeId = String(id || '');
        if (!PRESET_ID_RE.test(safeId))
            return { ok: false, error: '非法 id（仅允许小写字母、数字、连字符）：' + safeId };
        const dir = join(deps.presetsDir, safeId);
        try {
            await stat(dir);
        }
        catch {
            return { ok: false, error: '预设不存在：' + safeId };
        }
        await writeFile(join(dir, FILENAME), String(content ?? ''), 'utf8');
        return { ok: true, id: safeId };
    }
    async function apply(id) {
        const safeId = String(id || '');
        if (!PRESET_ID_RE.test(safeId))
            return { ok: false, error: '非法 id（仅允许小写字母、数字、连字符）：' + safeId };
        let content;
        try {
            content = await readFile(join(deps.presetsDir, safeId, FILENAME), 'utf8');
        }
        catch {
            return { ok: false, error: '预设不存在：' + safeId };
        }
        const globalPath = await deps.getGlobalAgentsMdPath();
        // 备份当前全局内容（若存在）到 __last-applied__，再覆盖写入。
        let prev = null;
        try {
            prev = await readFile(globalPath, 'utf8');
        }
        catch { /* 当前不存在，不备份 */ }
        if (prev !== null) {
            const backupDir = join(deps.presetsDir, LAST_APPLIED_ID);
            await mkdir(backupDir, { recursive: true });
            await writeFile(join(backupDir, FILENAME), prev, 'utf8');
        }
        await writeFile(globalPath, content, 'utf8');
        return { ok: true, id: safeId, backedUp: prev !== null };
    }
    async function getCurrent() {
        try {
            await ensureInit();
            const [globalPath, presetsDir] = await Promise.all([deps.getGlobalAgentsMdPath(), deps.presetsDir]);
            let content;
            try {
                content = await readFile(globalPath, 'utf8');
            }
            catch {
                return { ok: true, content: '', presetId: null, exists: false };
            }
            const globalHash = createHash('sha256').update(content).digest('hex');
            let presetId = null;
            let entries = [];
            try {
                entries = await readdir(presetsDir, { withFileTypes: true });
            }
            catch { /* 库不存在 */ }
            for (const e of entries) {
                if (!e.isDirectory() || !PRESET_ID_RE.test(e.name) || e.name === LAST_APPLIED_ID)
                    continue;
                let c;
                try {
                    c = await readFile(join(presetsDir, e.name, FILENAME), 'utf8');
                }
                catch {
                    continue;
                }
                if (createHash('sha256').update(c).digest('hex') === globalHash) {
                    presetId = e.name;
                    break;
                }
            }
            return { ok: true, content, presetId, exists: true };
        }
        catch (e) {
            return { ok: false, error: message(e) };
        }
    }
    async function remove(id) {
        const safeId = String(id || '');
        if (safeId === LAST_APPLIED_ID)
            return { ok: false, error: '备份槽不可删除' };
        if (!PRESET_ID_RE.test(safeId))
            return { ok: false, error: '非法 id（仅允许小写字母、数字、连字符）：' + safeId };
        const dir = join(deps.presetsDir, safeId);
        try {
            await stat(dir);
        }
        catch {
            return { ok: false, error: '预设不存在：' + safeId };
        }
        await rm(dir, { recursive: true, force: true });
        return { ok: true, id: safeId };
    }
    // 从外部文本内容（如导入的 .md 文件）建预设：id 校验 + 重复检查 + 写 AGENTS.md。
    async function importPreset(id, content) {
        const safeId = String(id || '');
        if (!PRESET_ID_RE.test(safeId))
            return { ok: false, error: '非法 id（仅允许小写字母、数字、连字符）：' + safeId };
        const dir = join(deps.presetsDir, safeId);
        try {
            await stat(dir);
            return { ok: false, error: 'id 已存在：' + safeId };
        }
        catch { /* 不存在，继续 */ }
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, FILENAME), String(content ?? ''), 'utf8');
        return { ok: true, id: safeId };
    }
    return { list, read, create, update, apply, getCurrent, remove, importPreset };
}
