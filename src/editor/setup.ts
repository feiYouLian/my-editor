/**
 * 编辑器装配。
 * 适用范围：仅 <20MB 文档；≥20MB 或 .log 不进入编辑器。
 * 性能保护：>50000 行或存在 >2000 字符超长行时整篇降级纯文本。
 *
 * 配置驱动：所有受配置影响的扩展均置于 Compartment，
 * 配置载入/变更后调用 handle.applySettings() 热更新，无需重建编辑器。
 *
 * 分层：键位表在 keymap.ts，配置驱动扩展在 extensions.ts，
 * 每标签状态缓存在 stateCache.ts；本文件只做 view 生命周期与状态机。
 */

import { EditorState, Transaction, type StateEffect } from "@codemirror/state";
import { EditorView, placeholder } from "@codemirror/view";
import { settings } from "../config/settings";
import { loadLanguage, languageKeyFromPath } from "./languages";
import {
  createCompartments,
  dynamicEffects,
  globalIndentStyle,
  hasLongLine,
  initialExtensions,
  perDocumentEffects,
  whitespaceExtension,
  wrapExtension,
  readOnlyExtensions,
  type EditorCompartments,
} from "./extensions";
import { detectIndent, type IndentStyle } from "../core/indentDetect";
import {
  addBookmark,
  addBookmarks,
  bookmarkLinesOf,
  removeBookmark,
  restoreBookmarkLines,
} from "./bookmarks";
import { foldEffect, foldedRanges, unfoldEffect } from "@codemirror/language";
import { DocumentStateCache } from "./stateCache";

/** 选区字符数（多选区求和；列选择会产生多个 range） */
function countSelectedChars(state: EditorState): number {
  let total = 0;
  for (const range of state.selection.ranges) total += range.to - range.from;
  return total;
}

export interface EditorCallbacks {
  /** 文档内容变化（用户输入或撤销/重做） */
  onDocChange?: () => void;
  /** 光标位置变化（selectedChars：所有选区字符数之和，列选择时为多选区） */
  onCursorChange?: (info: {
    line: number;
    col: number;
    totalLines: number;
    selectedChars: number;
  }) => void;
  /** 高亮因性能保护被禁用时通知一次 */
  onHighlightDisabled?: (reason: "lines" | "longLine") => void;
  /** 书签增删（用于把书签写进会话；已做 400ms 防抖，不必自己节流） */
  onBookmarkChange?: () => void;
  /** 折叠状态变化（同上） */
  onFoldChange?: () => void;
  /**
   * 切回某文档时发现其撤销历史已不可用（文档超 2MB 从未缓存，或缓存超 8 条被淘汰）。
   * 撤销静默失效最容易被误认为「编辑器坏了」，每个文档提示一次。
   */
  onUndoHistoryLost?: () => void;
}

export interface EditorHandle {
  view: EditorView;
  /**
   * 加载 / 激活文档。docId 为标签的稳定标识：
   * 同一 docId 且内容未变时恢复该标签缓存的状态（保留撤销历史与光标），
   * 内容变化或首次打开时重建状态。
   */
  loadDocument: (
    path: string,
    content: string,
    readonly?: boolean,
    languageOverride?: string | null,
    docId?: string,
  ) => Promise<void>;
  /** 关闭标签后丢弃其缓存状态 */
  forgetDocument: (docId: string) => void;
  /** 当前编辑器承载的文档标识（标签 id）；无文档时为 null。
   *  回调方用它校验编辑器内容是否仍与自己负责的标签一致 */
  docId: () => string | null;
  /** 标签切换外层窗口（探测 / 大文件视图等异步步骤）开始：
   *  期间抑制编辑器回调，避免把上一个文档的内容/光标写到新标签上 */
  beginSwitch: () => void;
  /** 标签切换外层窗口结束（loadDocument 完成后调用） */
  endSwitch: () => void;
  getContent: () => string;
  /** 切换高亮语言（不重载内容）：undefined = 自动，null = 纯文本，字符串 = 指定语言键 */
  setLanguage: (override: string | null | undefined) => Promise<void>;
  toggleWhitespace: () => void;
  /** 空白字符当前是否显示（状态栏体现用） */
  isWhitespaceOn: () => boolean;
  /** 自动换行开关 */
  setWordWrap: (on: boolean) => void;
  currentLanguage: () => string | null;
  /** 跳转到指定行（1 基）并聚焦编辑器 */
  gotoLine: (line: number) => void;
  /** 应用当前 settings 到编辑器（配置载入/热更新后调用） */
  applySettings: () => void;
  /**
   * 对整篇文档做一次文本变换（保存前清理用）。
   * history=false 时不进撤销栈：用户按一次 Ctrl+Z 不该"撤销一次看不见的空白清理"。
   */
  applyDocTransform: (fn: (text: string) => string, opts?: { history?: boolean }) => boolean;
  /** 当前文档的缩进风格（状态栏展示用） */
  indentStyle: () => IndentStyle;
  /** 手动指定当前文档的缩进（会话级，不写配置） */
  setIndent: (style: IndentStyle) => void;
  /** 某标签的书签行号（会话保存用；标签已关闭时返回空数组） */
  bookmarksOf: (docId: string) => number[];
  /** 恢复某标签的书签（标签尚未载入时排队，载入后生效） */
  restoreBookmarks: (docId: string, lines: number[]) => void;
  /** 某标签的折叠区（[起始行, 结束行]，1 基；会话保存用） */
  foldsOf: (docId: string) => number[][];
  /** 恢复某标签的折叠区（未载入时排队） */
  restoreFolds: (docId: string, ranges: number[][]) => void;
}

export function createEditor(parent: HTMLElement, callbacks: EditorCallbacks): EditorHandle {
  const c: EditorCompartments = createCompartments();

  /** loadDocument 重入计数：并发加载期间抑制 dirty 回调（替代单布尔量，
   *  避免快速连点标签时先到的 finally 提前释放抑制状态） */
  let loadingDepth = 0;
  /** 载入代号：每次 loadDocument 递增，await 后校验，过期载入不得再写任何状态 */
  let docLoadSeq = 0;
  /** 语言应用代号：每次 applyLanguage / forgetDocument 递增，
   *  比 activeDocKey 守卫更可靠（A → B → A 快速切换时 docKey 会相等） */
  let languageSeq = 0;
  /** 标签切换外层窗口（loadActiveTab 中 loadDocument 之前的异步步骤） */
  let switching = false;
  let languageKey: string | null = null;
  let currentPath = "";
  let whitespaceOn = settings.showWhitespace;
  let wordWrapOn = settings.wordWrap;
  /** 当前生效的只读态（切换标签时随文档恢复） */
  let currentReadonly = false;
  /** 当前文档的缩进风格（检测优先，未启用/不可靠时取全局配置） */
  let currentIndent: IndentStyle = globalIndentStyle();
  /** 每个文档检测到的缩进：会话级（不落配置，重启重新检测） */
  const indentByDoc = new Map<string, IndentStyle>();
  /**
   * 每个文档的书签行号（会话持久化用）。
   * 不直接读 stateCache：缓存有 8 条的淘汰上限，超出的标签会丢书签。
   */
  const bookmarksByDoc = new Map<string, number[]>();
  /** 恢复会话时暂存的书签：目标标签尚未载入（占位标签）时排队，载入后再应用 */
  const pendingBookmarks = new Map<string, number[]>();
  /** 每文档的折叠区（[起始行, 结束行]，1 基）：会话持久化用 */
  const foldsByDoc = new Map<string, number[][]>();
  /** 待恢复的折叠区（标签尚未载入） */
  const pendingFolds = new Map<string, number[][]>();

  const stateCache = new DocumentStateCache();
  /** 已提示过「撤销历史已释放」的文档（避免每次切回都刷状态栏） */
  const undoLostWarned = new Set<string>();
  let activeDocKey: string | null = null;
  /** 配置（含空白 / 换行等开关）每次变更 +1，用于判断缓存状态是否过期 */
  let configGeneration = 0;

  /** 取该文档的缩进风格：已检测过直接复用，否则按内容检测一次 */
  function resolveIndent(docKey: string | null, content: string): IndentStyle {
    if (!settings.detectIndent) return globalIndentStyle();
    if (docKey) {
      const cached = indentByDoc.get(docKey);
      if (cached) return cached;
    }
    const detected = detectIndent(content, {
      tabSize: settings.tabSize,
      insertSpaces: settings.insertSpaces,
    });
    if (docKey) indentByDoc.set(docKey, detected);
    return detected;
  }

  /** 当前状态的折叠区（[起始行, 结束行]，1 基） */
  function foldsOf(state: EditorState): number[][] {
    const out: number[][] = [];
    foldedRanges(state).between(0, state.doc.length, (from, to) => {
      out.push([state.doc.lineAt(from).number, state.doc.lineAt(to).number]);
    });
    return out;
  }

  /** 按行号对恢复折叠：越界 / 非法区间忽略（文件被外部改动后行数可能变少） */
  function restoreFoldRanges(target: EditorView, ranges: readonly number[][]): void {
    const doc = target.state.doc;
    const effects: StateEffect<{ from: number; to: number }>[] = [];
    for (const range of ranges) {
      if (!Array.isArray(range) || range.length < 2) continue;
      const fromLine = Math.max(1, Math.min(Math.floor(range[0]), doc.lines));
      const toLine = Math.max(1, Math.min(Math.floor(range[1]), doc.lines));
      if (toLine <= fromLine) continue;
      effects.push(foldEffect.of({ from: doc.line(fromLine).from, to: doc.line(toLine).to }));
    }
    if (effects.length > 0) target.dispatch({ effects });
  }

  function createState(doc: string): EditorState {
    // history 等基础扩展已在 initialExtensions 内（勿重复添加：双 history = 双撤销栈）
    return EditorState.create({
      doc,
      extensions: [
        ...initialExtensions(c, {
          whitespaceOn,
          wordWrapOn,
          readonly: currentReadonly,
          indent: currentIndent,
        }),
        placeholder("打开文件开始编辑（Ctrl+S 保存）"),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && loadingDepth === 0 && !switching) {
            callbacks.onDocChange?.();
          }
          // 书签变化：记到内存映射并通知会话落盘（书签不是文档内容，不能靠 docChanged 捕获）
          const bookmarkTouched = update.transactions.some((tr) =>
            tr.effects.some(
              (e) => e.is(addBookmark) || e.is(addBookmarks) || e.is(removeBookmark),
            ),
          );
          if (bookmarkTouched && activeDocKey !== null && !switching) {
            bookmarksByDoc.set(activeDocKey, bookmarkLinesOf(update.state));
            callbacks.onBookmarkChange?.();
          }
          // 折叠状态同理：不进文档内容，只能靠 effect 捕获
          const foldTouched = update.transactions.some((tr) =>
            tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)),
          );
          if (foldTouched && activeDocKey !== null && !switching) {
            foldsByDoc.set(activeDocKey, foldsOf(update.state));
            callbacks.onFoldChange?.();
          }
          if ((update.selectionSet || update.docChanged) && !switching) {
            const head = update.state.selection.main.head;
            const line = update.state.doc.lineAt(head);
            callbacks.onCursorChange?.({
              line: line.number,
              col: head - line.from + 1,
              totalLines: update.state.doc.lines,
              selectedChars: countSelectedChars(update.state),
            });
          }
        }),
      ],
    });
  }

  /** 缓存当前状态；超大文档不缓存（见 DocumentStateCache） */
  function cacheActiveState(key: string): void {
    const state = view.state;
    stateCache.set(key, {
      state,
      generation: configGeneration,
      langKey: languageKey,
      readonly: currentReadonly,
    });
  }

  const view = new EditorView({ parent, state: createState("") });

  /**
   * 应用高亮语言。
   * override：undefined = 按当前文件扩展名自动；null = 纯文本；字符串 = 指定语言键。
   * 性能保护（行数超限 / 超长行）优先于语言加载，命中时整篇降级纯文本。
   */
  async function applyLanguage(override: string | null | undefined): Promise<void> {
    const token = ++languageSeq;
    const key = override === undefined ? languageKeyFromPath(currentPath) : override;

    const tooManyLines = view.state.doc.lines > settings.highlighterDisabledOver;
    // 行数已超限时无需再逐行扫描超长行
    const longLine = !tooManyLines && hasLongLine(view.state);
    if (tooManyLines || longLine) {
      languageKey = null; // 高亮被性能保护禁用，状态栏按纯文本展示
      view.dispatch({ effects: c.language.reconfigure([]) });
      callbacks.onHighlightDisabled?.(tooManyLines ? "lines" : "longLine");
      return;
    }
    const support = key ? await loadLanguage(key) : null;
    // 语言包加载期间可能已切换标签 / 关闭文档：过期结果丢弃
    if (token !== languageSeq) return;
    languageKey = key;
    view.dispatch({ effects: c.language.reconfigure(support ? [support] : []) });
  }

  /** 手动广播光标信息：setState 不触发 updateListener，切标签后状态栏需主动刷新 */
  function notifyCursor(state: EditorState): void {
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    callbacks.onCursorChange?.({
      line: line.number,
      col: head - line.from + 1,
      totalLines: state.doc.lines,
      selectedChars: countSelectedChars(state),
    });
  }

  async function loadDocument(
    path: string,
    content: string,
    readonly = false,
    languageOverride?: string | null,
    docId?: string,
  ): Promise<void> {
    const seq = ++docLoadSeq;
    const key = docId ?? null;
    const sameDoc =
      key !== null && activeDocKey === key && view.state.doc.toString() === content;
    loadingDepth++;
    try {
      currentPath = path;
      currentReadonly = readonly;
      // 缩进按文档生效：必须先算，后面 createState / dynamicEffects 都要用
      currentIndent = resolveIndent(key, content);
      if (!sameDoc) {
        // 离开当前标签：先把状态（含撤销历史）存起来
        if (activeDocKey !== null) cacheActiveState(activeDocKey);
        const cached = key !== null ? stateCache.get(key) : undefined;
        // 先取光标再删：delete 会连超限文档的光标记录一起清掉
        const cursor = key !== null ? stateCache.takeCursor(key) : undefined;
        if (key !== null) stateCache.delete(key);
        if (cached && cached.state.doc.toString() === content) {
          view.setState(cached.state);
          languageKey = cached.langKey;
          // 先落 docId：语言加载 / 光标广播都依赖它判断当前文档
          activeDocKey = key;
          const scroll = EditorView.scrollIntoView(
            cached.state.selection.main.head,
            { y: "nearest" },
          );
          if (cached.generation === configGeneration) {
            // 快速路径：配置未变，无需重建扩展开关。
            // 只读态必须按目标标签重配：视图当前只读态属于上一个标签，
            // 若因 cached.readonly === readonly 跳过，上一个标签的只读态
            // 会残留到当前标签（如只读日志切到可写文件后仍无法输入）。
            view.dispatch({
              effects: [
                c.readOnly.reconfigure(readOnlyExtensions(readonly)),
                // 按文档生效的扩展（缩进 / 自动闭合 / 补全）即使在快速路径也要重配，
                // 否则会停留在上一个标签的值上（例如缩进宽度串味）
                ...perDocumentEffects(c, { readonly, indent: currentIndent }),
                scroll,
              ],
            });
          } else {
            view.dispatch({
              effects: [
                ...dynamicEffects(c, { whitespaceOn, wordWrapOn, readonly, indent: currentIndent }),
                scroll,
              ],
            });
            await applyLanguage(languageOverride);
            if (seq !== docLoadSeq) return;
          }
        } else {
          // 新状态在创建时即按当前配置与只读态构建
          view.setState(createState(content));
          languageKey = null;
          activeDocKey = key;
          // 没有可复用的缓存状态：撤销栈已被释放（超 2MB 从未缓存 / 缓存超 8 条被淘汰）。
          // 每个文档只提示一次，避免切来切去反复打扰。
          if (key !== null && !cached && !undoLostWarned.has(key)) {
            undoLostWarned.add(key);
            callbacks.onUndoHistoryLost?.();
          }
          if (cursor !== undefined) {
            // 超限文档没有缓存状态：至少恢复光标，否则切回会跳回文首
            const head = Math.min(cursor, view.state.doc.length);
            view.dispatch({
              selection: { anchor: head },
              effects: EditorView.scrollIntoView(head, { y: "nearest" }),
            });
          }
          await applyLanguage(languageOverride);
          if (seq !== docLoadSeq) return;
        }
      } else {
        view.dispatch({
          effects: dynamicEffects(c, { whitespaceOn, wordWrapOn, readonly, indent: currentIndent }),
        });
        await applyLanguage(languageOverride);
        if (seq !== docLoadSeq) return;
      }
      // 恢复书签 / 折叠：占位标签首次载入、从缓存恢复时都走这里
      if (key !== null && activeDocKey === key) {
        const pending = pendingBookmarks.get(key);
        if (pending && pending.length > 0) {
          pendingBookmarks.delete(key);
          restoreBookmarkLines(view, pending);
          bookmarksByDoc.set(key, bookmarkLinesOf(view.state));
        }
        const pendingFold = pendingFolds.get(key);
        if (pendingFold && pendingFold.length > 0) {
          pendingFolds.delete(key);
          restoreFoldRanges(view, pendingFold);
          foldsByDoc.set(key, foldsOf(view.state));
        }
      }
      // 快速连点标签时，晚到的载入不要覆盖当前标签的状态栏光标
      if (activeDocKey === key) notifyCursor(view.state);
    } finally {
      loadingDepth--;
    }
  }

  /** 关闭标签时丢弃其缓存状态；若关闭的是当前标签，避免下次切换再把它写回缓存 */
  function forgetDocument(docId: string): void {
    stateCache.delete(docId);
    undoLostWarned.delete(docId);
    indentByDoc.delete(docId);
    bookmarksByDoc.delete(docId);
    pendingBookmarks.delete(docId);
    foldsByDoc.delete(docId);
    pendingFolds.delete(docId);
    // 作废在飞的语言加载：否则关闭后它仍可能把语言作用到其它文档
    languageSeq++;
    if (activeDocKey === docId) {
      activeDocKey = null;
      // 同时清空视图与语言高亮：否则已关闭文档的内容/语言会残留显示，
      // 且在飞的 applyLanguage 早已被守卫拦截，languageCompartment 不会自愈
      currentReadonly = false;
      view.setState(createState(""));
      languageKey = null;
    }
  }

  /** 配置热更新：将当前 settings 应用到编辑器各 Compartment */
  function applySettings(): void {
    whitespaceOn = settings.showWhitespace;
    wordWrapOn = settings.wordWrap;
    configGeneration++;
    // 关闭"检测缩进"后立即回落到全局配置；开启时沿用当前文档已检测的结果
    currentIndent = settings.detectIndent
      ? (activeDocKey !== null ? indentByDoc.get(activeDocKey) : undefined) ??
        resolveIndent(activeDocKey, view.state.doc.toString())
      : globalIndentStyle();
    view.dispatch({
      effects: dynamicEffects(c, {
        whitespaceOn,
        wordWrapOn,
        readonly: currentReadonly,
        indent: currentIndent,
      }),
    });
  }

  return {
    view,
    loadDocument,
    forgetDocument,
    docId: () => activeDocKey,
    beginSwitch: () => {
      switching = true;
    },
    endSwitch: () => {
      switching = false;
    },
    setLanguage: applyLanguage,
    getContent: () => view.state.doc.toString(),
    toggleWhitespace: () => {
      whitespaceOn = !whitespaceOn;
      configGeneration++;
      view.dispatch({ effects: c.whitespace.reconfigure(whitespaceExtension(whitespaceOn)) });
    },
    isWhitespaceOn: () => whitespaceOn,
    setWordWrap: (on: boolean) => {
      wordWrapOn = on;
      configGeneration++;
      view.dispatch({ effects: c.wrap.reconfigure(wrapExtension(on)) });
    },
    currentLanguage: () => languageKey,
    gotoLine: (line: number) => {
      const n = Math.min(Math.max(1, line), view.state.doc.lines);
      const from = view.state.doc.line(n).from;
      view.dispatch({ selection: { anchor: from }, scrollIntoView: true });
      view.focus();
    },
    bookmarksOf: (docId) => {
      if (docId === activeDocKey) {
        const live = bookmarkLinesOf(view.state);
        bookmarksByDoc.set(docId, live);
        return live;
      }
      return bookmarksByDoc.get(docId) ?? [];
    },
    restoreBookmarks: (docId, lines) => {
      if (lines.length === 0) return;
      bookmarksByDoc.set(docId, lines);
      if (docId === activeDocKey) {
        restoreBookmarkLines(view, lines);
        bookmarksByDoc.set(docId, bookmarkLinesOf(view.state));
      } else {
        // 占位标签 / 未激活标签：等 loadDocument 载入后再应用
        pendingBookmarks.set(docId, lines);
      }
    },
    foldsOf: (docId) => {
      if (docId === activeDocKey) {
        const live = foldsOf(view.state);
        foldsByDoc.set(docId, live);
        return live;
      }
      return foldsByDoc.get(docId) ?? [];
    },
    restoreFolds: (docId, ranges) => {
      if (ranges.length === 0) return;
      foldsByDoc.set(docId, ranges);
      if (docId === activeDocKey) {
        restoreFoldRanges(view, ranges);
        foldsByDoc.set(docId, foldsOf(view.state));
      } else {
        pendingFolds.set(docId, ranges);
      }
    },
    indentStyle: () => currentIndent,
    setIndent: (style) => {
      currentIndent = style;
      if (activeDocKey !== null) indentByDoc.set(activeDocKey, style);
      configGeneration++;
      view.dispatch({
        effects: perDocumentEffects(c, { readonly: currentReadonly, indent: style }),
      });
    },
    applyDocTransform: (fn, opts) => {
      const before = view.state.doc.toString();
      const after = fn(before);
      if (after === before) return false;
      view.dispatch({
        changes: { from: 0, to: before.length, insert: after },
        annotations:
          opts?.history === false ? Transaction.addToHistory.of(false) : undefined,
      });
      return true;
    },
    applySettings,
  };
}
