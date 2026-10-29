/**
 * 自定义语言：`<配置目录>/languages/<名字>.json` 的结构、校验与默认值。
 *
 * 只做**关键字级**高亮（手写 StreamLanguage，见 editor/keywordLanguage.ts），
 * 不做语法解析——这足以覆盖 .toml / .ini / .conf / .env / 日志格式这类
 * 「关键词 + 注释 + 字符串 + 数字」的文件，也是零依赖能做到的上限。
 *
 * 与内置语言注册表的重名 / 扩展名冲突检查不在这里（那需要知道内置表），
 * 由 editor/languages.ts 的 setUserLanguages 负责。
 */

export interface UserLanguageSpec {
  /** 语言键 = 文件名（去扩展名） */
  name: string;
  /** 自动识别的扩展名（小写，含点） */
  extensions: string[];
  /** 供 Markdown 围栏与手动选择识别的别名 */
  aliases: string[];
  lineComment?: string;
  blockComment?: [string, string];
  keywords: string[];
  /** 类型 / 内置名（用 typeName 配色） */
  types: string[];
  /** 字符串引号字符集合 */
  quotes: string;
  numbers: boolean;
  /** 括号字符集合（用 bracket 配色） */
  brackets: string;
  caseInsensitive: boolean;
}

export interface ParsedLanguage {
  spec: UserLanguageSpec;
  /** 文件里出现但不认识的键 */
  unknownKeys: string[];
}

export type LanguageParseResult =
  | { ok: true; value: ParsedLanguage }
  | { ok: false; error: string };

const KNOWN_KEYS = new Set([
  "extensions",
  "aliases",
  "lineComment",
  "blockComment",
  "keywords",
  "types",
  "quotes",
  "numbers",
  "brackets",
  "caseInsensitive",
]);

const EXT_RE = /^\.[a-z0-9_+-]{1,16}$/i;
const ALIAS_RE = /^[a-z0-9_+-]{1,24}$/i;
const MAX_WORDS = 500;
const MAX_WORD_LEN = 64;

function stringList(
  raw: unknown,
  what: string,
  pattern: RegExp,
  max: number,
): { ok: true; list: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: `${what} 必须是数组` };
  if (raw.length > max) return { ok: false, error: `${what} 最多 ${max} 项` };
  const list: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return { ok: false, error: `${what} 只能包含字符串` };
    const value = item.trim();
    if (!value) continue;
    if (!pattern.test(value)) return { ok: false, error: `${what} 里的「${value}」格式不合法` };
    if (!list.includes(value)) list.push(value);
  }
  return { ok: true, list };
}

/**
 * 解析单个语言文件。
 * `extensions` 是唯一的必填项——没有扩展名就没法自动生效，只能靠手动选择，
 * 那不如先让人补上。
 */
export function parseUserLanguage(name: string, text: string): LanguageParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `不是合法 JSON（${String(e).split("\n")[0]}）` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "顶层必须是对象" };
  }
  const root = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(root).filter((k) => !KNOWN_KEYS.has(k));

  const ext = stringList(root.extensions, "extensions", EXT_RE, 20);
  if (!ext.ok) return ext;
  if (ext.list.length === 0) {
    return { ok: false, error: "extensions 不能为空（例如 [\".toml\"]）" };
  }
  const extensions = ext.list.map((e) => e.toLowerCase());

  let aliases: string[] = [];
  if (root.aliases !== undefined) {
    const parsed = stringList(root.aliases, "aliases", ALIAS_RE, 10);
    if (!parsed.ok) return parsed;
    aliases = parsed.list.map((a) => a.toLowerCase());
  }

  const keywords = stringList(root.keywords ?? [], "keywords", /^[^\s]+$/, MAX_WORDS);
  if (!keywords.ok) return keywords;
  if (keywords.list.some((k) => k.length > MAX_WORD_LEN)) {
    return { ok: false, error: `keywords 单项最长 ${MAX_WORD_LEN} 字符` };
  }
  const types = stringList(root.types ?? [], "types", /^[^\s]+$/, MAX_WORDS);
  if (!types.ok) return types;
  if (types.list.some((t) => t.length > MAX_WORD_LEN)) {
    return { ok: false, error: `types 单项最长 ${MAX_WORD_LEN} 字符` };
  }

  let lineComment: string | undefined;
  if (root.lineComment !== undefined) {
    if (typeof root.lineComment !== "string" || !root.lineComment.trim()) {
      return { ok: false, error: "lineComment 必须是非空字符串（如 \"#\"）" };
    }
    const value = root.lineComment.trim();
    if (value.length > 4 || /\s/.test(value)) {
      return { ok: false, error: "lineComment 最长 4 字符且不能含空白" };
    }
    lineComment = value;
  }

  let blockComment: [string, string] | undefined;
  if (root.blockComment !== undefined) {
    const pair = root.blockComment;
    if (!Array.isArray(pair) || pair.length !== 2) {
      return { ok: false, error: 'blockComment 必须是 [起, 止] 两个字符串' };
    }
    const [start, end] = pair as unknown[];
    const valid = (v: unknown) => typeof v === "string" && v.trim() && v.length <= 8 && !/\s/.test(v);
    if (!valid(start) || !valid(end)) {
      return { ok: false, error: "blockComment 的两端须为 1–8 字符且不含空白" };
    }
    blockComment = [String(start).trim(), String(end).trim()];
  }

  let quotes = "\"'";
  if (root.quotes !== undefined) {
    if (typeof root.quotes !== "string" || root.quotes.length === 0 || root.quotes.length > 4) {
      return { ok: false, error: 'quotes 须为 1–4 个字符（如 "\\"\'"）' };
    }
    quotes = root.quotes;
  }

  let brackets = "()[]{}";
  if (root.brackets !== undefined) {
    if (typeof root.brackets !== "string" || root.brackets.length > 12) {
      return { ok: false, error: "brackets 须为字符串且不超过 12 个字符" };
    }
    brackets = root.brackets;
  }

  const numbers = root.numbers === undefined ? true : root.numbers;
  if (typeof numbers !== "boolean") return { ok: false, error: "numbers 必须是 true / false" };
  const caseInsensitive = root.caseInsensitive === undefined ? false : root.caseInsensitive;
  if (typeof caseInsensitive !== "boolean") {
    return { ok: false, error: "caseInsensitive 必须是 true / false" };
  }

  return {
    ok: true,
    value: {
      spec: {
        name,
        extensions,
        aliases,
        lineComment,
        blockComment,
        keywords: keywords.list,
        types: types.list,
        quotes,
        numbers,
        brackets,
        caseInsensitive,
      },
      unknownKeys,
    },
  };
}

/** 批量解析后端返回的文件列表（坏文件进 errors，不影响其它语言） */
export function parseLanguageEntries(
  entries: { name: string; content: string }[],
): { languages: UserLanguageSpec[]; errors: string[] } {
  const languages: UserLanguageSpec[] = [];
  const errors: string[] = [];
  for (const entry of entries) {
    const result = parseUserLanguage(entry.name, entry.content);
    if (!result.ok) {
      errors.push(`${entry.name}.json：${result.error}`);
      continue;
    }
    languages.push(result.value.spec);
    if (result.value.unknownKeys.length > 0) {
      errors.push(`${entry.name}.json：忽略了不认识的键 ${result.value.unknownKeys.join("、")}`);
    }
  }
  return { languages, errors };
}
