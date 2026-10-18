import { invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";
import { cliFormatters, installHints, syntheticName } from "../config/formatters";

/**
 * 代码格式化（双通道）：
 * - 前端 Prettier 通道：懒加载 prettier/standalone + 分语言插件
 * - 后端 CLI 通道：Rust spawn 外部工具（black/gofmt/rustfmt/
 *   google-java-format/clang-format），stdin/stdout，5s 超时
 *
 * 两个场景：文档级（formatDocument）与选中级（formatSelection，
 * 先缩进归一化再格式化，替换后重置选区）。
 *
 * 实测注意：Prettier 3 standalone 不含任何内置 parser，
 * 连 json 也必须显式装载 babel + estree 插件。
 */

/** 语言键 → Prettier parser */
const parserByLanguage: Record<string, string> = {
  javascript: "babel",
  jsx: "babel",
  typescript: "typescript",
  tsx: "typescript",
  json: "json",
  css: "css",
  markdown: "markdown",
  yaml: "yaml",
  html: "html",
};

async function loadPlugins(parser: string): Promise<unknown[]> {
  switch (parser) {
    case "babel":
    case "json":
      return [
        await import("prettier/plugins/babel"),
        await import("prettier/plugins/estree"),
      ];
    case "typescript":
      return [
        await import("prettier/plugins/typescript"),
        await import("prettier/plugins/estree"),
      ];
    case "css":
      return [await import("prettier/plugins/postcss")];
    case "markdown":
      return [
        await import("prettier/plugins/markdown"),
        await import("prettier/plugins/estree"),
        await import("prettier/plugins/babel"),
      ];
    case "yaml":
      return [await import("prettier/plugins/yaml")];
    case "html":
      return [await import("prettier/plugins/html")];
    default:
      return [];
  }
}

export interface FormatResult {
  ok: boolean;
  message: string;
  changed: boolean;
}

/**
 * 内置 JS 格式化器（不依赖外部 CLI，全部懒加载）：
 * - SQL → sql-formatter（NPM 方案）
 * - XML → xml-formatter
 * JSON / YAML 已由 Prettier 覆盖（见 parserByLanguage）。
 * 这四个即用户要求的「全内置」集合：json / sql / xml / yaml。
 */
const jsFormatters: Record<string, (text: string) => Promise<string>> = {
  sql: async (text) => {
    const { format: formatSql } = await import("sql-formatter");
    // expressionWidth 默认 50 太激进（表达式超 50 字符就折行），放宽到 120
    return formatSql(text, {
      language: "sql",
      tabWidth: 2,
      keywordCase: "upper",
      expressionWidth: 120,
      linesBetweenQueries: 2,
    });
  },
  xml: async (text) => {
    const mod = await import("xml-formatter");
    const formatXml = (
      mod as { default: (xml: string, opts?: Record<string, unknown>) => string }
    ).default;
    const out = formatXml(text, { indentation: "  ", collapseContent: true });
    // xml-formatter 默认输出 CRLF：按原文换行符风格还原
    return /\r\n/.test(text) ? out : out.replace(/\r\n/g, "\n");
  },
};

/** 该语言是否有格式化器（CLI / 内置 JS / Prettier） */
export function supportsFormatting(languageKey: string | null): boolean {
  if (!languageKey) return false;
  return (
    languageKey in cliFormatters ||
    languageKey in jsFormatters ||
    languageKey in parserByLanguage
  );
}

/** 纯文本格式化（不触碰编辑器）：按语言自动选择通道 */
export async function formatText(
  text: string,
  languageKey: string | null,
  filePath: string | null,
): Promise<FormatResult> {
  // CLI 通道优先（Prettier 不覆盖的语言）
  const cli = languageKey ? cliFormatters[languageKey] : undefined;
  if (cli) {
    try {
      const args = cli.args.map((a) =>
        a.replace("__PLACEHOLDER__", filePath || syntheticName(languageKey!)),
      );
      const output = await invoke<string>("run_cli_formatter", {
        tool: cli.tool,
        args,
        content: text,
      });
      const changed = output !== text;
      return {
        ok: true,
        changed,
        message: changed ? "格式化完成" : "已是格式化后的内容",
        output,
      } as FormatResult & { output?: string };
    } catch (e) {
      const hint = installHints[cli.tool];
      const msg = hint ? `${String(e)}\n安装指引: ${hint}` : String(e);
      return { ok: false, message: msg, changed: false };
    }
  }

  // 内置 JS 格式化器通道（SQL / XML，懒加载）
  const jsFormat = languageKey ? jsFormatters[languageKey] : undefined;
  if (jsFormat) {
    try {
      const output = await jsFormat(text);
      const changed = output !== text;
      return {
        ok: true,
        changed,
        message: changed ? "格式化完成" : "已是格式化后的内容",
        output,
      } as FormatResult & { output?: string };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `格式化失败: ${msg}`, changed: false };
    }
  }

  // 前端 Prettier 通道
  const parser = languageKey ? parserByLanguage[languageKey] : undefined;
  if (!parser) {
    return { ok: false, message: "该语言暂无格式化器", changed: false };
  }
  try {
    const [{ format }, plugins] = await Promise.all([
      import("prettier/standalone"),
      loadPlugins(parser),
    ]);
    const output = await format(text, {
      parser,
      plugins: plugins as never,
      filepath: filePath ?? undefined,
    });
    const changed = output !== text;
    return {
      ok: true,
      changed,
      message: changed ? "格式化完成" : "已是格式化后的内容",
      output,
    } as FormatResult & { output?: string };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `格式化失败: ${msg}`, changed: false };
  }
}

/** 文档级格式化：全量格式化并替换 */
export async function formatDocument(
  view: EditorView,
  languageKey: string | null,
  filePath: string | null,
): Promise<FormatResult> {
  const source = view.state.doc.toString();
  const result = await formatText(source, languageKey, filePath);
  const output = (result as FormatResult & { output?: string }).output;
  if (result.ok && output !== undefined && output !== source) {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: output },
    });
  }
  return result;
}

// ---- 选中内容格式化（缩进归一化）----

/** 取选区各行公共缩进 */
function commonIndent(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return "";
  let prefix = lines[0].match(/^[ \t]*/)?.[0] ?? "";
  for (const line of lines.slice(1)) {
    const cur = line.match(/^[ \t]*/)?.[0] ?? "";
    let i = 0;
    while (i < prefix.length && i < cur.length && prefix[i] === cur[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

function indentText(text: string, prefix: string): string {
  if (!prefix) return text;
  return text
    .split("\n")
    .map((l) => (l.length > 0 ? prefix + l : l))
    .join("\n");
}

/**
 * 选中内容格式化：
 * 去掉公共缩进 → 按目标语言格式化 → 按原缩进还原 → 替换并重置选区。
 * 片段独立解析失败时（如半个代码块），提示改用文档级格式化。
 */
export async function formatSelection(
  view: EditorView,
  languageKey: string | null,
  filePath: string | null,
): Promise<FormatResult> {
  const { from, to } = view.state.selection.main;
  if (from === to) {
    return { ok: false, message: "请先选中要格式化的内容", changed: false };
  }
  const selected = view.state.doc.sliceString(from, to);
  const base = commonIndent(selected);
  const dedented = base ? selected.replace(new RegExp(`^${base.replace(/\t/g, "\\t")}`, "gm"), "") : selected;

  const result = await formatText(dedented, languageKey, filePath);
  const output = (result as FormatResult & { output?: string }).output;
  if (!result.ok || output === undefined) return result;
  if (output === dedented) {
    return { ok: true, message: "已是格式化后的内容", changed: false };
  }
  const finalText = indentText(output.replace(/\n$/, ""), base);
  view.dispatch({
    changes: { from, to, insert: finalText },
    selection: { anchor: from, head: from + finalText.length },
  });
  return { ok: true, message: "选中内容格式化完成", changed: true };
}
