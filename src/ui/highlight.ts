/**
 * 命中字符高亮：把指定下标的字符包进 <mark>。
 *
 * 只用 textContent / createTextNode 拼装，不碰 innerHTML —— 文件名里出现
 * `<img onerror=...>` 也只会被当作普通字符显示。
 */

/** 把 text 按 positions（下标集合）切段渲染到 host */
export function appendHighlighted(host: HTMLElement, text: string, positions: Set<number>): void {
  if (positions.size === 0) {
    host.append(document.createTextNode(text));
    return;
  }
  let buffer = "";
  let markBuffer = "";
  const flushText = (): void => {
    if (buffer) {
      host.append(document.createTextNode(buffer));
      buffer = "";
    }
  };
  const flushMark = (): void => {
    if (markBuffer) {
      const mark = document.createElement("mark");
      mark.textContent = markBuffer;
      host.append(mark);
      markBuffer = "";
    }
  };
  for (let i = 0; i < text.length; i++) {
    if (positions.has(i)) {
      flushText();
      markBuffer += text[i];
    } else {
      flushMark();
      buffer += text[i];
    }
  }
  flushMark();
  flushText();
}
