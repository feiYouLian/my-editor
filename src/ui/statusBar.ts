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
import { recordMessage } from "../core/messageLog";
import type { Tab } from "../store/tabs";

/** 图片标签下无意义的字段（只读二进制：无行列 / 编码 / 换行 / 语言 / 开关 / 脏标记） */
const IMAGE_IRRELEVANT_FIELDS = new Set([
  "cursor",
  "lines",
  "encoding",
  "newline",
  "language",
  "indent",
  "whitespace",
  "wrap",
  "dirty",
]);

export interface StatusBarElements {
  path: HTMLSpanElement;
  size: HTMLSpanElement;
  encoding: HTMLSpanElement;
  newline: HTMLSpanElement;
  language: HTMLSpanElement;
  cursor: HTMLSpanElement;
  lines: HTMLSpanElement;
  /** 图片标签的自然尺寸（图片模式下替代行列） */
  imageSize: HTMLSpanElement;
  dirty: HTMLSpanElement;
  /** 常驻错误（保存失败等）：不随 3 秒消息消失，直到显式清除 */
  error: HTMLSpanElement;
  /** 长任务进行中指示（旋转点 + 文案） */
  busy: HTMLSpanElement;
  message: HTMLSpanElement;
  /** 当前文档缩进（空格 N / Tab） */
  indent: HTMLSpanElement;
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
  /** 当前文档缩进文案（"空格:4" / "Tab" / "—"） */
  indentLabel: () => string;
  /** 编辑器空白字符是否显示中 */
  isWhitespaceOn: () => boolean;
  /** 编辑器切换空白字符 */
  toggleWhitespace: () => void;
  /** 编辑器设置自动换行 */
  setWordWrap: (on: boolean) => void;
  /** 点状态栏消息时打开「最近消息」（未注入则不绑定点击） */
  onShowMessageHistory?: () => void;
}

export interface StatusBar {
  refresh(): void;
  /** 图片查看器回报自然尺寸（宽 × 高），仅激活标签的回报会被采纳 */
  setImageSize(tabId: string, width: number, height: number): void;
  /** 瞬时消息；durationMs 默认 3000，错误类提示可传更长停留时间 */
  showMessage(text: string, durationMs?: number): void;
  /** 常驻错误条：一直显示到 clearStickyError()，用于"保存失败"等不能错过的失败 */
  showStickyError(text: string): void;
  clearStickyError(): void;
  /** 长任务进行中：可嵌套（计数归零才隐藏），纯 CSS 动画 */
  showBusy(text: string): void;
  hideBusy(): void;
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
  /** 用户配置的字段显隐（设置中心），未配置的字段默认显示 */
  let configuredFields = new Map<string, boolean>();
  /** 上次按标签类型应用显隐时的模式；refresh 在内容帧上高频触发，值未变时跳过重排 */
  let appliedImageMode: boolean | null = null;
  /** 当前激活图片标签的自然尺寸：只留一条，切换标签即失效（同一标签重进免重算） */
  let imageSize: { tabId: string; width: number; height: number } | null = null;

  // 消息本身可点：显示期间点它打开「最近消息」，消失后也能从命令面板进
  if (deps.onShowMessageHistory) {
    elements.message.style.cursor = "pointer";
    elements.message.addEventListener("click", () => deps.onShowMessageHistory?.());
  }

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

  /** 图片尺寸文案：仅激活标签已回报尺寸时可用，否则显示占位 */
  function refreshImageSize(tab: Tab | null): void {
    const known = tab && imageSize?.tabId === tab.id ? imageSize : null;
    elements.imageSize.textContent = known ? `${known.width} × ${known.height}` : "—";
  }

  function setImageSize(tabId: string, width: number, height: number): void {
    // 后台标签解码完成的结果丢弃：切回该标签时查看器会重新触发一次 load
    if (deps.getActiveTab()?.id !== tabId) return;
    imageSize = { tabId, width, height };
    refreshImageSize(deps.getActiveTab());
  }

  /** 单个字段显隐，连带其后紧邻的分隔符 */
  function setFieldHidden(el: HTMLElement, hidden: boolean): void {
    el.classList.toggle("field-hidden", hidden);
    const next = el.nextElementSibling;
    if (next?.classList.contains("status-sep")) next.classList.toggle("field-hidden", hidden);
  }

  /**
   * 字段显隐 = 用户配置 ∪ 标签类型：
   * 图片是只读二进制，没有行列、编码、换行、语言这些概念，也没有可编辑的
   * 空白字符 / 自动换行开关——这些字段在图片标签下全部隐藏，空出的位置
   * 让路径 / 只读 / 文件大小 / 图片尺寸一目了然（窄窗口也不会把大小挤没）。
   * imageSize 不参与设置中心的可配置字段，只随标签类型出现。
   */
  function applyFieldVisibility(force = false): void {
    const image = deps.getActiveTab()?.kind === "image";
    if (!force && image === appliedImageMode) return;
    appliedImageMode = image;
    document.querySelectorAll<HTMLElement>(".statusbar [data-field]").forEach((el) => {
      const id = el.dataset.field ?? "";
      let visible = configuredFields.get(id) ?? true;
      if (id === "imageSize") visible = image;
      else if (image && IMAGE_IRRELEVANT_FIELDS.has(id)) visible = false;
      setFieldHidden(el, !visible);
    });
  }

  function refresh(): void {
    const tab = deps.getActiveTab();
    applyFieldVisibility();
    refreshImageSize(tab);
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
    // 虚拟视图（大文件 / 日志）没有光标回调，行数只能由标签里的总行数渲染
    if (tab?.virtual && typeof tab.totalLines === "number") {
      elements.lines.textContent = `共 ${tab.totalLines} 行`;
    }
    elements.language.textContent = tab ? deps.languageLabel(tab) : "纯文本";
    elements.indent.textContent = tab ? deps.indentLabel() : "—";
    elements.dirty.classList.toggle("hidden", !tab?.dirty);
    elements.external.classList.toggle("hidden", tab?.externallyChanged !== true);
    elements.readonly.classList.toggle("hidden", tab?.readonly !== true);
    if (tab?.readonly) {
      // 只写"只读"等于没说：把原因压在字段里，不必 hover 才知道为什么不能编辑
      const reason = (tab.readonlyReason ?? "").trim();
      const short = reason.length > 12 ? `${reason.slice(0, 12)}…` : reason;
      elements.readonly.textContent = short ? `只读 · ${short}` : "只读";
      elements.readonly.title = reason;
    } else {
      elements.readonly.textContent = "只读";
      elements.readonly.title = "";
    }
    refreshWhitespace();
    refreshWordWrap();
  }

  /** 状态栏瞬时消息（格式化结果等，默认 3 秒后淡出） */
  /** 同一显示窗口内叠加了多少条消息：用于"（+N）"提示，避免关键信息被后一条吞掉 */
  let messageCount = 0;

  function showMessage(text: string, durationMs = 3000): void {
    // 先记一条历史：这条消息 3 秒后就在界面上消失了，但「刚才说了什么」
    // 还能从通知面板的「最近消息」里翻回来（存 core/messageLog，不落盘）
    recordMessage(text);
    const visible = !elements.message.classList.contains("hidden");
    messageCount = visible ? messageCount + 1 : 0;
    elements.message.textContent = messageCount > 0 ? `${text}（+${messageCount}）` : text;
    elements.message.title = deps.onShowMessageHistory
      ? `${text}\n（点击查看最近消息）`
      : text;
    elements.message.classList.remove("hidden");
    if (messageTimer) clearTimeout(messageTimer);
    messageTimer = setTimeout(() => {
      elements.message.classList.add("hidden");
      messageCount = 0;
    }, durationMs);
  }

  /** 并发长任务计数：嵌套调用时后到的文案覆盖，全部结束才隐藏 */
  let busyDepth = 0;

  function showBusy(text: string): void {
    busyDepth++;
    const textEl = elements.busy.querySelector<HTMLElement>(".status-busy-text");
    if (textEl) textEl.textContent = text;
    elements.busy.classList.remove("hidden");
  }

  function hideBusy(): void {
    busyDepth = Math.max(0, busyDepth - 1);
    if (busyDepth === 0) elements.busy.classList.add("hidden");
  }

  /** 常驻错误：独立元素，避免与 3 秒瞬时消息互相覆盖 */
  function showStickyError(text: string): void {
    elements.error.textContent = text;
    elements.error.title = text;
    elements.error.classList.remove("hidden");
  }

  function clearStickyError(): void {
    elements.error.textContent = "";
    elements.error.title = "";
    elements.error.classList.add("hidden");
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
      void updateSettings(merged).catch((e) => {
        console.warn("[config] 写回失败", e);
        // 界面已切换但配置没落地：不说的话，用户重启后发现设置"自己变回去了"
        showMessage("设置写入 config.json 失败：本次改动重启后可能不会保留", 6000);
      });
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
    configuredFields = new Map(fields.map((f) => [f.id, f.visible]));
    applyFieldVisibility(true);
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
    setImageSize,
    showMessage,
    showStickyError,
    clearStickyError,
    showBusy,
    hideBusy,
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
