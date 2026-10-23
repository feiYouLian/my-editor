/**
 * 设置中心 ▸ 快捷键页：命令键位列表、过滤、重绑定录制、冲突检测、
 * 单项/全部恢复默认。
 *
 * 列编辑器键（edit.columnEditor）特殊：它走 editorEnhancements.columnEditorKey
 * 而非 keybindings 覆盖段，因此保存路径与「是否被改绑」的判定都单独处理。
 */

import { getConfig } from "../config/settings";
import { confirmAction } from "../ui/dialogs";
import {
  eventKeyName,
  eventToKeyNotation,
  findKeyConflict,
  formatKey,
  isOverridden,
  isReservedKey,
  keyCommands,
  normalizeNotation,
  resolveKey,
  setKeyOverride,
  suspendKeyDispatch,
  type KeyCommand,
} from "../config/keybindings";
import {
  DEFAULT_COLUMN_EDITOR_KEY,
  editorEnhancements,
  saveSettings,
  type SettingsTabContext,
} from "./shared";

export function renderKeybindings(main: HTMLElement, ctx: SettingsTabContext): void {
  const head = document.createElement("div");
  head.className = "settings-kb-head";
  const filter = document.createElement("input");
  filter.type = "text";
  filter.className = "settings-kb-filter";
  filter.placeholder = "过滤命令…";
  head.append(filter);
  const resetAll = document.createElement("button");
  resetAll.type = "button";
  resetAll.textContent = "全部恢复默认";
  resetAll.addEventListener("click", () => {
    void confirmAction("确定要将所有快捷键恢复为默认值吗？自定义绑定将丢失。", "恢复默认").then(
      (ok) => {
        if (!ok) return;
        saveSettings({
          keybindings: [],
          // 列编辑器键走 editorEnhancements，一并复位
          editorEnhancements: {
            ...editorEnhancements(),
            columnEditorKey: DEFAULT_COLUMN_EDITOR_KEY,
          },
        });
        ctx.rerender();
        ctx.callbacks.onMessage("快捷键已全部恢复默认");
      },
    );
  });
  head.append(resetAll);
  main.append(head);

  const list = document.createElement("div");
  list.className = "settings-kb-list";
  main.append(list);

  const renderList = (query: string): void => {
    list.innerHTML = "";
    const q = query.trim().toLowerCase();
    const groups = new Map<string, KeyCommand[]>();
    for (const cmd of keyCommands()) {
      if (q && !cmd.title.toLowerCase().includes(q) && !cmd.id.includes(q)) continue;
      const arr = groups.get(cmd.section) ?? [];
      arr.push(cmd);
      groups.set(cmd.section, arr);
    }
    if (groups.size === 0) {
      const empty = document.createElement("div");
      empty.className = "settings-kb-empty";
      empty.textContent = "无匹配命令";
      list.append(empty);
      return;
    }
    for (const [sectionName, cmds] of groups) {
      const groupEl = document.createElement("div");
      groupEl.className = "settings-kb-group";
      const title = document.createElement("div");
      title.className = "settings-kb-group-title";
      title.textContent = sectionName;
      groupEl.append(title);
      for (const cmd of cmds) {
        groupEl.append(renderKeyRow(cmd, ctx));
      }
      list.append(groupEl);
    }
  };

  filter.addEventListener("input", () => renderList(filter.value));
  renderList("");
}

function renderKeyRow(cmd: KeyCommand, ctx: SettingsTabContext): HTMLElement {
  const cfg = getConfig();
  const row = document.createElement("div");
  row.className = "settings-kb-row";

  const name = document.createElement("span");
  name.className = "settings-kb-name";
  name.textContent = cmd.title;
  row.append(name);

  const keyCell = document.createElement(cmd.fixed ? "span" : "button");
  keyCell.className = "settings-kb-key";
  if (cmd.fixed) {
    // 列编辑器键特殊：走 editorEnhancements.columnEditorKey 重绑
    if (cmd.id === "edit.columnEditor") {
      keyCell.textContent = formatKey(
        normalizeNotation(cfg.editorEnhancements.columnEditorKey),
      );
    } else {
      keyCell.textContent = formatKey(cmd.defaultKey);
    }
    const badge = document.createElement("span");
    badge.className = "settings-kb-badge";
    badge.textContent = cmd.id === "edit.columnEditor" ? "可改绑" : "内置";
    keyCell.append(badge);
  } else {
    keyCell.textContent = formatKey(resolveKey(cmd, cfg));
    keyCell.title = "点击重绑定（Esc 清除绑定）";
    keyCell.addEventListener("click", () => {
      recordKey(cmd, keyCell as HTMLElement, ctx);
    });
  }
  row.append(keyCell);

  const action = document.createElement("span");
  action.className = "settings-kb-action";
  const special = cmd.id === "edit.columnEditor";
  const overridden = special
    ? cfg.editorEnhancements.columnEditorKey !== DEFAULT_COLUMN_EDITOR_KEY
    : isOverridden(cmd, cfg);
  if (overridden) {
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "settings-kb-reset";
    reset.textContent = "恢复默认";
    reset.addEventListener("click", () => {
      if (special) {
        saveSettings({
          editorEnhancements: {
            ...editorEnhancements(),
            columnEditorKey: DEFAULT_COLUMN_EDITOR_KEY,
          },
        });
      } else {
        saveSettings({ keybindings: setKeyOverride(cfg, cmd.id, "") });
      }
      ctx.rerender();
    });
    action.append(reset);
  } else if (!cmd.fixed) {
    const hint = document.createElement("span");
    hint.className = "settings-kb-default-hint";
    hint.textContent = resolveKey(cmd, cfg) ? "默认" : "未绑定";
    action.append(hint);
  }
  row.append(action);
  return row;
}

/** 录制新键位：挂起全局派发 → 捕获一次组合键 → 冲突检测 → 写回 */
function recordKey(cmd: KeyCommand, cell: HTMLElement, ctx: SettingsTabContext): void {
  // 先取消上一段录制：否则它的 keydown 监听会残留，与本次录制双响应
  ctx.getStopRecording()?.();
  const original = cell.textContent;
  cell.textContent = "按下新键位…（Esc 清除）";
  cell.classList.add("recording");
  suspendKeyDispatch(true);

  const finish = (): void => {
    window.removeEventListener("keydown", onKey, true);
    suspendKeyDispatch(false);
    cell.classList.remove("recording");
    ctx.setStopRecording(null);
  };

  const onKey = (e: KeyboardEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    // 纯修饰键：继续等待完整组合
    if (!eventKeyName(e)) return;
    // Esc 无修饰：清除绑定
    if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      finish();
      if (cmd.id === "edit.columnEditor") {
        saveSettings({
          editorEnhancements: {
            ...editorEnhancements(),
            columnEditorKey: DEFAULT_COLUMN_EDITOR_KEY,
          },
        });
      } else {
        saveSettings({ keybindings: setKeyOverride(getConfig(), cmd.id, "") });
      }
      ctx.rerender();
      ctx.callbacks.onMessage(`「${cmd.title}」绑定已清除`);
      return;
    }
    const notation = eventToKeyNotation(e);
    if (!notation) return;
    finish();

    if (isReservedKey(notation, getConfig())) {
      ctx.callbacks.onMessage(`${formatKey(notation)} 被编辑器/系统占用，无法绑定`);
      cell.textContent = original;
      return;
    }
    const conflict = findKeyConflict(notation, getConfig(), cmd.id);
    const apply = (): void => {
      if (cmd.id === "edit.columnEditor") {
        // 记法 → CM6 keymap 记法（字母主键小写）
        const parts = notation.split("-");
        const key = parts.pop()!;
        const cm6Key = /^[A-Z]$/.test(key) ? key.toLowerCase() : key;
        saveSettings({
          editorEnhancements: {
            ...editorEnhancements(),
            columnEditorKey: [...parts, cm6Key].join("-"),
          },
        });
      } else {
        saveSettings({ keybindings: setKeyOverride(getConfig(), cmd.id, notation) });
      }
      ctx.rerender();
      ctx.callbacks.onMessage(`「${cmd.title}」已绑定到 ${formatKey(notation)}`);
    };
    if (conflict) {
      void confirmAction(
        `${formatKey(notation)} 已绑定到「${conflict.title}」，确定改绑到「${cmd.title}」吗？`,
        "改绑",
      ).then((ok) => {
        if (ok) apply();
        else ctx.rerender();
      });
    } else {
      apply();
    }
  };

  ctx.setStopRecording(finish);
  window.addEventListener("keydown", onKey, true);
  cell.focus();
}
