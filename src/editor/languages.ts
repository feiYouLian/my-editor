import { LanguageDescription, LanguageSupport, StreamLanguage } from "@codemirror/language";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { createKeywordLanguage } from "./keywordLanguage";
import type { UserLanguageSpec } from "../config/userLanguages";

/**
 * 语言注册表：
 * - 内置语言静态打包进主 bundle：TS/JS/JSON/HTML/CSS/Markdown/Python
 * - 懒加载语言首次打开对应文件时动态 import：Rust/Go/Java/C++/SQL/YAML/XML/Properties/cURL
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
  // properties：CodeMirror 官方遗留流模式；补 languageData 以支持 Ctrl+/
  properties: () =>
    import("@codemirror/legacy-modes/mode/properties").then((m) =>
      new LanguageSupport(
        StreamLanguage.define({
          ...m.properties,
          languageData: { commentTokens: { line: "#" } },
        }),
      ),
    ),
  // cURL：手写轻量流模式（editor/curlLanguage.ts）
  curl: () => import("./curlLanguage").then((m) => m.curlLanguage()),
};

// ---------------------------------------------------------------------------
// 用户自定义语言（<配置目录>/languages/*.json，关键字级高亮）
// 与下面的内置表分开存放：内置表是打包期的常量，用户表是运行期载入态。
// ---------------------------------------------------------------------------

interface UserLanguageEntry {
  support: LanguageSupport;
  extensions: string[];
  aliases: string[];
  displayName: string;
}

const userLanguages = new Map<string, UserLanguageEntry>();
/** 用户语言贡献的 扩展名 → 语言键；优先级高于内置映射，低于 config 的 languageExtensions */
const userExtensions: Record<string, string> = {};

/**
 * 注册用户语言（由 main.ts 在载入配置后调用）。
 * 返回需要提示的问题：与内置语言重名、扩展名被别的自定义语言占用。
 * 这两种情况都**不覆盖**既有语言——静默顶掉内置高亮比不做更糟。
 */
export function setUserLanguages(specs: UserLanguageSpec[]): string[] {
  userLanguages.clear();
  for (const key of Object.keys(userExtensions)) delete userExtensions[key];
  // 旧的支持对象已失效，缓存一并清空（内置语言下次用到时重新构造，开销可忽略）
  cache.clear();

  const errors: string[] = [];
  for (const spec of specs) {
    if (spec.name in builtins || spec.name in lazy) {
      errors.push(`语言「${spec.name}」与内置语言同名，已忽略`);
      continue;
    }
    if (userLanguages.has(spec.name)) {
      errors.push(`语言「${spec.name}」重复定义，已忽略后一个`);
      continue;
    }
    const clash = spec.extensions.filter((ext) => userExtensions[ext] !== undefined);
    if (clash.length > 0) {
      errors.push(`语言「${spec.name}」的扩展名 ${clash.join("、")} 已被其它自定义语言占用，已忽略`);
      continue;
    }
    userLanguages.set(spec.name, {
      support: createKeywordLanguage(spec),
      extensions: spec.extensions,
      aliases: spec.aliases,
      displayName: spec.name,
    });
    for (const ext of spec.extensions) userExtensions[ext] = spec.name;
  }
  return errors;
}

/** 已注册的用户自定义语言数（状态提示用） */
export function userLanguageCount(): number {
  return userLanguages.size;
}

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
  {
    name: "properties",
    alias: ["ini", "conf"],
    extensions: [".properties"],
    load: lazy.properties,
  },
  { name: "curl", alias: ["bash-curl"], extensions: [".curl"], load: lazy.curl },
];

/** 供 markdown({ codeLanguages }) 使用：围栏代码块按语言名/别名/扩展名匹配 */
export function markdownCodeLanguages(): LanguageDescription[] {
  const builtin = codeLanguageTable.map((c) =>
    LanguageDescription.of({
      name: c.name,
      alias: c.alias,
      extensions: c.extensions,
      load: c.load,
    }),
  );
  // 用户语言已经构造好 LanguageSupport，不需要异步加载
  const user = [...userLanguages.entries()].map(([key, entry]) =>
    LanguageDescription.of({
      name: key,
      alias: entry.aliases,
      extensions: entry.extensions,
      load: async () => entry.support,
    }),
  );
  return [...builtin, ...user];
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
  ".properties": "properties",
  ".curl": "curl",
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
  properties: "Properties",
  curl: "cURL",
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

/**
 * 无扩展名 / 点开头文件（`Dockerfile`、`Makefile`、`CMakeLists.txt`、`.env`…）。
 * 只映射到**已注册**的语言：dockerfile/makefile/cmake 没有专用高亮，
 * 先落 properties（`#` 注释 + 键值结构近似）；日后加了专用语言改这一行即可。
 */
const basenameToLanguage: Record<string, string> = {
  dockerfile: "properties",
  "dockerfile.dev": "properties",
  makefile: "properties",
  gnumakefile: "properties",
  "cmakelists.txt": "properties",
  ".env": "properties",
  ".gitignore": "properties",
  ".gitattributes": "properties",
  ".npmrc": "properties",
  ".editorconfig": "properties",
};

export function languageKeyFromPath(path: string): string | null {
  // 先按文件名整体匹配：`D:/a.b/Makefile` 这类路径用扩展名算法会算出带分隔符的"扩展名"
  const base = path.replace(/^.*[\\/]/, "").toLowerCase();
  const byName = basenameToLanguage[base];
  if (byName) return overrides[`/${base}`] ?? byName;
  const dot = base.lastIndexOf(".");
  // 注意：`.env` 的 dot === 0 是有意的（当扩展名处理），不能改成 dot <= 0
  if (dot < 0) return null;
  const ext = base.slice(dot);
  return overrides[ext] ?? userExtensions[ext] ?? extensionToLanguage[ext] ?? null;
}

/** 语言键 → 展示名（含用户自定义语言） */
export function languageName(key: string): string {
  return languageDisplayNames[key] ?? userLanguages.get(key)?.displayName ?? key;
}

/** 状态栏语言菜单用：全部可手动选择的语言（内置 + 自定义，不含纯文本） */
export function allLanguageNames(): { key: string; label: string }[] {
  const builtin = Object.keys(languageDisplayNames)
    .filter((key) => key !== "plaintext")
    .map((key) => ({ key, label: languageDisplayNames[key] }));
  const user = [...userLanguages.entries()].map(([key, entry]) => ({
    key,
    label: `${entry.displayName}（自定义）`,
  }));
  return [...builtin, ...user];
}

/**
 * 生效的语言：手动覆盖 > 扩展名映射 > 纯文本。
 * 与 Tab 类型耦合，故随语言域放此（ui/app 层共用）。
 */
export function effectiveLanguage(tab: {
  languageOverride?: string | null;
  path: string | null;
}): string | null {
  if (tab.languageOverride !== undefined) return tab.languageOverride;
  return tab.path ? languageKeyFromPath(tab.path) : null;
}

/** 状态栏语言文案（手动覆盖时加标注） */
export function languageLabel(tab: {
  languageOverride?: string | null;
  path: string | null;
}): string {
  const key = effectiveLanguage(tab);
  const name = key ? languageName(key) : "纯文本";
  return tab.languageOverride !== undefined ? `${name}（手动）` : name;
}

const cache = new Map<string, LanguageSupport | null>();

/** 加载语言支持：内置同步、懒加载异步、用户自定义语言同步；未知扩展返回 null（纯文本） */
export async function loadLanguage(key: string): Promise<LanguageSupport | null> {
  if (cache.has(key)) return cache.get(key) ?? null;
  let support: LanguageSupport | null = null;
  try {
    if (userLanguages.has(key)) support = userLanguages.get(key)?.support ?? null;
    else if (key in builtins) support = builtins[key]();
    else if (key in lazy) support = await lazy[key]();
  } catch (err) {
    console.warn(`[languages] 加载语言失败: ${key}`, err);
    support = null;
  }
  cache.set(key, support);
  return support;
}
