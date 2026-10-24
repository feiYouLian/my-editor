/**
 * 差异比较编排：未保存改动 / 与另一文件 / 与 Git（worktree | index）。
 *
 * 渲染在 panels/diffPanel.ts（按需动态引入，只在真正发起比较时加载）；
 * 本模块管「场景定义 → 会话 → 面板 → 差异块采用 → 补丁导出」的编排。
 * 纯函数 mergeHunk 不依赖任何外部状态，随会话逻辑放在此。
 */

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { tabStore, type Tab } from "../store/tabs";
import type {
  DiffPanel,
  DiffPayload,
  DiffRow,
  DiffSession,
} from "../panels/diffPanel";
import { readDiskAs } from "./fileService";

export interface DiffServiceDeps {
  getActiveTab: () => Tab | null;
  showMessage: (text: string) => void;
  /** 采用差异块后重载当前标签（main.ts 的标签切换状态机） */
  onReloadActiveTab: () => Promise<void>;
}

/**
 * 差异块合并：块内取 applySide、块外取 baseSide；该侧无对应行的行被丢弃。
 * 差异行由 Rust 对齐输出，两侧单元格可拼回原文，故无需重新读取文件。
 */
function mergeHunk(
  payload: DiffPayload,
  hunkIndex: number,
  baseSide: "left" | "right",
  applySide: "left" | "right",
  trailingNewline: boolean,
): string {
  const start = payload.hunks[hunkIndex]?.row;
  let end = payload.rows.length;
  if (start !== undefined) {
    end = start;
    while (end < payload.rows.length && payload.rows[end].kind !== "equal") end += 1;
  }
  const cell = (row: DiffRow, side: "left" | "right"): string | null => {
    if (side === "left") return row.oldNo === null ? null : row.left;
    return row.newNo === null ? null : row.right;
  };

  const lines: string[] = [];
  payload.rows.forEach((row, i) => {
    const side = start !== undefined && i >= start && i < end ? applySide : baseSide;
    const text = cell(row, side);
    if (text !== null) lines.push(text);
  });
  if (lines.length === 0) return "";
  const joined = lines.join("\n");
  return trailingNewline ? `${joined}\n` : joined;
}

/**
 * 比较两段文本前的磁盘基线：磁盘内容不再常驻内存，仅在主动比较/还原时读一次。
 * 未命名文档（path 为空）没有磁盘基线，按空内容处理。
 */
async function diskBaseline(path: string | null, encoding: string): Promise<string> {
  return path ? (await readDiskAs(path, encoding)).content : "";
}

export class DiffService {
  /** 差异面板按需加载：只在真正发起比较时引入 */
  private panel: DiffPanel | null = null;
  private panelPromise: Promise<DiffPanel> | null = null;
  private session: DiffSession | null = null;

  constructor(private deps: DiffServiceDeps) {}

  private ensurePanel(): Promise<DiffPanel> {
    if (!this.panelPromise) {
      this.panelPromise = import("../panels/diffPanel").then(({ DiffPanel }) => {
        this.panel = new DiffPanel();
        return this.panel;
      });
    }
    return this.panelPromise;
  }

  async open(session: DiffSession, hunkIndex?: number): Promise<void> {
    this.session = session;
    try {
      const payload = await session.load();
      (await this.ensurePanel()).open(
        payload,
        session.actions,
        session.adopt() ?? undefined,
        hunkIndex,
      );
    } catch (e) {
      this.deps.showMessage(`比较失败：${String(e).split("\n")[0]}`);
    }
  }

  /** 采用当前差异块：写回编辑器并重新计算差异，保持所在差异块位置 */
  async adoptHunk(hunkIndex: number): Promise<void> {
    const session = this.session;
    const payload = this.panel?.getPayload() ?? null;
    const adopt = session?.adopt();
    if (!session || !payload || !adopt || !adopt.enabled()) return;
    const tab = this.deps.getActiveTab();
    if (!tab || tab.kind !== "text") return;
    if (tab.readonly) {
      this.deps.showMessage("只读文件不支持差异块合并");
      return;
    }
    // 文档基线侧：可采用侧的对侧
    const baseSide: "left" | "right" = adopt.side === "left" ? "right" : "left";
    const current = tabStore.snapshotOf(tab);
    const trailing =
      session.trailingFrom === "content" ? current.endsWith("\n") : tab.savedTrailingNewline;
    const merged = mergeHunk(payload, hunkIndex, baseSide, adopt.side, trailing);
    if (merged === current) {
      this.deps.showMessage("该处内容已与所选侧一致，无需改动");
      return;
    }
    tabStore.applyEdit(tab.id, merged);
    await this.deps.onReloadActiveTab();
    await this.open(session, hunkIndex);
    this.deps.showMessage(`已采用第 ${hunkIndex + 1} 处差异块（未保存，Ctrl+S 生效）`);
  }

  /** 导出统一 diff 补丁到 <path>.patch */
  async exportPatch(basePath: string, patch: string): Promise<void> {
    try {
      const written = await invoke<string>("export_patch", { path: basePath, content: patch });
      this.deps.showMessage(`补丁已导出：${written}`);
    } catch (e) {
      this.deps.showMessage(`导出失败：${String(e).split("\n")[0]}`);
    }
  }

  /** 以当前标签为左侧、给定路径为右侧做文件比较 */
  async compareWithPath(rightPath: string): Promise<void> {
    const tab = this.deps.getActiveTab();
    if (!tab || tab.kind !== "text" || !tab.path) {
      this.deps.showMessage("请先打开一个磁盘上的文本文件作为比较基准");
      return;
    }
    if (tab.path === rightPath) {
      this.deps.showMessage("两侧是同一个文件，无需比较");
      return;
    }
    const leftPath = tab.path;
    const tabId = tab.id;
    await this.open({
      load: () => invoke<DiffPayload>("diff_files", { leftPath, rightPath }),
      actions: [
        {
          label: "导出补丁",
          run: () => {
            const p = this.panel?.getPayload();
            if (p) void this.exportPatch(leftPath, p.patch);
          },
        },
      ],
      // 文档基线为左侧（当前文件磁盘内容）；仅当标签无未保存改动时两侧内容才对齐
      adopt: () => ({
        side: "right",
        enabled: () => {
          const t = tabStore.findById(tabId);
          return !!t && !t.dirty && !t.readonly;
        },
        title: "采用右侧：把当前差异块替换为另一文件的内容（需先保存当前标签的改动）",
        run: (i) => void this.adoptHunk(i),
      }),
      trailingFrom: "saved",
    });
  }

  /** 与系统文件选择器挑选的文件比较 */
  async compareWithPickedFile(): Promise<void> {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "所有文件", extensions: ["*"] }],
    });
    if (typeof selected !== "string") return;
    await this.compareWithPath(selected);
  }

  /** 以当前激活标签为左侧，与右键点击的标签比较 */
  compareTabs(otherTabId: string): void {
    if (otherTabId === this.deps.getActiveTab()?.id) {
      this.deps.showMessage("请先切换到另一侧标签，或使用「比较 ▸ 与文件…比较」");
      return;
    }
    const other = tabStore.findById(otherTabId);
    if (!other?.path) {
      this.deps.showMessage("该标签不是磁盘上的文本文件");
      return;
    }
    void this.compareWithPath(other.path);
  }

  /** 场景一：当前文件 磁盘内容 ⇄ 编辑中内容 */
  async diffUnsaved(): Promise<void> {
    const tab = this.deps.getActiveTab();
    if (!tab || tab.kind !== "text") {
      this.deps.showMessage("请先打开一个文本文件");
      return;
    }
    if (!tab.dirty) {
      this.deps.showMessage("当前文件没有未保存改动");
      return;
    }
    const tabId = tab.id;
    const name = tab.name;
    await this.open({
      load: async () => {
        const t = tabStore.findById(tabId);
        if (!t) throw new Error("标签已关闭");
        const disk = await diskBaseline(t.path, t.encoding);
        return invoke<DiffPayload>("diff_texts", {
          leftText: disk,
          rightText: tabStore.snapshotOf(t),
          leftLabel: `磁盘 · ${name}`,
          rightLabel: `编辑中 · ${name}`,
        });
      },
      actions: [
        {
          label: "还原改动",
          title: "放弃编辑中的内容，回到磁盘版本",
          run: async () => {
            const t = tabStore.findById(tabId);
            if (!t) return;
            const disk = await diskBaseline(t.path, t.encoding);
            tabStore.restoreContent(tabId, disk);
            await this.deps.onReloadActiveTab();
            this.panel?.close();
            this.deps.showMessage(t.path ? "已还原为磁盘内容" : "已清空未命名文档（无磁盘基线）");
          },
        },
        {
          label: "导出补丁",
          run: () => {
            const p = this.panel?.getPayload();
            if (p) void this.exportPatch(tabStore.findById(tabId)?.path ?? name, p.patch);
          },
        },
      ],
      // 文档基线为右侧（编辑中）；可采用左侧把该处还原为磁盘内容
      adopt: () => ({
        side: "left",
        enabled: () => !this.deps.getActiveTab()?.readonly,
        title: "采用左侧：把当前差异块还原为磁盘内容（写回编辑器，需手动保存）",
        run: (i) => void this.adoptHunk(i),
      }),
      trailingFrom: "content",
    });
  }

  /** 场景三：与 Git 比较（scope = worktree 工作区 | index 暂存区） */
  async diffWithGit(scope: "worktree" | "index"): Promise<void> {
    const tab = this.deps.getActiveTab();
    if (!tab?.path || tab.kind !== "text") {
      this.deps.showMessage("请先打开一个磁盘上的文本文件");
      return;
    }
    const path = tab.path;
    const tabId = tab.id;
    let available: boolean;
    try {
      available = await invoke<boolean>("git_available", { path });
    } catch (e) {
      this.deps.showMessage(`Git 比较失败：${String(e).split("\n")[0]}`);
      return;
    }
    if (!available) {
      this.deps.showMessage("当前文件不在 Git 仓库中，无法比较");
      return;
    }
    await this.open({
      load: () => invoke<DiffPayload>("git_diff", { path, scope }),
      actions: [
        {
          label: "导出补丁",
          run: () => {
            const p = this.panel?.getPayload();
            if (p) void this.exportPatch(path, p.patch);
          },
        },
      ],
      // worktree：文档基线为右侧（工作区磁盘内容），可采用左侧还原为 Git 版本；
      // index：右侧是暂存区，与编辑器内容不对应，故不提供差异块采用
      adopt: () =>
        scope === "index"
          ? null
          : {
              side: "left",
              enabled: () => {
                const t = tabStore.findById(tabId);
                return !!t && !t.dirty && !t.readonly;
              },
              title: "采用左侧：把当前差异块还原为 Git 版本（需先保存当前标签的改动）",
              run: (i) => void this.adoptHunk(i),
            },
      trailingFrom: "saved",
    });
  }
}
