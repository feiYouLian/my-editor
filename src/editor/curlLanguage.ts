/**
 * cURL 轻量语法高亮（手写 StreamLanguage，约 100 行）。
 *
 * 覆盖：注释行 / 短长选项 / URL / 双单引号串 / 行尾续行。
 * 注册在 editor/languages.ts（懒加载 + .curl 扩展名 + Markdown 围栏）。
 */

import { LanguageSupport, StreamLanguage, type StreamParser } from "@codemirror/language";
import { tags } from "@lezer/highlight";

/** 首个非空白字符是否为注释起始（支持缩进后的 # 注释） */
function atLineCommentStart(stream: { pos: number; string: string }): boolean {
  return stream.string.slice(0, stream.pos).trim() === "";
}

const curlParser: StreamParser<null> = {
  name: "curl",
  startState: () => null,
  token(stream) {
    if (stream.eatSpace()) return null;

    // 行首 # 到行尾：注释
    if (atLineCommentStart(stream) && stream.peek() === "#") {
      stream.skipToEnd();
      return "comment";
    }

    // 命令名（脚本首词或续行后的首词）
    if (stream.match(/^curl\b/)) return "keyword";

    // 短选项（-X / -H / -d / -o）与长选项（--request / --header）
    if (stream.match(/^--?[A-Za-z][\w.-]*/)) return "keyword";

    // URL：整串着色，便于在长命令里快速定位目标
    if (stream.match(/^https?:\/\/[^\s'"`]+/)) return "url";

    // 双引号 / 单引号串（含转义）
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^'(?:[^'\\]|\\.)*'?/)) return "string";

    // 行尾反斜杠：续行标记
    if (stream.match(/^\\\s*$/)) {
      stream.skipToEnd();
      return "operator";
    }

    stream.next();
    return null;
  },
  tokenTable: { url: tags.url },
  languageData: { commentTokens: { line: "#" } },
};

/** 供 languages.ts 懒加载注册 */
export function curlLanguage(): LanguageSupport {
  return new LanguageSupport(StreamLanguage.define(curlParser));
}
