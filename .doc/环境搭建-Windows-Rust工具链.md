# Windows 开发环境搭建（Tauri 2 + Rust）

## 问题现象

```text
PS D:\giteeResp\my-editor> npm run tauri dev
failed to run 'cargo metadata' command to get workspace directory:
failed to run command cargo metadata --no-deps --format-version 1: program not found
```

## 根因

`tauri dev` 在启动前会执行 `cargo metadata` 读取 Cargo 工作区信息。当前机器 **未安装 Rust 工具链**，因此该命令找不到可执行文件。

实测环境检查结果（2026-10-24）：

| 检查项 | 结果 |
| --- | --- |
| `cargo` / `rustc` / `rustup` | ❌ 全部不存在 |
| `%USERPROFILE%\.cargo\bin` | ❌ 不存在 |
| `%USERPROFILE%\.rustup` | ❌ 不存在 |
| Visual Studio Build Tools（VC.Tools.x86.x64） | ❌ 未安装 |
| WebView2 运行时 | ✅ 145.0.3800.97 |
| 操作系统 | ✅ Windows 10 22H2 (19045) |
| winget | ✅ 可用 |

结论：需要补齐 **Rust 工具链** 与 **MSVC C++ 生成工具** 两项前置依赖。

## 安装步骤

### 1. 安装 MSVC C++ 生成工具

以**管理员**身份打开 PowerShell：

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools --accept-source-agreements --accept-package-agreements --override "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

> 手工安装等价操作：下载 Visual Studio Build Tools，勾选「使用 C++ 的桌面开发」（含 MSVC v143 + Windows 10/11 SDK）。
> 缺这一步，Rust 编译到链接阶段会报 `link.exe not found` / `LINK : fatal error`。

### 2. 安装 Rust（rustup，msvc 目标）

普通 PowerShell（无需管理员）：

```powershell
$env:RUSTUP_DIST_SERVER="https://rsproxy.cn"
$env:RUSTUP_UPDATE_ROOT="https://rsproxy.cn/rustup"
Invoke-WebRequest "https://rsproxy.cn/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe" -OutFile "$env:TEMP\rustup-init.exe"
& "$env:TEMP\rustup-init.exe" -y
```

官方源替代地址：`https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe`（国内网络较慢）。
`-y` 使用默认配置：host = `x86_64-pc-windows-msvc`，profile = default（含 rustc、cargo、rust-std、rust-docs、clippy、rustfmt）。

### 3. 配置 crates 镜像

Tauri 依赖树很大，国内必须配镜像。新建 `C:\Users\Admin\.cargo\config.toml`：

```toml
[source.crates-io]
replace-with = 'rsproxy-sparse'

[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"

[net]
git-fetch-with-cli = true
```

### 4. 重开终端

`rustup-init` 只**新写入**用户级 `PATH`，已运行的终端 / IDE 进程持有旧的环境变量快照，不会自动刷新。
必须完全退出 PowerShell 与 CodeBuddy 后重新打开，否则仍会 `program not found`。

### 5. 验证

```powershell
cargo --version
rustc --version
cd D:\giteeResp\my-editor
npm run tauri dev
```

预期：首次启动触发完整依赖编译（300+ crate），耗时约 3–8 分钟；之后增量启动数秒内完成。

## 常见后续错误

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `link.exe not found` | 未装 MSVC C++ 生成工具 | 回到步骤 1 |
| `failed to download crates` / 卡在 Updating | 未配镜像 | 回到步骤 3 |
| `cargo metadata` 仍 not found | 终端未重启 | 回到步骤 4 |
| 窗口白屏 | WebView2 缺失（本机已具备） | 装 Microsoft Edge WebView2 Runtime |

## 验收基线

项目 `CODEBUDDY.md` 约定每次改动后执行：

```bash
npx tsc --noEmit && npm run build && (cd src-tauri && cargo test)
```

其中 `cargo test` 依赖本文档所述环境。
