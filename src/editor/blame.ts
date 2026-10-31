/**
 * 当前行 Git Blame 内联扩展：在光标所在行尾显示「作者 · 日期 · 摘要」。
 *
 * 数据由 app 层按光标位置写入（setBlameAnnotation）；本文件只负责：
 * - 文档变更时自动清空，避免行号错位后继续显示旧信息；
 * - 只在当前行尾挂一个 widget，不增加整篇 DOM。
 */

import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";

export interface BlameAnnotation {
  /** 1 基行号 */
  line: number;
  hash: string;
  shortHash: string;
  author: string;
  authorTime: number;
  summary: string;
}

export const setBlameAnnotation = StateEffect.define<BlameAnnotation | null>();

const blameField = StateField.define<BlameAnnotation | null>({
  create: () => null,
  update(value, tr) {
    // 编辑后行号已不可信：先隐藏，保存/重新拉取后再显示
    if (tr.docChanged) return null;
    for (const effect of tr.effects) {
      if (effect.is(setBlameAnnotation)) return effect.value;
    }
    return value;
  },
});

class BlameWidget extends WidgetType {
  constructor(private readonly info: BlameAnnotation) {
    super();
  }

  eq(other: BlameWidget): boolean {
    return (
      this.info.line === other.info.line &&
      this.info.hash === other.info.hash &&
      this.info.author === other.info.author &&
      this.info.summary === other.info.summary
    );
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-inline-blame";
    const date = this.info.authorTime
      ? new Date(this.info.authorTime * 1000).toLocaleDateString()
      : "";
    span.textContent = [this.info.author || "未知作者", date, this.info.summary]
      .filter(Boolean)
      .join(" · ");
    span.title = [
      this.info.hash,
      this.info.summary,
      `${this.info.author || "未知作者"}${date ? ` · ${date}` : ""}`,
    ]
      .filter(Boolean)
      .join("\n");
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const blameDecorations = EditorView.decorations.compute(
  [blameField, "selection"],
  (state) => {
    const info = state.field(blameField);
    if (!info || info.line < 1 || info.line > state.doc.lines) return Decoration.none;
    const line = state.doc.line(info.line);
    return Decoration.set([
      Decoration.widget({ widget: new BlameWidget(info), side: 1 }).range(line.to),
    ]);
  },
);

export const inlineBlameExtension = [blameField, blameDecorations];
