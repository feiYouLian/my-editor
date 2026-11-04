#!/usr/bin/env node
/**
 * IPC 参数契约静态校验。
 *
 * Rust 侧的 #[tauri::command] 与前端 invoke() 分属两种语言，各自编译都能过，
 * 参数名写错只会在运行时暴露（0.6.1 的 encodingName → encoding 即此类）。
 * 本脚本用文本解析把两边的「命令名 + 参数名」抽出来做集合比较：
 *   - 命令漏注册 / 注册了不存在的命令
 *   - 前端调用了不存在的命令
 *   - 前端漏传必填参数、传了多余参数、参数名大小写不符
 *
 * 只做静态扫描，不改代码；有错误时退出码 1，可直接挂进 CI。
 *
 * 约定：
 *   - Tauri 命令参数在 JS 侧为 camelCase（Rust snake_case 自动转换）
 *   - Option<T> 视为可选；AppHandle / State<T> / Window 等由框架注入，不计入参数表
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUST_COMMANDS = join(ROOT, "src-tauri", "src", "commands");
const RUST_LIB = join(ROOT, "src-tauri", "src", "lib.rs");
const SRC = join(ROOT, "src");

const errors = [];
const notes = [];

/** 框架注入参数：不来自前端，不参与契约比较 */
const INJECTED_TYPES = [
  "AppHandle",
  "State<",
  "Window",
  "WebviewWindow",
  "Webview",
  "Manager",
  "Resource",
];

function walk(dir, exts) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

function rel(p) {
  return relative(ROOT, p).split(sep).join("/");
}

/** 屏蔽注释（保留长度与换行，便于回填行号）：字符串内容原样保留 */
function maskComments(text) {
  const chars = [...text];
  let i = 0;
  const n = text.length;
  // 状态：code / line / block / single / double / template
  let state = "code";
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (state === "code") {
      if (c === "/" && next === "/") {
        state = "line";
        chars[i] = " ";
        chars[i + 1] = " ";
        i += 2;
        continue;
      }
      if (c === "/" && next === "*") {
        state = "block";
        chars[i] = " ";
        chars[i + 1] = " ";
        i += 2;
        continue;
      }
      if (c === "'") state = "single";
      else if (c === '"') state = "double";
      else if (c === "`") state = "template";
      i++;
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
      } else {
        chars[i] = " ";
      }
      i++;
      continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") {
        chars[i] = " ";
        chars[i + 1] = " ";
        i += 2;
        state = "code";
        continue;
      }
      if (c !== "\n") chars[i] = " ";
      i++;
      continue;
    }
    // 字符串：只关心结束符与转义
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (state === "single" && c === "'") state = "code";
    else if (state === "double" && c === '"') state = "code";
    else if (state === "template" && c === "`") state = "code";
    i++;
  }
  return chars.join("");
}

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * 从 openIdx（指向左括号）出发，返回匹配的右括号下标。
 * rust=true 时只认双引号字符串：`'` 在 Rust 里是生命周期，不是字符串边界。
 */
function matchBracket(text, openIdx, open = "(", close = ")", rust = false) {
  let depth = 0;
  let i = openIdx;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || (!rust && (c === "'" || c === "`"))) {
      const quote = c;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** 顶层逗号切分（尊重括号与字符串；rust=true 时 `'` 不当作字符串） */
function splitTop(text, sep = ",", rust = false) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || (!rust && (c === "'" || c === "`"))) {
      const quote = c;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if ("([{<".includes(c)) depth++;
    else if (")]}>".includes(c)) depth--;
    else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function snakeToCamel(name) {
  return name.replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase());
}

// ---------------------------------------------------------------------------
// Rust 侧：命令定义与注册表
// ---------------------------------------------------------------------------

function parseRustCommands() {
  const commands = new Map();
  const files = walk(RUST_COMMANDS, [".rs"]);
  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    const text = maskComments(raw);
    const at = lineIndex(text);
    const re = /#\[tauri::command(?:\([^)]*\))?\]/g;
    let m;
    while ((m = re.exec(text))) {
      const after = text.slice(m.index + m[0].length);
      const fnMatch = /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(/.exec(after);
      if (!fnMatch) {
        errors.push(`${rel(file)}:${at(m.index)} #[tauri::command] 后未找到 fn 定义`);
        continue;
      }
      const name = fnMatch[1];
      const nameOffset = m.index + m[0].length + fnMatch[0].length - 1;
      const closeIdx = matchBracket(text, nameOffset, "(", ")", true);
      if (closeIdx < 0) {
        errors.push(`${rel(file)}:${at(m.index)} 命令 ${name} 参数列表未闭合`);
        continue;
      }
      const rawParams = text.slice(nameOffset + 1, closeIdx);
      const params = [];
      for (const piece of splitTop(rawParams, ",", true)) {
        const item = piece.trim();
        if (!item) continue;
        const colon = item.indexOf(":");
        if (colon < 0) continue; // self 等
        const pname = item.slice(0, colon).replace(/^mut\s+/, "").trim();
        const ptype = item.slice(colon + 1).replace(/\s+/g, " ").trim();
        if (!/^\w+$/.test(pname)) continue;
        const injected = INJECTED_TYPES.some((t) => ptype.includes(t));
        if (injected) continue;
        const optional = /^Option</.test(ptype);
        params.push({ name: snakeToCamel(pname), required: !optional });
      }
      if (commands.has(name)) {
        errors.push(`${rel(file)}:${at(m.index)} 命令 ${name} 重复定义`);
        continue;
      }
      commands.set(name, { name, params, file: rel(file), line: at(m.index) });
    }
  }
  return commands;
}

function parseRegisteredCommands() {
  const raw = readFileSync(RUST_LIB, "utf8");
  const text = maskComments(raw);
  const start = text.indexOf("generate_handler![");
  if (start < 0) {
    errors.push("lib.rs 未找到 generate_handler![]");
    return new Set();
  }
  const openIdx = text.indexOf("[", start);
  const closeIdx = matchBracket(text, openIdx, "[", "]");
  if (closeIdx < 0) {
    errors.push("lib.rs 的 generate_handler![] 未闭合");
    return new Set();
  }
  const body = text.slice(start, closeIdx);
  const names = new Set();
  for (const piece of splitTop(body.slice(body.indexOf("[") + 1), ",")) {
    const item = piece.trim();
    if (!item) continue;
    const last = item.split("::").pop().trim();
    if (/^\w+$/.test(last)) names.add(last);
  }
  return names;
}

// ---------------------------------------------------------------------------
// 前端侧：invoke("cmd", { ... })
// ---------------------------------------------------------------------------

function skipGeneric(text, i) {
  // i 指向 '<'，返回 '>' 之后的位置
  let depth = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "=" && text[i + 1] === ">") {
      i += 2;
      continue;
    }
    if (c === "<") depth++;
    else if (c === ">") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

function readStringLiteral(text, i) {
  const quote = text[i];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let out = "";
  i++;
  while (i < text.length && text[i] !== quote) {
    if (text[i] === "\\") {
      out += text[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (quote === "`" && text[i] === "$" && text[i + 1] === "{") return null; // 模板插值，跳过
    out += text[i];
    i++;
  }
  return { value: out, end: i + 1 };
}

/** 解析对象字面量的顶层键；返回 { keys, dynamic } */
function readObjectKeys(text, i) {
  // i 指向 '{'
  const closeIdx = matchBracket(text, i, "{", "}");
  if (closeIdx < 0) return null;
  const body = text.slice(i + 1, closeIdx);
  const keys = [];
  let dynamic = false;
  for (const piece of splitTop(body, ",")) {
    const item = piece.trim();
    if (!item) continue;
    if (item.startsWith("...")) {
      dynamic = true;
      continue;
    }
    const m = /^(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([A-Za-z_$][\w$]*))\s*(?::|$)/.exec(item);
    if (!m) {
      dynamic = true;
      continue;
    }
    keys.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
  }
  return { keys, dynamic, end: closeIdx + 1 };
}

function parseFrontendCalls() {
  const calls = [];
  const files = walk(SRC, [".ts"]).filter((f) => !f.endsWith(".d.ts"));
  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    // 只扫描真正引入 Tauri invoke 的文件，避免把同名的私有方法当成命令调用
    if (!/from\s+["']@tauri-apps\/api\/(core|tauri)["']/.test(raw)) continue;
    const text = maskComments(raw);
    const at = lineIndex(text);
    const re = /\binvoke\b/g;
    let m;
    while ((m = re.exec(text))) {
      const prev = text[m.index - 1] ?? "";
      if (/[\w$.]/.test(prev)) continue; // 属性名 / 更长标识符
      let i = m.index + "invoke".length;
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] === "<") {
        const afterGeneric = skipGeneric(text, i);
        if (afterGeneric < 0) {
          notes.push(`${rel(file)}:${at(m.index)} 泛型未闭合，跳过`);
          continue;
        }
        i = afterGeneric;
        while (i < text.length && /\s/.test(text[i])) i++;
      }
      if (text[i] !== "(") continue;
      i++;
      while (i < text.length && /\s/.test(text[i])) i++;
      const lit = readStringLiteral(text, i);
      if (!lit) {
        notes.push(`${rel(file)}:${at(m.index)} 命令名为变量，无法静态校验`);
        continue;
      }
      const line = at(m.index);
      // 插件命令（plugin:xxx|yyy）由 Tauri 插件注册，不在 generate_handler![] 中
      if (lit.value.includes(":") || lit.value.includes("|")) continue;
      let j = lit.end;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] !== ",") {
        calls.push({ command: lit.value, keys: [], dynamic: false, file: rel(file), line });
        continue;
      }
      j++;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] !== "{") {
        calls.push({ command: lit.value, keys: null, dynamic: true, file: rel(file), line });
        continue;
      }
      const obj = readObjectKeys(text, j);
      if (!obj) {
        errors.push(`${rel(file)}:${line} invoke("${lit.value}") 参数对象未闭合`);
        continue;
      }
      calls.push({
        command: lit.value,
        keys: obj.keys,
        dynamic: obj.dynamic,
        file: rel(file),
        line,
      });
    }
  }
  return calls;
}

// ---------------------------------------------------------------------------
// 比较
// ---------------------------------------------------------------------------

function main() {
  const commands = parseRustCommands();
  const registered = parseRegisteredCommands();
  const calls = parseFrontendCalls();

  for (const [name, cmd] of commands) {
    if (!registered.has(name)) {
      errors.push(`${cmd.file}:${cmd.line} 命令 ${name} 未在 lib.rs 的 generate_handler![] 注册`);
    }
  }
  for (const name of registered) {
    if (!commands.has(name)) {
      errors.push(`lib.rs 注册了不存在的命令 ${name}`);
    }
  }

  const calledCommands = new Set();
  for (const call of calls) {
    calledCommands.add(call.command);
    const cmd = commands.get(call.command);
    if (!cmd) {
      errors.push(`${call.file}:${call.line} 前端调用了不存在的命令 ${call.command}`);
      continue;
    }
    if (call.dynamic) {
      notes.push(`${call.file}:${call.line} ${call.command} 参数为变量 / 展开，跳过参数校验`);
      continue;
    }
    const provided = new Set(call.keys);
    for (const p of cmd.params) {
      if (p.required && !provided.has(p.name)) {
        errors.push(
          `${call.file}:${call.line} ${call.command} 缺少必填参数 ${p.name}` +
            `（Rust: ${cmd.file}:${cmd.line}）`,
        );
      }
    }
    const known = new Set(cmd.params.map((p) => p.name));
    for (const key of provided) {
      if (!known.has(key)) {
        const allowed = cmd.params.map((p) => p.name).join(", ") || "（无）";
        errors.push(`${call.file}:${call.line} ${call.command} 多传参数 ${key}（接受：${allowed}）`);
      }
    }
  }

  const unused = [...commands.keys()].filter((n) => !calledCommands.has(n));
  if (unused.length > 0) {
    notes.push(`前端未调用的命令 ${unused.length} 个：${unused.join(", ")}`);
  }

  console.log("IPC 契约校验");
  console.log(
    `  命令定义 ${commands.size} / 已注册 ${registered.size} / 调用点 ${calls.length} / 覆盖命令 ${calledCommands.size}`,
  );
  for (const note of notes) console.log(`  [提示] ${note}`);
  for (const err of errors) console.log(`  [错误] ${err}`);
  console.log(`  错误 ${errors.length}`);
  if (errors.length > 0) process.exitCode = 1;
}

main();
