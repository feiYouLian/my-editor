# 终端与 Code Run 增强 技术设计文档

v1.0（2026-10-24）

| 项目 | 内容 |
| --- | --- |
| 文档类型 | 功能专项技术设计文档（评估 / 架构 / 安全 / 验收） |
| 上位文档 | 《轻量级定制文本编辑器_技术设计文档》、《新增功能_技术设计文档》、CODEBUDDY.md 目录约定 |
| 状态 | 已实现（2026-10-24） |

## 1 评估结论

**Code Run 可以在终端执行，且推荐用真 PTY 实现。**

- 前端用 `@xterm/xterm` 渲染，Rust 用 `portable-pty` 提供 PTY；Windows 走 ConPTY（Win10 1809+）。
- 「在终端运行」不新开一次性进程，而是把等价命令行写入当前 shell（`& 'python' 'file.py'`），与 VSCode Code Runner 的交互一致。
- 命令参数复用 `run.rs` 的 `CommandSpec`，shell 引号由 Rust 统一处理，前端不拼接命令字符串。
- 终端内命令是交互式的，**不受** Code Run 的 30s 超时 / 1MB 输出上限约束。

## 2 关键决策

| 决策 | 内容 |
| --- | --- |
| 依赖 | Rust `portable-pty 0.9`；前端 `@xterm/xterm 6` + `@xterm/addon-fit`（动态 import，懒加载分片约 85KB gzip） |
| 会话数 | v1 单会话；`terminal_open` 先结束旧会话；面板「隐藏」不杀进程，「关闭」/应用退出才杀 |
| 默认 shell | Windows 优先 PATH 或 `%ProgramFiles%\PowerShell\7` 下的 `pwsh.exe`，否则 `powershell.exe`；macOS/Linux 用 `$SHELL`，兜底 `/bin/bash` |
| 输出传输 | `terminal://output` 事件发送 base64 字节，前端解码为 `Uint8Array` 交给 xterm，避免 UTF-8 分块截断 |
| 输入 | xterm `onData` → `terminal_write`；Ctrl+Shift+C/V 由面板处理复制/粘贴 |
| 运行命令 | `terminal_run_code` / `terminal_run_curl` 由 Rust 构造 shell 行并写入 `\r` |

## 3 终端架构

### 3.1 Rust（`src-tauri/src/commands/terminal.rs`）

- `TerminalState { slot: Arc<Mutex<Option<Session>>>, seq }`，`Session` 持有 `master` / `writer` / `child` / `shell_kind`。
- 命令：
  - `terminal_open(shell, cwd, cols, rows) -> TerminalInfo { id, shell, cwd }`
  - `terminal_write(id, data)` / `terminal_resize(id, cols, rows)` / `terminal_close(id)`
  - `terminal_run_code(id, path, runner)`：过 `PathGuard::ensure_file_scope`，再写命令行
  - `terminal_run_curl(id, script)`：`parse_curl_args` 后写 curl 命令行
- 事件：`terminal://output { id, data(base64) }`、`terminal://exit { id, code }`。
- 读取线程：每次读取（8KB）即发送，保证提示符/单字符输入的延迟；守望线程 50ms 轮询退出状态。
- 关闭：Windows `taskkill /PID <pid> /T /F` + `child.kill()`；其它平台 `child.kill()`。
- 环境：`TERM=xterm-256color`、`TERM_PROGRAM=my-editor`、`PYTHONIOENCODING=utf-8`；Windows PowerShell 追加 `-NoLogo -NoExit -Command` 把控制台输入/输出编码切到 UTF-8。

### 3.2 前端（`terminalPanel.ts` / `terminalHost.ts`）

- `TerminalPanel` 只负责 DOM 与 xterm：主题、字号、fit、剪贴板、``Ctrl+` `` 捕获。
- `TerminalHost` 负责会话生命周期：
  - 懒加载面板（xterm 不进主 bundle）
  - `ensureOpen` 启动/复用会话，`runFile` / `runCurlScript` 写命令，`close` 结束进程
  - 启动窗口内按会话 id 缓存输出（`pendingChunks`），避免丢掉 ConPTY 的首批字节
- 面板隐藏（``Ctrl+` `` / 终端打开时让出底部区域）保留 xterm 与 shell；关闭按钮结束进程。

### 3.3 ConPTY 首帧特性（实测）

ConPTY 启动后会先发送 `ESC[6n`（DSR 光标位置查询），**必须由终端模拟器回应** `ESC[<row>;<col>R`，否则 PowerShell 会一直等待，终端表现为空白。

- xterm.js 自带 DSR 响应，会通过 `onData` 把回复送回来；
- `TerminalHost` 必须保证：会话 id 返回前的首批输出先缓存、拿到 id 后再写入 xterm，否则 DSR 被过滤，回复永远发不出去。已用 `pendingChunks` 处理。
- 该行为在 Windows 上用独立 PTY 冒烟验证：不回应 DSR 时无提示符；回应后 `echo` 与中文输出正常。

## 4 在终端运行（VSCode Code Runner 语义）

- 入口：
  - 工具栏 ``>_`` / ``Ctrl+` ``：打开或隐藏终端
  - `Ctrl+F5` / 右键「代码 ▸ 在终端运行当前文件」/ 命令面板：把当前文件送进终端
  - 右键「代码 ▸ 在终端执行 cURL 脚本」：选区优先，无选区整篇，不要求已保存
- 前置条件与 F5 一致：文件已保存且无未保存改动（cURL 脚本除外）。
- 命令渲染（Rust `render_shell_line`）：
  - PowerShell：`$env:PYTHONIOENCODING='utf-8'; & 'python' 'C:\a b\x.py'`
  - POSIX：`PYTHONIOENCODING='utf-8' 'python' 'a b'`
  - `cmd.exe`：明确拒绝在终端运行（提示改用 PowerShell）
  - Windows 上 curl 固定使用 `curl.exe`：PowerShell 的 `curl` 是 `Invoke-WebRequest` 别名，直接写 `curl` 会报参数错误
- 引号规则：PowerShell 单引号内 `'` 双写；POSIX `'\''`。
- cURL 脚本识别只看第一个有意义行（跳空行与 `#` 注释），兼容 `curl` / `curl.exe` / PowerShell 的 `& 'curl' ...`；右键菜单只在当前选区/文档确实像 cURL 命令时显示入口。

## 5 Code Run 输出优化

### 5.1 通用

- 去 ANSI 颜色/光标控制序列；
- `\r` 进度行折叠到最后一个非空片段（curl/下载工具）；
- 按行渲染 `<div class="run-line run-line-<kind>">`，行尾不完整片段留到下一批（ANSI 序列不会被分块截断）；
- stderr 默认按错误着色；错误/警告/堆栈元信息分级。

### 5.2 按语言

| runner | 规则 |
| --- | --- |
| python | `Traceback`、`File "...", line N`、`XxxError/Exception` 标红；`File` 位置可点击 |
| node | `Uncaught`、`Error:`/`TypeError:` 标红；`    at ` 堆栈标灰；`(path:line:col)` / `file://` 位置可点击（支持 `async` 帧） |
| java | `Exception in thread`、`Caused by:`、`error:` 标红；`\tat ...(X.java:N)` 标灰且可点击；javac `X.java:N: error:` 可点击 |
| curl | `curl: (N)` 标红；stdout 缓冲到退出后，若是 JSON 则整体美化并提示「JSON 响应（已格式化）」 |

### 5.3 文件位置跳转

- 相对路径按运行目录（文件所在目录）解析；
- 点击后打开文件、等待 `tabSwitcher.load()` 完成，再 `editorHandle.gotoLine(line)`；
- 大文件只读虚拟视图不跳行，状态栏给出提示。

### 5.4 UTF-8 分块修复

`run.rs` 的读线程新增 `utf8_flush_len`：每次 flush 只输出完整的 UTF-8 前缀，末尾不完整的 1–3 字节保留到下一次读取。修复中文在读取分块边界被替换为 `�` 的既有缺陷。Rust 单测覆盖 2/3/4 字节序列与非法字节。

## 6 配置与快捷键

| 项 | 值 |
| --- | --- |
| `terminal.shell` | 空串 = 自动检测；下次新建终端生效 |
| ``Ctrl+` `` | 打开/隐藏终端（`terminal.toggle`） |
| `Ctrl+F5` | 在终端运行当前文件（`code.runInTerminal`） |
| 命令面板 | `output.show` 重新显示运行输出；`code.runCurlInTerminal` |

底部区域同一时间只展示一个面板：打开终端隐藏运行输出（保留内容与运行状态），开始新的 Code Run 隐藏终端（shell 继续运行）。

## 7 安全与边界

- 终端是任意命令执行入口，**非沙箱**；与 Code Run 既有语义一致，README 已声明。
- `terminal_run_code` 仍校验文件在 `PathGuard` 范围内；终端内自行 `cd` / `-o 路径` 不受限制。
- 私网抓取开关与终端无关。
- 终端内命令不受 30s / 1MB 限制；需要限时的任务请用 F5 输出面板。
- 单会话 v1；不随会话恢复，应用退出即结束。
- 终端聚焦时全局快捷键沿用「INPUT/TEXTAREA 不派发」规则；``Ctrl+` `` 与终端剪贴板由面板自身处理。

## 8 验收与测试结果

- 基线：`npx tsc --noEmit`、`npm run build`、`cargo test` 通过（Rust 82 项）。
- Rust 单测：`utf8_flush_len`、`shell_kind`、PowerShell/POSIX `render_shell_line`、`command_spec`。
- 前端冒烟（esbuild + Node）：ANSI/`\r`、Python/Node/Java 分类、Windows/ESM 位置解析、cURL JSON 美化、路径拼接与耗时格式，全部通过。
- PTY 冒烟（Windows）：ConPTY + PowerShell 启动、DSR 回应、`echo` 与中文输出验证通过。
- 构建产物：`terminalPanel-*.js` 约 336KB（gzip 85KB）为独立懒加载分片，xterm CSS 约 5KB 独立分片。

## 9 未覆盖 / 后续

- 多标签终端、会话恢复（v2）；
- 终端内链接识别、右键菜单（复制/粘贴/清屏）细化；
- PowerShell 5.1 不同控制台代码页的极端场景仍需多机手测；
- 终端主题的 16 色 ANSI 调色板目前沿用 xterm 默认，浅色主题可后续细化。
