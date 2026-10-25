/**
 * 设置中心面板骨架：对话框外壳、分类导航、打开/关闭/切换。
 * 三个分类页的渲染在 settings/（themeTab / keybindingsTab / layoutTab），
 * 小控件工厂在 ui/formControls.ts，共享常量与保存通道在 settings/shared.ts。
 *
 * 统一入口：菜单 设置 ▸ 设置… / 命令面板「打开设置…」/ Ctrl+,
 * 所有改动即时生效并写回 config.json（Rust 侧原子替换），无需重启。
 */

import {
  CATEGORY_LABELS,
  setSettingsNotify,
  type Category,
  type SettingsPanelCallbacks,
  type SettingsTabContext,
} from "../settings/shared";
import { renderTheme } from "../settings/themeTab";
import { renderKeybindings } from "../settings/keybindingsTab";
import { renderLayout } from "../settings/layoutTab";
import { renderFiles } from "../settings/filesTab";

export type { SettingsPanelCallbacks };

export class SettingsPanel {
  private backdrop: HTMLElement | null = null;
  private category: Category = "theme";
  /** 录制中的清理函数（快捷键重绑定） */
  private stopRecording: (() => void) | null = null;

  constructor(private readonly callbacks: SettingsPanelCallbacks) {
    setSettingsNotify(callbacks.onMessage);
  }

  get isOpen(): boolean {
    return this.backdrop !== null;
  }

  /** 分类页上下文：把面板级能力（重渲染、录制注册）注入各页 */
  private tabContext(): SettingsTabContext {
    return {
      callbacks: this.callbacks,
      rerender: () => {
        const main = this.backdrop?.querySelector<HTMLElement>(".settings-main");
        if (main) this.renderCategory(main);
      },
      getStopRecording: () => this.stopRecording,
      setStopRecording: (fn) => {
        this.stopRecording = fn;
      },
    };
  }

  open(category: Category = this.category): void {
    if (this.backdrop) {
      this.switchCategory(category);
      return;
    }
    this.category = category;

    const backdrop = document.createElement("div");
    backdrop.className = "settings-backdrop";

    const dialog = document.createElement("div");
    dialog.className = "settings-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", "设置");

    // 头部
    const head = document.createElement("div");
    head.className = "settings-head";
    const title = document.createElement("h3");
    title.textContent = "设置";
    head.append(title);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "settings-close";
    closeBtn.textContent = "×";
    closeBtn.title = "关闭（Esc）";
    head.append(closeBtn);
    dialog.append(head);

    // 左侧分类导航
    const body = document.createElement("div");
    body.className = "settings-body";
    const nav = document.createElement("nav");
    nav.className = "settings-nav";
    for (const cat of CATEGORY_LABELS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `settings-nav-item${cat.id === this.category ? " active" : ""}`;
      btn.dataset.cat = cat.id;
      btn.textContent = cat.label;
      btn.addEventListener("click", () => this.switchCategory(cat.id));
      nav.append(btn);
    }
    body.append(nav);

    const main = document.createElement("div");
    main.className = "settings-main";
    body.append(main);
    dialog.append(body);

    // 底部
    const foot = document.createElement("div");
    foot.className = "settings-foot";
    const hint = document.createElement("span");
    hint.className = "settings-hint";
    hint.textContent = "所有改动即时生效并自动保存到 config.json";
    foot.append(hint);
    const closeFooter = document.createElement("button");
    closeFooter.type = "button";
    closeFooter.className = "primary";
    closeFooter.textContent = "关闭";
    foot.append(closeFooter);
    dialog.append(foot);

    backdrop.append(dialog);
    document.body.append(backdrop);
    this.backdrop = backdrop;

    const done = () => this.close();
    closeBtn.addEventListener("click", done);
    closeFooter.addEventListener("click", done);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) done();
    });
    dialog.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.stopRecording) done();
    });

    this.renderCategory(main);
  }

  close(): void {
    // 先取消录制：否则窗口级 keydown 监听会残留，且全局派发仍处挂起状态
    this.stopRecording?.();
    this.backdrop?.remove();
    this.backdrop = null;
  }

  toggle(): void {
    if (this.backdrop) this.close();
    else this.open();
  }

  private switchCategory(cat: Category): void {
    this.category = cat;
    if (!this.backdrop) return;
    this.backdrop.querySelectorAll(".settings-nav-item").forEach((btn) => {
      btn.classList.toggle("active", (btn as HTMLElement).dataset.cat === cat);
    });
    const main = this.backdrop.querySelector<HTMLElement>(".settings-main");
    if (main) this.renderCategory(main);
  }

  private renderCategory(main: HTMLElement): void {
    this.stopRecording?.();
    main.innerHTML = "";
    main.scrollTop = 0;
    const ctx = this.tabContext();
    if (this.category === "theme") renderTheme(main, ctx);
    else if (this.category === "keybindings") renderKeybindings(main, ctx);
    else if (this.category === "files") renderFiles(main, ctx);
    else renderLayout(main, ctx);
  }
}
