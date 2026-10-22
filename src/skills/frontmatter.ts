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
  // split 至少返回一个元素，所以只判首行在不在，不再重复判长度。
  if (lines[0] != null && lines[0].trim() === "---") {
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === "---") {
        end = i;
        break;
      }
    }
    if (end >= 0) {
      hasFrontmatter = true;
      for (let i = 1; i < end; i++) {
        // end 是 lines 的合法下标，循环体内 lines[i] 恒存在。
        const line = lines[i]!;
        const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
        if (m) {
          // 该正则两个捕获组都非可选，命中即恒为 string。
          const key = m[1]!;
          const raw = m[2]!;
          fields.push({ key, raw });
          const block = /^([>|])[-+]?\s*$/.exec(raw);
          if (block) {
            const content: string[] = [];
            while (i + 1 < end) {
              const next = lines[i + 1]!;
              if (!/^\s/.test(next) && next !== "") break;
              i++;
              content.push(next);
            }
            const indentation = content
              .filter((line) => line.trim() !== "")
              .reduce(
                (min, line) =>
                  Math.min(min, (/^\s*/.exec(line)?.[0] ?? "").length),
                Infinity,
              );
            const normalized = content.map((line) =>
              Number.isFinite(indentation)
                ? line.slice(Math.min(indentation, line.length))
                : line,
            );
            map[key] =
              block[1] === ">"
                ? normalized.join(" ").replace(/\s+/g, " ").trim()
                : normalized.join("\n").trim();
          } else {
            map[key] = decodeYamlScalar(raw);
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

/** 去掉 frontmatter 值两侧的引号并 trim；不是字符串时按空串处理。 */
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

/** 会被 YAML 解析器识别成非字符串的裸值（布尔 / null / 数字 / 日期）。 */
const YAML_RESERVED_SCALAR_RE =
  /^(?:true|false|null|~|yes|no|on|off|[-+]?(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|\d{4}-\d{2}-\d{2}(?:[Tt ].*)?)$/i;
/** 不能出现在裸标量开头的 YAML 指示符。 */
const YAML_INDICATOR_START_RE = /^[-?:,[\]{}#&*!|>'"%@`]/;
/** 裸标量里会被误读的 `: ` / 行尾 `:` / ` #`。 */
const YAML_UNSAFE_BODY_RE = /:(?:\s|$)|(?:^|\s)#/;

/**
 * 把任意字符串编码成一行安全的 YAML 标量：能裸写就裸写，否则用 JSON 双引号。
 *
 * 需要引号的情形：首尾空白、控制字符、会开启块标量的指示符、布尔 / null / 数字 / 日期形态、
 * 含 `: `、行尾 `:`、` #`、以及引号本身。`decodeYamlScalar` 是它的读侧，两边必须对得上。
 */
export function yamlScalar(value: unknown): string {
  const s = String(value == null ? "" : value);
  if (s === "") return '""';
  const needsQuote =
    s !== s.trim() ||
    /[\u0000-\u001f\u007f]/.test(s) ||
    YAML_INDICATOR_START_RE.test(s) ||
    YAML_RESERVED_SCALAR_RE.test(s) ||
    YAML_UNSAFE_BODY_RE.test(s) ||
    s.includes('"') ||
    s.includes("'");
  return needsQuote ? JSON.stringify(s) : s;
}

/**
 * 序列化一个 frontmatter 字段（含键名）：单行走 `yamlScalar`；多行用 `|` 块（保留换行）。
 * 例外：多行里出现去空白后恰为 `---` 的行时改用 JSON 引号标量 —— 块标量缩进两格也躲不开
 * `parseSkillDoc` 的结束扫描（`trim() === "---"`），引号形式是单物理行，扫描无从误判。
 */
export function yamlFieldLines(
  key: string,
  value: string | boolean,
): string[] {
  if (typeof value === "boolean") return [`${key}: ${value}`];
  const s = String(value);
  if (s.includes("\n")) {
    if (s.split("\n").some((line) => line.trim() === "---"))
      return [`${key}: ${JSON.stringify(s)}`];
    return [`${key}: |`, ...s.split("\n").map((line) => `  ${line}`)];
  }
  return [`${key}: ${yamlScalar(s)}`];
}

/**
 * 行级重写 frontmatter 的顶层标量字段，其余行（嵌套字段、未知键、注释、顺序）逐字保留。
 *
 * - `updates[key]`：字符串 = 写入（已有的整段取值行被替换，块标量的续行一并替换）；`null` = 删除；
 *   `undefined` = 保持原样。缺失的键追加到字段区末尾。
 * - `body` 不传 = 保留原正文；传了就整体替换（与旧序列化行为一致）。
 * - 文件没有 frontmatter 时，按 updates 新建一段（仅写入非 null 的键）。
 */
export function rewriteFrontmatterFields(
  text: string,
  updates: Record<string, string | null | undefined>,
  body?: string,
): string {
  const src = String(text ?? "");
  const bom = src.charCodeAt(0) === 0xfeff ? "\uFEFF" : "";
  const content = bom === "" ? src : src.slice(1);
  const nl = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  let end = -1;
  if (lines[0] != null && lines[0].trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === "---") {
        end = i;
        break;
      }
    }
  }
  if (end < 0) {
    const head: string[] = ["---"];
    for (const [key, value] of Object.entries(updates)) {
      if (typeof value === "string") head.push(...yamlFieldLines(key, value));
    }
    head.push("---");
    return (
      bom +
      head.join(nl) +
      nl +
      (body === undefined ? content : String(body))
    );
  }
  const front = lines.slice(1, end);
  const nextBody = body === undefined ? lines.slice(end + 1).join(nl) : String(body);
  const out: string[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (i < front.length) {
    // i < front.length，所以这一行恒存在。
    const line = front[i]!;
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) {
      out.push(line);
      i++;
      continue;
    }
    // 该正则两个捕获组都非可选，命中即恒为 string。
    const key = m[1]!;
    const isBlock = /^[>|][-+]?\s*$/.test(m[2]!);
    let spanEnd = i + 1;
    if (isBlock) {
      while (
        spanEnd < front.length &&
        (front[spanEnd] === "" || /^\s/.test(front[spanEnd]!))
      ) {
        spanEnd++;
      }
    } else {
      while (spanEnd < front.length && /^\s/.test(front[spanEnd]!)) spanEnd++;
    }
    const update = Object.prototype.hasOwnProperty.call(updates, key)
      ? updates[key]
      : undefined;
    if (update === undefined) {
      for (let k = i; k < spanEnd; k++) out.push(front[k]!);
    } else if (update !== null) {
      out.push(...yamlFieldLines(key, update));
    }
    seen.add(key);
    i = spanEnd;
  }
  for (const [key, value] of Object.entries(updates)) {
    if (typeof value === "string" && !seen.has(key))
      out.push(...yamlFieldLines(key, value));
  }
  const frontText = out.length === 0 ? "" : out.join(nl) + nl;
  return `${bom}---${nl}${frontText}---${nl}${nextBody}`;
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