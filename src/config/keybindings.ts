/**
 * 快捷键分发与用户覆盖：命令注册表由 core/commands.ts 统一持有
 * （菜单栏 / 命令面板 / 快捷键 / 设置中心同源），本模块负责
 * 键位解析（core/keyNotation.ts）、覆盖存储、冲突检测与匹配分发。
 *
 * - 解析：config.json 的 keybindings 覆盖默认键（用户自定义优先）
 * - 派发：单一 window 捕获阶段分发器（main.ts 挂载），替代原硬编码 if-else
 * - 固定绑定（CM6 内置，如撤销/注释/书签）仅展示不可重绑，走 fixed 标记
 */

import type { AppConfig } from "./settings";
import {
  bindableCommands,
  type BindableCommand,
  type CommandDef,
} from "../core/commands";
import { normalizeNotation, notationMatches } from "../core/keyNotation";

// 记法工具由使用方按需从 core/keyNotation 导入；此处转发以保持既有导入路径可用
export {
  eventToKeyNotation,
  eventKeyName,
  formatKey,
  normalizeNotation,
  notationMatches,
  parseNotation,
  splitNotation,
  type ParsedKey,
} from "../core/keyNotation";

/** 键位命令视图（CommandDef 的键位相关子集，兼容既有调用方） */
export type KeyCommand = BindableCommand;

/** 参与快捷键体系的命令（设置中心键位页 / 冲突检测 / 分发用） */
export function keyCommands(): readonly KeyCommand[] {
  return bindableCommands();
}

/** 用户自定义覆盖优先于默认键 */
export function resolveKey(cmd: CommandDef, cfg: AppConfig): string {
  const override = cfg.keybindings.find((k) => k.command === cmd.id);
  return override?.key ?? cmd.defaultKey ?? "";
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
// 保留键与派发
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
  // 注意：Mod-Shift-L 不在此列——它被特意借用为「格式化文档」的备用键
  // （中文 Windows 下 Alt+Shift 常被输入法吞掉），加入保留集会令其失效。
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
 * 保留键（剪贴板 / 撤销 / CM6 内置）即使被手改配置占用也不派发，
 * 否则会连 preventDefault 一起吞掉系统行为。
 */
export function matchKeyCommand(e: KeyboardEvent, cfg: AppConfig): KeyCommand | null {
  if (suspended) return null;
  const target = e.target as HTMLElement | null;
  if (target) {
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return null;
  }
  for (const cmd of keyCommands()) {
    if (cmd.fixed) continue;
    const keys = [resolveKey(cmd, cfg), ...(cmd.altKeys ?? [])];
    if (
      keys.some((k) => {
        if (!k) return false;
        const notation = normalizeNotation(k);
        // 保留键优先：设置面板只在校验时用它，分发器这里同样要放过
        if (isReservedKey(notation, cfg)) return false;
        return notationMatches(notation, e);
      })
    ) {
      return cmd;
    }
  }
  return null;
}

/** 查找占用某键位的命令 id（冲突检测用，含固定命令与别名） */
export function findKeyConflict(
  notation: string,
  cfg: AppConfig,
  excludeId?: string,
): KeyCommand | null {
  for (const cmd of keyCommands()) {
    if (cmd.id === excludeId) continue;
    const keys = [resolveKey(cmd, cfg), ...(cmd.altKeys ?? [])];
    if (keys.some((k) => k && normalizeNotation(k) === notation)) return cmd;
  }
  return null;
}
