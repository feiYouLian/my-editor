/**
 * 命令面板（Ctrl+Shift+P）：
 * 高级操作统一收进面板，主界面保持干净。
 *
 * 搜索同时看三个字段：标题（模糊子序列）、keywords（精确/包含优先）、
 * description（包含即命中）。说明写进命令元数据，面板只消费，不硬编码文案。
 */

import { commandScore, type CommandScore } from "../core/commandScore";
import { appendHighlighted } from "../ui/highlight";
import { showHelpDialog } from "./helpDialog";

export interface CommandItem {
  id: string;
  title: string;
  section?: string;
  /** 一句话说明（第二行渲染） */
  description?: string;
  /** 用户会输入的词（搜索用） */
  keywords?: string[];
  /** 结果说明（选中项的详情区） */
  outcome?: { kind: string; hint?: string };
  /** 快捷键展示文本（函数形式：渲染时求值，改键位后无需重注册） */
  shortcut?: string | (() => string);
  run: () => void;
}

/** 打分逻辑在 core（审计脚本共用同一份实现），这里原样转出供调用方使用 */
export { commandScore };
export type { CommandScore };

export class CommandPalette {
  private commands: CommandItem[] = [];
  private overlay: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;
  private detailEl: HTMLElement | null = null;
  private selectedIndex = 0;
  private visible: CommandItem[] = [];
  /** 上次渲染时的查询：查询变了就要把选中项复位（否则回车会打开"意外那条"） */
  private lastQuery = "";

  /** 最近使用的命令 id（localStorage 持久化，跨会话保留） */
  private static readonly RECENT_KEY = "my-editor.palette.recent";
  private static readonly RECENT_LIMIT = 8;

  register(cmd: CommandItem): void {
    this.commands = this.commands.filter((c) => c.id !== cmd.id);
    this.commands.push(cmd);
  }

  registerAll(cmds: CommandItem[]): void {
    cmds.forEach((c) => this.register(c));
  }

  get isOpen(): boolean {
    return this.overlay !== null;
  }

  open(): void {
    if (this.overlay) {
      this.input?.focus();
      return;
    }
    const overlay = document.createElement("div");
    overlay.className = "palette-overlay";

    const box = document.createElement("div");
    box.className = "palette-box";

    this.input = document.createElement("input");
    this.input.className = "palette-input";
    this.input.placeholder = "输入命令名、用途或产物…（Esc 关闭）";
    this.input.addEventListener("input", () => this.renderList());
    this.input.addEventListener("keydown", (e) => this.onKeydown(e));

    this.listEl = document.createElement("div");
    this.listEl.className = "palette-list";

    this.detailEl = document.createElement("div");
    this.detailEl.className = "palette-detail";

    box.append(this.input, this.listEl, this.detailEl);
    overlay.append(box);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.close();
    });
    document.body.append(overlay);
    this.overlay = overlay;

    this.renderList();
    this.input.focus();
  }

  close(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.input = null;
    this.listEl = null;
    this.detailEl = null;
  }

  toggle(): void {
    if (this.overlay) this.close();
    else this.open();
  }

  private onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    } else if (e.key === "Enter" && e.ctrlKey) {
      // Ctrl+Enter：不执行命令，先看它的完整说明
      e.preventDefault();
      const cmd = this.visible[this.selectedIndex];
      if (!cmd) return;
      this.close();
      showHelpDialog("commands", cmd.id);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = this.visible[this.selectedIndex];
      if (cmd) this.invoke(cmd);
    } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      this.move(1);
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      this.move(-1);
    }
  }

  private move(delta: number): void {
    if (this.visible.length === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + this.visible.length) % this.visible.length;
    // 只切选中样式：重建整表会让按住方向键时掉帧
    this.updateSelection();
  }

  /** 执行命令并记录到「最近使用」 */
  private invoke(cmd: CommandItem): void {
    this.close();
    this.remember(cmd.id);
    cmd.run();
  }

  private recentIds(): string[] {
    try {
      const raw = localStorage.getItem(CommandPalette.RECENT_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  }

  private remember(id: string): void {
    const next = [id, ...this.recentIds().filter((v) => v !== id)].slice(
      0,
      CommandPalette.RECENT_LIMIT,
    );
    try {
      localStorage.setItem(CommandPalette.RECENT_KEY, JSON.stringify(next));
    } catch {
      // 隐私模式 / 存储受限：最近使用失效不影响命令执行
    }
  }

  private shortcutText(cmd: CommandItem): string {
    if (typeof cmd.shortcut === "function") return cmd.shortcut();
    return cmd.shortcut ?? "";
  }

  private renderList(): void {
    if (!this.listEl || !this.input) return;
    const query = this.input.value.trim();
    const recent = this.recentIds();
    const scored = this.commands
      .map((cmd) => ({ cmd, ...commandScore(query, cmd) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        // 同分时（含空查询）最近使用优先；未用过的按注册序保持稳定
        const ra = recent.indexOf(a.cmd.id);
        const rb = recent.indexOf(b.cmd.id);
        return (ra < 0 ? Number.MAX_SAFE_INTEGER : ra) - (rb < 0 ? Number.MAX_SAFE_INTEGER : rb);
      });

    this.visible = scored.map((s) => s.cmd);
    if (query !== this.lastQuery) {
      this.lastQuery = query;
      this.selectedIndex = 0;
    }
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.visible.length - 1));
    this.listEl.innerHTML = "";

    if (this.visible.length === 0) {
      const empty = document.createElement("div");
      empty.className = "palette-empty";
      empty.textContent =
        "没有匹配的命令 · 先换个词试试（可以说用途，如「发给别人」），或按 Esc 关闭";
      this.listEl.append(empty);
      this.updateSelection();
      return;
    }

    this.visible.forEach((cmd, i) => {
      const item = document.createElement("div");
      item.className = `palette-item${i === this.selectedIndex ? " selected" : ""}`;

      const main = document.createElement("div");
      main.className = "palette-item-main";

      const titleRow = document.createElement("div");
      titleRow.className = "palette-item-title";
      if (cmd.section) titleRow.append(document.createTextNode(`${cmd.section}: `));
      // 只高亮标题里的命中，不把分组名也点亮
      appendHighlighted(titleRow, cmd.title, new Set(scored[i].positions));
      main.append(titleRow);

      if (cmd.description) {
        const desc = document.createElement("div");
        desc.className = "palette-item-desc";
        desc.textContent = cmd.description;
        main.append(desc);
      }

      item.append(main);
      const shortcut = this.shortcutText(cmd);
      if (shortcut) {
        const key = document.createElement("span");
        key.className = "palette-shortcut";
        key.textContent = shortcut;
        item.append(key);
      }
      item.addEventListener("click", () => this.invoke(cmd));
      item.addEventListener("mouseenter", () => {
        if (this.selectedIndex !== i) {
          this.selectedIndex = i;
          this.updateSelection();
        }
      });
      this.listEl?.append(item);
    });
    this.updateSelection();
  }

  /** 只更新选中样式与详情区，不重建 DOM（重建会打断点击：悬停即替换元素） */
  private updateSelection(): void {
    if (!this.listEl) return;
    this.listEl.querySelectorAll(".palette-item").forEach((el, idx) => {
      el.classList.toggle("selected", idx === this.selectedIndex);
    });
    this.listEl.children[this.selectedIndex]?.scrollIntoView({ block: "nearest" });

    if (this.detailEl) {
      const cmd = this.visible[this.selectedIndex];
      const hint = cmd?.outcome?.hint ?? "";
      this.detailEl.replaceChildren();
      if (hint) {
        const text = document.createElement("span");
        text.className = "palette-detail-text";
        text.textContent = hint;
        this.detailEl.append(text);
      }
      if (cmd) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "palette-detail-btn";
        more.textContent = "查看完整说明";
        more.title = "在帮助里打开这条命令的说明（Ctrl+Enter）";
        more.addEventListener("click", () => {
          this.close();
          showHelpDialog("commands", cmd.id);
        });
        this.detailEl.append(more);
      }
      this.detailEl.classList.toggle("palette-detail-empty", !hint);
    }
  }
}
