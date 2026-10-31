/**
 * 文件树目录监听（G2）：只监听已展开目录，事件按目录合并后回调。
 * Rust 侧 watch_dirs 为非递归监听；前端 300ms 防抖，避免一次批量操作刷新多次。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface TreeChangedPayload {
  dir: string;
  paths: string[];
}

const MAX_WATCH_DIRS = 200;
const DEBOUNCE_MS = 300;

export class TreeWatcher {
  private unlisten: UnlistenFn | null = null;
  private timer: number | null = null;
  private pending = new Set<string>();
  private currentDirs: string[] = [];
  private starting: Promise<void> | null = null;
  /** setDirs 代际：快速展开/折叠时只让最后一次真正下发 */
  private seq = 0;

  constructor(
    private readonly onChanged: (dirs: string[]) => void,
    private readonly onLimit?: () => void,
  ) {}

  async start(): Promise<void> {
    if (this.unlisten) return;
    if (this.starting) return this.starting;
    this.starting = listen<TreeChangedPayload>("tree://changed", (event) => {
      const dir = event.payload?.dir;
      if (!dir) return;
      this.pending.add(dir);
      this.schedule();
    })
      .then((unlisten) => {
        this.unlisten = unlisten;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  /** 目录集合变化时重建监听（去重、上限 200、未变化不请求） */
  async setDirs(dirs: string[]): Promise<void> {
    const unique = [...new Set(dirs.filter(Boolean))];
    if (unique.length > MAX_WATCH_DIRS) this.onLimit?.();
    const next = unique.slice(0, MAX_WATCH_DIRS);
    if (next.length === this.currentDirs.length && next.every((d, i) => d === this.currentDirs[i])) {
      return;
    }
    const seq = ++this.seq;
    this.currentDirs = next;
    await this.start();
    if (seq !== this.seq) return; // 已有更新的目录集合，交给它下发
    try {
      await invoke<number>("watch_dirs", { paths: next });
    } catch (e) {
      // 监听失败不阻塞文件树使用；下一次目录变化会重试
      console.warn("[tree-watch] 重建监听失败", e);
    }
  }

  stop(): void {
    this.seq += 1;
    this.unlisten?.();
    this.unlisten = null;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
    this.currentDirs = [];
    void invoke("watch_dirs", { paths: [] }).catch(() => {});
  }

  private schedule(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      const dirs = [...this.pending];
      this.pending.clear();
      if (dirs.length > 0) this.onChanged(dirs);
    }, DEBOUNCE_MS);
  }
}
