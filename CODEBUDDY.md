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

依赖方向（实际约束，2026-11-12 复核）：

```
core  ← 所有层可依赖（core 自身不得 import 任何上层）
ui    → core / config / store
editor→ core / config / store
services → core / config
config→ core
panels→ core / ui / editor / config / store / services
app   → core / ui / panels / editor / store / services / config
main.ts → 全部
```

- `config/keybindings.ts` 与 `editor/*` 互相依赖属于已知可接受项（键位记法已下沉 `core/keyNotation.ts`）
- **已知例外**：`config/settings.ts` 调用 `editor/languages.ts` 的 `setLegacyLanguages` / `setLanguageOverrides`
  （语言表是运行期可变状态；纯数据下沉 `core/` 之前无法收口）
- 跨模块共享状态一律经各宿主自己的 `Deps` 接口显式注入；禁止新增模块级可变单例

## 验收基线（每个改动后必跑）

```bash
npm test && npx tsc --noEmit && npm run build && (cd src-tauri && cargo test --lib)
node scripts/check-ipc-contract.mjs && node scripts/scan-unsafe.mjs && node scripts/scan-innerhtml.mjs
node scripts/audit-discoverability.mjs && npm run gen:commands
npm run typecheck:e2e
# E2E 连真实应用（WebView2 CDP），先构建调试版：
npm run build:e2e && npm run test:e2e
# 调试构建支持 MY_EDITOR_CONFIG_DIR（E2E 用它隔离会话 / 草稿；WebView2 数据目录同样按用例隔离），
# 正式构建忽略；命令行传目录 = 打开工作区（my-editor.exe D:\project）
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
- 测试基线（2026-11-08）：`npm test` 131 项 + 渲染层 33 项（`vitest.render.config.ts`）、`cargo test --lib` 210 项（+2 条默认 ignore 的真实注册表往返）、E2E 24 条
- 0.8.1 性能与资源修复（2026-11-08）：三轮性能/内存审查收口 —— 重载与退出统一释放后端资源
  （Code Run / PTY / 大文件会话）、大文件会话级取消标志（索引 / 续扫 / 过滤）、过滤取消按会话隔离且
  取消即作废半截命中、窗口读取不再克隆锚点表、过滤块缓冲复用；验收见 `docs/acceptance/2026-11-08.md`
- 0.8.0 可发现性与产品化（2026-11-06，`dev/0.8.0`）：133 条命令补齐说明与结果去向（58 条高频命令带搜索关键词）、
  命令面板两行渲染 + 按用途搜索、产物类动作统一走结果卡（路径可复制 / 打开目录，通知中心留底）、
  四处「导出补丁」按来源改名且同名不静默覆盖、Git 历史面板范围说明与复制 / 导出、6 个面板 `?` 入口、空态补下一步；
  新增 `scripts/audit-discoverability.mjs`（C0–C8 判据）并接入 `ci.yml`，
  验收记录见 `docs/acceptance/2026-11-06-discoverability.md`；2026-11-07 审查收口：
  用途搜索改为唯一命中、结果卡按调用点（函数 + 卡片标题）校验、评分抽到 `src/core/commandScore.ts` 与审计共用、
  CI 增「命令索引重生成后无 diff」判据；C.17 人工走查仍未执行
- 0.7.0 计划 S0–S1 完成（2026-11-04）：起始标签 `v0.6.3-baseline`、工作分支 `dev/0.7.0`；
  新增 IPC 参数契约 / 生产 panic 点 / DOM 注入面三道静态门禁（`scripts/`，已接入 `ci.yml`）；
  验收基线整理为 `docs/ACCEPTANCE.md`（自动 / 半自动 / 人工三层，与批次一一对应）
- 0.7.0 计划 S2 进行中（2026-11-04）：E2E 基座已接入（调试版应用 + WebView2 CDP + Playwright，
  `e2e/` + `playwright.config.ts`，19 条用例覆盖 12 条关键路径与启动基线（路径 2 仅覆盖保存保持原编码）；
  渲染层测试覆盖 `searchView` / `quickOpen` / `tabsBar` / `gitView`
- 0.7.0 计划 S3 完成（2026-11-04，标签 `v0.7.0-s3`）：release 关闭 devtools、
  抓取重定向逐跳复查、配置目录写保护、DOM 注入面归零、终端 shell 收敛到内置列表
- 0.7.0 计划 S4 完成（2026-11-04，标签 `v0.7.0-s4`）：格式化失败结构化提示 + 配置直达、
  冲突引导三动作、分支重命名（git branch -m）、大文件过滤结果导出 / 复制
- 0.7.0 计划 S5 完成（2026-11-05，标签 `v0.7.0-s5`）：Code Run 运行器可配置
  （config.json 的 runners 表按语言键扩展 / 覆盖，设置页增删改 + 参数校验，立即生效）
- 0.7.0 计划 S6 完成（2026-11-05，标签 `v0.7.0-s6`）：Git 历史 / Blame 千条级列表虚拟化、
  历史面板键盘操作（↑↓/Enter/Esc）、git.css 废弃样式清理（-231 行）、首行提取统一走 firstLine
- 0.7.0 计划 S7 完成（2026-11-05，标签 `v0.7.0`）：验收记录归档 docs/acceptance/2026-11-05.md，
  CHANGELOG 转 0.7.0 段、USER-GUIDE 补运行器与命令行工作区说明，版本号统一 0.7.0
- 0.7.1 收口修复（2026-11-06）：审查报告 P0-1 / P0-2 / P2-1 / P2-2 全部修复
  （运行器 program / 参数双侧校验、大文件导出防覆盖 + 原子写、scan-innerhtml 补 `+=` 与 `index.html`、
  scan-unsafe 按 `#[cfg(test)]` 项边界分类、CI Node 24 与恒真条件清理）；
  P1-1 判据收敛为纵深防御（不拆分 capability，理由见 docs/acceptance/2026-11-06.md §3）；
  E2E 20 条全绿；执行数据与判定见 docs/acceptance/2026-11-06.md
- **打包约束**：安装包文案（`shortDescription` / `longDescription` 等）含中文时，必须配 `bundle.windows.wix.language: "zh-CN"`，
  否则 WiX 以代码页 1252 链接 MSI 会报 `LGHT0311`；改过 bundle 配置先在本地 `npm run tauri build` 跑通再推 tag
- 未达项：E2E 20 条用例覆盖全部 12 条关键路径（路径 2 的「另存为转码」仍受原生对话框限制）；
  C 层人工观感条目待桌面会话走查（`☐` 未勾选原因已统一声明在 docs/ACCEPTANCE.md 头部，走查后补录）；
  `formatters` 的 tool / args 未做 program 级校验（v0.6.3 起的既有面，见 docs/acceptance/2026-11-06.md §7）；
  自动更新的 endpoint / pubkey 仍为占位，发布产物不含 `latest.json` 与签名
