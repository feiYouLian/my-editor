/**
 * 编辑器剪贴板操作（CM6 view 级，供右键菜单与命令面板共用）。
 * 多选区合并为换行分隔文本；cut 仅在可编辑时删除选区。
 */

import type { EditorView } from "@codemirror/view";

/** 将选区写入系统剪贴板；cut 为真时同时删除选区 */
export async function copyFromEditor(
  view: EditorView,
  cut: boolean,
  onError: (message: string) => void,
): Promise<void> {
  const { ranges } = view.state.selection;
  if (ranges.every((r) => r.empty)) return;
  const text = ranges.map((r) => view.state.sliceDoc(r.from, r.to)).join("\n");
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    onError(`写入剪贴板失败：${String(e).split("\n")[0]}`);
    return;
  }
  if (cut && !view.state.readOnly) {
    const changes = ranges.map((r) => ({ from: r.from, to: r.to, insert: "" }));
    view.dispatch({ changes, selection: { anchor: changes[0].from } });
  }
  view.focus();
}

/** 将系统剪贴板文本粘贴到当前选区 */
export async function pasteIntoEditor(
  view: EditorView,
  onError: (message: string) => void,
): Promise<void> {
  if (view.state.readOnly) return;
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch (e) {
    onError(`读取剪贴板失败：${String(e).split("\n")[0]}`);
    return;
  }
  if (!text) return;
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
  });
  view.focus();
}
