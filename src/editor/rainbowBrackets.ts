import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  Decoration,
  type DecorationSet,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { language as languageFacet, syntaxTree } from "@codemirror/language";

/**
 * 彩虹括号（rainbow brackets，3.1 可读性辅助增强）。
 *
 * 自研 ViewPlugin（无外部依赖，与书签 gutter 同思路）：
 * - 仅扫描视口 ±50 行，逐字符跟踪嵌套深度，深度对 6 色取模着色；
 * - 开/闭括号同深度同色，实现「配对区分」；
 * - 语法树可用时跳过 字符串/注释/正则 子树内的括号，避免 `"("` 之类误着色；
 * - 行数超过 maxLines（默认 50000，与高亮降级阈值一致）时整体禁用；
 * - 仅在 docChanged / viewportChanged / 语言 facet 变化时重建，选择变化不触发。
 *
 * 配色（main.css --rb-0..5）：6 色相在色轮上 60° 均分，并按「暖 → 冷 → 暖 → 冷」
 * 交替排序（红 → 青 → 琥珀 → 蓝 → 绿 → 紫），保证相邻嵌套层级的色相差 ≥90°
 * （光谱顺序排列时红/橙/黄相邻仅差 ~30°，无法区分）；各色亮度/饱和度经调校
 * 使其在对应底色上视觉重量一致。颜色经 CSS 变量按主题分 palette 提供，
 * 装饰类仅作 `color: var(--rb-N)`，主题切换自动跟随。
 */

/** 颜色档位数（须与 main.css 中 .rbk-0..5 对应） */
const LEVELS = 6;

const OPEN_BRACKETS = "([{";
const CLOSE_BRACKETS = ")]}";

/** 需要遮罩（跳过其中括号）的语法树节点名 */
const MASKED_NODE = /string|comment|regex|template/i;

export interface RainbowBracketsOptions {
  /** 超过此行数整体禁用（默认 50000） */
  maxLines?: number;
  /** 视口上下多扫描的行数（滚动时提前就绪，默认 50） */
  padLines?: number;
}

export function rainbowBrackets(options: RainbowBracketsOptions = {}): Extension[] {
  const maxLines = options.maxLines ?? 50000;
  const padLines = options.padLines ?? 50;

  /** 收集 [from, to) 范围内的字符串/注释遮罩区间（升序） */
  function maskedRanges(state: EditorState, from: number, to: number): [number, number][] {
    const ranges: [number, number][] = [];
    try {
      syntaxTree(state).iterate({
        from,
        to,
        enter: (node) => {
          if (MASKED_NODE.test(node.name)) {
            ranges.push([node.from, node.to]);
            return false; // 不再进入子树
          }
          return true;
        },
      });
    } catch {
      // 语法树不可用（纯文本等）→ 退化为无遮罩扫描
    }
    return ranges;
  }

  function build(view: EditorView): DecorationSet {
    const { state } = view;
    if (state.doc.lines > maxLines) return Decoration.none;

    const firstLine = state.doc.lineAt(view.viewport.from).number;
    const lastLine = state.doc.lineAt(view.viewport.to).number;
    const fromLine = Math.max(1, firstLine - padLines);
    const toLine = Math.min(state.doc.lines, lastLine + padLines);
    const from = state.doc.line(fromLine).from;
    const to = state.doc.line(toLine).to;

    const masked = maskedRanges(state, from, to);
    const text = state.sliceDoc(from, to);

    const builder = new RangeSetBuilder<Decoration>();
    const stack: number[] = [];
    let mi = 0;

    for (let i = 0; i < text.length; i++) {
      const abs = from + i;
      // 跳过遮罩区间（字符串/注释/正则）
      while (mi < masked.length && masked[mi][1] <= abs) mi++;
      if (mi < masked.length) {
        const [mFrom, mTo] = masked[mi];
        if (abs >= mFrom && abs < mTo) {
          i = mTo - from - 1;
          continue;
        }
      }
      const ch = text[i];
      const oi = OPEN_BRACKETS.indexOf(ch);
      if (oi >= 0) {
        const level = stack.length % LEVELS;
        builder.add(abs, abs + 1, Decoration.mark({ class: `rbk rbk-${level}` }));
        stack.push(level);
        continue;
      }
      if (CLOSE_BRACKETS.indexOf(ch) >= 0 && stack.length > 0) {
        const level = stack.pop()!;
        builder.add(abs, abs + 1, Decoration.mark({ class: `rbk rbk-${level}` }));
      }
    }
    return builder.finish();
  }

  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = build(view);
        }
        update(update: ViewUpdate) {
          // 语言懒加载完成（facet 变化）时语法树才可用，需重建以启用遮罩
          if (
            update.docChanged ||
            update.viewportChanged ||
            update.startState.facet(languageFacet) !== update.state.facet(languageFacet)
          ) {
            this.decorations = build(update.view);
          }
        }
      },
      { decorations: (v) => v.decorations },
    ),
  ];
}
