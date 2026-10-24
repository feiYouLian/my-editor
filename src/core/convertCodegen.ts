/**
 * JSON → Java / TypeScript 代码生成（纯字符串模板，无第三方依赖）。
 *
 * 规则（与《新增功能_技术设计文档》3.3 一致）：
 * - number：整数 → long / number，小数 → double / number
 * - 数组 → List<T> / T[]；空数组 → List<Object> / unknown[]
 * - 对象 → 嵌套 static class / 嵌套 interface
 * - 混合类型数组 → Object / unknown，并附 `// mixed: …` 注释
 * - 顶层必须是对象或对象数组，否则报错
 */

export type CodeLang = "java" | "ts";

export interface CodegenOptions {
  /** 根类型名，默认 "Root" */
  className: string;
  /** Java：class + getter 或 Java 17+ record */
  javaStyle: "class" | "record";
  /** class 模式追加 Lombok @Data（默认 false） */
  javaLombok: boolean;
}

type Prim = { kind: "prim"; java: string; ts: string };
type Mixed = { kind: "mixed"; detail: string };
type Obj = { kind: "object"; name: string; fields: Field[] };
type Arr = { kind: "array"; element: TypeNode };
type TypeNode = Prim | Mixed | Obj | Arr;

interface Field {
  /** 生成代码中的字段名 */
  name: string;
  /** JSON 原始键（用于改名注释） */
  original: string;
  type: TypeNode;
}

const OBJECT: Prim = { kind: "prim", java: "Object", ts: "unknown" };
const STRING: Prim = { kind: "prim", java: "String", ts: "string" };
const BOOLEAN: Prim = { kind: "prim", java: "boolean", ts: "boolean" };
const INT: Prim = { kind: "prim", java: "long", ts: "number" };
const DOUBLE: Prim = { kind: "prim", java: "double", ts: "number" };

const JAVA_KEYWORDS = new Set(
  (
    "abstract assert boolean break byte case catch char class const continue default do double " +
    "else enum extends final finally float for goto if implements import instanceof int interface " +
    "long native new package private protected public return short static strictfp super switch " +
    "synchronized this throw throws transient try void volatile while true false null"
  ).split(" "),
);

/** 类型名去重：同名对象追加 2、3… */
class TypeNamer {
  private used = new Set<string>();

  take(base: string): string {
    const stem = base || "Type";
    let name = stem;
    let n = 2;
    while (this.used.has(name)) name = `${stem}${n++}`;
    this.used.add(name);
    return name;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON 键 → PascalCase 类型名（支持中文等 Unicode 字母） */
function toPascal(raw: string): string {
  const parts = raw.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const name = parts.map((p) => p[0].toUpperCase() + p.slice(1)).join("");
  if (!name) return "Type";
  return /^[\p{N}]/u.test(name) ? `T${name}` : name;
}

/** JSON 键 → camelCase 字段名（非法字符/关键字/数字开头均处理） */
function toField(raw: string): string {
  const parts = raw.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  let name = parts
    .map((p, i) => (i === 0 ? p[0].toLowerCase() + p.slice(1) : p[0].toUpperCase() + p.slice(1)))
    .join("");
  if (!name) name = "field";
  if (/^[\p{N}]/u.test(name)) name = `_${name}`;
  if (JAVA_KEYWORDS.has(name)) name = `${name}_`;
  return name;
}

/** 数组字段的类名优先用单数（items → Item） */
function singularize(name: string): string {
  return name.length > 2 && name.endsWith("s") && !name.endsWith("ss")
    ? name.slice(0, -1)
    : name;
}

interface Ctx {
  namer: TypeNamer;
  objects: Obj[];
}

/** 合并同名字段的多个取值：全对象 → 合并字段；全数字 → number；否则回落 mixed */
function inferMerged(values: unknown[], hint: string, ctx: Ctx): TypeNode {
  const vals = values.filter((v) => v !== null && v !== undefined);
  if (vals.length === 0) return OBJECT;
  if (vals.every(isPlainObject)) return inferObject(vals, hint, ctx);
  if (vals.every(Array.isArray)) {
    return inferArray(vals.flat() as unknown[], hint, ctx);
  }
  if (vals.every((v) => typeof v === "number")) {
    return vals.every((v) => Number.isInteger(v)) ? INT : DOUBLE;
  }
  const kinds = [...new Set(vals.map((v) => typeof v))];
  if (kinds.length === 1 && kinds[0] === "string") return STRING;
  if (kinds.length === 1 && kinds[0] === "boolean") return BOOLEAN;
  return { kind: "mixed", detail: kinds.join(" | ") };
}

function inferArray(items: unknown[], hint: string, ctx: Ctx): Arr {
  const vals = items.filter((v) => v !== null && v !== undefined);
  if (vals.length === 0) return { kind: "array", element: OBJECT };
  if (vals.every(isPlainObject)) {
    return { kind: "array", element: inferObject(vals, singularize(hint), ctx) };
  }
  if (vals.every(Array.isArray)) {
    return { kind: "array", element: inferArray(vals.flat() as unknown[], hint, ctx) };
  }
  return { kind: "array", element: inferMerged(vals, hint, ctx) };
}

function inferObject(list: Record<string, unknown>[], hint: string, ctx: Ctx): Obj {
  const name = ctx.namer.take(toPascal(hint || "Item"));
  const keys: string[] = [];
  for (const obj of list) {
    for (const key of Object.keys(obj)) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  const fields: Field[] = keys.map((key) => {
    const values = list.filter((o) => key in o).map((o) => o[key]);
    return { name: toField(key), original: key, type: inferMerged(values, key, ctx) };
  });
  // 不同 JSON 键可能净化成同一字段名（a-b / a_b）：追加序号去重
  const used = new Set<string>();
  for (const field of fields) {
    if (!used.has(field.name)) {
      used.add(field.name);
      continue;
    }
    let n = 2;
    let name = `${field.name}${n}`;
    while (used.has(name)) name = `${field.name}${++n}`;
    field.name = name;
    used.add(name);
  }
  const node: Obj = { kind: "object", name, fields };
  ctx.objects.push(node);
  return node;
}

function javaType(type: TypeNode): string {
  if (type.kind === "prim") return type.java;
  if (type.kind === "mixed") return "Object";
  if (type.kind === "object") return type.name;
  return `List<${javaType(type.element)}>`;
}

function tsType(type: TypeNode): string {
  if (type.kind === "prim") return type.ts;
  if (type.kind === "mixed") return "unknown";
  if (type.kind === "object") return type.name;
  return `${tsType(type.element)}[]`;
}

function usesList(type: TypeNode): boolean {
  if (type.kind === "array") return true;
  if (type.kind === "object") return type.fields.some((f) => usesList(f.type));
  return false;
}

/** 混合类型可能藏在数组元素里（如 [1, "a"] → unknown[]），注释需要向外传递 */
function mixedDetail(type: TypeNode): string | null {
  if (type.kind === "mixed") return type.detail;
  if (type.kind === "array") return mixedDetail(type.element);
  return null;
}

function fieldComment(field: Field): string {
  const notes: string[] = [];
  if (field.name !== field.original) notes.push(`原键: "${field.original}"`);
  const mixed = mixedDetail(field.type);
  if (mixed) notes.push(`mixed: ${mixed}`);
  return notes.length ? ` // ${notes.join("; ")}` : "";
}

function capitalize(name: string): string {
  return name ? name[0].toUpperCase() + name.slice(1) : name;
}

function recordComment(obj: Obj): string[] {
  const renamed = obj.fields.filter((f) => f.name !== f.original);
  return renamed.length
    ? [`    // 字段改名：${renamed.map((f) => `${f.original} -> ${f.name}`).join("; ")}`]
    : [];
}

function renderJava(root: Obj, ctx: Ctx, opts: CodegenOptions): string {
  const nested = ctx.objects.filter((o) => o !== root);
  const lines: string[] = [];
  if (opts.javaStyle === "class" && opts.javaLombok) lines.push("import lombok.Data;");
  if ([root, ...nested].some((o) => o.fields.some((f) => usesList(f.type)))) {
    lines.push("import java.util.List;");
  }
  if (lines.length > 0) lines.push("");

  if (opts.javaStyle === "record") {
    const params = root.fields
      .map((f) => `${javaType(f.type)} ${f.name}`)
      .join(", ");
    lines.push(`public record ${root.name}(${params}) {`);
    lines.push(...recordComment(root));
    for (const obj of nested) {
      lines.push("");
      const nestedParams = obj.fields
        .map((f) => `${javaType(f.type)} ${f.name}`)
        .join(", ");
      lines.push(`    public record ${obj.name}(${nestedParams}) {`);
      lines.push(...recordComment(obj).map((l) => `    ${l.trim()}`));
      lines.push("    }");
    }
    lines.push("}");
    return lines.join("\n");
  }

  const lombok = opts.javaLombok;
  const renderClass = (obj: Obj, indent: string, isRoot: boolean): string[] => {
    const body: string[] = [];
    if (lombok) body.push(`${indent}@Data`);
    body.push(`${indent}public ${isRoot ? "" : "static "}class ${obj.name} {`);
    for (const f of obj.fields) {
      body.push(`${indent}    private ${javaType(f.type)} ${f.name};${fieldComment(f)}`);
    }
    if (!lombok) {
      for (const f of obj.fields) {
        body.push("");
        body.push(`${indent}    public ${javaType(f.type)} get${capitalize(f.name)}() {`);
        body.push(`${indent}        return ${f.name};`);
        body.push(`${indent}    }`);
      }
    }
    return body;
  };

  lines.push(...renderClass(root, "", true));
  for (const obj of nested) {
    lines.push("");
    lines.push(...renderClass(obj, "    ", false));
    lines.push("    }");
  }
  lines.push("}");
  return lines.join("\n");
}

function renderTs(root: Obj, ctx: Ctx): string {
  const renderInterface = (obj: Obj): string[] => {
    const body: string[] = [`export interface ${obj.name} {`];
    for (const f of obj.fields) {
      if (f.name !== f.original) body.push(`  /** 原键: "${f.original}" */`);
      const mixed = mixedDetail(f.type);
      body.push(`  ${f.name}: ${tsType(f.type)};${mixed ? ` // mixed: ${mixed}` : ""}`);
    }
    body.push("}");
    return body;
  };
  const blocks = [renderInterface(root)];
  for (const obj of ctx.objects) {
    if (obj !== root) blocks.push(renderInterface(obj));
  }
  return blocks.map((b) => b.join("\n")).join("\n\n");
}

/**
 * 从任意 JSON 值推断类型树并生成源码。
 * 顶层必须是对象或对象数组（数组时 className 表示元素类型）。
 */
export function jsonToCode(json: unknown, lang: CodeLang, opts: CodegenOptions): string {
  if (!isPlainObject(json) && !Array.isArray(json)) {
    throw new Error("顶层必须是对象或对象数组（当前是标量）");
  }
  const ctx: Ctx = { namer: new TypeNamer(), objects: [] };
  const className = opts.className.trim() || "Root";
  let root: Obj;
  let arrayRoot = false;
  if (Array.isArray(json)) {
    if (json.length === 0) throw new Error("JSON 根数组为空，无法推断类型");
    if (!json.every(isPlainObject)) {
      throw new Error("顶层必须是对象或对象数组（当前数组含非对象元素）");
    }
    const type = inferArray(json, className, ctx);
    if (type.element.kind !== "object") throw new Error("无法从根数组推断对象类型");
    root = type.element;
    arrayRoot = true;
  } else {
    root = inferObject([json], className, ctx);
  }
  const header = arrayRoot ? `// JSON 根为数组：${root.name} 表示数组元素类型\n` : "";
  const body = lang === "java" ? renderJava(root, ctx, opts) : renderTs(root, ctx);
  return `${header}${body}\n`;
}
