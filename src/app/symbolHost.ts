/**
 * 符号定位（F12「转到定义」）：文本级，**不是 LSP**。
 *
 * 分工：后端 `find_symbols`（commands/search.rs）只回命中位置与"是不是定义"的启发式分类；
 * 这里负责取当前词、决定直接跳还是弹候选、以及跳过去。
 *
 * 明确取舍：没有类型解析，因此重载 / 宏生成 / 同名不同义会不准。
 * 换来的是零新依赖、无索引、无常驻内存——与「不引入 LSP」的轻量红线一致。
 */

import { invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";

import { tabStore } from "../store/tabs";
import { openStatusMenu } from "../ui/statusMenu";

interface SymbolHit {
  path: string;
  relative: string;
  line: number;
  col: number;
  /** 定义种类（fn / class / method …）；空串 = 只是引用 */
  kind: string;
  text: string;
}

export interface SymbolHostDeps {
  getView: () => EditorView | null;
  getWorkspaceRoot: () => string | null;
  getIgnoreDirs: () => string[];
  /** 打开文件并跳到指定行（复用运行输出堆栈点击那条路径） */
  openAt: (path: string, line: number) => Promise<void>;
  showMessage: (text: string) => void;
}

/** 候选上限：超过这个量说明这个词太常见（如 get），菜单也挑不动 */
const MAX_HITS = 50;
/** 菜单里每行的行文本截断长度 */
const LABEL_TEXT_CHARS = 48;

function clip(text: string): string {
  const one = text.trim().replace(/\s+/g, " ");
  return one.length > LABEL_TEXT_CHARS ? `${one.slice(0, LABEL_TEXT_CHARS)}…` : one;
}

export class SymbolHost {
  constructor(private readonly deps: SymbolHostDeps) {}

  async jumpToDefinition(): Promise<void> {
    const { getView, getWorkspaceRoot, getIgnoreDirs, openAt, showMessage } = this.deps;

    const view = getView();
    if (!view) return;
    const root = getWorkspaceRoot();
    if (!root) {
      showMessage("转到定义需要先打开工作区：文件 → 打开目录");
      return;
    }

    const pos = view.state.selection.main.head;
    const range = view.state.wordAt(pos);
    const word = (range ? view.state.sliceDoc(range.from, range.to) : "").trim();
    if (!word) {
      showMessage("光标不在标识符上：把光标移到函数名 / 类名上再按 F12");
      return;
    }

    let hits: SymbolHit[];
    try {
      hits = await invoke<SymbolHit[]>("find_symbols", {
        root,
        word,
        ignoreDirs: getIgnoreDirs(),
        maxHits: MAX_HITS,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      showMessage(`符号定位失败：${reason.split("\n")[0]}`);
      return;
    }

    if (hits.length === 0) {
      showMessage(
        `工作区里没有「${word}」（只扫 < 2MB 的文本文件，跳过 node_modules 等忽略目录）`,
      );
      return;
    }

    // 唯一命中直接跳：F12 的主场景就是"就那一个"
    if (hits.length === 1) {
      const hit = hits[0];
      await openAt(hit.path, hit.line);
      showMessage(`${hit.kind ? `[${hit.kind}] ` : ""}${hit.relative}:${hit.line}`);
      return;
    }

    const definitions = hits.filter((hit) => hit.kind !== "").length;
    const coords = view.coordsAtPos(pos);
    const anchor = coords ? { x: coords.right, y: coords.bottom } : { x: 60, y: 100 };
    openStatusMenu<SymbolHit | null>({
      anchor,
      header:
        definitions > 0
          ? `「${word}」：${definitions} 处定义`
          : `「${word}」：没有定义，以下是 ${hits.length} 处引用`,
      options: hits.map((hit) => ({
        value: hit,
        label: `${hit.kind ? `[${hit.kind}] ` : ""}${hit.relative}:${hit.line}　${clip(hit.text)}`,
      })),
      current: null,
      tabId: tabStore.active()?.id ?? "",
      onMessage: showMessage,
      onPick: (hit) => {
        if (hit) void openAt(hit.path, hit.line);
      },
    });
  }
}
