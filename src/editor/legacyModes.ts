/**
 * 附加语言：`@codemirror/legacy-modes` 里未默认启用的流模式（shell / PowerShell / TOML / diff …）。
 *
 * **按需启用**而不是默认全开：每个模式是一个独立分片（2–8 KB），全开会让 `dist/` 多出
 * 二十多个小块。所以这里只定义"可选项"，只有用户在设置里勾选后才会被注册，
 * 且打开对应扩展名的文件时才会真正 `import()` 该分片——没勾选就永远不加载。
 *
 * 与「自定义语言（config/userLanguages.ts）」的分工：
 * - 这里：CodeMirror 官方维护的完整流模式，记号分类更细（正则、插值、关键字集准确）
 * - 那里：用户自己用 JSON 声明关键字，覆盖内置与这里都没有的格式
 * 两者都**不是语法树**，因此都没有补全、诊断、折叠。
 */

import { LanguageSupport, StreamLanguage, type StreamParser } from "@codemirror/language";

export interface LegacyModeDef {
  /** 设置页与状态栏展示名 */
  label: string;
  extensions: string[];
  /** 无扩展名 / 点开头文件的整体文件名（小写） */
  basenames?: string[];
  /** 行注释符：注入了才能用「切换注释」Ctrl+/ */
  lineComment?: string;
  /** 动态 import 单个模式所在分片；调用时才加载（各模式的 state 类型不同，故用 any） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  load: () => Promise<StreamParser<any>>;
}

/**
 * 可选语言表：只放对「看日志 / 改配置 / 跑脚本」真正有用的那几个，
 * 不做「把 100 个模式全列出来」——列表太长等于没有列表。
 */
export const LEGACY_MODES: Record<string, LegacyModeDef> = {
  shell: {
    label: "Shell（bash / zsh）",
    extensions: [".sh", ".bash", ".zsh", ".ksh"],
    basenames: [".bashrc", ".zshrc", ".profile", ".bash_profile"],
    lineComment: "#",
    load: () => import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell),
  },
  powershell: {
    label: "PowerShell",
    extensions: [".ps1", ".psm1", ".psd1"],
    lineComment: "#",
    load: () => import("@codemirror/legacy-modes/mode/powershell").then((m) => m.powerShell),
  },
  toml: {
    label: "TOML",
    extensions: [".toml"],
    lineComment: "#",
    load: () => import("@codemirror/legacy-modes/mode/toml").then((m) => m.toml),
  },
  diff: {
    label: "Diff / 补丁",
    extensions: [".diff", ".patch"],
    load: () => import("@codemirror/legacy-modes/mode/diff").then((m) => m.diff),
  },
  dockerfile: {
    label: "Dockerfile",
    extensions: [],
    basenames: ["dockerfile", "dockerfile.dev", "containerfile"],
    lineComment: "#",
    load: () => import("@codemirror/legacy-modes/mode/dockerfile").then((m) => m.dockerFile),
  },
  cmake: {
    label: "CMake",
    extensions: [".cmake"],
    basenames: ["cmakelists.txt"],
    lineComment: "#",
    load: () => import("@codemirror/legacy-modes/mode/cmake").then((m) => m.cmake),
  },
  http: {
    label: "HTTP 请求（.http / .rest）",
    extensions: [".http", ".rest"],
    lineComment: "#",
    load: () => import("@codemirror/legacy-modes/mode/http").then((m) => m.http),
  },
  perl: {
    label: "Perl",
    extensions: [".pl", ".pm", ".t"],
    lineComment: "#",
    load: () => import("@codemirror/legacy-modes/mode/perl").then((m) => m.perl),
  },
  lua: {
    label: "Lua",
    extensions: [".lua"],
    lineComment: "--",
    load: () => import("@codemirror/legacy-modes/mode/lua").then((m) => m.lua),
  },
  ruby: {
    label: "Ruby",
    extensions: [".rb", ".rake", ".gemspec"],
    basenames: ["gemfile", "rakefile"],
    lineComment: "#",
    load: () => import("@codemirror/legacy-modes/mode/ruby").then((m) => m.ruby),
  },
  haskell: {
    label: "Haskell",
    extensions: [".hs", ".lhs"],
    lineComment: "--",
    load: () => import("@codemirror/legacy-modes/mode/haskell").then((m) => m.haskell),
  },
  csharp: {
    label: "C#",
    extensions: [".cs"],
    lineComment: "//",
    load: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.csharp),
  },
  kotlin: {
    label: "Kotlin",
    extensions: [".kt", ".kts"],
    lineComment: "//",
    load: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.kotlin),
  },
};

/** 设置页列表顺序稳定的键名（对象键顺序即声明顺序） */
export function legacyModeNames(): string[] {
  return Object.keys(LEGACY_MODES);
}

export function isLegacyMode(name: string): boolean {
  return name in LEGACY_MODES;
}

/**
 * 构造语言支持。未知名字返回 null（调用方按纯文本处理）。
 * 与 properties 同样的做法：把 lineComment 注入 languageData，否则 Ctrl+/ 无效。
 */
export async function createLegacyLanguage(name: string): Promise<LanguageSupport | null> {
  const entry = LEGACY_MODES[name];
  if (!entry) return null;
  try {
    const mode = await entry.load();
    return new LanguageSupport(
      StreamLanguage.define({
        ...mode,
        languageData: entry.lineComment ? { commentTokens: { line: entry.lineComment } } : {},
      }),
    );
  } catch (err) {
    console.warn(`[legacy-mode] 加载失败: ${name}`, err);
    return null;
  }
}
