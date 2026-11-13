/**
 * 错误文本归一化。
 *
 * Tauri 命令失败时返回的字符串常带多行（命令输出、git 原始报错、堆栈），
 * 而状态栏 / 通知只放得下一行，所以统一取首行。
 */
export function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = text.split(/\r?\n/)[0]?.trim() ?? "";
  return line || "未知错误";
}
