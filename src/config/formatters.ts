/**
 * CLI 格式化工具配置（对应 config.json 的 formatters 块）。
 * 前端仅用它判断「某语言是否支持 CLI 格式化」与安装指引；
 * 真正的工具与参数在后端按语言键从 config.json 解析（防 RCE），
 * args 中的 __PLACEHOLDER__ 由后端替换为文件路径。
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
