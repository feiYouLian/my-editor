/**
 * 键位记法：解析、归一化、事件匹配与展示（零依赖）。
 *
 * 记法规范：部件顺序 Mod → Alt → Shift → 主键，"-" 连接；
 * 主键取 e.code 归一值（KeyA→A、Comma→,、ArrowUp→Up、F2→F2）。
 * 内部存储、比较、录制输出一律用归一化形式。
 *
 * 本模块从 config/keybindings.ts 下沉（Phase 1），使 core/commands.ts
 * 可以在不违反依赖方向的前提下复用展示格式化。
 */

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export interface ParsedKey {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

/** e.code → 记法主键；纯修饰键返回 null（等待完整组合） */
export function eventKeyName(e: KeyboardEvent): string | null {
  const code = e.code;
  if (!code) return e.key && e.key.length === 1 ? e.key.toUpperCase() : null;
  let m: RegExpMatchArray | null;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit([0-9])$/.exec(code))) return m[1];
  if ((m = /^Numpad([0-9])$/.exec(code))) return m[1];
  if ((m = /^F([1-9]|1[0-2])$/.exec(code))) return `F${m[1]}`;
  switch (code) {
    case "ArrowUp": return "Up";
    case "ArrowDown": return "Down";
    case "ArrowLeft": return "Left";
    case "ArrowRight": return "Right";
    case "PageUp": return "PageUp";
    case "PageDown": return "PageDown";
    case "Home": return "Home";
    case "End": return "End";
    case "Tab": return "Tab";
    case "Escape": return "Escape";
    case "Enter": return "Enter";
    case "NumpadEnter": return "Enter";
    case "Backspace": return "Backspace";
    case "Delete": return "Delete";
    case "Insert": return "Insert";
    case "Space": return "Space";
    case "Comma": return ",";
    case "Period": return ".";
    case "Slash": return "/";
    case "Semicolon": return ";";
    case "Equal": return "=";
    case "Minus": return "-";
    case "BracketLeft": return "[";
    case "BracketRight": return "]";
    case "Backslash": return "\\";
    case "Quote": return "'";
    case "Backquote": return "`";
    default:
      return null;
  }
}

/** 拆分记法为「修饰部 + 主键」；主键可能是 "-"（减号），需特殊处理 */
export function splitNotation(notation: string): { mods: string[]; key: string } | null {
  if (notation === "-") return { mods: [], key: "-" };
  if (notation.endsWith("--")) return { mods: notation.slice(0, -2).split("-"), key: "-" };
  const idx = notation.lastIndexOf("-");
  if (idx < 0) return { mods: [], key: notation };
  const key = notation.slice(idx + 1);
  if (!key) return null;
  return { mods: notation.slice(0, idx).split("-"), key };
}

/** 解析记法；非法返回 null */
export function parseNotation(notation: string): ParsedKey | null {
  const split = splitNotation(notation);
  if (!split) return null;
  const parsed: ParsedKey = { mod: false, alt: false, shift: false, key: split.key };
  for (const p of split.mods) {
    if (p === "Mod" || p === "Ctrl" || p === "Cmd" || p === "Meta") parsed.mod = true;
    else if (p === "Alt" || p === "Option") parsed.alt = true;
    else if (p === "Shift") parsed.shift = true;
    else return null;
  }
  return parsed;
}

/**
 * 归一化记法：主键统一大写（CM6 keymap 记法字母主键为小写，如 "Alt-c" → "Alt-C"）。
 */
export function normalizeNotation(notation: string): string {
  if (notation === "-" || notation.endsWith("--")) return notation;
  const split = splitNotation(notation);
  if (!split) return notation;
  const norm = /^[a-z]$/.test(split.key) ? split.key.toUpperCase() : split.key;
  return [...split.mods, norm].join("-");
}

/** KeyboardEvent → 记法（纯修饰键返回 null） */
export function eventToKeyNotation(e: KeyboardEvent): string | null {
  const key = eventKeyName(e);
  if (!key) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Mod");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("-");
}

/** 记法是否命中当前事件 */
export function notationMatches(notation: string, e: KeyboardEvent): boolean {
  const parsed = parseNotation(notation);
  if (!parsed) return false;
  const key = eventKeyName(e);
  if (!key || key !== parsed.key) return false;
  return (
    (e.ctrlKey || e.metaKey) === parsed.mod &&
    e.altKey === parsed.alt &&
    e.shiftKey === parsed.shift
  );
}

/** 记法 → 展示（Mod → Ctrl / ⌘） */
export function formatKey(notation: string): string {
  if (!notation) return "未绑定";
  const split = splitNotation(notation);
  if (!split) return notation;
  const mods = split.mods.map((p) => {
    if (p === "Mod") return IS_MAC ? "⌘" : "Ctrl";
    if (p === "Alt") return IS_MAC ? "⌥" : "Alt";
    if (p === "Shift") return IS_MAC ? "⇧" : "Shift";
    return p;
  });
  return [...mods, split.key].join("+");
}
