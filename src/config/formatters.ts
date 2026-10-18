/**
 * CLI 格式化工具配置（设计文档 3.5，对应 config.json 的 formatters 块）。
 * 前端配置后端接入前使用此默认值；args 中的 __PLACEHOLDER__
 * 在调用时替换为真实文件路径。
 */

export interface FormatterConfig {
  tool: string;
  args: string[];
}

/** 语言键 → CLI 工具（Prettier 覆盖之外的语言） */
export const cliFormatters: Record<string, FormatterConfig> = {
  python: { tool: "black", args: ["-q", "-"] },
  go: { tool: "gofmt", args: [] },
  rust: { tool: "rustfmt", args: [] },
  java: { tool: "google-java-format", args: ["--aosp"] },
  cpp: { tool: "clang-format", args: ["-style=file", "-assume-filename=__PLACEHOLDER__"] },
};

/** 工具缺失时的安装引导（按平台） */
export const installHints: Record<string, string> = {
  black: "pip install black",
  gofmt: "随 Go SDK 提供：https://go.dev/doc/install",
  rustfmt: "rustup component add rustfmt",
  "google-java-format":
    "需 Java 11+：下载 all-deps jar 后可用 java -jar google-java-format-all-deps.jar --aosp - 并在配置中指定完整命令",
  "clang-format": "随 LLVM/Clang 提供：https://llvm.org/builds/ 或 VS 生成工具",
};

/** 合成文件名（未命名文档传给 assume-filename 用） */
const syntheticExt: Record<string, string> = {
  python: "py",
  go: "go",
  rust: "rs",
  java: "java",
  cpp: "cpp",
};

export function syntheticName(languageKey: string): string {
  return `untitled.${syntheticExt[languageKey] ?? "txt"}`;
}
