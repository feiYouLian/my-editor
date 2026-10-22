import type { LanguageSupport } from "@codemirror/language";
import { LanguageDescription } from "@codemirror/language";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";

/**
 * 语言注册表：
 * - 内置语言静态打包进主 bundle：TS/JS/JSON/HTML/CSS/Markdown/Python
 * - 懒加载语言首次打开对应文件时动态 import：Rust/Go/Java/C++/SQL
 */

/** 内置语言：同步构造 */
const builtins: Record<string, () => LanguageSupport> = {
  javascript: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  typescript: () => javascript({ typescript: true }),
  tsx: () => javascript({ jsx: true, typescript: true }),
  json: () => json(),
  html: () => html(),
  css: () => css(),
  // codeLanguages：md 文档内 ```lang 代码块按语言嵌套高亮（懒加载，见下方语言表）
  markdown: () => markdown({ codeLanguages: markdownCodeLanguages() }),
  python: () => python(),
};

/** 懒加载语言：动态 import，由 Vite 自动代码分片 */
const lazy: Record<string, () => Promise<LanguageSupport>> = {
  rust: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  go: () => import("@codemirror/lang-go").then((m) => m.go()),
  java: () => import("@codemirror/lang-java").then((m) => m.java()),
  cpp: () => import("@codemirror/lang-cpp").then((m) => m.cpp()),
  sql: () => import("@codemirror/lang-sql").then((m) => m.sql()),
  yaml: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  xml: () => import("@codemirror/lang-xml").then((m) => m.xml()),
};

/**
 * Markdown 围栏代码块（```lang）的嵌套高亮语言表。
 *
 * markdown() 不传 codeLanguages 时，代码块内容按纯文本渲染——这就是
 * "md 编辑页代码块没有高亮"的原因。这里把文件语言表同一套来源映射为
 * LanguageDescription：内置语言同步构造，其余走 load 懒加载，
 * 只有文档里真正出现某语言代码块时才动态 import 对应包，不进入主 bundle。
 */
const codeLanguageTable: {
  name: string;
  alias: string[];
  extensions: string[];
  load: () => Promise<LanguageSupport>;
}[] = [
  {
    name: "javascript",
    alias: ["js", "jsx", "mjs", "cjs", "node"],
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    load: async () => javascript(),
  },
  {
    name: "typescript",
    alias: ["ts"],
    extensions: [".ts", ".mts"],
    load: async () => javascript({ typescript: true }),
  },
  {
    name: "tsx",
    alias: [],
    extensions: [".tsx"],
    load: async () => javascript({ jsx: true, typescript: true }),
  },
  { name: "json", alias: ["jsonc"], extensions: [".json", ".jsonc"], load: async () => json() },
  { name: "html", alias: ["htm", "xhtml"], extensions: [".html", ".htm"], load: async () => html() },
  { name: "css", alias: [], extensions: [".css", ".less", ".scss"], load: async () => css() },
  {
    name: "python",
    alias: ["py", "python3"],
    extensions: [".py", ".pyi"],
    load: async () => python(),
  },
  {
    name: "markdown",
    alias: ["md"],
    extensions: [".md", ".markdown"],
    load: async () => markdown({ codeLanguages: markdownCodeLanguages() }),
  },
  { name: "rust", alias: ["rs"], extensions: [".rs"], load: lazy.rust },
  { name: "go", alias: ["golang"], extensions: [".go"], load: lazy.go },
  { name: "java", alias: [], extensions: [".java"], load: lazy.java },
  {
    name: "cpp",
    alias: ["c", "c++", "cc", "cxx", "h", "hpp"],
    extensions: [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp"],
    load: lazy.cpp,
  },
  {
    name: "sql",
    alias: ["mysql", "postgres", "postgresql", "sqlite"],
    extensions: [".sql"],
    load: lazy.sql,
  },
  { name: "yaml", alias: ["yml"], extensions: [".yaml", ".yml"], load: lazy.yaml },
  {
    name: "xml",
    alias: ["svg", "plist", "xaml", "rss", "atom"],
    extensions: [".xml", ".svg", ".plist", ".xaml"],
    load: lazy.xml,
  },
];

/** 供 markdown({ codeLanguages }) 使用：围栏代码块按语言名/别名/扩展名匹配 */
export function markdownCodeLanguages(): LanguageDescription[] {
  return codeLanguageTable.map((c) =>
    LanguageDescription.of({
      name: c.name,
      alias: c.alias,
      extensions: c.extensions,
      load: c.load,
    }),
  );
}

/** 扩展名 → 语言键（对应 config.json 的 languageExtensions，可被配置覆盖） */
export const extensionToLanguage: Record<string, string> = {
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".mts": "typescript",
  ".json": "json",
  ".jsonc": "json",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".less": "css",
  ".scss": "css",
  ".md": "markdown",
  ".markdown": "markdown",
  ".py": "python",
  ".pyi": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".c": "cpp",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".h": "cpp",
  ".hpp": "cpp",
  ".sql": "sql",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".xml": "xml",
  ".xaml": "xml",
  ".svg": "xml",
  ".plist": "xml",
};

/** 语言键 → 展示名（状态栏显示） */
export const languageDisplayNames: Record<string, string> = {
  javascript: "JavaScript",
  jsx: "JSX",
  typescript: "TypeScript",
  tsx: "TSX",
  json: "JSON",
  html: "HTML",
  css: "CSS",
  markdown: "Markdown",
  python: "Python",
  rust: "Rust",
  go: "Go",
  java: "Java",
  cpp: "C/C++",
  sql: "SQL",
  yaml: "YAML",
  xml: "XML",
  plaintext: "纯文本",
};

/** config.json languageExtensions 覆盖层：优先级高于内置映射 */
const overrides: Record<string, string> = {};

/** 应用配置里的 languageExtensions（键为小写扩展名，如 ".log"） */
export function setLanguageOverrides(map: Record<string, string>): void {
  for (const key of Object.keys(overrides)) delete overrides[key];
  for (const [ext, lang] of Object.entries(map)) {
    overrides[ext.toLowerCase()] = lang;
  }
}

export function languageKeyFromPath(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = path.slice(dot).toLowerCase();
  return overrides[ext] ?? extensionToLanguage[ext] ?? null;
}

const cache = new Map<string, LanguageSupport | null>();

/** 加载语言支持：内置同步、懒加载异步；未知扩展返回 null（纯文本） */
export async function loadLanguage(key: string): Promise<LanguageSupport | null> {
  if (cache.has(key)) return cache.get(key) ?? null;
  let support: LanguageSupport | null = null;
  try {
    if (key in builtins) support = builtins[key]();
    else if (key in lazy) support = await lazy[key]();
  } catch (err) {
    console.warn(`[languages] 加载语言失败: ${key}`, err);
    support = null;
  }
  cache.set(key, support);
  return support;
}
