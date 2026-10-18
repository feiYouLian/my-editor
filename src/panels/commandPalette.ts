/**
 * 命令面板（Ctrl+Shift+P，设计文档 3.9）：
 * Sublime 风格——高级操作统一收进面板，主界面保持干净。
 * 动作注册表模式：各功能模块在实现时 register，随阶段递增。
 * 宏录制/回放不在本期范围（决策 17），故无「运行宏」条目。
 */

export interface CommandItem {
  id: string;
  title: string;
  section?: string;
  run: () => void;
}

export class CommandPalette {
  private commands: CommandItem[] = [];
  private overlay: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;
  private selectedIndex = 0;
  private visible: CommandItem[] = [];

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
      if (cmd) {
        this.close();
        cmd.run();
      }
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
    this.renderList();
  }

  /** 简单模糊匹配：子序列匹配 + 连续匹配加分 */
  private fuzzyMatch(query: string, text: string): number {
    if (!query) return 1;
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    let score = 0;
    let ti = 0;
    let lastMatch = -1;
    for (const ch of q) {
      const idx = t.indexOf(ch, ti);
      if (idx < 0) return 0;
      score += idx === lastMatch + 1 ? 2 : 1;
      lastMatch = idx;
      ti = idx + 1;
    }
    return score;
  }

  private renderList(): void {
    if (!this.listEl || !this.input) return;
    const query = this.input.value.trim();
    const scored = this.commands
      .map((cmd) => ({ cmd, score: this.fuzzyMatch(query, cmd.title) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    this.visible = scored.map((s) => s.cmd);
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
      item.textContent = cmd.section ? `${cmd.section}: ${cmd.title}` : cmd.title;
      item.addEventListener("click", () => {
        this.close();
        cmd.run();
      });
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
