/**
 * 侧栏视图切换（文件 / 搜索 / 大纲）。
 *
 * 只负责 tab 高亮、面板显隐与"变更通知"，各视图内部渲染由各自模块负责。
 * 当前视图持久化到 config.layout.sidebarView（Rust/前端双端已同步）。
 */

export type SidebarView = "files" | "search" | "outline";

export interface SidebarViewsDeps {
  /** 当前配置中的初始视图（bootstrap 载入配置后调用 restore 覆盖） */
  initial: SidebarView;
  /** 用户切换后通知（用于写回 config.json） */
  onChange: (view: SidebarView) => void;
}

export class SidebarViews {
  private current: SidebarView;

  constructor(
    private tabsEl: HTMLElement,
    private panes: Record<SidebarView, HTMLElement>,
    private deps: SidebarViewsDeps,
  ) {
    this.current = deps.initial;
    this.tabsEl.querySelectorAll<HTMLButtonElement>(".sidebar-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        const view = btn.dataset.view as SidebarView | undefined;
        if (view) this.switch(view);
      });
    });
    this.apply();
  }

  get view(): SidebarView {
    return this.current;
  }

  /** 用户主动切换：应用到界面并持久化 */
  switch(view: SidebarView): void {
    if (view === this.current) return;
    this.current = view;
    this.apply();
    this.deps.onChange(view);
  }

  /** 启动时按配置恢复（不触发持久化，避免回写同一值） */
  restore(view: SidebarView): void {
    this.current = view;
    this.apply();
  }

  private apply(): void {
    this.tabsEl.querySelectorAll<HTMLButtonElement>(".sidebar-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === this.current);
    });
    for (const [view, el] of Object.entries(this.panes) as [SidebarView, HTMLElement][]) {
      el.classList.toggle("hidden", view !== this.current);
    }
  }
}
