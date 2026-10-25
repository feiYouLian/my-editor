/**
 * 文件操作服务：打开（含图片 / 大文件分流）、保存 / 另存为 /
 * 另存为指定编码、插入剪贴板图片、未命名文档、配置文件打开与重载。
 *
 * 编辑器相关的最小能力（光标插入）经 deps 注入，避免 app → main
 * 反向依赖；大文件分流委托 LargeFileHost。
 */

import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getConfig, loadSettings, settings, type AppConfig } from "../config/settings";
import { tabStore, type Tab } from "../store/tabs";
import { pushRecentFile } from "../panels/recentFiles";
import { showConfigReloaded } from "../ui/settingsHelp";
import { confirmAction } from "../ui/dialogs";
import { basenameOf } from "../core/paths";
import { localStamps } from "../core/stamps";
import { effectiveLanguage } from "../editor/languages";
import type { LargeFileHost } from "./largeFileHost";
import type { FileContent, SaveResult } from "../types/app";

export interface FileServiceDeps {
  getActiveTab: () => Tab | null;
  blockIfReadonly: () => boolean;
  showMessage: (text: string) => void;
  /** 打开文件后的乱码复检 */
  onCheckMojibake: (tabId: string) => void;
  /** 保存后丢弃该标签的草稿（tabId → 草稿 key 的解析在 main.ts） */
  onDiscardDraft: (tabId: string) => void;
  /** 保存窗口内又有新输入时重写草稿（不能直接丢弃，否则新内容失去兜底） */
  onPersistDraft: (tabId: string) => void;
  /** 在编辑器光标处插入文本 */
  insertAtCursor: (text: string) => void;
  /** 文件监听重登记（保存改变了路径集合） */
  syncWatchedFiles: () => void;
  /** 保存后刷新状态栏（脏标记 / 体积） */
  refreshStatus: () => void;
  /** 打开「另存为指定编码」对话框 */
  pickEncoding: (
    encodings: string[],
    current: string,
    onPick: (encoding: string) => void,
    note: string,
  ) => void;
  /** 大文件宿主（分流 / 虚拟视图） */
  largeHost: LargeFileHost;
}

/** 编码回退列表（与状态栏编码菜单共用） */
export const FALLBACK_ENCODINGS = [
  "UTF-8",
  "GBK",
  "GB18030",
  "UTF-16 LE",
  "UTF-16 BE",
  "Big5",
  "Windows-1252",
];

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"]);

function isImagePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

/**
 * 按指定编码重读磁盘内容（不建标签、不改状态）。
 * 「重新打开为」与「差异比较」共用：分流阈值必须保持同一口径。
 */
export function readDiskAs(path: string, encoding: string): Promise<FileContent> {
  return invoke<FileContent>("reopen_with_encoding", {
    path,
    encoding,
    largeFileThreshold: settings.largeFileThreshold,
    logExtensions: getConfig().largeFile.logExtensions,
  });
}

export class FileService {
  constructor(private deps: FileServiceDeps) {}

  /** 从路径打开（文件树点击 / 工作区恢复 / 对话框共用） */
  async openFilePath(
    path: string,
    opts: { silent?: boolean; forceEditor?: boolean } = {},
  ): Promise<void> {
    const existing = tabStore.findByPath(path);
    if (existing) {
      tabStore.activate(existing.id);
      return;
    }
    const { showMessage } = this.deps;
    try {
      if (isImagePath(path)) {
        // 图片：base64 读取 → 只读查看器
        const img = await invoke<{
          path: string;
          name: string;
          size: number;
          data_url: string;
        }>("read_image_file", { path });
        tabStore.openImage(img.path, img.name, img.size, img.data_url);
        pushRecentFile(img.path);
        return;
      }
      // 文本：先探测体积与扩展名——命中分流规则则进入只读虚拟视图（不全量载入内存）
      if (!opts.forceEditor) {
        try {
          const probe = await invoke<{ size: number; extension: string }>("probe_file", {
            path,
          });
          if (this.deps.largeHost.needVirtualView(probe.size, probe.extension)) {
            const info = await this.deps.largeHost.openVirtualFile(path);
            if (info) {
              pushRecentFile(path);
              if (!opts.silent) {
                showMessage(`${info.name}：${info.totalLines} 行，已进入只读虚拟视图`);
              }
              return;
            }
          }
        } catch (e) {
          // 虚拟视图不可用（如 UTF-16）时回退编辑器路径
          console.warn("[large] 回退编辑器打开:", e);
        }
      }
      // 编辑器路径：经只读守卫——命中阈值或日志扩展名时仍载入但标记只读
      const data = await invoke<FileContent>("open_text_file", {
        path,
        largeFileThreshold: settings.largeFileThreshold,
        logExtensions: getConfig().largeFile.logExtensions,
      });
      const tab = tabStore.open(data);
      pushRecentFile(data.path);
      this.deps.onCheckMojibake(tab.id);
      if (opts.silent) return;
      if (tab.readonly) {
        showMessage(`${tab.readonlyReason}，已以只读方式打开`);
      } else if (data.encoding_confidence === "low") {
        showMessage(`已按 ${data.encoding} 解码（置信度低，可点击状态栏编码切换）`);
      }
    } catch (e) {
      if (!opts.silent) showMessage(`打开失败: ${String(e).split("\n")[0]}`);
    }
  }

  /** 工具栏打开按钮：对话框选择 */
  async openFileDialog(): Promise<void> {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "所有文件", extensions: ["*"] }],
    });
    if (typeof selected !== "string") return;
    await this.openFilePath(selected);
  }

  async saveFile(): Promise<void> {
    const tab = this.deps.getActiveTab();
    if (!tab) return;
    if (this.deps.blockIfReadonly()) return;
    if (!tab.path) {
      await this.saveFileAs();
      return;
    }
    await this.writeTo(tab, tab.path);
  }

  async saveFileAs(): Promise<void> {
    const tab = this.deps.getActiveTab();
    if (!tab) return;
    if (this.deps.blockIfReadonly()) return;
    const target = await save({ defaultPath: tab.name });
    if (typeof target !== "string") return;
    // 对话框期间用户可能已关闭/切换标签：必须重新校验，否则会把
    // 已放弃的标签内容写到磁盘上
    const current = tabStore.findById(tab.id);
    if (!current) {
      this.deps.showMessage("标签已关闭，已取消另存为");
      return;
    }
    await this.writeTo(current, target);
  }

  /** 另存为指定编码：编码对话框 → 系统保存对话框 */
  saveAsWithEncoding(): void {
    const tab = this.deps.getActiveTab();
    if (!tab || tab.kind !== "text") {
      this.deps.showMessage("请先打开一个文本文件");
      return;
    }
    if (this.deps.blockIfReadonly()) return;
    if (tab.virtual) {
      this.deps.showMessage("大文件只读视图不支持另存为");
      return;
    }
    this.deps.pickEncoding(
      tab.encodingCandidates.length ? tab.encodingCandidates : FALLBACK_ENCODINGS,
      tab.encoding,
      (encoding) => {
        void (async () => {
          const current = tabStore.findById(tab.id);
          if (!current) {
            this.deps.showMessage("标签已关闭，已取消另存为");
            return;
          }
          const target = await save({ defaultPath: current.name });
          if (typeof target !== "string") return;
          // 保存对话框期间标签可能已被关闭
          if (!tabStore.findById(tab.id)) {
            this.deps.showMessage("标签已关闭，已取消另存为");
            return;
          }
          try {
            await this.writeTo(current, target, encoding);
            this.deps.showMessage(`已按 ${encoding} 另存为：${basenameOf(target)}`);
          } catch (e) {
            this.deps.showMessage(`另存为失败: ${String(e).split("\n")[0]}`);
          }
        })();
      },
      `当前标签：${tab.name}`,
    );
  }

  /**
   * 读取剪贴板中的图片，存到文档同级的 `<文档名>.assets/` 目录，并在光标处插入引用。
   * Markdown 插入 `![](相对路径)`，其他语言插入相对路径文本。
   */
  async insertClipboardImage(): Promise<void> {
    const { showMessage } = this.deps;
    const tab = this.deps.getActiveTab();
    if (!tab || tab.kind !== "text") {
      showMessage("请先打开一个文本文件");
      return;
    }
    if (this.deps.blockIfReadonly()) return;
    if (!tab.path) {
      showMessage("请先保存文档，再插入剪贴板图片");
      return;
    }
    if (!navigator.clipboard?.read) {
      showMessage("当前环境不支持读取剪贴板图片");
      return;
    }

    let blob: Blob | null = null;
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (type) {
          blob = await item.getType(type);
          break;
        }
      }
    } catch (e) {
      showMessage(`读取剪贴板失败：${String(e).split("\n")[0]}`);
      return;
    }
    if (!blob) {
      showMessage("剪贴板中没有图片（请先截图或复制图片）");
      return;
    }

    const ext = blob.type === "image/jpeg" ? "jpg" : blob.type === "image/gif" ? "gif" : "png";
    const dir = tab.path.replace(/[\\/][^\\/]+$/, "");
    const base = tab.name.replace(/\.[^.]+$/, "") || "assets";
    const stamp = localStamps().local.replace(/[-: ]/g, "");
    const fileName = `image-${stamp}.${ext}`;
    const rel = `${base}.assets/${fileName}`;
    const absolute = `${dir}/${rel}`;

    try {
      const bytes = await blobToBase64(blob);
      await invoke<number>("write_binary_file", { path: absolute, base64Data: bytes });
    } catch (e) {
      showMessage(`图片写入失败：${String(e).split("\n")[0]}`);
      return;
    }

    this.deps.insertAtCursor(effectiveLanguage(tab) === "markdown" ? `![](${rel})` : rel);
    showMessage(`已插入图片：${rel}`);
  }

  /** 调 Rust 保存命令：保留换行符与 BOM（原子替换在 Rust 侧） */
  async writeTo(tab: Tab, path: string, encodingOverride?: string): Promise<void> {
    // 经 snapshotOf 取内容：激活标签会先把编辑器里的最新内容落回（惰性快照）
    const encoding = encodingOverride ?? tab.encoding;
    const newline = tab.newline;
    // 这份文本就是最终落盘的内容：保存期间的新输入不能算进基线
    const written = tabStore.snapshotOf(tab);
    const result = await invoke<SaveResult>("save_file", {
      path,
      content: written,
      newline,
      hasBom: tab.has_bom,
      encoding,
    });
    // 指定编码另存：标签编码与基线一并切到新编码，避免残留脏标记
    if (encodingOverride) tabStore.applySavedEncoding(tab.id, encodingOverride);
    if (path !== tab.path) {
      tabStore.setPath(tab.id, result.path, basenameOf(result.path));
    }
    const current = tabStore.findById(tab.id);
    if (current) {
      current.size = result.size;
    }
    tabStore.markSaved(tab.id, written, { encoding, newline });
    // 内容已落盘：草稿不再需要；但保存窗口内可能又输入了新内容，
    // 此时草稿必须按最新内容重写（直接丢弃会连新输入的兜底一起删掉）
    if (tabStore.findById(tab.id)?.dirty) this.deps.onPersistDraft(tab.id);
    else void this.deps.onDiscardDraft(tab.id);
    tabStore.markExternal(tab.id, false);
    this.deps.syncWatchedFiles();
    this.deps.refreshStatus();
    // 注意：与原实现一致，保存成功不弹消息（脏标记经 refresh 消失）
  }

  /** 未命名文档编号：取当前最小的空闲序号，保证同名标签可并存 */
  nextUntitledName(): string {
    const used = new Set<number>();
    for (const tab of tabStore.list()) {
      if (tab.path) continue;
      const m = /^未命名(?:-(\d+))?$/.exec(tab.name);
      if (m) used.add(m[1] ? Number(m[1]) : 1);
    }
    let n = 1;
    while (used.has(n)) n++;
    return `未命名-${n}`;
  }

  /** 新建未命名文档（可指定初始名称，用于草稿恢复） */
  newUntitled(name = this.nextUntitledName()): Tab {
    const content: FileContent = {
      path: "",
      name,
      size: 0,
      content: "",
      encoding: "UTF-8",
      encoding_confidence: "high",
      encoding_candidates: [],
      newline: "NONE",
      has_bom: false,
      readonly: false,
      readonly_reason: "",
    };
    return tabStore.open(content);
  }

  /** 打开一个带内容的未命名标签（格式转换 / 代码生成结果，标记为未保存） */
  openGeneratedTab(name: string, content: string, language: string): void {
    const data: FileContent = {
      path: "",
      name,
      size: new TextEncoder().encode(content).length,
      content,
      encoding: "UTF-8",
      encoding_confidence: "high",
      encoding_candidates: [],
      newline: "LF",
      has_bom: false,
      readonly: false,
      readonly_reason: "",
    };
    tabStore.open(data, { unsaved: true, languageOverride: language });
    this.deps.refreshStatus();
  }

  /** 打开 config.json（便于查看/编辑配置） */
  async openConfigFile(): Promise<void> {
    try {
      const path = await invoke<string>("config_path");
      await this.openFilePath(path);
    } catch (e) {
      this.deps.showMessage(`打开配置失败: ${String(e).split("\n")[0]}`);
    }
  }

  /** 重新加载 config.json（改完配置免重启生效） */
  async reloadConfig(): Promise<void> {
    const { showMessage } = this.deps;
    try {
      let cfgPath: string | null = null;
      try {
        cfgPath = await invoke<string>("config_path");
      } catch {
        cfgPath = null;
      }
      // 配置若在编辑器标签中改过但未保存，先询问是否落盘——否则重新读到的仍是旧值
      if (cfgPath) {
        const tab = tabStore.findByPath(cfgPath);
        if (tab?.dirty) {
          const ok = await confirmAction(
            "config.json 有未保存的修改，是否保存后再重新加载？",
            "保存并重新加载",
          );
          if (!ok) return; // 取消：不做任何改动，避免误丢编辑中的修改
          await this.writeTo(tab, cfgPath);
        }
      }
      const cfg = await loadSettings();
      showMessage("配置已重新加载");
      showConfigReloaded(cfgPath ?? "（未能获取配置路径）", configSummary(cfg));
    } catch (e) {
      showMessage(`重新加载配置失败: ${String(e).split("\n")[0]}`);
    }
  }
}

/** Blob → base64（去掉 data URL 前缀） */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** 配置关键值摘要（重新加载后的反馈内容） */
function configSummary(cfg: AppConfig): string[] {
  const e = cfg.editorEnhancements;
  return [
    `theme = ${cfg.theme}`,
    `tabSize = ${cfg.tabSize}　insertSpaces = ${cfg.insertSpaces}　formatOnSave = ${cfg.formatOnSave}`,
    `highlighterDisabledOver = ${cfg.highlighterDisabledOver} 行　longLineSkipChars = ${cfg.longLineSkipChars}`,
    `largeFileThreshold = ${cfg.largeFileThreshold} 字节`,
    `languageExtensions = ${Object.keys(cfg.languageExtensions).length} 条映射`,
    `showWhitespace = ${e.showWhitespace}　bracketMatching = ${e.bracketMatching}　indentGuides = ${e.indentGuides}`,
    `occurrenceHighlight = ${e.occurrenceHighlight}　columnSelection = ${e.columnSelection}`,
    `columnEditorKey = ${e.columnEditorKey}　columnSelectionModifier = ${e.columnSelectionModifier}`,
    `layout.sidebarVisible = ${cfg.layout.sidebarVisible}`,
    `fetch.allowPrivateNetwork = ${cfg.fetch.allowPrivateNetwork}`,
    `terminal.shell = ${cfg.terminal.shell || "（自动）"}`,
  ];
}
