/**
 * 状态栏：字段刷新、主题切换、字段显隐、分栏比例、瞬时消息，
 * 以及空白字符 / 自动换行两个持久化开关。
 *
 * DOM 元素由调用方（main.ts 装配层）查询后传入，本模块只做渲染与
 * 交互逻辑，不 import main.ts（依赖方向 ui → store/config/core）。
 * 跨模块协作（运行按钮、编辑器开关、语言文案）经 deps 回调注入。
 */

import {
  getConfig,
  updateSettings,
  type AppConfig,
  type StatusBarFieldEntry,
} from "../config/settings";
import { formatSize } from "../core/format";
import type { Tab } from "../store/tabs";

export interface StatusBarElements {
  path: HTMLSpanElement;
  size: HTMLSpanElement;
  encoding: HTMLSpanElement;
  newline: HTMLSpanElement;
  language: HTMLSpanElement;
  cursor: HTMLSpanElement;
  lines: HTMLSpanElement;
  dirty: HTMLSpanElement;
  message: HTMLSpanElement;
  whitespace: HTMLSpanElement;
  wrap: HTMLSpanElement;
  readonly: HTMLSpanElement;
  draft: HTMLSpanElement;
  external: HTMLSpanElement;
}

export interface StatusBarDeps {
  /** 当前激活标签 */
  getActiveTab: () => Tab | null;
  /** 语言展示文案（含「（手动）」标注；领域逻辑在 main.ts） */
  languageLabel: (tab: Tab) => string;
  /** 编辑器空白字符是否显示中 */
  isWhitespaceOn: () => boolean;
  /** 编辑器切换空白字符 */
  toggleWhitespace: () => void;
  /** 编辑器设置自动换行 */
  setWordWrap: (on: boolean) => void;
}

export interface StatusBar {
  refresh(): void;
  /** 瞬时消息；durationMs 默认 3000，错误类提示可传更长停留时间 */
  showMessage(text: string, durationMs?: number): void;
  refreshWhitespace(): void;
  refreshWordWrap(): void;
  toggleWhitespace(): void;
  toggleWordWrap(): void;
  applyTheme(cfg: AppConfig): void;
  applyFields(fields: StatusBarFieldEntry[]): void;
  setSplitRatio(ratio: number): void;
  persistConfig(patch: Partial<AppConfig>): void;
}

export function createStatusBar(
  elements: StatusBarElements,
  deps: StatusBarDeps,
): StatusBar {
  // 分栏容器在此查询而非由调用方传入：main.ts 中该元素的声明晚于
  // 状态栏装配点，传入会引入初始化顺序约束
  const splitArea = document.querySelector<HTMLElement>(".editor-area");
  const systemDarkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  let messageTimer: ReturnType<typeof setTimeout> | null = null;
  let configSaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** 待写入的配置补丁：300ms 内的多次调用合并，不能只保留最后一次
   *  （否则连续切换空白字符 + 自动换行时，前一个改动会在写盘前被覆盖掉） */
  let pendingPatch: Partial<AppConfig> = {};
  /** 自动换行同步镜像：配置落库有 300ms 防抖，窗口内防连点互相抵消 */
  let wordWrapOn = getConfig().editorEnhancements.wordWrap;

  function refreshWhitespace(): void {
    const on = deps.isWhitespaceOn();
    elements.whitespace.textContent = `空白: ${on ? "显" : "隐"}`;
    elements.whitespace.classList.toggle("on", on);
  }

  function refreshWordWrap(): void {
    // 读同步镜像而非配置：配置落库有 300ms 防抖，窗口内还是旧值
    elements.wrap.textContent = `换行: ${wordWrapOn ? "开" : "关"}`;
    elements.wrap.classList.toggle("on", wordWrapOn);
  }

  function refresh(): void {
    const tab = deps.getActiveTab();
    elements.path.textContent = tab ? tab.name : "未打开文件";
    elements.path.title = tab?.path ?? "";
    elements.size.textContent = tab ? formatSize(tab.size) : "—";
    elements.encoding.textContent = tab
      ? `${tab.encoding}${tab.mojibakeReason ? " ⚠" : ""}`
      : "UTF-8";
    elements.encoding.title = tab?.mojibakeReason
      ? `${tab.mojibakeReason}（点击切换编码）`
      : "点击切换编码（重新打开为…）";
    elements.newline.textContent = tab ? tab.newline : "—";
    elements.language.textContent = tab ? deps.languageLabel(tab) : "纯文本";
    elements.dirty.classList.toggle("hidden", !tab?.dirty);
    elements.external.classList.toggle("hidden", tab?.externallyChanged !== true);
    elements.readonly.classList.toggle("hidden", tab?.readonly !== true);
    elements.readonly.title = tab?.readonly ? tab.readonlyReason : "";
    refreshWhitespace();
    refreshWordWrap();
  }

  /** 状态栏瞬时消息（格式化结果等，默认 3 秒后淡出） */
  function showMessage(text: string, durationMs = 3000): void {
    elements.message.textContent = text;
    elements.message.classList.remove("hidden");
    if (messageTimer) clearTimeout(messageTimer);
    messageTimer = setTimeout(() => elements.message.classList.add("hidden"), durationMs);
  }

  /** 合并两层配置补丁：嵌套对象（layout / editorEnhancements 等）逐层合并 */
  function mergePatch(
    base: Partial<AppConfig>,
    patch: Partial<AppConfig>,
  ): Partial<AppConfig> {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      const prev = out[key];
      const plain = (v: unknown): v is Record<string, unknown> =>
        typeof v === "object" && v !== null && !Array.isArray(v);
      out[key] = plain(prev) && plain(value) ? { ...prev, ...value } : value;
    }
    return out as Partial<AppConfig>;
  }

  /** 防抖写回 config.json（界面开关与配置文件保持联动） */
  function persistConfig(patch: Partial<AppConfig>): void {
    pendingPatch = mergePatch(pendingPatch, patch);
    if (configSaveTimer) clearTimeout(configSaveTimer);
    configSaveTimer = setTimeout(() => {
      configSaveTimer = null;
      const merged = pendingPatch;
      pendingPatch = {};
      void updateSettings(merged).catch((e) => console.warn("[config] 写回失败", e));
    }, 300);
  }

  function toggleWhitespace(): void {
    deps.toggleWhitespace();
    refreshWhitespace();
    persistConfig({
      editorEnhancements: {
        ...getConfig().editorEnhancements,
        showWhitespace: deps.isWhitespaceOn(),
      },
    });
  }

  function toggleWordWrap(): void {
    const next = !wordWrapOn;
    wordWrapOn = next;
    deps.setWordWrap(next);
    persistConfig({
      editorEnhancements: { ...getConfig().editorEnhancements, wordWrap: next },
    });
    refreshWordWrap();
    showMessage(`自动换行已${next ? "开启" : "关闭"}`);
  }

  function resolveAppTheme(theme: AppConfig["theme"]): "dark" | "light" | "high-contrast" {
    if (theme === "system") return systemDarkQuery.matches ? "dark" : "light";
    return theme;
  }

  function applyTheme(cfg: AppConfig): void {
    document.documentElement.dataset.theme = resolveAppTheme(cfg.theme);
  }

  // system 主题跟随系统偏好（仅配置为 system 时响应）
  systemDarkQuery.addEventListener("change", () => {
    if (getConfig().theme === "system") applyTheme(getConfig());
  });

  /** 状态栏字段显隐（数组顺序即展示顺序） */
  function applyFields(fields: StatusBarFieldEntry[]): void {
    const visible = new Map(fields.map((f) => [f.id, f.visible]));
    document.querySelectorAll<HTMLElement>(".statusbar [data-field]").forEach((el) => {
      const on = visible.get(el.dataset.field ?? "") ?? true;
      el.classList.toggle("field-hidden", !on);
      const next = el.nextElementSibling;
      if (next?.classList.contains("status-sep")) next.classList.toggle("field-hidden", !on);
    });
  }

  /** 应用分栏比例（设置中心滑杆 / 配置默认值共用） */
  function setSplitRatio(ratio: number): void {
    if (!splitArea) return;
    const clamped = Math.min(0.85, Math.max(0.15, ratio));
    splitArea.style.setProperty("--split-ratio", `${(clamped * 100).toFixed(1)}%`);
    try {
      localStorage.setItem("my-editor.splitRatio", String(clamped));
    } catch {
      // localStorage 不可用时仅会话内生效
    }
  }

  return {
    refresh,
    showMessage,
    refreshWhitespace,
    refreshWordWrap,
    toggleWhitespace,
    toggleWordWrap,
    applyTheme,
    applyFields,
    setSplitRatio,
    persistConfig,
  };
}
