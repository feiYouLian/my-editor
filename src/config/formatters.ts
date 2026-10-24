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

/**
 * 工具缺失时的安装引导（按平台）。
 * 约定：第一行是可直接执行的安装命令（会被拼到状态栏首行，状态栏只渲染
 * 首行，见 main.ts），后续行是补充说明，仅在控制台的完整报错里可见。
 */
export const installHints: Record<string, string> = {
  // pip 在无写权限时会转为用户安装：black.exe 落在
  // %APPDATA%\Python\PythonXXX\Scripts 而该目录通常不在 PATH，导致「command
  // pip install black 成功、编辑器仍报找不到」。此时改为直调解释器模块最稳。
  black: `pip install black
Windows 上 pip 常把 black 装到用户目录（%APPDATA%\\Python\\PythonXXX\\Scripts）而该目录不在 PATH，
此时可改在 config.json 的 formatters.python 中直接调用解释器：{"tool": "python", "args": ["-m", "black", "-q", "-"]}`,
  gofmt: "随 Go SDK 提供：https://go.dev/doc/install",
  rustfmt: "rustup component add rustfmt",
  "google-java-format":
    "需 Java 11+：下载 all-deps jar 后可用 java -jar google-java-format-all-deps.jar --aosp - 并在配置中指定完整命令",
  "clang-format": "随 LLVM/Clang 提供：https://llvm.org/builds/ 或 VS 生成工具",
};
