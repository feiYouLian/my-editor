# CODEBUDDY.md

## 项目概况

轻量级定制文本编辑器：Tauri 2（Rust 后端）+ CodeMirror 6（前端单编辑器实例）+ Vite。
技术设计见根目录《轻量级定制文本编辑器_技术设计文档.md》，功能清单见《轻量级编辑器_易实现功能清单.md》。

## 目录约定与依赖规则（2026-10 重构中，强制执行）

```
src/
  core/     纯函数与零依赖基础（记法解析、命令注册表、格式化、路径工具）
  ui/       通用 DOM 控件与界面部件（菜单工厂、表单控件、对话框）
  panels/   功能面板（文件树、设置中心、预览、大文件视图、差异面板…）
  editor/   CodeMirror 6 相关（装配、扩展、书签、变换）
  store/    应用状态（标签页 TabStore）
  services/ 与 Rust 后端的服务封装（会话、工作区、文件监视）
  app/      跨模块编排 host（Phase 3 从 main.ts 迁出）
  main.ts   装配层：import + 依赖组装 + bootstrap()，目标 ≤ 500 行
```

依赖方向（单向，禁止反向 import）：

```
core → ui → panels → app → main.ts
```

- `core/` 不得 import 上面任何一层
- `ui/` 只依赖 `core/`
- `panels/` 依赖 `core/` + `ui/`
- `app/` 编排 `core/ui/panels/editor/store/services`
- 跨模块共享状态经 `app/context.ts` 的 `AppContext` 显式传递，禁止新增模块级可变单例

## 验收基线（每个改动后必跑）

```bash
npx tsc --noEmit && npm run build && (cd src-tauri && cargo test)
```

Rust 侧另有安全约束：所有 fs 类命令必须过 `commands/paths.rs` 的路径守卫
（读取类自动登记；树操作限工作区根；覆盖类限已知文件及同目录）；重活一律
`spawn_blocking`，同步命令不得做全文件/全盘扫描。

## 当前状态

- 安全修复 + 高危 bug 修复：已完成（2026-10-21）
- 结构重构：按《重构计划.md》执行，Phase 0 进行中
- 新增功能（格式转换 / properties 高亮 / 网页抓取 / cURL 脚本执行）：已完成（2026-10-24），设计见《新增功能_技术设计文档.md》
- 终端与 Code Run 增强（PTY 终端 / 在终端运行 / 按语言输出优化）：已完成（2026-10-24），设计见《终端与CodeRun增强_技术设计文档.md》
