/**
 * 侧栏分区（VS Code 风格折叠列表）：
 * 「正在打开的文件 / 文件 / 搜索 / 大纲」四个分区标题纵向排列。
 *
 * 各分区独立展开 / 收起（不互斥），也不强制占满侧栏高度；
 * 多个分区同时展开时由容器整体滚动。
 * 最后操作的分区持久化到 config.layout.sidebarView。
 */

export type SidebarView = "open" | "files" | "search" | "outline";

export interface SidebarViewsDeps {
  /** 当前配置中的初始分区（bootstrap 载入配置后调用 restore 覆盖） */
  initial: SidebarView;
  /** 用户展开分区后通知（用于写回 config.json） */
  onChange: (view: SidebarView) => void;
}

export class SidebarViews {
  /** 当前展开的分区集合（可多个） */
  private expanded = new Set<SidebarView>();
  /** 最后操作的分区：命令 / 快捷键定位用，也是持久化的值 */
  private lastActive: SidebarView;

  constructor(
    private sectionsEl: HTMLElement,
    private panes: Record<SidebarView, HTMLElement>,
    private deps: SidebarViewsDeps,
  ) {
    this.lastActive = deps.initial;
    this.expanded.add(deps.initial);
    this.sectionsEl.querySelectorAll<HTMLButtonElement>(".sidebar-section-head").forEach((btn) => {
      btn.addEventListener("click", () => {
        const view = btn.dataset.view as SidebarView | undefined;
        if (view) this.toggle(view);
      });
    });
    this.apply();
  }

  /** 最后操作的分区（供预览 / 大纲刷新判断） */
  get view(): SidebarView {
    return this.lastActive;
  }

  /** 命令 / 快捷键：展开指定分区并记录为当前分区（不收起其他分区） */
  switch(view: SidebarView): void {
    this.expanded.add(view);
    this.lastActive = view;
    this.apply();
    this.deps.onChange(view);
  }

  /** 启动时按配置恢复：只展开配置中的分区 */
  restore(view: SidebarView): void {
    this.expanded = new Set([view]);
    this.lastActive = view;
    this.apply();
  }

  /** 点击标题：独立展开 / 收起（收起不改变持久化的当前分区） */
  private toggle(view: SidebarView): void {
    if (this.expanded.has(view)) {
      this.expanded.delete(view);
    } else {
      this.expanded.add(view);
      this.lastActive = view;
      this.deps.onChange(view);
    }
    this.apply();
  }

  private apply(): void {
    this.sectionsEl
      .querySelectorAll<HTMLButtonElement>(".sidebar-section-head")
      .forEach((btn) => {
        const view = btn.dataset.view as SidebarView | undefined;
        if (!view) return;
        const open = this.expanded.has(view);
        btn.classList.toggle("active", open);
        btn.setAttribute("aria-expanded", String(open));
        btn.closest(".sidebar-section")?.classList.toggle("expanded", open);
        const chevron = btn.querySelector<HTMLElement>(".chevron");
        if (chevron) chevron.textContent = open ? "⌄" : "›";
      });
    for (const [view, el] of Object.entries(this.panes) as [SidebarView, HTMLElement][]) {
      el.classList.toggle("hidden", !this.expanded.has(view));
    }
  }
}
