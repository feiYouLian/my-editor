/**
 * 快捷键注册中心（设置中心 B7，见设计文档 15.3）。
 *
 * - 命令注册表：各模块注册 CommandItem 式的键位命令（id / 标题 / 分组 / 默认键 / run）
 * - 解析：config.json 的 keybindings 覆盖默认键（用户自定义优先）
 * - 派发：单一 window 捕获阶段分发器（main.ts 挂载），替代原硬编码 if-else
 * - 录制：eventToKeyNotation 将 KeyboardEvent 归一为内部记法 "Mod-Shift-P" / "Alt-C"
 * - 固定绑定（CM6 内置，如撤销/注释/书签）仅展示不可重绑，走 fixed 标记
 *
 * 记法规范：部件顺序 Mod → Alt → Shift → 主键，"-" 连接；
 * 主键取 e.code 归一值（KeyA→A、Comma→,、ArrowUp→Up、F2→F2）。
 */

import type { AppConfig } from "./settings";

export interface KeyCommand {
  id: string;
  title: string;
  section: string;
  /** 默认键位（"" = 未绑定） */
  defaultKey: string;
  /** 固定别名（不可改；如中文 Windows 下 Alt+Shift 被输入法吞掉时的备用键） */
  altKeys?: string[];
  /** 编辑器内置（CM6）绑定：仅展示，不可重绑定 */
  fixed?: boolean;
  run: () => void;
}

const commands: KeyCommand[] = [];

export function registerKeyCommands(cmds: KeyCommand[]): void {
  for (const cmd of cmds) {
    const i = commands.findIndex((c) => c.id === cmd.id);
    if (i >= 0) commands[i] = cmd;
    else commands.push(cmd);
  }
}

export function keyCommands(): readonly KeyCommand[] {
  return commands;
}

// ---------------------------------------------------------------------------
// 键位解析
// ---------------------------------------------------------------------------

/** 用户自定义覆盖优先于默认键 */
export function resolveKey(cmd: KeyCommand, cfg: AppConfig): string {
  const override = cfg.keybindings.find((k) => k.command === cmd.id);
  return override?.key ?? cmd.defaultKey;
}

/** 命令当前是否被用户改绑过 */
export function isOverridden(cmd: KeyCommand, cfg: AppConfig): boolean {
  return cfg.keybindings.some((k) => k.command === cmd.id);
}

/** 写入/清除某个命令的键位（返回新 keybindings 数组） */
export function setKeyOverride(
  cfg: AppConfig,
  commandId: string,
  key: string,
): AppConfig["keybindings"] {
  const rest = cfg.keybindings.filter((k) => k.command !== commandId);
  return key ? [...rest, { command: commandId, key }] : rest;
}

// ---------------------------------------------------------------------------
// 记法 ↔ KeyboardEvent
// ---------------------------------------------------------------------------

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

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

export interface ParsedKey {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

/** 拆分记法为「修饰部 + 主键」；主键可能是 "-"（减号），需特殊处理 */
function splitNotation(notation: string): { mods: string[]; key: string } | null {
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
 * 内部存储、比较、录制输出一律用归一化形式。
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

// ---------------------------------------------------------------------------
// 派发
// ---------------------------------------------------------------------------

/**
 * 保留键位：CM6 内置或系统剪贴板行为，全局分发器不得抢占。
 * 列编辑器键（editorEnhancements.columnEditorKey）由调用方动态加入。
 */
const RESERVED_KEYS = new Set([
  "Mod-Z",
  "Mod-Shift-Z",
  "Mod-Y",
  "Mod-A",
  "Mod-C",
  "Mod-V",
  "Mod-X",
  "Mod-/",
  "Mod-G",
  "Mod-Alt-G",
  "Mod-Shift-L", // CM6 selectSelectionMatches（当前借道为格式化备用键）
  "Alt-Up",
  "Alt-Down",
  "F3",
  "Shift-F3",
  "Ctrl-F2",
  "F2",
  "Shift-F2",
]);

/** 额外保留键（列编辑器当前键位等，由 UI 层注入；自动归一化） */
let extraReserved: string[] = [];

export function setExtraReservedKeys(keys: string[]): void {
  extraReserved = keys.filter(Boolean).map(normalizeNotation);
}

export function isReservedKey(notation: string, _cfg: AppConfig): boolean {
  if (RESERVED_KEYS.has(notation)) return true;
  return extraReserved.includes(notation);
}

/** 录制期间挂起分发（避免录到快捷键本身） */
let suspended = false;

export function suspendKeyDispatch(v: boolean): void {
  suspended = v;
}

/**
 * 全局派发：捕获阶段匹配可重绑命令。
 * 表单输入框内不派发（避免录制/搜索框输入触发快捷键）；
 * CM6 编辑器为 contenteditable div，不在此列，保持既有行为。
 */
export function matchKeyCommand(e: KeyboardEvent, cfg: AppConfig): KeyCommand | null {
  if (suspended) return null;
  const target = e.target as HTMLElement | null;
  if (target) {
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return null;
  }
  for (const cmd of commands) {
    if (cmd.fixed) continue;
    const keys = [resolveKey(cmd, cfg), ...(cmd.altKeys ?? [])];
    if (keys.some((k) => k && notationMatches(normalizeNotation(k), e))) return cmd;
  }
  return null;
}

/** 查找占用某键位的命令 id（冲突检测用，含固定命令与别名） */
export function findKeyConflict(
  notation: string,
  cfg: AppConfig,
  excludeId?: string,
): KeyCommand | null {
  for (const cmd of commands) {
    if (cmd.id === excludeId) continue;
    const keys = [resolveKey(cmd, cfg), ...(cmd.altKeys ?? [])];
    if (keys.some((k) => k && normalizeNotation(k) === notation)) return cmd;
  }
  return null;
}
