# CODEBUDDY.md

## 项目概况

轻量级定制文本编辑器：Tauri 2（Rust 后端）+ CodeMirror 6（前端单编辑器实例）+ Vite。
技术设计见根目录《轻量级定制文本编辑器_技术设计文档.md》，能力差距与补齐方案见《编辑器差距补齐_详细设计文档.md》，
面向使用者的功能说明以 `README.md` 为当前真源；重构与评审的过程记录（含已完成的《重构计划》、已废弃的《易实现功能清单》与 OCR 专项）
不再保留独立文档，统一看 `.doc/` 归档与 git 历史。

## 目录约定（按职责分层）

```
src/
  core/      纯函数与零依赖基础（记法解析、命令注册表、格式化、路径工具、转换、Cron）
  ui/        通用 DOM 控件（状态栏、标签栏、面包屑、菜单工厂、对话框、表单控件）
  panels/    功能面板（文件树、设置中心、预览、大文件视图、差异面板、各类对话框）
  editor/    CodeMirror 6 相关（装配、扩展、键位表、书签、变换、格式化）
  store/     应用状态（标签页 TabStore）
  services/  与 Rust 后端的服务封装（会话、工作区、文件监视）
  config/    配置读写与热更新、快捷键解析与分发
  settings/  设置中心的分类页
  app/       跨模块编排 host（文件 / 会话 / 预览 / 运行 / 终端 / 差异 / 标签切换 / 窗口）
  main.ts    装配层：import + 依赖组装 + 命令注册 + bootstrap()
```

依赖方向（实际约束，2026-10-25 审计）：

```
core  ← 所有层可依赖（core 自身不得 import 任何上层）
ui    → core / config / store
panels→ core / ui / editor / config / services
app   → core / ui / panels / editor / store / services / config
main.ts → 全部
```

- `config/keybindings.ts` 与 `editor/*` 互相依赖属于已知可接受项（键位记法已下沉 `core/keyNotation.ts`）
- **已知越界（技术债）**：`store/tabs.ts` 为批量关闭确认 import `ui/dialogs.ts`；
  待改为把确认回调注入 TabStore（不阻塞其它改动）
- 跨模块共享状态一律经各宿主自己的 `Deps` 接口显式注入；禁止新增模块级可变单例
  （原 `app/context.ts` 的 AppContext 方案已废弃并在 2026-10-25 删除）

## 验收基线（每个改动后必跑）

```bash
npm test && npx tsc --noEmit && npm run build && (cd src-tauri && cargo test --lib)
node scripts/check-ipc-contract.mjs && node scripts/scan-unsafe.mjs && node scripts/scan-innerhtml.mjs
npm run typecheck:e2e
# E2E 连真实应用（WebView2 CDP），先构建调试版：
npm run tauri build -- --debug --no-bundle && npm run test:e2e
```

Rust 侧约束：

- 所有 fs 类命令必须过 `commands/paths.rs` 的路径守卫：
  读取类自动登记；目录树操作限工作区根；写入类限已知文件及其同目录 / 已登记目录的直接子项
- **重活一律 `spawn_blocking`**：全文编码 + fsync、递归删除、整图读取 + base64、
  草稿写盘、进程启动与 `taskkill`、HTTP 落盘都不得放在同步命令或 async 命令主体里
- 自身写盘用 `watch::mark_writing` / `note_written` 包裹（`writing` 标记，不是时间窗口），
  保证「外部修改」不会被动吞掉

## 当前状态

- 安全修复 + 高危 bug 修复：已完成（2026-10-21）
- 结构重构 Phase 0–5：已完成（2026-10-23）；`main.ts` 是装配层，随功能增长，2026-11-01 实测 2241 行（原定 ≤500 的目标已放弃，剩余为命令注册表数据与跨宿主接线）
- 新增功能（格式转换 / properties 高亮 / 网页抓取 / cURL 脚本执行）：已完成（2026-10-24）
- 终端与 Code Run 增强（PTY 终端 / 在终端运行 / 按语言输出优化 / 多会话 ≤ 8）：已完成（2026-10-24 起，10-31 扩展）
- 全局代码审查与优化（保存基线、载入代际、热路径、Rust 阻塞命令、CSP、路径守卫）：已完成（2026-10-25），
  记录见 `.doc/全局代码审查与优化-2026-10-25.md`
- V1 能力补齐（Git 源代码管理全家桶与只读模式 / 书签 / 工作区覆盖 / 结构化视图 / Markdown 目录与公式与 Mermaid / 设计令牌与无障碍）：已完成并发版至 **0.6.1**（2026-11-01）
- 文件关联改为应用内显式开关（2026-11-04）：安装包不再声明 `bundle.fileAssociations`；
  设置 →「文件与会话 → Windows 系统集成」只向 HKCU 登记「打开方式」候选，不改 `.ext` 默认值（见 `commands/association.rs`）；
  旧版安装器留下的默认关联可在此处「一键恢复」（有 `_backup` 的恢复原程序，无备份的去掉默认）
- 测试基线（2026-11-04）：`npm test` 131 项 + 渲染层 13 项（`vitest.render.config.ts`）、`cargo test --lib` 184 项（+2 条默认 ignore 的真实注册表往返）
- 0.7.0 计划 S0–S1 完成（2026-11-04）：起始标签 `v0.6.3-baseline`、工作分支 `dev/0.7.0`；
  新增 IPC 参数契约 / 生产 panic 点 / DOM 注入面三道静态门禁（`scripts/`，已接入 `ci.yml`）；
  验收基线整理为 `docs/ACCEPTANCE.md`（自动 / 半自动 / 人工三层，与批次一一对应）
- 0.7.0 计划 S2 进行中（2026-11-04）：E2E 基座已接入（调试版应用 + WebView2 CDP + Playwright，
  `e2e/` + `playwright.config.ts`，空基线 1 条）；渲染层测试覆盖 `searchView` / `quickOpen` / `tabsBar` / `gitView`；
  12 条关键路径待补
- **打包约束**：安装包文案（`shortDescription` / `longDescription` 等）含中文时，必须配 `bundle.windows.wix.language: "zh-CN"`，
  否则 WiX 以代码页 1252 链接 MSI 会报 `LGHT0311`；改过 bundle 配置先在本地 `npm run tauri build` 跑通再推 tag
- 未达项：E2E 仅有空基线，12 条关键路径未补；自动更新的 endpoint / pubkey 仍为占位，发布产物不含 `latest.json` 与签名
