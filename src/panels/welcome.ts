/**
 * 欢迎页：无打开标签时的首屏引导。
 *
 * 纯展示 + 入口转发：打开文件 / 新建 / 打开目录 / 最近打开 + 常用快捷键。
 * 动作由 main.ts 注入（panels 不反向依赖 app）。
 */

export interface WelcomeDeps {
  onOpenFile: () => void;
  onNewFile: () => void;
  onOpenDirectory: () => void;
  onRecent: () => void;
  /** 快捷键速查：首屏可见，省掉「去设置里翻」的一步 */
  onShowShortcuts: () => void;
  /** 关于（版本 / 配置目录） */
  onShowAbout: () => void;
}

interface WelcomeAction {
  label: string;
  key: string;
  run: () => void;
}

export class WelcomePanel {
  constructor(
    private readonly host: HTMLElement,
    deps: WelcomeDeps,
  ) {
    this.render(deps);
  }

  private render(deps: WelcomeDeps): void {
    this.host.innerHTML = "";

    const card = document.createElement("div");
    card.className = "welcome-card";

    const title = document.createElement("div");
    title.className = "welcome-title";
    title.textContent = "my-editor";

    const subtitle = document.createElement("div");
    subtitle.className = "welcome-subtitle";
    subtitle.textContent = "轻量级定制文本编辑器";

    const actions: WelcomeAction[] = [
      { label: "打开文件", key: "Ctrl+O", run: deps.onOpenFile },
      { label: "新建文档", key: "Ctrl+N", run: deps.onNewFile },
      { label: "打开目录", key: "工作区", run: deps.onOpenDirectory },
      { label: "最近打开", key: "", run: deps.onRecent },
    ];

    const grid = document.createElement("div");
    grid.className = "welcome-actions";
    for (const action of actions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "welcome-action";
      const label = document.createElement("span");
      label.className = "welcome-action-label";
      label.textContent = action.label;
      btn.append(label);
      if (action.key) {
        const key = document.createElement("span");
        key.className = "welcome-action-key";
        key.textContent = action.key;
        btn.append(key);
      }
      btn.addEventListener("click", action.run);
      grid.append(btn);
    }

    const tips = document.createElement("div");
    tips.className = "welcome-tips";
    tips.textContent =
      "命令面板 Ctrl+Shift+P · 设置 Ctrl+, · 终端 Ctrl+` · 全部保存 Ctrl+Alt+S";

    // 次级入口：不抢主按钮的权重，但首屏就能看见（原先埋在设置菜单与命令面板里）
    const links = document.createElement("div");
    links.className = "welcome-links";
    for (const [label, run] of [
      ["快捷键速查", deps.onShowShortcuts],
      ["关于", deps.onShowAbout],
    ] as Array<[string, () => void]>) {
      const link = document.createElement("button");
      link.type = "button";
      link.className = "welcome-link";
      link.textContent = label;
      link.addEventListener("click", run);
      links.append(link);
    }

    card.append(title, subtitle, grid, tips, links);
    this.host.append(card);
  }

  /** 无标签时显示；有标签时隐藏 */
  setVisible(visible: boolean): void {
    this.host.classList.toggle("hidden", !visible);
  }
}
