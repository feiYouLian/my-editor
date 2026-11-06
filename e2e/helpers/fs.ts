import { readFile } from "node:fs/promises";

/**
 * 读文件，尚未生成时返回标记串而不是抛错。
 *
 * `expect.poll` 的回调一旦抛异常就**立即失败、不再重试**（不是断言式重试）。
 * 产物是异步落盘的，点击导出后首帧读不到属于正常时序，必须让它继续轮询。
 */
export async function readWhenWritten(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "<尚未生成>";
  }
}
