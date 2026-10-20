import type { EditorView } from "@codemirror/view";

/**
 * Markdown 编辑工具：选中文本包裹 / 取消包裹，插入 GFM 表格。
 */

/**
 * 成对标记包裹切换：
 * 选区外侧已是标记 → 去掉外侧；选区自身被标记包围 → 去掉首尾；
 * 否则包裹（空选区时插入标记并把光标放到中间）。
 */
export function toggleWrap(view: EditorView, marker: string): { ok: boolean; message: string } {
  const range = view.state.selection.main;
  const len = marker.length;
  const { from, to } = range;
  const text = view.state.sliceDoc(from, to);

  if (from - len >= 0 && to + len <= view.state.doc.length) {
    const outer = view.state.sliceDoc(from - len, to + len);
    if (outer === marker + text + marker) {
      view.dispatch({
        changes: [
          { from: from - len, to: from, insert: "" },
          { from: to, to: to + len, insert: "" },
        ],
        selection: { anchor: from - len, head: to - len },
      });
      return { ok: true, message: `已取消 ${marker} 包裹` };
    }
  }

  if (text.length >= len * 2 && text.startsWith(marker) && text.endsWith(marker)) {
    const inner = text.slice(len, text.length - len);
    view.dispatch({
      changes: { from, to, insert: inner },
      selection: { anchor: from, head: from + inner.length },
    });
    return { ok: true, message: `已取消 ${marker} 包裹` };
  }

  const wrapped = `${marker}${text}${marker}`;
  view.dispatch({
    changes: { from, to, insert: wrapped },
    selection: text === "" ? { anchor: from + len } : { anchor: from, head: from + wrapped.length },
  });
  return { ok: true, message: `已用 ${marker} 包裹选区` };
}

/** 生成 GFM 表格文本（1 行表头 + 分隔行 + bodyRows 行空数据行） */
export function buildMarkdownTable(cols: number, bodyRows: number): string {
  const header = `| ${Array.from({ length: cols }, (_, i) => `列${i + 1}`).join(" | ")} |`;
  const divider = `| ${Array.from({ length: cols }, () => "---").join(" | ")} |`;
  const rows = Array.from(
    { length: bodyRows },
    () => `| ${Array.from({ length: cols }, () => "   ").join(" | ")} |`,
  );
  return [header, divider, ...rows].join("\n");
}

/** 在光标处插入表格；光标所在行非空时先换行，避免与上下文粘连 */
export function insertTable(
  view: EditorView,
  cols: number,
  bodyRows: number,
): { ok: boolean; message: string } {
  if (!Number.isInteger(cols) || cols < 1 || cols > 12) {
    return { ok: false, message: "列数需为 1-12 的整数" };
  }
  if (!Number.isInteger(bodyRows) || bodyRows < 0 || bodyRows > 50) {
    return { ok: false, message: "数据行数需为 0-50 的整数" };
  }
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const lead = line.from === pos ? "" : "\n";
  const text = `${lead}${buildMarkdownTable(cols, bodyRows)}\n`;
  view.dispatch({
    changes: { from: pos, to: pos, insert: text },
    // 光标落到首个表头单元格内（"| " 之后）
    selection: { anchor: pos + lead.length + 2 },
  });
  return { ok: true, message: `已插入 ${cols} 列 ${bodyRows} 行表格` };
}
