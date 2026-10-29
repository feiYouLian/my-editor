/**
 * 自定义编辑器主题：文件格式、校验与 `custom:<名字>` 取值约定。
 *
 * 解析放在前端而不是后端：配色键名 → CodeMirror 语法 tag（@lezer/highlight）的映射
 * 是编辑器语义，后端只负责列出 `<配置目录>/themes/*.json` 的原始内容。
 *
 * 失败不静默：每个坏文件都返回「文件名 + 原因」，由调用方汇总提示——
 * 否则用户改错一个键只会看到「主题没生效」，不知道该改哪。
 */

export const CUSTOM_THEME_PREFIX = "custom:";

/** 结构色：编辑器底色 / 光标 / 选区 / gutter，对应 EditorView.theme 的 CSS 规则 */
export interface UserThemeUi {
  background?: string;
  foreground?: string;
  caret?: string;
  selection?: string;
  activeLine?: string;
  gutterBackground?: string;
  gutterForeground?: string;
}

/** 语法色键名（与 @lezer/highlight 的 tags 一一对应，见 editor/theme.ts） */
export const SYNTAX_KEYS = [
  "keyword",
  "string",
  "number",
  "comment",
  "variableName",
  "function",
  "typeName",
  "propertyName",
  "operator",
  "bracket",
  "tagName",
  "attributeName",
  "heading",
  "link",
  "invalid",
] as const;

export type SyntaxKey = (typeof SYNTAX_KEYS)[number];

export interface UserTheme {
  name: string;
  /** 深色主题标记：影响 CodeMirror 内置样式的明暗取舍（不写则按背景色亮度推断） */
  dark: boolean;
  ui: UserThemeUi;
  syntax: Partial<Record<SyntaxKey, string>>;
}

export interface ParsedTheme {
  theme: UserTheme;
  /** 文件里出现但不认识的键（拼错时给出明确线索，而不是静默忽略） */
  unknownKeys: string[];
}

export type ThemeParseResult = { ok: true; value: ParsedTheme } | { ok: false; error: string };

/** 主题文件 → config.json 里的取值 */
export function themeValue(name: string): string {
  return `${CUSTOM_THEME_PREFIX}${name}`;
}

/** 从取值中取出主题名；非自定义主题返回 null */
export function customThemeName(value: string): string | null {
  return value.startsWith(CUSTOM_THEME_PREFIX)
    ? value.slice(CUSTOM_THEME_PREFIX.length).trim() || null
    : null;
}

/**
 * 颜色值校验：只拦会破坏 CSS 的结构性字符（`{}` `;` `@` 与 `url(`），
 * 不限制具体写法——`#rrggbb`、`rgb()`、`hsl()`、命名色都允许。
 */
export function isValidColor(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const value = raw.trim();
  if (value.length === 0 || value.length > 64) return false;
  if (/[{};@]/.test(value)) return false;
  return !value.toLowerCase().includes("url(");
}

/** 背景色亮度 → 是否深色（sRGB 相对亮度，权重取常用近似值） */
function isDarkBackground(color: string | undefined): boolean | null {
  if (!color) return null;
  const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!hex) return null;
  const body = hex[1];
  const full =
    body.length === 3
      ? body
          .split("")
          .map((c) => c + c)
          .join("")
      : body;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return r * 0.299 + g * 0.587 + b * 0.114 < 128;
}

const UI_KEYS: (keyof UserThemeUi)[] = [
  "background",
  "foreground",
  "caret",
  "selection",
  "activeLine",
  "gutterBackground",
  "gutterForeground",
];

/**
 * 解析单个主题文件。
 * 约定：`syntax` 至少一项；`ui` 可省略（省略时只换语法配色，结构色沿用当前内置主题）。
 */
export function parseUserTheme(name: string, text: string): ThemeParseResult {
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

  const uiRaw = root.ui;
  if (uiRaw !== undefined && (typeof uiRaw !== "object" || uiRaw === null || Array.isArray(uiRaw))) {
    return { ok: false, error: "ui 必须是对象" };
  }
  const syntaxRaw = root.syntax;
  if (typeof syntaxRaw !== "object" || syntaxRaw === null || Array.isArray(syntaxRaw)) {
    return { ok: false, error: "缺少 syntax 对象（至少给一个配色键，如 keyword）" };
  }

  const unknownKeys: string[] = [];
  const ui: UserThemeUi = {};
  const uiEntries = Object.entries((uiRaw ?? {}) as Record<string, unknown>);
  for (const [key, value] of uiEntries) {
    if (!UI_KEYS.includes(key as keyof UserThemeUi)) {
      unknownKeys.push(`ui.${key}`);
      continue;
    }
    if (!isValidColor(value)) {
      return { ok: false, error: `ui.${key} 不是有效颜色值` };
    }
    ui[key as keyof UserThemeUi] = String(value).trim();
  }

  const syntax: Partial<Record<SyntaxKey, string>> = {};
  for (const [key, value] of Object.entries(syntaxRaw as Record<string, unknown>)) {
    if (!(SYNTAX_KEYS as readonly string[]).includes(key)) {
      unknownKeys.push(`syntax.${key}`);
      continue;
    }
    if (!isValidColor(value)) {
      return { ok: false, error: `syntax.${key} 不是有效颜色值` };
    }
    syntax[key as SyntaxKey] = String(value).trim();
  }
  if (Object.keys(syntax).length === 0) {
    return { ok: false, error: "syntax 里没有任何可用配色键" };
  }

  const declaredDark = root.dark;
  if (declaredDark !== undefined && typeof declaredDark !== "boolean") {
    return { ok: false, error: "dark 必须是 true / false" };
  }
  const dark = typeof declaredDark === "boolean" ? declaredDark : (isDarkBackground(ui.background) ?? true);

  return { ok: true, value: { theme: { name, dark, ui, syntax }, unknownKeys } };
}

/**
 * 批量解析后端返回的文件列表。
 * 返回解析成功的主题与「需要告诉用户的问题」两拨数据；
 * 主题名重复时保留首个并报告，避免下拉框出现两个同名项。
 */
export function parseThemeEntries(
  entries: { name: string; content: string }[],
): { themes: UserTheme[]; errors: string[] } {
  const themes: UserTheme[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const result = parseUserTheme(entry.name, entry.content);
    if (!result.ok) {
      errors.push(`${entry.name}.json：${result.error}`);
      continue;
    }
    if (seen.has(entry.name)) {
      errors.push(`${entry.name}.json：主题名重复，已忽略`);
      continue;
    }
    seen.add(entry.name);
    themes.push(result.value.theme);
    if (result.value.unknownKeys.length > 0) {
      errors.push(
        `${entry.name}.json：忽略了不认识的键 ${result.value.unknownKeys.join("、")}`,
      );
    }
  }
  return { themes, errors };
}
