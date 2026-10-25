/**
 * Java 源码 → JSON 示例。
 *
 * 规则：
 * - 只取当前类声明的字段（不合并父类字段）；static / transient / @JsonIgnore 由解析层跳过
 * - 字段名取字段名，@JsonProperty / @SerializedName / @JSONField 可改名
 * - 示例值：字符串 ""、数字 0、布尔 false、日期时间 "2024-01-01 12:00:00"
 * - 集合 / 数组 → 一个元素；Map → {"key": 值}；Optional<T> → T；未知类型 → null
 * - 循环引用在断点处输出 null
 * - 根类可由选项指定，默认取「未被其他类引用的顶层类」
 */

import { parseJavaDecls, type JavaDecl, type TypeRef } from "./javaParse";

export interface JavaToJsonOptions {
  /** 根类名；留空时自动推断 */
  rootClass?: string;
}

const STRING_TYPES = new Set([
  "String",
  "CharSequence",
  "Character",
  "char",
  "StringBuilder",
  "StringBuffer",
]);
const BOOLEAN_TYPES = new Set(["boolean", "Boolean", "AtomicBoolean"]);
const INT_TYPES = new Set([
  "byte",
  "Byte",
  "short",
  "Short",
  "int",
  "Integer",
  "long",
  "Long",
  "BigInteger",
  "AtomicInteger",
  "AtomicLong",
]);
const DECIMAL_TYPES = new Set(["float", "Float", "double", "Double", "BigDecimal", "Number"]);
const DATE_TYPES = new Set([
  "Date",
  "Calendar",
  "LocalDateTime",
  "Instant",
  "ZonedDateTime",
  "OffsetDateTime",
  "Timestamp",
  "Year",
]);
const LIST_TYPES = new Set([
  "List",
  "ArrayList",
  "LinkedList",
  "Vector",
  "Set",
  "HashSet",
  "LinkedHashSet",
  "TreeSet",
  "SortedSet",
  "Collection",
  "Iterable",
  "Queue",
  "Deque",
  "ArrayDeque",
  "PriorityQueue",
  "CopyOnWriteArrayList",
  "Stream",
]);
const MAP_TYPES = new Set([
  "Map",
  "HashMap",
  "LinkedHashMap",
  "TreeMap",
  "SortedMap",
  "ConcurrentHashMap",
  "Hashtable",
  "Properties",
  "JSONObject",
]);
const OPTIONAL_TYPES = new Set([
  "Optional",
  "OptionalInt",
  "OptionalLong",
  "OptionalDouble",
]);
const ASYNC_TYPES = new Set(["Future", "CompletableFuture", "CompletionStage"]);

interface SampleContext {
  byName: Map<string, JavaDecl>;
  /** 当前递归路径（循环引用检测） */
  stack: string[];
}

function isByteLike(type: TypeRef): boolean {
  return (
    type.kind === "named" &&
    (type.name === "byte" || type.name === "Byte" || type.name === "char" || type.name === "Character")
  );
}

function collectNamed(type: TypeRef, out: Set<string>): void {
  if (type.kind === "named") {
    out.add(type.name);
    return;
  }
  if (type.kind === "array") {
    collectNamed(type.element, out);
    return;
  }
  out.add(type.raw);
  for (const arg of type.args) collectNamed(arg, out);
}

function sampleNamed(name: string, ctx: SampleContext): unknown {
  if (STRING_TYPES.has(name)) return "";
  if (BOOLEAN_TYPES.has(name)) return false;
  if (INT_TYPES.has(name) || DECIMAL_TYPES.has(name)) return 0;
  if (name === "LocalDate") return "2024-01-01";
  if (name === "LocalTime") return "12:00:00";
  if (DATE_TYPES.has(name)) return "2024-01-01 12:00:00";
  if (name === "UUID") return "00000000-0000-0000-0000-000000000000";
  if (name === "Object" || name === "void") return null;

  const decl = ctx.byName.get(name);
  if (!decl) return null;
  if (decl.kind === "enum") return decl.constants[0] ?? "UNKNOWN";
  if (decl.kind === "interface") return {};
  if (ctx.stack.includes(name)) return null;

  ctx.stack.push(name);
  const obj: Record<string, unknown> = {};
  for (const field of decl.fields) obj[field.name] = sampleOf(field.type, ctx);
  ctx.stack.pop();
  return obj;
}

function sampleOf(type: TypeRef, ctx: SampleContext): unknown {
  if (type.kind === "array") {
    // byte[] / char[] 在 Jackson 中序列化为字符串
    if (isByteLike(type.element)) return "";
    return [sampleOf(type.element, ctx)];
  }
  if (type.kind === "generic") {
    if (LIST_TYPES.has(type.raw)) {
      return type.args[0] ? [sampleOf(type.args[0], ctx)] : [];
    }
    if (MAP_TYPES.has(type.raw)) {
      return { key: type.args[1] ? sampleOf(type.args[1], ctx) : null };
    }
    if (OPTIONAL_TYPES.has(type.raw)) {
      return type.args[0] ? sampleOf(type.args[0], ctx) : null;
    }
    if (ASYNC_TYPES.has(type.raw)) return null;
    return sampleNamed(type.raw, ctx);
  }
  return sampleNamed(type.name, ctx);
}

/** 根类：未被其他类引用的顶层类优先；否则退回首个声明 */
function inferRoot(decls: JavaDecl[], byName: Map<string, JavaDecl>): JavaDecl {
  const referenced = new Set<string>();
  for (const decl of decls) {
    for (const field of decl.fields) collectNamed(field.type, referenced);
  }
  const topLevel = decls.filter((decl) => decl.depth === 0);
  const candidate =
    topLevel.find((decl) => !referenced.has(decl.name)) ?? topLevel[0] ?? decls[0];
  return byName.get(candidate.name) ?? candidate;
}

/** Java 源码 → JSON 示例文本；失败抛 Error（message 面向用户） */
export function javaToJson(source: string, opts: JavaToJsonOptions = {}): string {
  if (!source.trim()) throw new Error("内容为空，无法转换");
  const decls = parseJavaDecls(source);
  if (decls.length === 0) {
    throw new Error("未找到 Java 类 / 枚举定义（需要 class、record 或 enum 声明）");
  }
  const byName = new Map<string, JavaDecl>();
  for (const decl of decls) {
    if (!byName.has(decl.name)) byName.set(decl.name, decl);
  }

  const requested = opts.rootClass?.trim() ?? "";
  let root: JavaDecl;
  if (requested) {
    const found = byName.get(requested);
    if (!found) {
      throw new Error(`未找到类「${requested}」，可选：${[...byName.keys()].join("、")}`);
    }
    root = found;
  } else {
    root = inferRoot(decls, byName);
  }

  const sample = sampleNamed(root.name, { byName, stack: [] });
  return `${JSON.stringify(sample, null, 2)}\n`;
}
