# my-editor · 轻量级定制文本编辑器

设计文档：[`轻量级定制文本编辑器_技术设计文档.md`](./轻量级定制文本编辑器_技术设计文档.md)（v1.3）

本仓库为 Tauri 2 + Vite + TypeScript 项目骨架，对应设计文档**阶段 0**：基础布局（左树 + 右编辑器 + 状态栏）、Rust 文件对话框、读写命令（原子保存）。

## 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20 | 已用 v24 验证 |
| Rust | ≥ 1.77 | 通过 [rustup](https://rustup.rs) 安装 |

平台额外依赖：

- **Windows**：WebView2 Runtime（Win10/11 默认自带）+ [Microsoft C++ 生成工具](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
- **macOS**：Xcode Command Line Tools（`xcode-select --install`）
- **Linux**：`sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf`

## 快速开始

```bash
npm install
npm run tauri dev
```

## 构建与打包

```bash
npm run tauri build
```

产物位于 `src-tauri/target/release/bundle/`（Windows: `msi/` 与 `nsis/`，nsis 产物即 .exe 安装包）。

## 图标

```bash
node scripts/gen-icon.mjs                 # 生成 512x512 源图标 icons/app-icon.png
npx tauri icon icons/app-icon.png         # 生成 src-tauri/icons/ 全量图标
```

## 阶段 0 验收对照

| 验收项 | 状态 |
| --- | --- |
| 项目骨架（Tauri 2 + Vite + TS）可运行 | ✅ |
| 文件对话框打开 / 读取 | ✅ `read_file`（BOM 与换行符探测） |
| 保存：临时文件 + fsync + 原子 rename，保留换行符 / BOM | ✅ `save_file` |
| 基础布局 + 状态栏（路径/大小/编码/换行符/未保存标记） | ✅ |
| Ctrl/Cmd+S 保存 | ✅ |

**轻量化基线实测（阶段 0 收尾必做，对应设计文档 1.3 指标）**：

- 包体：`npm run tauri build` 后记录 `src-tauri/target/release/bundle/` 产物大小（目标 <15MB）
- 空闲内存：启动后不打开任何文件，用任务管理器（Windows）/ 活动监视器（macOS）记录进程工作集（目标 <120MB）
- 在基准环境（4 核 / 16GB / NVMe / Win11）测量，每项 3 次取中位数，结果记入文档 10.3

## 目录结构（对应设计文档第 6 章）

```
src/                      # 前端（原生 TS + Vite）
├── main.ts               # 阶段 0 主逻辑（阶段 1 起拆分 editor/ panels/ store/）
├── types/app.ts          # 前后端共享类型
└── styles/main.css       # 暗色主题
src-tauri/                # Rust 后端
├── src/main.rs           # 入口
├── src/lib.rs            # Tauri Builder / 命令注册
├── src/commands/file.rs  # 文件读写（原子保存）
├── capabilities/         # 权限最小化（阶段 0 仅对话框）
└── tauri.conf.json
scripts/                  # 开发辅助脚本（图标生成）
tests/ e2e/               # 单元测试 / E2E（阶段 9 建设）
```

## 开发进度

- **阶段 0（已完成）**：项目骨架、文件对话框、读写命令（原子保存）、基础布局与状态栏
- **阶段 1（已完成）**：CodeMirror 6 编辑器核心
  - ✅ spike 结论：列选择 = `@codemirror/view` 核心 `rectangularSelection`（Alt+拖选）；空白字符 = 核心 `highlightWhitespace()`；缩进参考线 = `@replit/codemirror-indentation-markers`；书签 = 自研 gutter
  - ✅ 已实现：CM6 集成（`src/editor/setup.ts`）、语言注册表（7 内置 + 7 懒加载：Rust/Go/Java/C++/SQL/YAML/XML）、one-dark 主题、选中同名高亮、括号匹配、缩进参考线、空白字符开关、列编辑器（Alt+C）、书签（Ctrl+F2/F2/Shift-F2 + 标记所有命中）、查找替换面板 + 自定义结果面板（二次过滤/双击跳转）、状态栏（路径/大小/编码/换行符/语言/光标/行数/未保存）
  - ⏳ 待办：CM6 大文档内存实测（5/10/20MB 三档，超标则编辑器阈值降至 10MB）；真机交互验证

- **阶段 3（进行中）**：Markdown/HTML 编辑与预览双模式
  - ✅ 已实现：MD 预览（markdown-it + DOMPurify + highlight.js，编辑/预览/双栏三模式，滚动联动，300ms 防抖，**分割线可拖动调比例**）；HTML 沙箱 iframe 预览（禁脚本）；图片查看器（只读，缩放/适应）；**预览右键导出 HTML / Word(.doc) / PDF（系统打印对话框）**；read_file 二进制检测；≥20MB 预览禁用
  - ⏳ 待办：HTML/PDF 导出；MD 相对路径图片解析（自定义协议）

- **阶段 2（已完成）**：文件管理 + 工作区 + 命令面板 + 格式化
  - ✅ 文件树（`src/panels/fileTree.ts`）：目录懒展开、单击打开、右键菜单（新建/重命名/删除/文件管理器定位/刷新）
  - ✅ 多标签页（`src/store/tabs.ts`）：标签栏/切换/关闭（脏文件确认）/未保存标记
  - ✅ 工作区（`src/services/workspace.ts`）：打开目录、根目录+展开状态+打开文件列表持久化（Rust `workspace.json`，原子写入）、启动恢复
  - ✅ 命令面板（`src/panels/commandPalette.ts`）：Ctrl+Shift+P、模糊匹配、动作注册表（文件/工作区/编辑/查找四组）
  - ✅ Prettier 前端通道（`src/editor/format.ts`）：Shift+Alt+F / 命令面板，懒加载 standalone + 分语言插件；**json / yaml / sql / xml 四个格式全内置零外部依赖**（sql→sql-formatter、xml→xml-formatter，换行符风格自动还原）
  - ✅ CLI 后端通道（`src-tauri/src/commands/format.rs`）：black/gofmt/rustfmt/google-java-format/clang-format，stdin/stdout、5s 超时 kill、缺失安装引导、`__PLACEHOLDER__` 路径替换
  - ✅ 文档级 + 选中级格式化（缩进归一化）、>10000 行大文件确认

### 阶段 1 验收对照

| 验收项 | 状态 |
| --- | --- |
| 单文件编辑器可用（<20MB 文档） | ✅ |
| 代码高亮（内置 7 语言 + 懒加载 7 语言，>50000 行降级） | ✅ |
| 查找替换六项细节（面板/书签/增量/$1/In Selection/二次过滤） | ✅ |
| 列编辑（Alt 拖选）+ Alt+C 列编辑器三种模式 | ✅ |
| 选中同名高亮 / 空白字符 / 括号匹配 / 缩进参考线 | ✅ |
| 状态栏字段齐全（3.1） | ✅ |
| CM6 大文档内存实测 | ⏳ 待测 |

### 编辑器快捷键

| 快捷键 | 功能 |
| --- | --- |
| Ctrl/Cmd+F / Ctrl/Cmd+H | 查找 / 替换面板 |
| Alt+左键拖选 | 列选择 |
| Alt+C | 列编辑器对话框 |
| Ctrl+F2 / F2 / Shift+F2 | 切换书签 / 下一个 / 上一个 |
| Ctrl/Cmd+S | 保存 |
