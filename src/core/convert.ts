/**
 * 格式转换纯函数（core 层，无 DOM 依赖）：
 * - 内容嗅探 detectFormat（面板默认源格式）
 * - C1 JSON → YAML / C2 YAML → JSON
 * - C3 Properties → YAML / C4 YAML → Properties
 * - G2 Java 源码 → JSON 示例（G1 JSON → Java 代码生成见 convertCodegen.ts）
 * - 共享类型与面板选项规格（CONVERT_OPTION_SPECS）
 *
 * js-yaml 只在函数内动态 import()，不进主 bundle；properties / Java 解析为零依赖同步实现。
 * 失败统一抛 ConvertError（message + 可选 line，1 基）。
 */

import { javaToJson } from "./javaToJson";

export type ConvertFormat = "json" | "yaml" | "properties" | "java";
export type ConvertKind =
  | "json2yaml"
  | "yaml2json"
  | "properties2yaml"
  | "yaml2properties"
  | "java2json";
/** 面板目标：5 个格式转换方向 + 1 个代码生成 */
export type ConvertTarget = ConvertKind | "json2java";

export interface ConvertOptions {
  /** C3：把 true/false、数字、null 推断为对应标量（默认 false，保数据原样） */
  inferScalarTypes?: boolean;
  /** G2：根类名，空串按依赖关系自动推断 */
  javaRootClass?: string;
}

export class ConvertError extends Error {
  constructor(
    message: string,
    /** 1 基行号（能定位时提供） */
    public readonly line?: number,
  ) {
    super(message);
    this.name = "ConvertError";
  }
}

// ---------------------------------------------------------------------------
// 目标元数据（面板下拉、插入新标签的语言键与文件名）
// ---------------------------------------------------------------------------

export const CONVERT_TARGET_LABELS: Record<ConvertTarget, string> = {
  json2yaml: "JSON → YAML",
  yaml2json: "YAML → JSON",
  properties2yaml: "Properties → YAML",
  yaml2properties: "YAML → Properties",
  json2java: "JSON → Java",
  java2json: "Java → JSON",
};

export const CONVERT_TARGET_HINTS: Partial<Record<ConvertTarget, string>> = {
  properties2yaml: "键中的 . 按层级展开为嵌套 map（Spring 约定）",
  yaml2properties: "嵌套 map 拍平为 a.b.c；数组叶为 a.0 / a.1（往返不保证可逆）",
  json2java: "顶层需为对象或对象数组；生成类含字段与 getter（或 record）",
  java2json: "取类的非静态字段生成 JSON 示例，不合并父类字段",
};

/** 目标产物对应的语言键（插入新标签时用） */
export function targetLanguage(target: ConvertTarget): string {
  switch (target) {
    case "json2yaml":
    case "properties2yaml":
      return "yaml";
    case "yaml2json":
    case "java2json":
      return "json";
    case "yaml2properties":
      return "properties";
    case "json2java":
      return "java";
  }
}

/** 目标产物扩展名（文件名建议） */
export function targetExtension(target: ConvertTarget): string {
  return `.${targetLanguage(target)}`;
}

export interface OptionSpec {
  key: string;
  label: string;
  kind: "boolean" | "text" | "select";
  defaultValue: string | boolean;
  choices?: { value: string; label: string }[];
  hint?: string;
}

const CODEGEN_CLASS_NAME: OptionSpec = {
  key: "className",
  label: "根类型名",
  kind: "text",
  defaultValue: "Root",
};

export const CONVERT_OPTION_SPECS: Record<ConvertTarget, OptionSpec[]> = {
  json2yaml: [],
  yaml2json: [],
  properties2yaml: [
    {
      key: "inferScalarTypes",
      label: "推断标量类型（true / false / 数字 / null）",
      kind: "boolean",
      defaultValue: false,
      hint: "默认关闭：属性值保持字符串，避免电话、编号被吃掉前导零",
    },
  ],
  yaml2properties: [],
  json2java: [
    CODEGEN_CLASS_NAME,
    {
      key: "javaStyle",
      label: "Java 风格",
      kind: "select",
      defaultValue: "class",
      choices: [
        { value: "class", label: "class + getter" },
        { value: "record", label: "record（Java 17+）" },
      ],
    },
    {
      key: "javaLombok",
      label: "class 模式追加 Lombok @Data",
      kind: "boolean",
      defaultValue: false,
      hint: "record 模式忽略此项",
    },
  ],
  java2json: [
    {
      key: "javaRoot",
      label: "根类名",
      kind: "text",
      defaultValue: "",
      hint: "留空自动推断：取未被其他类引用的顶层类",
    },
  ],
};

// ---------------------------------------------------------------------------
// 内容嗅探
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * 启发式嗅探（失败返回 null，由用户手选）：
 * JSON 首字符 `{`/`[` 且可解析 → json；类型声明 + 花括号 → java；
 * 行内出现 `key=value` → properties；`---` / `- ` 列表 → yaml；其余按 `key: value` 视为 yaml。
 */
export function detectFormat(text: string): ConvertFormat | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // 以 { / [ 开头即按 JSON 处理（即使语法错误也给出带行号的 JSON 错误）
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  // Java 源码：class / interface / enum / record 声明 + 类型体
  if (
    trimmed.includes("{") &&
    /(?:^|[^\w$.])(?:class|interface|enum|record)\s+[\p{L}_$][\w$]*/u.test(trimmed)
  ) {
    return "java";
  }
  let eq = 0;
  let colon = 0;
  let yamlSignals = 0;
  for (const raw of trimmed.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    if (line === "---" || line === "...") {
      yamlSignals++;
      continue;
    }
    if (/^-\s/.test(line) || line === "-") {
      yamlSignals++;
      continue;
    }
    const m = /^[^=:]\S*?\s*([=:])\s*/.exec(line);
    if (!m) continue;
    if (m[1] === "=") eq++;
    else colon++;
  }
  if (yamlSignals > 0 && eq === 0) return "yaml";
  if (eq > 0) return "properties";
  if (colon > 0) return "yaml";
  return tryJson(trimmed) !== undefined ? "json" : null;
}

// ---------------------------------------------------------------------------
// Properties 解析 / 序列化
// ---------------------------------------------------------------------------

/** properties 转义还原：\uXXXX、\t、\n、\r、\f 与任意 `\x` */
function unescapeProperties(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = input[++i];
    if (next === undefined) break;
    if (next === "u") {
      const hex = input.slice(i + 1, i + 5);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      } else {
        out += "u";
      }
    } else if (next === "t") out += "\t";
    else if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "f") out += "\f";
    else out += next;
  }
  return out;
}

/** 拆分 `key=value` / `key:value` / `key value`（转义的分隔符不算） */
function splitPropertyLine(line: string): [string, string] | null {
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "=" || ch === ":") {
      return [line.slice(0, i), line.slice(i + 1)];
    }
    if (ch === " " || ch === "\t") {
      let j = i;
      while (j < line.length && (line[j] === " " || line[j] === "\t")) j++;
      if (line[j] === "=" || line[j] === ":") j++;
      return [line.slice(0, i), line.slice(j)];
    }
    i++;
  }
  return [line, ""];
}

export interface ParsedProperties {
  /** 原始键值对（按出现顺序，重复键以最后一次为准） */
  entries: [string, string][];
  /** 已按 `.` 展开为嵌套 map 的结构 */
  map: Record<string, unknown>;
}

/** 解析 properties：`#`/`!` 注释、`\` 续行、`=`/`:`/空白分隔、转义还原 */
export function parseProperties(text: string): ParsedProperties {
  const entries: [string, string][] = [];
  const rawLines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i];
    if (!line.trim() || /^\s*[#!]/.test(line)) continue;
    // 续行：行尾奇数个反斜杠表示下一行是延续
    while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < rawLines.length) {
      line = `${line.slice(0, -1)}${rawLines[++i].replace(/^\s+/, "")}`;
    }
    const pair = splitPropertyLine(line.trim());
    if (!pair) continue;
    const key = unescapeProperties(pair[0].trim());
    if (!key) continue;
    entries.push([key, unescapeProperties(pair[1].trim())]);
  }
  const map: Record<string, unknown> = {};
  for (const [key, value] of entries) setNested(map, key, value);
  return { entries, map };
}

/** 按 `.` 写入嵌套 map；中途遇到标量则替换为对象 */
function setNested(root: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  let cursor = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!isPlainObject(cursor[part])) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

/** C3 的标量推断：无前导零的数字 / true / false / null，其余保持字符串 */
export function inferScalar(value: string): unknown {
  if (value === "") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return Number(value);
  return value;
}

/** properties 键转义：`=`/`:`/空格/反斜杠与行首 `#`/`!` */
function escapePropertyKey(key: string): string {
  let out = key
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/([=: ])/g, "\\$1");
  if (/^[#!]/.test(out)) out = `\\${out}`;
  return out;
}

/** properties 值转义：反斜杠、换行、制表符与行首空格 */
function escapePropertyValue(value: string): string {
  let out = value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  if (out.startsWith(" ")) out = `\\${out}`;
  return out;
}

/** C4：嵌套 map 递归拍平（数组叶用 key.0 / key.1） */
function flattenYaml(
  value: unknown,
  prefix: string,
  out: [string, string][],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenYaml(item, `${prefix}.${index}`, out));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      flattenYaml(item, prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }
  if (!prefix) return;
  out.push([prefix, value === null || value === undefined ? "" : String(value)]);
}

// ---------------------------------------------------------------------------
// YAML 库（按需加载）与错误包装
// ---------------------------------------------------------------------------

type YamlModule = typeof import("js-yaml");

async function yamlModule(): Promise<YamlModule> {
  return import("js-yaml");
}

/** 解析 YAML；错误信息带 1 基行号 */
async function parseYaml(text: string): Promise<unknown> {
  const yaml = await yamlModule();
  try {
    const value = yaml.load(text);
    if (value === undefined) throw new ConvertError("YAML 内容为空");
    return value;
  } catch (e) {
    if (e instanceof ConvertError) throw e;
    const err = e as { message?: string; reason?: string; mark?: { line?: number } };
    const line = typeof err.mark?.line === "number" ? err.mark.line + 1 : undefined;
    const reason = err.reason ?? err.message ?? String(e);
    throw new ConvertError(
      line ? `YAML 解析失败（第 ${line} 行）：${reason}` : `YAML 解析失败：${reason}`,
      line,
    );
  }
}

/** 输出 YAML：indent 2、禁止 80 列折行（长 URL / 长串保持单行）、不生成锚点 */
async function dumpYaml(value: unknown): Promise<string> {
  const yaml = await yamlModule();
  return yaml.dump(value, { indent: 2, lineWidth: -1, noRefs: true, sortKeys: false });
}

/** 解析 JSON；失败抛 ConvertError（尽量从 position 换算 1 基行号） */
export function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    const m = /position (\d+)/.exec(msg);
    const line = m ? text.slice(0, Number(m[1])).split("\n").length : undefined;
    throw new ConvertError(
      line ? `JSON 解析失败（第 ${line} 行）：${msg}` : `JSON 解析失败：${msg}`,
      line,
    );
  }
}

// ---------------------------------------------------------------------------
// 转换入口
// ---------------------------------------------------------------------------

/** 单次转换；失败抛 ConvertError（带 message + 可选 1 基 line） */
export async function convert(
  text: string,
  kind: ConvertKind,
  opts: ConvertOptions = {},
): Promise<string> {
  if (!text.trim()) throw new ConvertError("内容为空，无法转换");
  switch (kind) {
    case "json2yaml": {
      return dumpYaml(parseJsonText(text));
    }
    case "yaml2json": {
      const value = await parseYaml(text);
      return `${JSON.stringify(value, null, 2)}\n`;
    }
    case "properties2yaml": {
      const { entries } = parseProperties(text);
      if (entries.length === 0) throw new ConvertError("未找到任何键值对（按 key=value 书写）");
      const map: Record<string, unknown> = {};
      for (const [key, value] of entries) {
        setNested(map, key, opts.inferScalarTypes ? inferScalar(value) : value);
      }
      return dumpYaml(map);
    }
    case "yaml2properties": {
      const value = await parseYaml(text);
      if (!isPlainObject(value)) {
        throw new ConvertError("Properties 转换需要 map 结构（顶层不能是数组或标量）");
      }
      const pairs: [string, string][] = [];
      flattenYaml(value, "", pairs);
      const lines = pairs.map(
        ([key, val]) => `${escapePropertyKey(key)}=${escapePropertyValue(val)}`,
      );
      return `# 由 YAML 拍平生成，数组叶为 key.N\n${lines.join("\n")}\n`;
    }
    case "java2json": {
      try {
        return javaToJson(text, { rootClass: opts.javaRootClass });
      } catch (e) {
        if (e instanceof ConvertError) throw e;
        throw new ConvertError(e instanceof Error ? e.message : String(e));
      }
    }
  }
}
