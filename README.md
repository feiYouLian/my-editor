# my-editor · 轻量级定制文本编辑器

设计文档：[`轻量级定制文本编辑器_技术设计文档.md`](./轻量级定制文本编辑器_技术设计文档.md)（v2.8；性能实测基线见 §11.19）

基于 **Tauri 2 + Vite + TypeScript + CodeMirror 6** 的桌面文本编辑器：前端负责编辑与交互，Rust 侧负责文件 IO、编码、大文件索引、Diff、格式化调度、进程运行与文件监听。

## 功能列表

### 文件与编辑

- 打开 / 保存 / 另存为 / 新建未命名（自动编号 `未命名-1`、`未命名-2`…）
- 原子保存：临时文件 + fsync + rename，保留原换行符（LF / CRLF / CR）与 BOM
- 编码：BOM / UTF-8 优先 / chardetng 三段式检测，状态栏可「重新打开为」其它编码；切换编码后保存即转码
- 乱码检测：识别「合法 UTF-8 字节被按其它编码解读」等异常并在状态栏提示建议编码
- 换行符：状态栏点击在 LF / CRLF / CR 间切换（仅改内存并标脏，手动保存落盘）
- 脏标记基线比对：内容、编码、换行符与最近保存基线一致时自动恢复干净状态
- 外部修改检测：文件被其它程序改动时状态栏提示「外部修改」，点击重新载入（自身保存不会误报）
- 最近打开列表、面包屑路径（工作区内显示相对层级，工作区外显示绝对路径；点击目录层级可预览内容并快速打开）

### 编辑器内核（CodeMirror 6）

- 语法高亮：内置 7 种 + 懒加载 7 种（Rust / Go / Java / C++ / SQL / YAML / XML）
- 撤销 / 重做、多光标、行号、活动行高亮
- 查找 / 替换：中文界面、正则捕获组 `$1`、In Selection、查找结果面板（双击跳转）
- 书签：切换 / 下一个 / 上一个（`Ctrl+F2` / `F2` / `Shift+F2`）
- 列块编辑：`Alt` 拖选 + 列编辑器对话框（`Alt+C`，插入序号 / 对齐等）
- 选中同名高亮、括号匹配、彩虹括号（按嵌套深度 6 色循环）、缩进参考线
- 空白字符显隐（状态栏与菜单开关，配置持久化）
- 行操作：删行 `Ctrl+D`、移动行 `Alt+↑/↓`、复制行 `Ctrl+Alt+↑/↓`、切换注释 `Ctrl+/`、Home 双段跳转
- 语言模式：状态栏手动覆盖高亮语言（自动 / 纯文本 / 各语言）
- 右键菜单：两级分组（编辑 / 查找与书签 / 代码 / 文本转换 / 插入 / JSON / Markdown），按当前语言与只读状态过滤

### 文件管理与工作区

- 文件树：目录懒加载、展开状态持久化、新建 / 重命名 / 删除 / 在文件管理器中定位 / 刷新
- 多标签页：脏标记、右键关闭左侧 / 右侧 / 其他 / 全部、鼠标滚轮横向滚动
- 工作区：打开目录、根目录与展开状态持久化、启动恢复
- 会话恢复：打开文件列表 + 光标位置 + 分栏比例；大文件以占位标签懒加载
- 草稿自动保存：编辑防抖写入草稿，启动时可恢复 / 丢弃 / 另存，按保留天数清理
- 文件树图标：统一线条 SVG，按类型着色（代码 / 配置 / 图片 / 压缩包）

### 预览与导出

- Markdown 预览：编辑 / 预览 / 双栏三态，双栏比例可拖动，滚动联动
- HTML 预览：沙箱 iframe（禁脚本）
- 图片查看器：缩放 / 适应窗口
- 导出：HTML（内联样式）、Word（.doc）、PDF（系统打印对话框）
- 大文件（≥ 20MB 或 `.log`）不进入编辑器，改为只读虚拟视图：稀疏行索引、按窗口读取、过滤、Minimap、编码重解释、逃生门

### 格式化

- Prettier 前端通道（懒加载分语言插件）：JS / JSX / TS / TSX / JSON / CSS / Markdown / HTML / YAML
- 内置格式化器：SQL（sql-formatter）、XML（xml-formatter）
- CLI 后端通道（5s 超时）：black / gofmt / rustfmt / google-java-format / clang-format
- 文档级与选中级格式化（选中先做缩进归一化）；>10000 行需确认

### 文本工具

- 大小写与命名风格：全部大写 / 小写 / 每词首字母大写 / camelCase / PascalCase / snake_case / kebab-case / CONSTANT_CASE
- JSON 美化 / 压缩（有选区处理选区，无选区处理整篇）
- Markdown：加粗 / 斜体 / 高亮包裹切换、插入 GFM 表格
- 插入：本地时间 / ISO / Unix 时间戳 / 日期 / 时间 / UUID v4 / 剪贴板图片（存 `.assets` 并插入引用）
- 正则测试器、Cron 表达式解析与生成（5 / 6 / 7 段，含未来 5 次执行时间与字段说明）
- 另存为指定编码；批量另存为编码（非破坏式，只生成副本）

### 代码运行（Code Run）

- 支持 Python / Node（JS、JSX）/ Java / cURL
- 标题栏运行按钮与 `F5`，运行中切换为停止
- 独立输出面板，流式回传；30s 超时、单次输出上限 1MB、进程树终止

### 设置与主题

- 主题：Dark / Light / 高对比度 / 跟随系统；编辑器语法主题与字号独立配置
- 快捷键注册表：可视化查看、录制重绑定、冲突检测、恢复默认（覆盖存 `config.json`）
- 页面布局：侧栏显隐、默认视图、分栏比例、编辑器显示项、状态栏字段显隐与排序
- 配置热更新：修改 `config.json` 后可「重新加载配置」即时生效

### 差异比较

- 与磁盘内容 / 指定文件 / Git HEAD / Git 暂存区比较
- 双栏差异视图、差异块级「采用左侧 / 采用右侧」、导出补丁

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

产物位于 `src-tauri/target/release/bundle/`（Windows：`msi/` 与 `nsis/`，nsis 产物即 .exe 安装包）。

## 测试与校验

```bash
npm run build            # 前端类型检查 + 生产构建
cd src-tauri
cargo test --lib         # Rust 单元测试（当前 53 项）
```

E2E（Playwright + tauri-driver）尚未接入。

## 图标

```bash
node scripts/gen-icon.mjs                 # 生成 512x512 源图标 icons/app-icon.png
npx tauri icon icons/app-icon.png         # 生成 src-tauri/icons/ 全量图标
```

## 源码目录

```
src/                          # 前端（原生 TS + Vite）
├── main.ts                   # 应用编排：标签联动、菜单、命令注册、Code Run、草稿/会话
├── editor/
│   ├── setup.ts              # CodeMirror 实例与扩展开关
│   ├── languages.ts          # 语言注册与懒加载
│   ├── theme.ts              # 编辑器语法主题
│   ├── search.ts             # 查找面板（中文界面）
│   ├── searchPanel.ts        # 查找结果面板
│   ├── bookmarks.ts          # 书签 gutter 与跳转
│   ├── columnEditor.ts       # 列编辑器对话框
│   ├── occurrences.ts        # 选中同名高亮
│   ├── rainbowBrackets.ts    # 彩虹括号
│   ├── format.ts             # Prettier + CLI 格式化
│   ├── transforms.ts         # 大小写 / JSON 美化压缩
│   └── markdownTools.ts      # Markdown 包裹与表格
├── panels/
│   ├── fileTree.ts           # 文件树（SVG 图标、右键操作）
│   ├── commandPalette.ts     # 命令面板
│   ├── menubar.ts            # 标题栏菜单
│   ├── preview.ts            # Markdown / HTML 预览、图片查看器与导出
│   ├── largeView.ts          # 大文件只读虚拟视图
│   ├── diffPanel.ts          # 差异比较视图
│   ├── settingsPanel.ts      # 设置中心
│   ├── cron.ts / cronPanel.ts# Cron 解析器与生成面板
│   ├── batchEncoding.ts      # 批量另存为编码
│   ├── regexTester.ts        # 正则测试器
│   ├── tableDialog.ts        # Markdown 表格对话框
│   ├── recentFiles.ts        # 最近打开
│   ├── saveEncoding.ts       # 另存为指定编码
│   └── runPanel.ts           # Code Run 输出面板
├── services/
│   ├── workspace.ts          # 工作区读写
│   ├── session.ts            # 会话与草稿
│   └── fsWatch.ts            # 外部修改事件订阅
├── store/
│   └── tabs.ts               # 多标签状态（内容 / 编码 / 换行 / 脏标记基线）
├── config/
│   ├── settings.ts           # config.json 读写与热更新
│   ├── keybindings.ts        # 快捷键注册表
│   └── formatters.ts         # CLI 格式化器定义
├── ui/
│   ├── dialogs.ts            # 确认 / 输入对话框
│   ├── menu.ts               # 弹出菜单定位（视口钳制）
│   └── settingsHelp.ts       # 配置说明
├── types/
│   └── app.ts                # 前后端共享类型
└── styles/
    └── main.css              # 主题与全局样式

src-tauri/src/                # Rust 后端
├── main.rs                   # 入口
├── lib.rs                    # Tauri Builder、命令注册、应用状态
└── commands/
    ├── file.rs               # 读取 / 探测 / 保存（原子写、BOM 与换行符）
    ├── encoding.rs           # 编码检测与乱码诊断
    ├── large.rs              # 大文件稀疏索引、窗口读取、过滤、Minimap
    ├── diff.rs               # 文本 / 文件 / Git 差异与补丁导出
    ├── format.rs             # CLI 格式化调度
    ├── run.rs                # Code Run（进程组、超时、输出上限）
    ├── watch.rs              # 外部修改监听（notify）
    ├── session.rs            # 会话与草稿持久化
    ├── batch.rs              # 批量另存为编码（非破坏式）
    ├── workspace.rs          # 工作区持久化
    ├── fs.rs                 # 文件树文件系统操作
    └── config.rs             # config.json 读写与版本迁移

scripts/                      # 开发辅助脚本（图标生成）
```

## 本地数据文件

均位于 Tauri 应用配置目录：

| 文件 / 目录 | 内容 |
| --- | --- |
| `config.json` | 主题、快捷键、布局、编辑器增强、会话与大文件等配置 |
| `workspace.json` | 工作区根目录与文件树展开状态 |
| `session.json` | 打开文件列表、光标位置、激活文件、分栏比例 |
| `drafts/` | 未保存内容的草稿（防抖写入，按保留天数清理） |

## 快捷键

| 快捷键 | 功能 |
| --- | --- |
| Ctrl/Cmd+S / Ctrl/Cmd+Shift+S | 保存 / 另存为 |
| Ctrl/Cmd+O / Ctrl/Cmd+N | 打开文件 / 新建未命名文档 |
| Ctrl/Cmd+W / Ctrl/Cmd+Q | 关闭标签 / 退出 |
| Ctrl/Cmd+F / Ctrl/Cmd+H | 当前文档查找 / 替换 |
| Ctrl/Cmd+Shift+P | 命令面板 |
| Ctrl/Cmd+B | 切换侧栏 |
| Ctrl/Cmd+, | 打开设置 |
| Ctrl/Cmd+PageUp / PageDown | 上一个 / 下一个标签 |
| F5 | 运行当前文件（Code Run） |
| Shift+Alt+F | 格式化文档 |
| Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z | 撤销 / 重做 |
| Ctrl/Cmd+/ | 切换注释 |
| Ctrl/Cmd+D | 删除当前行 |
| Alt+↑ / Alt+↓ | 上移 / 下移当前行 |
| Ctrl/Cmd+Alt+↑ / ↓ | 复制行到上方 / 下方 |
| Alt+拖选 | 列选择 |
| Alt+C | 列编辑器 |
| Ctrl/Cmd+F2 / F2 / Shift+F2 | 切换书签 / 下一个 / 上一个 |

状态栏可点击切换：编码、换行符、语言模式、空白字符显示。

## 已知取舍

- **全局搜索与 TODO 列表已按需求舍去**：保留当前文档查找 / 替换与查找结果面板
- **AI 辅助（B11）与 OCR（B12）** 尚未实现
- 批量转换原文件（就地改写）已舍去，仅提供非破坏式的「批量另存为编码」
- E2E 关键路径、macOS / Linux 内存数据待补
