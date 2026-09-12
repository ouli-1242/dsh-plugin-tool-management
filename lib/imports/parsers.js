// src/imports/parsers.js — transcript parsing for conversation import.
// Pure Node, no DSH dependencies: detect format, then convert a Claude Code /
// Cursor JSONL, a Codex-style Markdown transcript, or generic prefixed text
// into an ordered list of `{ role: 'user' | 'assistant', text }` turns.
/** Heading lines that begin a Markdown turn (`## User` / `### Assistant` …). */
const HEADING_RE = /^#{1,3}\s+(User|Human|Assistant|AI|Bot)\s*:?\s*$/i;
/** Bold-prefix lines (`**User:** …` / `**User**: …`). */
const BOLD_PREFIX_RE = /^\*\*(User|Human|Assistant|AI|Bot):?\*\*\s*:?\s*(.*)$/i;
/** Generic prefixed lines (`User: …` / `Assistant: …` / `用户：…`). */
const GENERIC_PREFIX_RE = /^(User|Human|用户|Assistant|AI|Bot|助手)\s*[:：]\s*(.*)$/i;
/** Flatten a message content value (string, text-block array, or nested object) to text. */
export function extractText(content) {
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content)) {
        let out = '';
        for (const part of content) {
            if (typeof part === 'string')
                out += part;
            else if (part && typeof part === 'object') {
                if (typeof part.text === 'string')
                    out += part.text;
                else if (typeof part.content === 'string')
                    out += part.content;
            }
        }
        return out;
    }
    if (content && typeof content === 'object') {
        if (typeof content.text === 'string')
            return content.text;
        if (typeof content.content === 'string')
            return content.content;
    }
    return '';
}
/** Push a finished turn, trimming empty bodies. */
function flushTurn(current, turns) {
    if (!current)
        return;
    const text = String(current.text || '').trim();
    if (text)
        turns.push({ role: current.role, text });
}
/**
 * Detect the transcript format. Extension wins; content sniffing only applies
 * when the name carries no recognized extension.
 * @returns {'jsonl' | 'markdown' | 'generic'}
 */
export function detectFormat(fileName, content) {
    const name = String(fileName || '').toLowerCase();
    if (/\.jsonl$/.test(name))
        return 'jsonl';
    if (/\.(md|markdown)$/.test(name))
        return 'markdown';
    if (/\.txt$/.test(name))
        return 'generic';
    const first = String(content || '').split(/\r?\n/).map((s) => s.trim()).find((s) => s) || '';
    if (first.startsWith('{')) {
        try {
            const obj = JSON.parse(first);
            if (obj && typeof obj === 'object' && (obj.type === 'user' || obj.type === 'assistant' || obj.role === 'user' || obj.role === 'assistant'))
                return 'jsonl';
        }
        catch (e) { /* not JSONL after all */ }
    }
    if (HEADING_RE.test(first) || BOLD_PREFIX_RE.test(first))
        return 'markdown';
    return 'generic';
}
/**
 * Parse a Claude Code / Cursor style JSONL transcript.
 * Recognizes `{type:'user'|'assistant', message:{role,content}}` (Claude Code)
 * and `{role, content}` (Cursor-like). System/tool lines are skipped; adjacent
 * turns with the same role are merged.
 * @returns {Array<{role:'user'|'assistant', text:string}>}
 */
export function parseJsonlTranscript(text) {
    const turns = [];
    let lastRole = null;
    let lastText = '';
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line)
            continue;
        let obj;
        try {
            obj = JSON.parse(line);
        }
        catch (e) {
            continue;
        }
        if (!obj || typeof obj !== 'object' || Array.isArray(obj))
            continue;
        let role = null;
        let content;
        if (obj.type === 'user' || obj.type === 'assistant') {
            const message = obj.message && typeof obj.message === 'object' && !Array.isArray(obj.message) ? obj.message : null;
            role = message && (message.role === 'user' || message.role === 'assistant') ? message.role : (obj.type === 'user' ? 'user' : 'assistant');
            content = message ? message.content : undefined;
        }
        else if (obj.role === 'user' || obj.role === 'assistant') {
            role = obj.role;
            content = obj.content;
        }
        if (!role)
            continue;
        const piece = extractText(content).trim();
        if (!piece)
            continue;
        if (role === lastRole) {
            lastText += '\n' + piece;
        }
        else {
            if (lastText)
                turns.push({ role: lastRole, text: lastText });
            lastRole = role;
            lastText = piece;
        }
    }
    if (lastText)
        turns.push({ role: lastRole, text: lastText });
    return turns;
}
/**
 * Parse a Markdown transcript into turns by heading or bold-prefix markers
 * (`## User`, `### Assistant`, `**User:**`, …). Content lines accumulate under
 * the current turn until the next marker.
 */
export function parseMarkdownTranscript(text) {
    const turns = [];
    let current = null;
    for (const line of String(text || '').split(/\r?\n/)) {
        const heading = line.match(HEADING_RE);
        if (heading) {
            flushTurn(current, turns);
            current = { role: isAssistantLabel(heading[1]) ? 'assistant' : 'user', text: '' };
            continue;
        }
        const bold = line.match(BOLD_PREFIX_RE);
        if (bold) {
            flushTurn(current, turns);
            current = { role: isAssistantLabel(bold[1]) ? 'assistant' : 'user', text: String(bold[2] || '').trim() };
            continue;
        }
        if (current)
            current.text += (current.text ? '\n' : '') + line;
    }
    flushTurn(current, turns);
    return turns;
}
/**
 * Parse generic prefixed text. Lines starting with `User:` / `Assistant:` /
 * `用户：` / `助手：` begin a new turn; everything else appends to the current
 * one. When no marker is present the whole text becomes one user turn.
 */
export function parseGenericText(text) {
    const lines = String(text || '').split(/\r?\n/);
    if (!lines.some((line) => GENERIC_PREFIX_RE.test(line.trim()))) {
        const whole = String(text || '').trim();
        return whole ? [{ role: 'user', text: whole }] : [];
    }
    const turns = [];
    let current = null;
    for (const line of lines) {
        const m = line.match(GENERIC_PREFIX_RE);
        if (m) {
            flushTurn(current, turns);
            current = { role: isAssistantLabel(m[1]) ? 'assistant' : 'user', text: String(m[2] || '').trim() };
        }
        else if (current) {
            current.text += (current.text ? '\n' : '') + line;
        }
    }
    flushTurn(current, turns);
    return turns;
}
/** Map a speaker label to the assistant role (AI / Bot / Assistant / 助手). */
function isAssistantLabel(label) {
    return /^(assistant|ai|bot|助手)$/i.test(label);
}
