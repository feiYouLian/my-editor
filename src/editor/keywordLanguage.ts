/**
 * 数据驱动的关键字级高亮语言（用户自定义语言用）。
 *
 * 与 editor/curlLanguage.ts 同一路线：手写 StreamParser，零新依赖、无语法解析。
 * 能识别的只有四类：行 / 块注释、字符串、数字、标识符（区分关键字 / 类型 / 普通）。
 * 这个粒度对 .toml / .ini / .conf / .env / 自定义日志格式够用；
 * 真要语法树就该上 Lezer，那是另一条路（会把用户语言变成"能装 npm 包"，明确不做）。
 */

import { LanguageSupport, StreamLanguage, type StreamParser } from "@codemirror/language";
import { tags, type Tag } from "@lezer/highlight";

import type { UserLanguageSpec } from "../config/userLanguages";

/** StreamParser 输出的记号名 → 高亮 tag（显式映射，避免依赖内部默认表） */
const TOKEN_TAGS: Record<string, Tag> = {
  keyword: tags.keyword,
  typeName: tags.typeName,
  string: tags.string,
  number: tags.number,
  comment: tags.comment,
  variableName: tags.variableName,
  bracket: tags.bracket,
  operator: tags.operator,
};

const WORD_RE = /^[A-Za-z_][A-Za-z0-9_-]*/;
const NUMBER_RE = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const OPERATOR_RE = /^[+\-*/%=<>!&|^~?:.]+/;

export function createKeywordLanguage(spec: UserLanguageSpec): LanguageSupport {
  const normalize = (word: string) => (spec.caseInsensitive ? word.toLowerCase() : word);
  const keywords = new Set(spec.keywords.map(normalize));
  const types = new Set(spec.types.map(normalize));

  const parser: StreamParser<null> = {
    name: spec.name,
    startState: () => null,
    token(stream) {
      if (stream.eatSpace()) return null;

      // 块注释：跨行一直吃到结束标记（到文件/行尾也算结束，避免未闭合时整篇变色）
      if (spec.blockComment && stream.match(spec.blockComment[0])) {
        for (;;) {
          if (stream.match(spec.blockComment[1])) break;
          if (stream.next() === undefined) break;
        }
        return "comment";
      }
      if (spec.lineComment && stream.match(spec.lineComment)) {
        stream.skipToEnd();
        return "comment";
      }

      const ch = stream.peek();
      if (ch !== undefined && spec.quotes.includes(ch)) {
        stream.next();
        let escaped = false;
        while (!stream.eol()) {
          const c = stream.next();
          if (escaped) {
            escaped = false;
            continue;
          }
          if (c === "\\") {
            escaped = true;
            continue;
          }
          if (c === ch) break;
        }
        return "string";
      }

      if (spec.numbers && ch !== undefined && ch >= "0" && ch <= "9" && stream.match(NUMBER_RE)) {
        return "number";
      }

      const word = stream.match(WORD_RE) as RegExpMatchArray | null;
      if (word) {
        const key = normalize(word[0]);
        if (keywords.has(key)) return "keyword";
        if (types.has(key)) return "typeName";
        return "variableName";
      }

      if (ch !== undefined && spec.brackets.includes(ch)) {
        stream.next();
        return "bracket";
      }
      if (ch !== undefined && OPERATOR_RE.test(ch) && stream.match(OPERATOR_RE)) {
        return "operator";
      }

      stream.next();
      return null;
    },
  };

  return new LanguageSupport(
    StreamLanguage.define({
      ...parser,
      tokenTable: TOKEN_TAGS,
      // 有行注释才有「切换注释」；块注释不参与 Ctrl+/
      languageData: spec.lineComment ? { commentTokens: { line: spec.lineComment } } : {},
    }),
  );
}
