# CODEBUDDY.md

## 项目概况

轻量级定制文本编辑器：Tauri 2（Rust 后端）+ CodeMirror 6（前端单编辑器实例）+ Vite。
技术设计见根目录《轻量级定制文本编辑器_技术设计文档.md》，功能清单见《轻量级编辑器_易实现功能清单.md》，
重构历程见《重构计划.md》，历次评审与优化记录见 `.doc/`。

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
npx tsc --noEmit && npm run build && (cd src-tauri && cargo test --lib)
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
- 结构重构 Phase 0–5：已完成（2026-10-23，main.ts 3317 → 约 1330 行，2026-10-25 实测 1327）
- 新增功能（格式转换 / properties 高亮 / 网页抓取 / cURL 脚本执行）：已完成（2026-10-24）
- 终端与 Code Run 增强（PTY 终端 / 在终端运行 / 按语言输出优化）：已完成（2026-10-24）
- 全局代码审查与优化（保存基线、载入代际、热路径、Rust 阻塞命令、CSP、路径守卫）：已完成（2026-10-25），
  记录见 `.doc/全局代码审查与优化-2026-10-25.md`
- 未达项：`main.ts` 仍 1327 行（目标 ≤ 500），剩余为命令注册表数据与跨宿主接线；
  E2E（Playwright + tauri-driver）尚未接入
