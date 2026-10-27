/**
 * 通知中心面板：点状态栏的 ⚠ 图标弹出，列出待处理提示与快捷动作。
 *
 * 定位在状态栏按钮上方（fixed），点空白 / Esc 关闭；条目处理完自动移除。
 */

import {
  NOTICE_LABELS,
  clearNotices,
  listNotices,
  removeNotice,
  subscribeNotices,
} from "../app/noticeStore";

export class NoticePanel {
  private el: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private anchor: HTMLElement,
    private deps: { onMessage: (text: string) => void },
  ) {}

  get isOpen(): boolean {
    return this.el !== null;
  }

  toggle(): void {
    if (this.el) this.close();
    else this.open();
  }

  private open(): void {
    const panel = document.createElement("div");
    panel.className = "context-menu notice-panel";

    const head = document.createElement("div");
    head.className = "notice-head";
    const title = document.createElement("span");
    title.textContent = "待处理";
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "notice-clear";
    clearBtn.textContent = "全部清除";
    clearBtn.addEventListener("click", () => {
      clearNotices();
      this.close();
    });
    head.append(title, clearBtn);
    panel.append(head);

    const list = document.createElement("div");
    list.className = "notice-list";
    panel.append(list);

    const renderList = (): void => {
      list.innerHTML = "";
      const items = listNotices();
      if (items.length === 0) {
        const empty = document.createElement("div");
        empty.className = "notice-empty";
        empty.textContent = "没有待处理提示";
        list.append(empty);
        return;
      }
      for (const notice of items) {
        const row = document.createElement("div");
        row.className = "notice-item";

        const kind = document.createElement("span");
        kind.className = `notice-kind notice-kind-${notice.kind}`;
        kind.textContent = NOTICE_LABELS[notice.kind];

        const text = document.createElement("span");
        text.className = "notice-text";
        text.textContent = notice.text;
        text.title = notice.text;

        const actions = document.createElement("span");
        actions.className = "notice-actions";
        for (const action of notice.actions) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "notice-action";
          btn.textContent = action.label;
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            removeNotice(notice.id);
            action.run();
            this.close();
          });
          actions.append(btn);
        }
        const dismiss = document.createElement("button");
        dismiss.type = "button";
        dismiss.className = "notice-dismiss";
        dismiss.textContent = "×";
        dismiss.title = "忽略这条";
        dismiss.addEventListener("click", (e) => {
          e.stopPropagation();
          removeNotice(notice.id);
        });
        actions.append(dismiss);

        row.append(kind, text, actions);
        list.append(row);
      }
    };

    renderList();
    document.body.append(panel);

    // 贴在状态栏按钮上方
    const rect = this.anchor.getBoundingClientRect();
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const left = Math.max(4, Math.min(rect.left, window.innerWidth - width - 4));
    const top = Math.max(4, rect.top - height - 6);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;

    this.el = panel;
    this.unsubscribe = subscribeNotices(renderList);
    document.addEventListener("click", this.onDocClick, true);
    document.addEventListener("keydown", this.onKeydown);
    this.deps.onMessage("通知中心已打开");
  }

  private close(): void {
    if (!this.el) return;
    this.unsubscribe?.();
    this.unsubscribe = null;
    document.removeEventListener("click", this.onDocClick, true);
    document.removeEventListener("keydown", this.onKeydown);
    this.el.remove();
    this.el = null;
  }

  private onDocClick = (e: MouseEvent): void => {
    const target = e.target;
    if (!(target instanceof Node)) return;
    if (this.el?.contains(target) || this.anchor.contains(target)) return;
    this.close();
  };

  private onKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this.close();
  };
}
