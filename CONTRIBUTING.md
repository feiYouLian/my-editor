# 参与开发

本项目体积小、依赖少，本地跑起来只要 Node + Rust。下面是最短的路径；深层的目录约定与依赖方向见 [`CODEBUDDY.md`](./CODEBUDDY.md)，操作手册见 [`docs/USER-GUIDE.md`](./docs/USER-GUIDE.md)。

## 1 环境

| 依赖 | 版本 |
| --- | --- |
| Node.js | ≥ 20（已验证 v24） |
| Rust | ≥ 1.77（通过 [rustup](https://rustup.rs) 安装） |
| Windows | WebView2 Runtime（Win10/11 自带）+ [Microsoft C++ 生成工具](https://visualstudio.microsoft.com/visual-cpp-build-tools/) |
| macOS | Xcode Command Line Tools |
| Linux | `libwebkit2gtk-4.1-dev` `libgtk-3-dev` `libayatana-appindicator3-dev` `librsvg2-dev` `patchelf` |

Windows 上的工具链搭建步骤见 [`.doc/环境搭建-Windows-Rust工具链.md`](./.doc/环境搭建-Windows-Rust工具链.md)。

## 2 跑起来

```bash
npm install
npm run tauri dev
```

打包：

```bash
npm run tauri build          # 产物在 src-tauri/target/release/bundle/
```

## 3 提交前必跑（验收基线）

```bash
npm test && npx tsc --noEmit && npm run build && (cd src-tauri && cargo test --lib)
```

四条全绿才算可提交。任何一条挂了都别用「反正不相关」放过——历史上这三类问题都出现过：
类型检查通过但构建被 `vite` 拒绝、Rust 单测过了但前端命令表键位冲突、构建通过但运行时 IPC 参数对不上。

当前基线：`npm test` 30 项、`cargo test --lib` 132 项。

手工回归看 [`验收清单_V1.md`](./验收清单_V1.md)（含 §10 冒烟清单），自动化覆盖不到的部分都在那里。

## 4 代码约定（硬约束）

**分层与依赖方向**（细则见 `CODEBUDDY.md`）：

```
core  ← 所有层可依赖（core 自身不得 import 上层）
ui    → core / config / store
panels→ core / ui / editor / config / services
app   → core / ui / panels / editor / store / services / config
main.ts → 全部
```

- 跨模块共享状态一律经各宿主自己的 `Deps` 接口显式注入，**禁止新增模块级可变单例**
- Rust 侧所有 fs 命令必须过 `commands/paths.rs` 的路径守卫
- 重活（全文编码 + fsync、递归删除、整图读取、草稿写盘、进程启动 / `taskkill`、HTTP 落盘）一律 `spawn_blocking`，不得放在同步或 async 命令主体里
- 自身写盘要用 `watch::mark_writing` / `note_written` 包裹，不要用时间窗口

**快捷键只增不改**

- 已有键位的**功能**不动（例如 `Ctrl+D` 保持删行，不改成 VS Code 的「选下一个同词」）
- 新命令的键位必须是可重绑项；`fixed` 只留给系统级动作
- 键位说明只有一处权威来源：命令注册表 → `README.md` 的快捷键表。不要另写第二张表

**轻量红线**

新增依赖要说清代价：安装包增量、常驻内存、常驻定时器数。默认不做 LSP、插件市场、调试器、远程开发这类"必然变重"的能力；
新增能力优先用已有依赖的现成 API 或懒加载。

## 5 新增一条命令

1. 在 `src/app/commandTable.ts` 里加一条（`id` 唯一、`title` 中文、`section` 归属、`run` 是调用已有方法）
2. 需要键位时加 `defaultKey`（记法如 `Mod-Shift-K`，解析在 `src/core/keyNotation.ts`）
3. 需要出现在菜单 / 右键菜单时加对应标记，菜单内容在 `src/app/menuContent.ts`
4. 跑 `npm test`——命令表测试会校验 id 唯一、键位记法合法、无两条命令抢同一键位、菜单 id 存在

## 6 提交与 PR

提交信息用 Conventional Commits，便于按版本归档（`CHANGELOG.md` 就是这么来的）：

```
feat(editor): 新增 xxx
fix(sidebar): 修复 xxx
docs(readme): 同步 xxx
refactor(core): 抽取 xxx
perf(large): 优化 xxx
ci(release): xxx
chore(release): 版本号升级至 0.4.0
```

PR 请按 [`.github/PULL_REQUEST_TEMPLATE.md`](./.github/PULL_REQUEST_TEMPLATE.md) 填写，重点写清三件事：
**改了什么 / 为什么 / 怎么验证的**（贴四条基线命令的结果）。

## 7 发版

版本号以 `package.json` 为真源，用脚本统一改 5 处：

```bash
npm run bump patch          # 或 minor / major / 指定版本
```

发布流程与踩过的坑（tag 必须等于 `tauri.conf.json` 版本、不要手建 Release、不可变 Release 不能覆盖）见
[`README.md` → 版本发布](./README.md#版本发布)。
