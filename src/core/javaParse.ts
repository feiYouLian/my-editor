/**
 * Java 源码扫描：类型声明 / 字段 / enum 常量 → 结构模型（纯字符串处理，无第三方依赖）。
 *
 * 只做「够生成 JSON 示例」的最小解析：class / record / enum / interface 与其中的字段，
 * 不做完整语法分析（不处理父类字段合并、接口方法体、泛型约束求值）。
 */

export type TypeRef =
  | { kind: "named"; name: string }
  | { kind: "array"; element: TypeRef }
  | { kind: "generic"; raw: string; args: TypeRef[] };

export interface JavaField {
  /** JSON 键名（注解改名优先） */
  name: string;
  type: TypeRef;
}

export interface JavaDecl {
  name: string;
  kind: "class" | "record" | "enum" | "interface";
  /** 声明处的花括号深度：0 = 顶层 */
  depth: number;
  /** 类型体起始下标（enum 常量解析用） */
  bodyStart: number;
  fields: JavaField[];
  constants: string[];
}

const UNKNOWN: TypeRef = { kind: "named", name: "Object" };

const MODIFIERS = new Set([
  "public",
  "protected",
  "private",
  "static",
  "final",
  "transient",
  "volatile",
  "abstract",
  "synchronized",
  "native",
  "strictfp",
  "default",
  "sealed",
]);

// ---------------------------------------------------------------------------
// 词法辅助
// ---------------------------------------------------------------------------

/** 跳过字符串 / 字符字面量（返回结束引号之后的下标） */
function skipLiteral(text: string, start: number): number {
  if (text.startsWith('"""', start)) {
    const end = text.indexOf('"""', start + 3);
    return end < 0 ? text.length : end + 3;
  }
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (ch === "\n") return i;
    i++;
  }
  return i;
}

/** 去注释（保留换行，字符串原样保留） */
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const end = skipLiteral(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** 字符串字面量替换为等长空白（等长保证下标仍可对齐原文） */
function blankLiterals(text: string): string {
  return text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (m) => " ".repeat(m.length));
}

/** 匹配 start（必须是 '('）对应的右括号下标；失败返回 -1 */
function matchParen(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = skipLiteral(text, i) - 1;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 按分隔符切分，忽略括号 / 尖括号 / 花括号内部（泛型参数、注解参数、常量构造） */
function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = skipLiteral(text, i) - 1;
      continue;
    }
    if (ch === "<" || ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ">" || ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** 首个顶层赋值号下标（跳过 ==、!=、<=、>= 与括号内部）；无则 -1 */
function indexOfAssign(text: string): number {
  let angle = 0;
  let round = 0;
  let square = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = skipLiteral(text, i) - 1;
      continue;
    }
    if (ch === "<") angle++;
    else if (ch === ">" && angle > 0 && text[i - 1] !== "-") angle--;
    else if (ch === "(") round++;
    else if (ch === ")") round = Math.max(0, round - 1);
    else if (ch === "[") square++;
    else if (ch === "]") square = Math.max(0, square - 1);
    else if (ch === "=" && angle === 0 && round === 0 && square === 0) {
      const prev = text[i - 1];
      const next = text[i + 1];
      if (next === "=" || prev === "=" || prev === "!" || prev === "<" || prev === ">") continue;
      return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// 声明 / 字段 / 类型解析
// ---------------------------------------------------------------------------

/** 去掉从头部连续出现的注解，返回注解文本与剩余内容 */
function takeAnnotations(raw: string): { annotations: string[]; rest: string } {
  const annotations: string[] = [];
  let rest = raw.trim();
  while (rest.startsWith("@")) {
    const m = /^@[\w$.]+/.exec(rest);
    if (!m) break;
    let end = m[0].length;
    let j = end;
    while (j < rest.length && /\s/.test(rest[j])) j++;
    if (rest[j] === "(") {
      const close = matchParen(rest, j);
      if (close < 0) break;
      end = close + 1;
    }
    annotations.push(rest.slice(0, end));
    rest = rest.slice(end).trim();
  }
  return { annotations, rest };
}

/** 去掉字段 / 方法前缀修饰符 */
function takeModifiers(text: string): { mods: Set<string>; rest: string } {
  const mods = new Set<string>();
  let rest = text.trim();
  for (;;) {
    const m = /^(\S+)\s+/.exec(rest);
    if (!m) break;
    const word = m[1];
    const normalized = word === "non-sealed" ? "sealed" : word;
    if (!MODIFIERS.has(normalized)) break;
    mods.add(normalized);
    rest = rest.slice(m[0].length);
  }
  return { mods, rest };
}

/** 取注解里的第一个字符串字面量（@JsonProperty("name") / (value = "name")） */
function firstString(annotation: string): string | null {
  const m = /"((?:[^"\\]|\\.)*)"/.exec(annotation);
  return m ? m[1] : null;
}

function simpleTypeName(raw: string): string {
  const name = raw.trim().replace(/^.*[.$]/, "").trim();
  // 通配符 / 类型变量 / 多词类型：无法推断具体结构
  if (!name || name.includes("?") || /\s/.test(name)) return "Object";
  return name;
}

function parseTypeRef(raw: string): TypeRef | null {
  let text = raw.trim();
  if (!text) return null;
  if (text.endsWith("...")) text = `${text.slice(0, -3)}[]`;
  if (text.endsWith("[]")) {
    return { kind: "array", element: parseTypeRef(text.slice(0, -2)) ?? UNKNOWN };
  }
  const lt = text.indexOf("<");
  if (lt > 0 && text.endsWith(">")) {
    const args = splitTopLevel(text.slice(lt + 1, -1), ",")
      .map((part) => parseTypeRef(part))
      .filter((arg): arg is TypeRef => arg !== null);
    return { kind: "generic", raw: simpleTypeName(text.slice(0, lt)), args };
  }
  return { kind: "named", name: simpleTypeName(text) };
}

/** 解析一条 `类型 字段名;` 语句；方法 / 构造器 / 静态常量返回 null */
function parseFieldStatement(raw: string): JavaField | null {
  const first = takeAnnotations(raw);
  const mods = takeModifiers(first.rest);
  if (mods.mods.has("static") || mods.mods.has("transient")) return null;
  const second = takeAnnotations(mods.rest);
  const annotations = [...first.annotations, ...second.annotations];
  if (annotations.some((a) => /@JsonIgnore\b/.test(a))) return null;

  const body = second.rest;
  const eq = indexOfAssign(body);
  let head = (eq >= 0 ? body.slice(0, eq) : body).trim();
  // 类型上的注解（如 List<@NotNull String>）先去掉，再判断是否残留方法括号
  head = head.replace(/@[\w$.]+(?:\s*\([^()]*\))?\s*/g, "").trim();
  if (!head || /[()]/.test(head)) return null;

  // 字段名尾部数组：String args[]
  let suffix = "";
  while (/\s*\[\s*\]$/.test(head)) {
    head = head.replace(/\s*\[\s*\]$/, "");
    suffix += "[]";
  }
  const m = /^(.+?)\s+([\p{L}_$][\w$]*)$/u.exec(head);
  if (!m) return null;
  const typeText = `${m[1].trim()}${suffix}`;
  // 多个变量声明（int a, b;）不展开；泛型内部的逗号不算
  if (!typeText || splitTopLevel(typeText, ",").length > 1) return null;
  const type = parseTypeRef(typeText);
  if (!type) return null;

  const rename = annotations
    .filter((a) => /@(?:JsonProperty|SerializedName|JSONField)\b/.test(a))
    .map((a) => firstString(a))
    .find((name): name is string => Boolean(name));
  return { name: rename ?? m[2], type };
}

/** enum 常量名（到首个顶层 ';' 为止） */
function parseEnumConstants(body: string): string[] {
  let head = body;
  let round = 0;
  let brace = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"' || ch === "'") {
      i = skipLiteral(body, i) - 1;
      continue;
    }
    if (ch === "(") round++;
    else if (ch === ")") round = Math.max(0, round - 1);
    else if (ch === "{") brace++;
    else if (ch === "}") brace = Math.max(0, brace - 1);
    else if (ch === ";" && round === 0 && brace === 0) {
      head = body.slice(0, i);
      break;
    }
  }
  return splitTopLevel(head, ",")
    .map((part) =>
      part
        .replace(/@[\w$.]+(?:\s*\([^()]*\))?\s*/g, "")
        .trim(),
    )
    .map((part) => /^([\p{L}_$][\w$]*)/u.exec(part)?.[1] ?? "")
    .filter(Boolean);
}

/** record 头部括号里的组件即字段：record User(String name, int age) */
function parseRecordComponents(header: string, from: number): JavaField[] {
  const open = header.indexOf("(", from);
  if (open < 0) return [];
  const close = matchParen(header, open);
  if (close < 0) return [];
  return splitTopLevel(header.slice(open + 1, close), ",")
    .map((part) => parseFieldStatement(part))
    .filter((field): field is JavaField => field !== null);
}

/** 从 `{` 之前的头部文本识别类型声明（取最后一个 class/interface/enum/record） */
function parseDeclHeader(header: string): JavaDecl | null {
  const clean = blankLiterals(header);
  const re = /(?:^|[^\w$.])(class|interface|enum|record)\s+([\p{L}_$][\w$]*)/gu;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(clean); m !== null; m = re.exec(clean)) last = m;
  if (!last) return null;
  const kind = last[1] as JavaDecl["kind"];
  const nameEnd = last.index + last[0].length;
  return {
    name: last[2],
    kind,
    depth: 0,
    bodyStart: 0,
    fields: kind === "record" ? parseRecordComponents(header, nameEnd) : [],
    constants: [],
  };
}

// ---------------------------------------------------------------------------
// 源码扫描
// ---------------------------------------------------------------------------

interface ScanFrame {
  kind: "type" | "block" | "group";
  /** 打开花括号之前的深度 */
  depth: number;
  decl?: JavaDecl;
  /** 打开前的语句起点（字段初始化带匿名类 / 数组字面量时恢复用） */
  stmtBefore: number;
  /** 关闭后是否恢复语句起点（字段初始化块） */
  restoreStmt: boolean;
}

function scanDecls(code: string): JavaDecl[] {
  const decls: JavaDecl[] = [];
  const frames: ScanFrame[] = [];
  let depth = 0;
  let paren = 0;
  let stmtStart = 0;
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'") {
      i = skipLiteral(code, i);
      continue;
    }
    if (ch === "(") {
      paren++;
      i++;
      continue;
    }
    if (ch === ")") {
      if (paren > 0) paren--;
      i++;
      continue;
    }
    if (ch === "{") {
      // 注解数组 / 括号内的花括号：只平衡深度，不打断当前语句
      if (paren > 0) {
        frames.push({ kind: "group", depth, stmtBefore: stmtStart, restoreStmt: true });
        depth++;
        i++;
        continue;
      }
      const header = code.slice(stmtStart, i);
      const decl = parseDeclHeader(header);
      if (decl) {
        decl.depth = depth;
        decl.bodyStart = i + 1;
        decls.push(decl);
        frames.push({ kind: "type", depth, decl, stmtBefore: stmtStart, restoreStmt: false });
      } else {
        // 字段初始化（= new X() {...} / 数组字面量）需要保留语句起点，闭合后继续解析该字段
        frames.push({
          kind: "block",
          depth,
          stmtBefore: stmtStart,
          restoreStmt: indexOfAssign(header) >= 0,
        });
      }
      depth++;
      stmtStart = i + 1;
      i++;
      continue;
    }
    if (ch === "}") {
      const frame = frames.pop();
      if (!frame) {
        i++;
        continue;
      }
      depth = frame.depth;
      if (frame.kind === "type" && frame.decl) {
        if (frame.decl.kind === "enum") {
          frame.decl.constants = parseEnumConstants(code.slice(frame.decl.bodyStart, i));
        }
      }
      stmtStart = frame.restoreStmt ? frame.stmtBefore : i + 1;
      i++;
      continue;
    }
    if (ch === ";") {
      const top = frames[frames.length - 1];
      if (top?.kind === "type" && top.decl && depth === top.depth + 1) {
        const field = parseFieldStatement(code.slice(stmtStart, i));
        if (field) top.decl.fields.push(field);
      }
      stmtStart = i + 1;
      i++;
      continue;
    }
    i++;
  }
  return decls;
}

/** 解析 Java 源码，返回按出现顺序排列的类型声明（含嵌套） */
export function parseJavaDecls(source: string): JavaDecl[] {
  return scanDecls(stripComments(source));
}
