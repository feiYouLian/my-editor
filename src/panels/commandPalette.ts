/**
 * 命令面板（Ctrl+Shift+P）：
 * 高级操作统一收进面板，主界面保持干净。
 * 动作注册表模式：各功能模块在实现时 register。
 * 不含宏录制/回放，故无「运行宏」条目。
 */

import { fuzzyMatch, fuzzyScore } from "../core/fuzzy";
import { appendHighlighted } from "../ui/highlight";

export interface CommandItem {
  id: string;
  title: string;
  section?: string;
  /** 快捷键展示文本（函数形式：渲染时求值，改键位后无需重注册） */
  shortcut?: string | (() => string);
  run: () => void;
}

export class CommandPalette {
  private commands: CommandItem[] = [];
  private overlay: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;
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
    this.input.placeholder = "输入命令…（Esc 关闭）";
    this.input.addEventListener("input", () => this.renderList());
    this.input.addEventListener("keydown", (e) => this.onKeydown(e));

    this.listEl = document.createElement("div");
    this.listEl.className = "palette-list";

    box.append(this.input, this.listEl);
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
  }

  toggle(): void {
    if (this.overlay) this.close();
    else this.open();
  }

  private onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
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
      .map((cmd) => ({ cmd, score: fuzzyScore(query, cmd.title) }))
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
      empty.textContent = "无匹配命令";
      this.listEl.append(empty);
      return;
    }

    this.visible.forEach((cmd, i) => {
      const item = document.createElement("div");
      item.className = `palette-item${i === this.selectedIndex ? " selected" : ""}`;
      const label = document.createElement("span");
      if (cmd.section) label.append(document.createTextNode(`${cmd.section}: `));
      // 只高亮命中的命令名，不把 "编辑:" 这类分组名也点亮
      const positions = new Set<number>();
      const match = fuzzyMatch(query, cmd.title);
      if (match) for (const pos of match.positions) positions.add(pos);
      appendHighlighted(label, cmd.title, positions);
      item.append(label);
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

  /** 只更新选中样式，不重建 DOM（重建会打断点击：悬停即替换元素） */
  private updateSelection(): void {
    if (!this.listEl) return;
    this.listEl.querySelectorAll(".palette-item").forEach((el, idx) => {
      el.classList.toggle("selected", idx === this.selectedIndex);
    });
    this.listEl.children[this.selectedIndex]?.scrollIntoView({ block: "nearest" });
  }
}
