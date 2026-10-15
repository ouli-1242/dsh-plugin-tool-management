// SKILL.md 的名称规整与 frontmatter 解析（宽松 YAML，保留键序）。
//
// 从 core.ts 整段搬来，一行未改。这一段不碰文件系统、也不碰 manager 本地策略状态，
// 输入是文本、输出是结构体，所以它可以单独看懂、单独测；core.ts 留下的是读写磁盘的那半。
import type { SkillDoc } from "./core-types.js";

// ── 命名规整 ────────────────────────────────────────────────────────────────

/** 尽量把任意名称规整为 kebab-case；无法生成合法名称时返回空串。 */
export function toKebab(s: unknown): string {
  let t = String(s).trim();
  if (t === "") return "";
  t = t.replace(/([a-z0-9])([A-Z])/g, "$1-$2"); // camelCase 边界
  t = t.toLowerCase();
  t = t.replace(/[\s_.]+/g, "-");
  t = t.replace(/[^a-z0-9-]/g, "-");
  t = t.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return t;
}

// ── frontmatter 解析 / 序列化（宽松 YAML 对象，保留键序）────────────────────

/** 剥离 UTF-8 BOM（Windows 工具常写入，不剥离会导致开头 --- 失配）。 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 解析 SKILL.md 的 frontmatter。返回 { fields, map, body }，map 保留键序。
 *  只识别顶层 key: value；缩进嵌套字段（如 metadata.source）不进入 map。 */
export function parseSkillDoc(text: unknown): SkillDoc {
  const src = stripBom(String(text));
  const lines = src.split(/\r?\n/);
  const map = Object.create(null);
  const fields = [];
  let body = src;
  let hasFrontmatter = false;
  if (lines.length > 0 && lines[0].trim() === "---") {
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        end = i;
        break;
      }
    }
    if (end >= 0) {
      hasFrontmatter = true;
      for (let i = 1; i < end; i++) {
        const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]);
        if (m) {
          fields.push({ key: m[1], raw: m[2] });
          const block = /^([>|])[-+]?\s*$/.exec(m[2]);
          if (block) {
            const content = [];
            while (
              i + 1 < end &&
              (/^\s/.test(lines[i + 1]) || lines[i + 1] === "")
            ) {
              i++;
              content.push(lines[i]);
            }
            const indentation = content
              .filter((line) => line.trim() !== "")
              .reduce(
                (min, line) =>
                  Math.min(min, (/^\s*/.exec(line) || [""])[0].length),
                Infinity,
              );
            const normalized = content.map((line) =>
              Number.isFinite(indentation)
                ? line.slice(Math.min(indentation, line.length))
                : line,
            );
            map[m[1]] =
              block[1] === ">"
                ? normalized.join(" ").replace(/\s+/g, " ").trim()
                : normalized.join("\n").trim();
          } else {
            map[m[1]] = decodeYamlScalar(m[2]);
          }
        }
      }
      body = lines.slice(end + 1).join("\n");
    }
  }
  return { fields, map, body, hasFrontmatter };
}

/** 读取 YAML 标量的显示值；不依赖第三方 YAML 解析器。 */
export function decodeYamlScalar(v: unknown): string {
  const s = String(v == null ? "" : v).trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    try {
      const value = JSON.parse(s);
      if (typeof value === "string") return value;
    } catch {
      /* 保留无法解析的原始内容 */
    }
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'")
    return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

export function unquote(v: unknown): string {
  const s = String(v == null ? "" : v).trim();
  if (
    s.length >= 2 &&
    ((s[0] === '"' && s[s.length - 1] === '"') ||
      (s[0] === "'" && s[s.length - 1] === "'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

// ── 声明名改写（退号落盘后同步 frontmatter）─────────────────────────────────

/** frontmatter 整块（开栏 / 字段区 / 闭栏三段各自成组，便于逐字回拼）。 */
const DECLARED_NAME_BLOCK_RE =
  /^(?<open>(?:\uFEFF)?[^\S\r\n]*---[^\S\r\n]*(?:\r\n|\n))(?<fields>[\s\S]*?)(?<close>^[^\S\r\n]*---[^\S\r\n]*(?:\r\n|\n|$))/m;
/** 顶格的 `name:` 行；缩进的嵌套字段（块标量的续行等）不匹配。 */
const DECLARED_NAME_LINE_RE = /^name[^\S\r\n]*:[^\r\n]*/m;

/**
 * 把 frontmatter 的 `name:` 行改写成新名字，其余逐字节保留（连 CRLF 都不动）；
 * 认不出形态（没有 frontmatter / 没有 `name:` 行 / 改完不变）时返回 null。
 *
 * **调用方保证 `name` 过 KEBAB_RE**（只含 `[a-z0-9-]`，无需转义；本模块不引
 * upload-pipeline 的 KEBAB_RE —— 那边引了本模块，引回来就成了环）。
 *
 * 退号落盘后必须调用（导入撞名、回收站恢复）：`canonicalSkillName` 取的是
 * 声明名而不是条目名，只改目录会"看着叫 foo-1、其实还是 foo"—— 两份同名
 * 技能在「同名首选」里被并成一组，而那颗开关挑的是来源，按下去什么都不会变。
 * 没有 `name:` 行的文档返回 null 是**良性**的：声明名为空时 canonicalSkillName
 * 回落到条目名，退号后的目录名就是它的名字。
 */
export function rewriteDeclaredName(text: string, name: string): string | null {
  const match = DECLARED_NAME_BLOCK_RE.exec(text);
  if (!match || !match.groups) return null;
  const fields = match.groups.fields as string;
  // 函数式替换：字段区里可能带 `$&` / `$'` 之类字面量，字符串式替换会把它们当占位符展开。
  const rewritten = fields.replace(DECLARED_NAME_LINE_RE, () => `name: ${name}`);
  if (rewritten === fields) return null;
  const open = match.groups.open as string;
  const close = match.groups.close as string;
  return text.replace(
    DECLARED_NAME_BLOCK_RE,
    () => `${open}${rewritten}${close}`,
  );
}