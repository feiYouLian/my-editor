/**
 * cURL 脚本识别（纯函数）：用于右键菜单显隐与「执行 cURL 脚本」入口校验。
 *
 * 只检查第一个有意义的行（跳过空行与 `#` 注释），兼容：
 * - `curl -sS ...`
 * - `curl.exe ...`（Windows 真实可执行文件）
 * - `& 'curl' ...` / `& 'curl.exe' ...`（PowerShell / DevTools 复制形式）
 */
const CURL_LINE_RE = /^(?:&\s*)?["']?curl(?:\.exe)?["']?(?:\s|$)/i;

export function looksLikeCurlScript(text: string): boolean {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    return CURL_LINE_RE.test(line);
  }
  return false;
}
