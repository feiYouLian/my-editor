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

import { EditorState } from "@codemirror/state";
import { EditorView, placeholder } from "@codemirror/view";
import { settings } from "../config/settings";
import { loadLanguage, languageKeyFromPath } from "./languages";
import {
  createCompartments,
  dynamicEffects,
  hasLongLine,
  initialExtensions,
  whitespaceExtension,
  wrapExtension,
  readOnlyExtensions,
  type EditorCompartments,
} from "./extensions";
import { DocumentStateCache } from "./stateCache";

export interface EditorCallbacks {
  /** 文档内容变化（用户输入或撤销/重做） */
  onDocChange?: () => void;
  /** 光标位置变化 */
  onCursorChange?: (info: { line: number; col: number; totalLines: number }) => void;
  /** 高亮因性能保护被禁用时通知一次 */
  onHighlightDisabled?: (reason: "lines" | "longLine") => void;
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

  const stateCache = new DocumentStateCache();
  let activeDocKey: string | null = null;
  /** 配置（含空白 / 换行等开关）每次变更 +1，用于判断缓存状态是否过期 */
  let configGeneration = 0;

  function createState(doc: string): EditorState {
    // history 等基础扩展已在 initialExtensions 内（勿重复添加：双 history = 双撤销栈）
    return EditorState.create({
      doc,
      extensions: [
        ...initialExtensions(c, { whitespaceOn, wordWrapOn, readonly: currentReadonly }),
        placeholder("打开文件开始编辑（Ctrl+S 保存）"),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && loadingDepth === 0 && !switching) {
            callbacks.onDocChange?.();
          }
          if ((update.selectionSet || update.docChanged) && !switching) {
            const head = update.state.selection.main.head;
            const line = update.state.doc.lineAt(head);
            callbacks.onCursorChange?.({
              line: line.number,
              col: head - line.from + 1,
              totalLines: update.state.doc.lines,
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
                scroll,
              ],
            });
          } else {
            view.dispatch({
              effects: [
                ...dynamicEffects(c, { whitespaceOn, wordWrapOn, readonly }),
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
          effects: dynamicEffects(c, { whitespaceOn, wordWrapOn, readonly }),
        });
        await applyLanguage(languageOverride);
        if (seq !== docLoadSeq) return;
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
    view.dispatch({
      effects: dynamicEffects(c, { whitespaceOn, wordWrapOn, readonly: currentReadonly }),
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
    applySettings,
  };
}
