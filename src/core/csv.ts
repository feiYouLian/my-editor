/**
 * CSV / TSV 解析（纯函数，只读视图用）。
 *
 * 目标不是做完整的 RFC4180 实现，而是"能把常见的表格文件正确切行切列"：
 * - 支持双引号包裹字段、字段内逗号/换行、`""` 转义；
 * - 自动探测分隔符（`,` `;` `\t` `|`）；
 * - 行列都设上限：十万行级的文件不能把内存吃光，截断后由 UI 明确提示。
 */

/** 候选分隔符（顺序即"平票时的优先级"：逗号最常见） */
const DELIMITERS = [",", ";", "\t", "|"] as const;

export interface CsvTable {
  delimiter: string;
  /** 已解析的行（含首行表头，若文件有表头） */
  rows: string[][];
  /** 是否因行数/列数上限被截断 */
  truncated: boolean;
  /** 发现的总行数（截断时大于 rows.length） */
  totalRows: number;
  /** 最大列数（各行列数的最大值） */
  columnCount: number;
}

export interface CsvParseOptions {
  /** 最多保留多少行（默认 100000） */
  maxRows?: number;
  /** 每行最多保留多少列（默认 200） */
  maxCols?: number;
}

/**
 * 探测分隔符：取前若干非空行，选"每行出现次数稳定且最多"的候选。
 * 稳定优先于数量——日志里逗号多但次数不齐时，`;` 往往才是真分隔符。
 */
export function detectDelimiter(text: string): string {
  const sampleLines = text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(0, 10);
  if (sampleLines.length === 0) return ",";

  let best = ",";
  let bestScore = -1;
  for (const delimiter of DELIMITERS) {
    const counts = sampleLines.map((line) => countOutsideQuotes(line, delimiter));
    const min = Math.min(...counts);
    if (min < 1) continue;
    // 每行都至少有 min 个；用"行数 × 最小值"打分，次数不齐的方案自然被压低
    const score = min * 1000 + counts.reduce((a, b) => a + b, 0);
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return best;
}

/** 统计一行里引号外的分隔符数量（引号内的逗号属于字段内容） */
function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') i += 1;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && ch === delimiter) {
      count += 1;
    }
  }
  return count;
}

/**
 * 解析表格。自动探测分隔符；行列超限即截断（truncated=true）。
 * 解析是逐字符状态机，十万行量级在几十毫秒内完成。
 */
export function parseCsv(text: string, options: CsvParseOptions = {}): CsvTable {
  const maxRows = Math.max(1, options.maxRows ?? 100_000);
  const maxCols = Math.max(1, options.maxCols ?? 200);
  const delimiter = detectDelimiter(text);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let totalRows = 0;
  let columnCount = 0;
  let truncated = false;

  const pushField = (): void => {
    if (row.length < maxCols) row.push(field);
    else truncated = true;
    field = "";
  };

  const pushRow = (): void => {
    totalRows += 1;
    columnCount = Math.max(columnCount, row.length);
    if (rows.length < maxRows) rows.push(row);
    else truncated = true;
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      // CRLF 只算一次换行
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      pushField();
      pushRow();
      continue;
    }
    field += ch;
  }
  // 末尾没有换行：补一行（全空文件不产生空行）
  if (field !== "" || row.length > 0) {
    pushField();
    pushRow();
  }

  return { delimiter, rows, truncated, totalRows, columnCount };
}
