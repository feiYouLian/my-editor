# my-editor · 轻量级定制文本编辑器

设计文档：[`轻量级定制文本编辑器_技术设计文档.md`](./轻量级定制文本编辑器_技术设计文档.md)（v2.9；性能实测基线见 §11.19）；新增域见 [`新增功能_技术设计文档.md`](./新增功能_技术设计文档.md) 与 [`终端与CodeRun增强_技术设计文档.md`](./终端与CodeRun增强_技术设计文档.md)。

基于 **Tauri 2 + Vite + TypeScript + CodeMirror 6** 的桌面文本编辑器：前端负责编辑与交互，Rust 侧负责文件 IO、编码、大文件索引、Diff、格式化调度、进程运行与文件监听。

## 功能列表

### 文件与编辑

- 打开 / 保存 / 另存为 / 新建未命名（自动编号 `未命名-1`、`未命名-2`…）
- 原子保存：临时文件 + fsync + rename，保留原换行符（LF / CRLF / CR）与 BOM
- 编码：BOM / UTF-8 优先 / chardetng 三段式检测，状态栏可「重新打开为」其它编码；切换编码后保存即转码
- 乱码检测：识别「合法 UTF-8 字节被按其它编码解读」等异常并在状态栏提示建议编码
- 换行符：状态栏点击在 LF / CRLF / CR 间切换（仅改内存并标脏，手动保存落盘）
- 脏标记基线比对：内容、编码、换行符与最近保存基线一致时自动恢复干净状态
- 外部修改检测：文件被其它程序改动时状态栏提示「外部修改」，点击可选择重新载入 / 与磁盘比较 / 忽略（自身保存不会误报）
- 最近打开列表、面包屑路径（工作区内显示相对层级，工作区外显示绝对路径；点击目录层级可预览内容并快速打开）
- 从网址抓取网页：输入 URL 保存为本地 HTML 并自动打开；默认拦截内网 / 本机地址（`config.json` 可放开）
- 全部保存（`Ctrl+Alt+S`）、重新载入当前文件、重新打开关闭的标签（`Ctrl+Shift+T`）
- 运行（`F5`）前自动保存未落盘内容；外部修改提示提供「重新载入 / 与磁盘比较 / 忽略」三选

### 编辑器内核（CodeMirror 6）

- 语法高亮：内置 7 种 + 懒加载 9 种（Rust / Go / Java / C++ / SQL / YAML / XML / Properties / cURL）
- 撤销 / 重做、多光标、行号、活动行高亮
- 查找 / 替换：中文界面、正则捕获组 `$1`、查找结果面板（双击跳转）
- 书签：切换 / 下一个 / 上一个（`Ctrl+F2` / `F2` / `Shift+F2`）
- 列块编辑：`Alt` 拖选 + 列编辑器对话框（`Alt+C`，插入序号 / 对齐等）
- 选中同名高亮、括号匹配、彩虹括号（按嵌套深度 6 色循环）、缩进参考线
- 空白字符显隐（状态栏与菜单开关，配置持久化）
- 代码折叠：gutter 折叠标记 + `Ctrl+Shift+[` / `Ctrl+Shift+]`（设置可关）
- 状态栏显示选中字符数（多选区求和）
- 行操作：删行 `Ctrl+D`、移动行 `Alt+↑/↓`、复制行 `Ctrl+Alt+↑/↓`、切换注释 `Ctrl+/`、Home 双段跳转
- 语言模式：状态栏手动覆盖高亮语言（自动 / 纯文本 / 各语言）
- 右键菜单：两级分组（编辑 / 查找与书签 / 代码 / 文本转换 / 插入 / JSON / Markdown），按当前语言与只读状态过滤

### 文件管理与工作区

- 文件树：目录懒加载、展开状态持久化、新建 / 重命名 / 删除 / 在文件管理器中定位 / 刷新 / 在终端中打开
- 多标签页：脏标记、右键关闭左侧 / 右侧 / 其他 / 全部、鼠标滚轮横向滚动、拖拽排序、常驻「+」新建按钮
- 快速打开（`Ctrl+P`）：工作区文件模糊过滤，多关键词 AND，30s 缓存
- 侧栏分区（VS Code 风格折叠列表）：正在打开的文件 / 文件 / 搜索 / 大纲；展开项持久化，打开的文件可点击激活与关闭
- 工作区搜索（`Ctrl+Shift+F`）：大小写 / 正则、忽略目录、按文件分组、行内替换预览与批量替换；替换历史存于应用配置目录，支持一键撤销
- 拖放打开：拖入文件直接打开，拖入目录询问设为工作区
- 首屏欢迎页：打开文件 / 新建 / 打开目录 / 最近打开
- 视图菜单：切换侧栏、切换终端、显示运行输出、侧栏视图（文件 / 搜索 / 大纲）
- 工作区：打开目录、根目录与展开状态持久化、启动恢复
- 会话恢复：打开文件列表 + 光标位置 + 分栏比例；大文件以占位标签懒加载
- 草稿自动保存：编辑防抖写入草稿；启动时以列表统一勾选恢复（原文件已变化的草稿另存为新文档），按保留天数清理
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
- 格式转换：JSON ↔ YAML、Properties ↔ YAML（`.` 层级展开 / 拍平，可选标量推断）、Java → JSON 示例，JSON → Java 代码生成；面板预览 + 命令面板直转
- Markdown：加粗 / 斜体 / 高亮包裹切换、插入 GFM 表格
- 插入：本地时间 / ISO / Unix 时间戳 / 日期 / 时间 / UUID v4 / 剪贴板图片（存 `.assets` 并插入引用）
- 正则测试器、Cron 表达式解析与生成（5 / 6 / 7 段，含未来 5 次执行时间与字段说明）
- 另存为指定编码；批量另存为编码（非破坏式，只生成副本）

### 代码运行（Code Run）

- 支持 Python / Node（JS、JSX）/ Java / cURL
- cURL 脚本无需保存即可执行（选区优先，无选区整篇）；`.curl` 文件与 Markdown 围栏有高亮；兼容 PowerShell / DevTools 的 `& 'curl' ...` 复制形式，Windows 使用 `curl.exe` 避免 PowerShell 别名
- 标题栏运行按钮与 `F5`，运行中切换为停止
- 独立输出面板，流式回传；30s 超时、单次输出上限 1MB、进程树终止
- 输出按语言优化：去 ANSI、Python/Node/Java 错误与堆栈分色、堆栈位置可点击跳转、cURL JSON 响应美化
- `Ctrl+F5` / 右键「在终端运行当前文件」：把命令送入内置终端，支持交互式输入

### 内置终端

- 真 PTY（Windows ConPTY），默认 PowerShell（有 pwsh 时优先）；``Ctrl+` `` 或工具栏 ``>_`` 打开/隐藏
- 支持颜色、光标控制、交互式程序、`Ctrl+C`、中文输入输出与窗口自适应
- 单会话；隐藏保留 shell，关闭按钮/应用退出结束进程；配置项 `terminal.shell` 可指定自定义 shell

### 设置与主题

- 主题：Dark / Light / 高对比度 / 跟随系统；编辑器语法主题与字号独立配置
- 快捷键注册表：可视化查看、录制重绑定、冲突检测、恢复默认（覆盖存 `config.json`）
- 页面布局：侧栏显隐、默认视图、分栏比例、编辑器显示项、状态栏字段显隐与排序
- 设置中心四页：外观主题 / 编辑器与布局 / 文件与会话（会话草稿、大文件、忽略目录、终端、替换历史）/ 快捷键
- 保存时自动格式化（可选，大文件自动跳过）
- 关于 / 版本：版本号、技术栈、配置与日志目录（可点击复制）、快捷键速查入口
- 快捷键速查：按命令分组列出当前已绑定键位（只读，可在设置中重绑定）
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
cargo test --lib         # Rust 单元测试（当前 103 项）
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
├── main.ts                   # 装配层：依赖组装、命令注册、快捷键分发、bootstrap
├── app/                      # 跨模块编排 host（构造函数注入 Deps）
│   ├── fileService.ts        # 打开 / 保存 / 另存 / 插入图片 / 配置文件
│   ├── sessionHost.ts        # session.json、草稿自动保存与恢复、外部修改
│   ├── tabSwitcher.ts        # 标签切换状态机（代际令牌 + 回调抑制窗口）
│   ├── previewHost.ts        # 预览模式、双栏滚动联动、导出流程
│   ├── largeFileHost.ts      # 大文件分流、虚拟视图会话、逃生门
│   ├── runHost.ts            # Code Run / 工具面板 / 格式转换入口
│   ├── terminalHost.ts       # 终端会话生命周期与「在终端运行」编排
│   ├── diffService.ts        # 四种比较场景与补丁导出
│   ├── fetchHost.ts          # 网页抓取编排（默认目录 / 抓取后打开）
│   ├── dropHost.ts           # 窗口拖放打开（文件 / 目录分流）
│   ├── statusActions.ts      # 状态栏换行 / 语言 / 编码菜单 + 乱码检测
│   ├── formatHost.ts         # 格式化编排（文档级 / 选中级 / 保存前）
│   ├── menuContent.ts        # 编辑器右键菜单内容构建器
│   ├── commandTable.ts       # 命令注册表数据（菜单 / 面板 / 快捷键同源）
│   ├── windowChrome.ts       # 标题栏按钮 / 缩放热区 / 退出清理
│   └── layout.ts             # 侧栏显隐与宽度、双栏分割线
├── core/                     # 零依赖纯函数
│   ├── commands.ts           # 命令注册表（菜单 / 面板 / 快捷键 / 设置同源）
│   ├── keyNotation.ts        # 键位记法解析、归一化与展示
│   ├── convert.ts            # 格式转换（JSON / YAML / Properties / Java + 嗅探）
│   ├── convertCodegen.ts     # JSON → Java / TypeScript 代码生成
│   ├── javaParse.ts          # Java 源码 → 类型声明 / 字段模型（字段扫描）
│   ├── javaToJson.ts         # Java 类型模型 → JSON 示例
│   ├── cron.ts               # Cron 解析与未来执行时间
│   ├── curlScript.ts         # cURL 脚本识别
│   ├── runOutput.ts          # Code Run 输出分类 / 堆栈位置 / cURL JSON
│   ├── paths.ts              # 路径工具（盘符 / UNC / 相对层级）
│   ├── format.ts             # formatSize / pad2
│   ├── fuzzy.ts              # 模糊匹配打分（命令面板 / 快速打开共用）
│   └── stamps.ts             # 时间戳与 UUID
├── editor/                   # CodeMirror 6
│   ├── setup.ts              # 单实例装配、标签载入状态机、语言热切换
│   ├── extensions.ts         # Compartment 扩展组装
│   ├── keymap.ts             # CM6 键位表
│   ├── stateCache.ts         # 每标签 EditorState 缓存
│   ├── languages.ts          # 语言注册与懒加载
│   ├── theme.ts              # 编辑器语法主题
│   ├── search.ts             # 查找面板（中文界面）
│   ├── searchPanel.ts        # 查找结果面板
│   ├── bookmarks.ts          # 书签 gutter 与跳转
│   ├── columnEditor.ts       # 列编辑器对话框
│   ├── occurrences.ts        # 选中同名高亮
│   ├── rainbowBrackets.ts    # 彩虹括号
│   ├── format.ts             # Prettier + CLI 格式化
│   ├── curlLanguage.ts       # cURL 轻量语法高亮
│   ├── transforms.ts         # 大小写 / JSON 美化压缩
│   ├── markdownTools.ts      # Markdown 包裹与表格
│   └── clipboard.ts          # 剪贴板读写
├── panels/                   # 功能面板（子目录为内部拆分）
│   ├── fileTree.ts           # 文件树（SVG 图标、右键操作）
│   ├── commandPalette.ts     # 命令面板
│   ├── menubar.ts            # 标题栏菜单
│   ├── preview.ts            # 预览宿主 + preview/（管线 / 本地图片 / 导出 / 图片查看器）
│   ├── largeView.ts          # 大文件只读虚拟视图 + largeView/（行缓存 / 过滤 / Minimap）
│   ├── diffPanel.ts          # 差异比较视图 + diffPanel/（渲染）
│   ├── settingsPanel.ts      # 设置中心骨架（分类页在 settings/）
│   ├── cronPanel.ts          # Cron 生成面板（解析在 core/cron.ts）
│   ├── batchEncoding.ts      # 批量另存为编码
│   ├── regexTester.ts        # 正则测试器
│   ├── tableDialog.ts        # Markdown 表格对话框
│   ├── recentFiles.ts        # 最近打开
│   ├── saveEncoding.ts       # 另存为指定编码
│   ├── convertPanel.ts       # 格式转换面板
│   ├── fetchPageDialog.ts    # 从网址抓取网页对话框
│   ├── terminalPanel.ts      # xterm 终端面板（懒加载）
│   ├── quickOpen.ts          # 快速打开（Ctrl+P）
│   ├── openEditorsView.ts    # 侧栏「正在打开的文件」列表
│   ├── searchView.ts         # 侧栏工作区搜索 / 批量替换
│   ├── outlineView.ts        # 侧栏大纲
│   ├── welcome.ts            # 首屏欢迎页
│   ├── draftRecovery.ts      # 草稿恢复列表
│   └── runPanel.ts           # Code Run 输出面板
├── settings/                 # 设置中心分类页
│   └── themeTab.ts / keybindingsTab.ts / layoutTab.ts / filesTab.ts / shared.ts
├── services/                 # 后端服务封装
│   ├── workspace.ts          # 工作区读写
│   ├── session.ts            # 会话与草稿
│   └── fsWatch.ts            # 外部修改事件订阅
├── store/
│   └── tabs.ts               # 多标签状态（惰性快照、指纹基线、结构/内容双事件）
├── config/
│   ├── settings.ts           # config.json 读写与热更新
│   ├── keybindings.ts        # 键位覆盖、冲突检测、分发表缓存
│   └── formatters.ts         # CLI 格式化器定义与安装提示
├── ui/
│   ├── statusBar.ts          # 状态栏渲染 / 主题 / 字段显隐 / 配置写回
│   ├── statusMenu.ts         # 状态栏弹出菜单工厂（换行 / 语言 / 编码）
│   ├── tabsBar.ts            # 标签栏渲染与右键菜单
│   ├── breadcrumb.ts         # 面包屑与目录下钻
│   ├── editorMenu.ts         # 编辑器右键菜单机器
│   ├── menu.ts               # 弹出菜单定位（视口钳制）
│   ├── dialogs.ts            # 确认 / 输入对话框
│   ├── formControls.ts       # 设置中心控件工厂
│   ├── icons.ts              # 文件图标工厂
│   ├── sidebar.ts            # 侧栏视图切换（文件 / 搜索 / 大纲）
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
    ├── terminal.rs           # 内置终端（PTY 会话、输入/尺寸、在终端运行）
    ├── fetch.rs              # 网页抓取（URL 校验 / 私网拦截 / 原子落盘）
    ├── watch.rs              # 外部修改监听（notify）
    ├── session.rs            # 会话与草稿持久化
    ├── batch.rs              # 批量另存为编码（非破坏式）
    ├── workspace.rs          # 工作区持久化
    ├── fs.rs                 # 文件树文件系统操作 / 路径类型探测
    ├── paths.rs              # 路径作用域守卫（PathGuard）
    ├── search.rs             # 文件列表 / 工作区搜索 / 批量替换与撤销历史
    └── config.rs             # config.json 读写与版本迁移

scripts/                      # 开发辅助脚本（图标生成）
```

## 本地数据文件

均位于 Tauri 应用配置目录：

| 文件 / 目录 | 内容 |
| --- | --- |
| `config.json` | 主题、快捷键、布局、编辑器增强、会话与大文件、网页抓取、终端 shell 等配置 |
| `workspace.json` | 工作区根目录与文件树展开状态 |
| `session.json` | 打开文件列表、光标位置、激活文件、分栏比例 |
| `drafts/` | 未保存内容的草稿（防抖写入，按保留天数清理） |
| `replace-history/` | 批量替换的原文快照与清单（撤销用，保留最近 10 批 / 7 天） |

## 快捷键

| 快捷键 | 功能 |
| --- | --- |
| Ctrl/Cmd+S / Ctrl/Cmd+Shift+S | 保存 / 另存为 |
| Ctrl/Cmd+O / Ctrl/Cmd+N | 打开文件 / 新建未命名文档 |
| Ctrl/Cmd+Shift+U | 从网址抓取网页 |
| Ctrl/Cmd+W / Ctrl/Cmd+Q | 关闭标签 / 退出 |
| Ctrl/Cmd+F / Ctrl/Cmd+H | 当前文档查找 / 替换 |
| Ctrl/Cmd+Shift+P | 命令面板 |
| Ctrl/Cmd+P | 快速打开文件 |
| Ctrl/Cmd+Shift+F | 工作区搜索 / 替换 |
| Ctrl/Cmd+Alt+S | 全部保存 |
| Ctrl/Cmd+Shift+T | 重新打开关闭的标签 |
| Ctrl/Cmd+Shift+[ / ] | 折叠 / 展开代码块 |
| Ctrl/Cmd+B | 切换侧栏 |
| Ctrl/Cmd+, | 打开设置 |
| Ctrl/Cmd+PageUp / PageDown | 上一个 / 下一个标签 |
| F5 | 运行当前文件（Code Run） |
| Ctrl/Cmd+F5 | 在终端运行当前文件 |
| ``Ctrl/Cmd+` `` | 打开 / 隐藏内置终端 |
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

- **全局搜索与批量替换已实现**（侧栏搜索视图，含替换历史与一键撤销）；`TODO` 列表尚未实现，可用搜索关键词替代
- **AI 辅助（B11）与 OCR（B12）** 尚未实现
- 批量编码转换仍只做非破坏式的「批量另存为编码」；就地改写请用工作区搜索的批量替换（带历史，可撤销）
- 格式转换本期只做 JSON ↔ YAML、Properties ↔ YAML 与 Java → JSON；JSON ↔ XML / CSV 延期
- 网页抓取只保存原始 HTML，不下载 / 重写图片、CSS、JS 等子资源；重定向后的最终地址 v1 不再复查（私网默认拦截 + CSP 主防线）
- 内置终端是任意命令执行入口、非沙箱；终端内命令不受 Code Run 的 30s / 1MB 限制。单会话，不随会话恢复
- `cmd.exe` 暂不支持「在终端运行」（请使用 PowerShell）；终端主题 ANSI 16 色沿用 xterm 默认
- E2E 关键路径、macOS / Linux 内存数据待补
