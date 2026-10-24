/**
 * 预览编排：模式切换、刷新、双栏滚动联动、导出菜单与导出流程。
 *
 * 分层：渲染在 panels/preview.ts（PreviewHost：markdown-it / DOMPurify /
 * iframe / 图片查看器），本模块只做「标签 ↔ 面板」的编排与导出流程。
 * app 层可依赖 store / config / panels / ui，禁止反向。
 */

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { EditorView } from "@codemirror/view";
import { getConfig } from "../config/settings";
import type { Tab } from "../store/tabs";
import {
  PreviewHost,
  buildStandaloneHtml,
  buildWordHtml,
  htmlToMarkdown,
  openPrintDialog,
  pathKindOf,
  type PreviewMode,
  type PreviewTab,
} from "../panels/preview";
import { placeMenu } from "../ui/menu";
import type { SaveResult } from "../types/app";

export interface PreviewControllerDeps {
  getActiveTab: () => Tab | null;
  getView: () => EditorView;
  showMessage: (text: string) => void;
}

/** 联动回显抑制窗口（与 preview.ts 的 PREVIEW_ECHO_MS 对齐） */
const EDITOR_ECHO_MS = 120;

export class PreviewController {
  private panel: PreviewHost;
  /** 各标签的视图模式记忆（切回该标签时恢复） */
  private modes = new Map<string, PreviewMode>();
  private menu: HTMLElement | null = null;
  /** 最近一次由预览联动产生的编辑器滚动截止时刻 */
  private editorEchoUntil = 0;

  constructor(
    pane: HTMLElement,
    private modeBar: HTMLElement,
    editorArea: HTMLElement,
    private deps: PreviewControllerDeps,
  ) {
    this.panel = new PreviewHost(
      pane,
      editorArea,
      (line) => this.scrollEditorToLine(line),
      (x, y) => {
        // HTML 预览在 iframe 内，右键经同源转发到这里
        const tab = deps.getActiveTab();
        if (tab && tab.kind === "text" && pathKindOf(tab.path)) {
          this.showExportMenu(x, y, tab);
        }
      },
    );

    // 编辑器滚动 → 预览联动
    deps.getView().scrollDOM.addEventListener("scroll", () => {
      // 预览联动产生的回显：忽略，避免两侧互相追赶
      if (performance.now() < this.editorEchoUntil) return;
      this.panel.syncFromEditor(deps.getView());
    });

    // 视图模式按钮（编辑 / 预览 / 双栏）
    modeBar.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = deps.getActiveTab();
        if (!tab) return;
        this.modes.set(tab.id, btn.dataset.mode as PreviewMode);
        this.refresh();
      });
    });

    // 预览区右键 → 导出菜单
    pane.addEventListener("contextmenu", (e) => {
      const tab = deps.getActiveTab();
      // 仅 md/html 文件可导出（图片查看器无导出意义）
      if (!tab || tab.kind !== "text" || !pathKindOf(tab.path)) return;
      e.preventDefault();
      this.showExportMenu(e.clientX, e.clientY, tab);
    });
    document.addEventListener("click", () => this.closeExportMenu());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.closeExportMenu();
    });
  }

  private toTab(tab: Tab): PreviewTab {
    return {
      id: tab.id,
      kind: tab.kind,
      path: tab.path,
      name: tab.name,
      content: tab.content,
      size: tab.size,
      dataUrl: tab.dataUrl,
    };
  }

  /** 当前生效的视图模式（供分栏拖拽等判断是否双栏） */
  currentMode(): PreviewMode {
    const tab = this.deps.getActiveTab();
    if (!tab) return "edit";
    if (tab.kind === "image") return "preview";
    if (!pathKindOf(tab.path)) return "edit";
    // 默认视图模式来自配置（设置中心 ▸ 页面布局）
    return this.modes.get(tab.id) ?? getConfig().layout.defaultViewMode;
  }

  /** 标签关闭：遗忘其模式记忆，并释放面板上该标签的渲染结果 */
  forget(tabId: string): void {
    this.modes.delete(tabId);
    this.panel.forgetTab(tabId);
  }

  /** 设置当前标签的视图模式（设置中心回调用） */
  setMode(mode: PreviewMode): void {
    const tab = this.deps.getActiveTab();
    if (!tab) return;
    this.modes.set(tab.id, mode);
    this.refresh();
  }

  /** 编辑器内容变化后的防抖重渲染 */
  scheduleRender(tab: Tab): void {
    this.panel.scheduleRender(this.toTab(tab));
  }

  refresh(): void {
    const tab = this.deps.getActiveTab();
    const mode = this.currentMode();
    const kind = pathKindOf(tab?.path ?? null);
    this.modeBar.classList.toggle("hidden", !kind);
    this.modeBar.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === mode);
    });
    this.panel.apply(tab ? this.toTab(tab) : null, mode);
  }

  /**
   * 预览滚动 → 编辑器滚动（双栏 Markdown）。
   *
   * 历史问题：coordsAtPos 对"当前未渲染的行"返回 null，快速拖动预览滚动条时
   * 编辑器完全不动，双栏偏移持续放大。改用 EditorView.scrollIntoView 效应：
   * CM6 会先把目标行纳入渲染范围再定位，视口外同样可滚。
   */
  private scrollEditorToLine(line: number): void {
    const view = this.deps.getView();
    const doc = view.state.doc;
    if (doc.lines === 0) return;
    // line 可能是小数（预览块内插值）：折算进行内位置
    const clamped = Math.min(Math.max(line, 1), doc.lines);
    const whole = Math.floor(clamped);
    const lineInfo = doc.line(whole);
    const offset = Math.round((clamped - whole) * (lineInfo.to - lineInfo.from));
    const pos = Math.min(lineInfo.from + offset, lineInfo.to);
    // 标记一次联动滚动：随后编辑器抛出的 scroll 事件在窗口内视为回显
    this.editorEchoUntil = performance.now() + EDITOR_ECHO_MS;
    view.dispatch({
      effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 8 }),
    });
  }

  // ---- 导出（HTML / Word / PDF / Markdown）----

  private closeExportMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }

  private showExportMenu(x: number, y: number, tab: Tab): void {
    this.closeExportMenu();
    const menu = document.createElement("div");
    menu.className = "context-menu";

    const isHtml = pathKindOf(tab.path) === "html";
    const items: { label: string; run: () => void }[] = [
      ...(isHtml
        ? [{ label: "导出 Markdown…（.md）", run: () => void this.export(tab, "md") }]
        : []),
      { label: "导出 HTML…", run: () => void this.export(tab, "html") },
      { label: "导出 Word…（.doc）", run: () => void this.export(tab, "word") },
      { label: "导出 PDF…（系统打印对话框）", run: () => void this.export(tab, "pdf") },
    ];
    for (const item of items) {
      const el = document.createElement("div");
      el.className = "context-menu-item";
      el.textContent = item.label;
      el.addEventListener("click", () => {
        this.closeExportMenu();
        item.run();
      });
      menu.append(el);
    }
    document.body.append(menu);
    placeMenu(menu, x, y);
    this.menu = menu;
  }

  private paneTitle(tab: Tab): string {
    return tab.name.replace(/\.(md|markdown|html?)$/i, "");
  }

  /**
   * 把 HTML 内嵌的 data:image 落盘为「<md 文件名>.assets/」，
   * 并把 src 改为相对路径，避免导出 Markdown 出现单行几十万字符。
   * 基于 DOM 遍历（不依赖属性引号写法），srcset 场景已由预览侧归一化。
   */
  private async exportImagesToAssets(
    html: string,
    mdPath: string,
  ): Promise<{ html: string; count: number }> {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const images = Array.from(doc.images).filter((img) =>
      /^data:image\//i.test(img.getAttribute("src") ?? ""),
    );
    if (images.length === 0) return { html, count: 0 };

    const folder = `${mdPath.replace(/\.md$/i, "")}.assets`;
    const folderName = folder.replace(/^.*[\\/]/, "");
    const replaced = new Map<string, string>();
    let index = 0;
    // 素材目录位于「另存对话框选定的新目录」下，应用此前没见过它：
    // 先登记为已知路径，否则 Rust 侧写盘作用域校验会拒绝（图片走降级丢失）
    try {
      await invoke("register_paths", { paths: [folder] });
    } catch (e) {
      console.warn("[export] 素材目录登记失败", e);
    }
    for (const img of images) {
      const dataUri = img.getAttribute("src") ?? "";
      const hit = replaced.get(dataUri);
      if (hit) {
        img.setAttribute("src", hit);
        continue;
      }
      const match = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,(.+)$/i.exec(dataUri);
      if (!match) continue;
      const extMap: Record<string, string> = {
        png: "png",
        jpg: "jpg",
        jpeg: "jpg",
        gif: "gif",
        webp: "webp",
        bmp: "bmp",
      };
      const ext = extMap[match[1].toLowerCase()] ?? "png";
      const fileName = `image-${++index}.${ext}`;
      try {
        await invoke("write_binary_file", {
          path: `${folder}\\${fileName}`,
          base64Data: match[2],
        });
        const rel = `${folderName}/${fileName}`;
        img.setAttribute("src", rel);
        replaced.set(dataUri, rel);
      } catch {
        // 单张失败不影响其余图片与正文导出（该图由转换器降级为纯 alt）
      }
    }
    return { html: doc.body?.innerHTML ?? html, count: replaced.size };
  }

  /** 导出当前预览（tab 为调用时快照；导出写的是用户新选路径） */
  async export(tab: Tab, format: "html" | "word" | "pdf" | "md"): Promise<void> {
    const showMessage = this.deps.showMessage;
    try {
      const title = this.paneTitle(tab);

      if (format === "pdf") {
        // 经系统打印对话框另存为 PDF
        const body = await this.panel.getExportBody(this.toTab(tab));
        openPrintDialog(buildStandaloneHtml(title, body));
        return;
      }

      if (format === "md") {
        const target = await save({ defaultPath: `${title}.md` });
        if (typeof target !== "string") return;
        const prepared = await this.exportImagesToAssets(tab.content, target);
        const content = await htmlToMarkdown(prepared.html);
        const result = await invoke<SaveResult>("save_file", {
          path: target,
          content,
          newline: "LF",
          hasBom: false,
          encoding: "UTF-8",
        });
        showMessage(
          prepared.count > 0
            ? `已导出: ${result.path}（${prepared.count} 张内嵌图片已存入 ${title}.assets）`
            : `已导出: ${result.path}`,
        );
        return;
      }

      const body = await this.panel.getExportBody(this.toTab(tab));
      const ext = format === "html" ? "html" : "doc";
      const target = await save({ defaultPath: `${title}.${ext}` });
      if (typeof target !== "string") return;
      const content =
        format === "html" ? buildStandaloneHtml(title, body) : buildWordHtml(title, body);
      const result = await invoke<SaveResult>("save_file", {
        path: target,
        content,
        newline: "LF",
        hasBom: false,
        encoding: "UTF-8",
      });
      showMessage(`已导出: ${result.path}`);
    } catch (e) {
      showMessage(`导出失败: ${String(e).split("\n")[0]}`);
      console.error("[export]", e);
    }
  }
}
