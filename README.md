# my-editor · 轻量级定制文本编辑器

[![release](https://img.shields.io/github/v/release/feiYouLian/my-editor?label=release)](https://github.com/feiYouLian/my-editor/releases)
[![license](https://img.shields.io/github/license/feiYouLian/my-editor)](./LICENSE)
![platform](https://img.shields.io/badge/platform-Windows%20x64-0078D6)
![installer](https://img.shields.io/badge/installer-6.92%20MiB-2ea44f)
![ui](https://img.shields.io/badge/UI-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red)

**6.92 MiB 安装包 · 48–53 ms 出窗口 · 全中文界面 · 装完即用，不用装插件**

基于 **Tauri 2 + Vite + TypeScript + CodeMirror 6** 的桌面文本编辑器：前端负责编辑与交互，Rust 侧负责文件 IO、编码、大文件索引、Diff、格式化调度、进程运行与文件监听。

定位是 **「Notepad++ 级别的上手成本，远超 Notepad++ 的能力密度」**——面向「看日志 / 改配置 / 跑脚本 / 写 Markdown」这类日常活。它**不是** VS Code 的替代品：没有 LSP（跳定义 / 诊断 / 语义补全）、没有插件体系，且不打算加（见 [已知取舍](#已知取舍)）。

## 下载安装

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Windows x64 | `my-editor_<版本>_x64-setup.exe` | NSIS 安装包，当前用户安装（**推荐**） |
| Windows x64 | `my-editor_<版本>_x64_zh-CN.msi` | MSI（简体中文），适合企业批量部署 |

- **下载**：[GitHub 最新 Release](https://github.com/feiYouLian/my-editor/releases/latest)
- **镜像 / 源码**：[Gitee](https://gitee.com/feiyoulian/my-editor) · [GitHub](https://github.com/feiYouLian/my-editor)
- 当前只发布 **Windows** 安装包；安装包未做代码签名，首次运行 SmartScreen 可能提示「未知发布者」。
- 0.6.1 起 **MSI 也是简体中文界面**（与 NSIS 对齐）；此前为 en-US，因为安装包文案含中文时 WiX 默认代码页 1252 无法链接。
- 版本号与变更见 [`CHANGELOG.md`](./CHANGELOG.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [`docs/USER-GUIDE.md`](./docs/USER-GUIDE.md) | 操作手册：五分钟上手 / 界面导览 / 常见工作流 / 设置 / 数据位置 / 排障顺序 |
| [`docs/FAQ.md`](./docs/FAQ.md) | 高频问题（编码乱码、外部修改、草稿恢复、大文件、Git 认证等） |
| [`docs/MIGRATION.md`](./docs/MIGRATION.md) | 从 VS Code / Sublime Text / Notepad++ 过来**需要改的几处习惯**（只列差异） |
| [`CHANGELOG.md`](./CHANGELOG.md) | 各版本变更 |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | 本地构建、测试基线、提交与 PR 规范 |
| [`README.en.md`](./README.en.md) | English overview（界面本身仅简体中文） |

设计文档（仓库根目录，面向维护者）：[`轻量级定制文本编辑器_技术设计文档.md`](./轻量级定制文本编辑器_技术设计文档.md)（v2.9；性能实测基线见 §11.19）；新增域见 [`新增功能_技术设计文档.md`](./新增功能_技术设计文档.md)、[`终端与CodeRun增强_技术设计文档.md`](./终端与CodeRun增强_技术设计文档.md) 与 [`编辑器Minimap缩略图_技术设计文档.md`](./编辑器Minimap缩略图_技术设计文档.md)；与 ST3 / VS Code / Notepad++ 的差距盘点、补齐方案、交互打磨、人性化审计与成本取舍见 [`编辑器差距补齐_详细设计文档.md`](./编辑器差距补齐_详细设计文档.md)（v1.8，V1 已实施，实施记录见 §16）；V1 的手工验收清单见 [`验收清单_V1.md`](./验收清单_V1.md)。

过程记录（已归档在 [`.doc/`](./.doc)，按日期命名）：代码审查、修复计划、后续任务清单、各功能专项计划与验收清单。已完成的过程文档（如重构计划、易实现功能清单、OCR 专项设计）不再单独保留，需要时查 git 历史。

## 功能列表

### 文件与编辑

- 打开 / 保存 / 另存为 / 新建未命名（自动编号 `未命名-1`、`未命名-2`…）
- 原子保存：临时文件 + fsync + rename，保留原换行符（LF / CRLF / CR）与 BOM
- 编码：BOM / UTF-8 优先 / chardetng 三段式检测，状态栏可「重新打开为」其它编码；切换编码后保存即转码
- 编码集：UTF-8 / UTF-16 / GBK / GB18030 / Big5 / Windows-1251 / Windows-1252 / Shift_JIS / EUC-KR；「另存为指定编码」可选写入 UTF-8 BOM（UTF-16 自动带 BOM），标签同步显示 BOM 状态
- 非 UTF-8 文件也能搜：工作区搜索与 `F12` 符号定位按 BOM/chardetng 解码后匹配（不只是 `from_utf8_lossy`），GBK / Big5 / UTF-16 文件结果准确
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
- 撤销 / 重做（`Ctrl+Z` / `Ctrl+Shift+Z`，Windows 同时保留 `Ctrl+Y`）、多光标、行号、活动行高亮
- 查找 / 替换：中文界面、正则捕获组 `$1`、查找结果面板（双击跳转）
- 书签：切换 / 下一个 / 上一个（`Ctrl+F2` / `F2` / `Shift+F2`），侧栏「书签」分区列出行号与内容摘要（点击跳转、× 删除，随会话恢复）
- 列块编辑：`Alt` 拖选 + 列编辑器对话框（`Alt+C`，插入序号 / 对齐等）
- 选中同名高亮、括号匹配、彩虹括号（按嵌套深度 6 色循环）、缩进参考线
- 空白字符显隐（状态栏与菜单开关，配置持久化）
- 代码折叠：gutter 折叠标记 + `Ctrl+Shift+[` / `Ctrl+Shift+]`（设置可关）
- 状态栏显示选中字符数（多选区求和）
- 行操作：删行 `Ctrl+D`、移动行 `Alt+↑/↓`、复制行 `Ctrl+Alt+↑/↓`、切换注释 `Ctrl+/`、Home 双段跳转
- 语言模式：状态栏手动覆盖高亮语言（自动 / 纯文本 / 各语言 / 自定义语言 / 附加语言）
- 转到定义 `F12`：工作区文本级定位（定义优先、多候选弹列表、无定义时回退引用）；**不做类型解析**
- 附加语言（按需加载）：Shell / PowerShell / TOML / Diff / Dockerfile / CMake / HTTP / Perl / Lua / Ruby / Haskell / C# / Kotlin，在 设置 → 编辑器与布局 勾选，打开对应文件时才加载该分片
- 右键菜单：两级分组（编辑 / 查找与书签 / 代码 / 文本转换 / 插入 / JSON / Markdown），按当前语言与只读状态过滤；行号区与内容区菜单分开（行操作不堆在内容区），支持纯键盘操作（`←`/`→` 移动、`↓`/`Enter` 展开、`Esc` 关并归还焦点）

### 文件管理与工作区

- 文件树：目录懒加载、展开状态持久化、新建 / 重命名 / 删除 / 在文件管理器中定位 / 刷新 / 在终端中打开
- 文件树多选与拖拽：`Ctrl` 点选 / `Shift` 连选，批量删除（回收站）；拖到目录或树体空白（工作区根）即移动；父目录与子项同时选中时只处理父目录，移动中途失败也会把已成功的项同步到标签
- 文件树跟随磁盘：已展开目录被其它程序新建 / 删除 / 改名时自动刷新（`workspace.watchTree` 可关，监听上限 200 个目录、非递归）
- 文件树内复制 / 剪切 / 粘贴（右键菜单或选中后 `Ctrl+C` / `Ctrl+X` / `Ctrl+V`）：复制重名会自动追加「(副本)」不覆盖任何文件，剪切遇到同名项直接报错；移动已打开的文件会同步标签路径
- **与资源管理器互通**：文件树里「复制」会把文件写进 Windows 系统剪贴板（`CF_HDROP`），可直接在资源管理器 `Ctrl+V` 粘出去；在资源管理器复制文件后，到文件树里 `Ctrl+V` 即可粘进当前目录（外部来源只复制、不删源）
- 多标签页：脏标记、右键关闭左侧 / 右侧 / 其他 / 全部、鼠标滚轮横向滚动、拖拽排序、常驻「+」新建按钮；标签多到看不全时右侧出「▾」溢出下拉直达任一标签
- 快速打开（`Ctrl+P`）：工作区文件模糊过滤，多关键词 AND，30s 缓存
- 侧栏分区（VS Code 风格折叠列表）：正在打开的文件 / 文件 / 搜索 / 大纲 / 源代码管理 / 书签；展开项持久化，打开的文件可点击激活与关闭；分区高度按内容分配、「书签 / 大纲」等可折叠，底部入口不被顶走
- 源代码管理（Git）：分支与 ahead/behind、暂存的更改 / 更改（含未跟踪）、行级与组级暂存/取消暂存、**差异块（hunk）级暂存**、提交、放弃更改（行内撤回图标 + 右键，不可撤销、需确认；覆盖前快照到配置目录 `discard-backup/`）；文件行右键（打开文件 / 查看更改 / 暂存 / 放弃更改 / 复制路径 / 复制相对路径 / 文件管理器 / 终端）；点击查看 HEAD↔工作区 / 暂存区 diff；命令失败弹窗展示完整输出（可复制）；文件树按 Git 状态染色（文件与上级目录）
- Git 历史与分支：「历史」打开底部 Git 历史面板（左侧提交列表、右侧补丁）；提交详情与文件级 diff 可回溯；左下角分支名可新建 / 切换 / 删除分支（删除在列表内二次确认）；全程不用模态对话框
- Git 冲突引导：冲突文件显示横幅与处理引导，冲突未解决前禁用提交
- Git Blame：行内 Blame 在当前行尾显示「作者 · 日期 · 摘要」（随光标与编辑状态响应，菜单「视图 ▸ 行内 Git Blame」可开关，默认开）；命令面板「Git：打开当前文件的 Blame 列表」逐行展示提交/作者/日期/内容并点击跳转（限制 2MB / 10000 行）
- **Git 只读模式**（`git.readOnly`）：只能看（状态 / 差异 / 历史 / 提交详情 / Blame / 分支列表），暂存、提交、放弃、推拉、分支写操作全部拒绝；前端守卫 + Rust `ensure_writable()` 双重校验（绕过前端也无效），且**写入口直接隐藏**而非置灰；开关即时生效
- 状态栏左下角 Git 入口：分支名点击切分支（面板可模糊过滤）、同步图标拉取 + 推送；切分支/拉取后自动重载未编辑的标签
- 工作区搜索（`Ctrl+Shift+F`）：大小写 / 正则、包含与排除 glob（gitignore 语义、规则持久化）、搜索历史 20 条、忽略目录、按文件分组、行内替换预览与批量替换；替换历史存于应用配置目录，支持一键撤销；正则走 Rust `regex` 引擎，不支持的 lookaround / 反向引用会明确提示
- 拖放打开：拖入文件直接打开，拖入目录询问设为工作区
- 菜单栏按功能归组（参考 VS Code / Sublime Text）：新增顶级 **Git** 菜单（拉取/推送、切换分支、提交历史、与 HEAD/暂存区比较、Blame、只读模式），取消孤立的「比较」菜单（文件级比较归「文件」、Git 比较归「Git」），帮助类（快捷键速查 / 关于 / 检查更新 / 日志 / 诊断包）归「帮助」，命令面板进「视图」首项
- 首屏欢迎页：打开文件 / 新建 / 打开目录 / 最近打开 / **最近工作区**（8 条，目录失效自动移除，可直接切换）
- 视图菜单：切换侧栏、切换终端、显示运行输出、侧栏视图（文件 / 搜索 / 大纲）
- 工作区：打开目录、根目录与展开状态持久化、启动恢复；缩进宽度与忽略目录可**按工作区覆盖**（设置 ▸ 文件与会话 ▸ 工作区覆盖，留空/0 跟随全局；覆盖存在应用配置目录，**不写进用户仓库**）
- 会话恢复：打开文件列表 + 光标位置 + 滚动位置 + 分栏比例；大文件以占位标签懒加载
- 草稿自动保存：编辑防抖写入草稿；启动时以列表统一勾选恢复（原文件已变化的草稿另存为新文档），按保留天数清理。**只有崩溃 / 被杀进程留下的草稿才会自动恢复**，主动关闭的标签（单条 / 批量 / 退出）连草稿副本一起删除
- 文件树图标：统一线条 SVG，按类型着色（代码 / 配置 / 图片 / 压缩包）

### 预览与导出

- Markdown 预览：编辑 / 预览 / 双栏三态，双栏比例可拖动（比例以 `config.json` 为单一真源），滚动联动
- Markdown 增强：**目录**（标题自动生成稳定锚点，右上角按 h1–h3 缩进列出、点击跳转，标题不足 2 个不显示入口）、**数学公式**（KaTeX：`$…$` / `$$…$$` / `math` 围栏，错误公式降级为红色文本）、**Mermaid 图表**（`mermaid` 围栏渲染为 SVG，`securityLevel: strict` + 过 DOMPurify，失败降级为源码块并给出原因）；KaTeX 与 Mermaid 均为按需分片，不进首屏
- HTML 预览：沙箱 iframe（禁脚本）
- 预览内查找：纯预览模式下 `Ctrl/Cmd+F` 在渲染结果（Markdown / HTML 均支持）中查找，全部命中高亮 + 当前命中橙底，`Enter` / `Shift+Enter` 上下跳转（不发散到 iframe 外的脚本，Esc 关闭）
- 图片查看器：缩放 / 适应窗口
- 导出：HTML（内联样式）、Word（.doc）、PDF（系统打印对话框）；Mermaid 图表与公式导出时固化为静态 SVG
- 本地图片：预览时探测并显示相对路径图片（非 Windows 路径统一用 `/` 拼接）
- 大文件（≥ 20MB 或 `.log`）不进入编辑器，改为只读虚拟视图：稀疏行索引、按窗口读取、过滤、Minimap、编码重解释、逃生门
- 大文件视图工具条：按**行号跳转**（过滤模式下跳到首个命中）、点击选中后**复制行**、**跟随**（每秒检查文件大小，有追加时续扫索引并贴底刷新，单次上限 32MB；手动上滚自动暂停，文件被截断/轮转时提示重开）；编码下拉不包含 UTF-16（虚拟视图按字节扫行会错位）

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
- 正则测试器、Cron 表达式解析与生成（5 / 6 / 7 段，含未来 5 次执行时间与字段说明）；正则测试与替换预览均走 Rust `regex` 引擎（与批量替换口径一致）
- **结构化只读视图**（菜单「视图 ▸ 表格视图（CSV） / JSON 树视图」）：CSV/TSV 自动探测分隔符（`,` `;` Tab `|`，引号内的分隔符不算列），支持引号包裹、字段内换行与 `""` 转义，按行虚拟滚动（十万行只渲染视口）、首行作表头与横向滚动同步、行列超限标注「已截断」；JSON 树按层懒展开（每层先渲染 200 项），超 8MB 直接拒并说明。全程不写盘
- 另存为指定编码；批量另存为编码（非破坏式，只生成副本；跳过备份文件）

### 代码运行（Code Run）

- 支持 Python / Node（JS、JSX）/ Java / cURL
- cURL 脚本无需保存即可执行（选区优先，无选区整篇）；`.curl` 文件与 Markdown 围栏有高亮；兼容 PowerShell / DevTools 的 `& 'curl' ...` 复制形式，Windows 使用 `curl.exe` 避免 PowerShell 别名
- 标题栏运行按钮与 `F5`，运行中切换为停止
- 独立输出面板，流式回传；默认 30s 超时、单次输出上限 1MB、进程树终止；「⚙」可改 **超时 1–600 秒 / 输出上限 64KB–10MB / 环境变量 / stdin**（后端逐项校验后写入子进程）
- 输出按语言优化：去 ANSI、Python/Node/Java 错误与堆栈分色、堆栈位置可点击跳转、cURL JSON 响应美化
- `Ctrl+F5` / 右键「在终端运行当前文件」：把命令送入内置终端，支持交互式输入

### 内置终端

- 真 PTY（Windows ConPTY），默认 PowerShell（有 pwsh 时优先）；``Ctrl+` `` 或工具栏 ``>_`` 打开/隐藏
- 支持颜色、光标控制、交互式程序、`Ctrl+C`、中文输入输出与窗口自适应
- **多会话**（最多 8 个 PTY）：面板带标签 / 新建 / 切换 / 重启 / 关闭；隐藏保留 shell，关闭按钮/应用退出结束进程；「在终端运行」优先复用文件所在目录的会话；配置项 `terminal.shell` 可指定自定义 shell
- 输出按 16ms / 32KB 批量下发，避免日志风暴时掉帧

### 设置与主题

- 主题：Dark / Light / 高对比度 / 跟随系统；编辑器语法主题与字号独立配置
- 自定义编辑器主题：主题 JSON 放进配置目录 `themes/`（文件名即主题名），设置页「打开主题目录 / 重新读取主题」即时生效、无需重启；格式见 [`docs/USER-GUIDE.md` §5.1](./docs/USER-GUIDE.md#51-自定义编辑器主题)
- 自定义语言：`languages/` 目录放 JSON 即可新增关键字级高亮语言（注释 / 字符串 / 数字 / 关键字 / 括号），与内置语言重名或扩展名冲突会提示并忽略；格式见 [`docs/USER-GUIDE.md` §5.2](./docs/USER-GUIDE.md#52-自定义语言关键字级高亮)
- 快捷键注册表：可视化查看、录制重绑定、冲突检测、恢复默认（覆盖存 `config.json`）
- 页面布局：侧栏显隐、默认视图、分栏比例、编辑器显示项（含右侧 Minimap 缩略图，`Ctrl/Cmd+Shift+M` 快捷切换）、状态栏字段显隐与排序
- 设置中心四页：外观主题 / 编辑器与布局 / 文件与会话（打开方式：单击 / 双击、**Windows 系统集成**、会话草稿、大文件日志扩展名、忽略目录、**工作区覆盖**、网页抓取私网开关、终端、替换历史、Git）/ 快捷键；配置保存失败时控件回滚到真实值
- 系统集成：设置 →「文件与会话 → Windows 系统集成」打开开关后，为 40 种文本类扩展名
  （txt / log / md / json / yaml / toml / xml / html / css / js / ts / rs / py / go / java / c / cpp / cs / php / rb / sh / bat / ps1 / sql / csv / diff / patch 等）
  登记「打开方式」候选（默认关，关闭开关即撤销）；检测到旧版安装包留下的默认关联时，同处提供「一键恢复」
- 帮助（菜单「帮助」）：用户指南 / 常见问题 / 快捷键速查 / 关于；内容取自仓库 `docs/`（与应用外文档同源），随安装包内联、**离线可看**，渲染走 markdown-it + DOMPurify 且按需加载（不进首屏 chunk）
- 日志与诊断：本地滚动日志（2MB × 3）、panic hook、`log_event`、「打开日志目录」与「导出诊断包」；前端未捕获异常与保存失败会落日志
- 消息历史：状态栏常驻入口（时钟图标）打开消息面板；通知按 `key` 去重（同一来源只保留最新一条）
- 检查更新：菜单「帮助 ▸ 检查更新…」（`tauri-plugin-updater`）。**当前 endpoint 与 pubkey 仍为占位**，未配置时友好失败；签名/密钥步骤见 `.doc/自动更新与签名配置-2026-10-31.md`
- 无障碍：状态栏瞬时消息与常驻错误同步走 `aria-live` 播报（这些提示 3 秒后从界面消失，读屏用户本来完全收不到）；标签栏 `role="tablist"` + 键盘切换，文件树 `role="tree"` + `aria-expanded`；深色主题强调色提到 `#66a0ff`、新增 `--accent-ink` 令牌，选中态对比度达 AA
- 保存时自动格式化（可选，大文件自动跳过）
- 关于 / 版本：版本号（由构建注入）、技术栈、配置目录（可点击复制）、快捷键速查入口
- 快捷键速查：按命令分组列出当前已绑定键位（只读，可在设置中重绑定）
- 配置热更新：修改 `config.json` 后可「重新加载配置」即时生效

### 差异比较

- 与磁盘内容 / 指定文件 / Git HEAD / Git 暂存区比较
- **灵活比较工作台**（文件 ▸ 灵活比较 / 命令面板）：左右两侧各自选来源（当前标签含未保存 / 当前选区（只比较某个方法代码块）/ 当前文件的磁盘版本（修改前 ⇄ 修改后）/ 已打开的文件 / 任意磁盘文件 / 剪贴板 / 空文本），两侧内容都可直接编辑，停顿约半秒自动重算，也可手动「重新比较」；支持差异块导航、展开全部、复制任意一侧或统一补丁
- 双栏差异视图、差异块级「采用左侧 / 采用右侧」、**差异块级「暂存此块 / 取消暂存此块」**、导出补丁；大 diff 的 DOM 构建分帧执行，目标 hunk 未渲染完时记录 pending、渲染完再跳转

## 资源占用（实测）

口径与采样方法见技术设计文档 §11.19，这里只列结论。"轻量"在本文档中**只指包体与启动**，不指内存。

| 项 | 值 | 说明 |
| --- | --- | --- |
| 安装包（NSIS / MSI） | **6.92 MiB / 8.36 MiB** | 0.6.1 实测（0.3.2 时为 4.33 / 5.88）；增长主要来自 KaTeX 与 Mermaid 随包内联（约 +4 MB；两者为按需分片，不影响首屏加载） |
| 裸可执行文件 | **15.94 MB** | 2026-11-01 实测（含内联的前端资源与回收站依赖的 `windows` crate 约 3.3 MB） |
| 应用自身进程 | 25.1 MB 工作集 / **6.0 MB 私有** | 2026-10-28 实测（Rust 后端 + 业务逻辑） |
| 整体私有内存 | **263–268 MB** | 2026-10-21 基线；其中约 262 MB 属 WebView2 进程组（系统渲染引擎，无法移除） |
| 启动到窗口出现 | 48–53 ms | 进程创建 → 主窗口句柄出现（2026-10-21） |
| **启动到可交互（TTI）** | 热启 **599–672 ms**，冷启首次 866–1088 ms | 进程创建 → 首帧绘制完成；多轮各 3 次取中位数，每次启动重写 `startup.json` |
| 10 个标签 / 24MB 日志 | 内存基本不变 | 占位标签懒加载 + 大文件只读虚拟视图 |

**请按「包体小、启动快」理解本项目，不要按「省内存」理解。** WebView2 的固定开销使整体私有内存下限在 160–200 MB，这是渲染架构决定的，与优化力度无关（论证见 `.doc/内存占用可行性分析-Sublime对比.md`）。

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

## 版本发布

版本号以 `package.json` 的 `version` 为真源，其余 4 处必须保持一致。手动逐处改容易漏，统一用脚本：

```bash
npm run bump patch               # 0.1.2 → 0.1.3
npm run bump minor               # 0.1.2 → 0.2.0
npm run bump major               # 0.1.2 → 1.0.0
npm run bump 0.2.1               # 指定版本
npm run bump patch -- --dry-run  # 只打印将改什么，不落盘
npm run bump 0.1.1 -- --force    # 允许降级（默认拒绝）
```

脚本（`scripts/bump-version.mjs`）按「文本行替换」修改，不整体重排文件，所以 diff 只有版本那一行；五个文件先在内存里算好、校验一致后才统一写盘，中途失败不会留下改了一半的状态。

| 文件 | 修改位置 |
| --- | --- |
| `package.json` | 顶层 `version`（真源） |
| `package-lock.json` | 顶层 `version` + `packages[""].version` |
| `src-tauri/tauri.conf.json` | 顶层 `version`（决定安装包版本与「关于」显示） |
| `src-tauri/Cargo.toml` | `[package]` 段下的 `version` |
| `src-tauri/Cargo.lock` | `name = "my-editor"` 对应的 `[[package]]` 块 |

发布流程：

```bash
# 1) 先把 `CHANGELOG.md` 的 [Unreleased] 改名为 [x.y.z] - 日期（新条目归集到该版本下）
npm run verify && npm test && (cd src-tauri && cargo test --lib)   # 本地基线，必须全绿
npm run tauri build                              # 验证打包能跑通（MSI + NSIS），比等 CI 编译 8 分钟后失败便宜
npm run bump 0.6.1                               # 统一改 5 处版本号
git add -A
git commit -m "chore(release): 0.6.1"
git tag v0.6.1
git push github HEAD && git push github refs/tags/v0.6.1   # 触发 .github/workflows/release.yml
git push origin HEAD --tags                                # 同步 Gitee 镜像
```

发布规范（都是踩过的坑，务必遵守）：

1. **tag 必须等于 `tauri.conf.json` 的版本号**。workflow 第一步就校验，不一致直接失败；安装包版本取自这里，对不上会产出版本号互相矛盾的 Release。
2. **不要手动在 GitHub 网页创建 Release**。手建的 Release 会占住该 tag，且 tag 指向的代码往往没改版本号，之后 workflow 永远发不进去。
3. **草稿阶段可反复重跑，Publish 之后不可变**。`tauri-action` 默认创建**草稿** Release，此时重跑会覆盖重建；一旦点了 Publish，该 Release 即成为不可变发布 —— 不能删除、不能替换资产、不能编辑。要更新安装包，唯一办法是升版本号打新 tag。
4. **同一个 tag 不要重复触发发布**。已发布后再重跑，`tauri-action` 的「先删同名资产再上传」会被 GitHub 拒绝（`Cannot delete asset from an immutable release`）；workflow 的「检查目标 tag 的 Release 状态」步骤会在编译前拦下，省去几分钟白编译。
5. **日常验证不必发 Release**。`.github/workflows/ci.yml` 在每次 push / PR 都会跑基线；发 Release 时 `tauri-action` 也会把安装包上传为 `installer-windows` artifact，直接下载安装包即可，不消耗版本号。
6. **两个远端分工**：`origin` = Gitee（镜像备份），`github` = GitHub（Actions 与 Release 所在），发布只推 `github`。
7. **安装包文案含中文时，必须配 `bundle.windows.wix.language: "zh-CN"`**。MSI 走 WiX，默认数据库代码页是 1252（Latin-1），`fileAssociations[].description` 这类中文会让 `light.exe` 报 `LGHT0311 characters that are not available in ... '1252'`（每个扩展名一条错误），打包整体失败。配好之后 MSI 用代码页 936，产物名从 `*_x64_en-US.msi` 变为 `*_x64_zh-CN.msi`（NSIS 本身支持中文，不受影响）。
8. **发过但构建失败的 tag 不要凑合用**。若 tag 指向的提交打包失败（无 Release 与产物），可选两种做法：升一个补丁号重发（保留失败 tag，代价是版本号），或删远端 tag 后在修复提交重打同名 tag（需同时处理 Gitee，且属于不可逆操作）。

## 测试与校验

```bash
npm test                 # 前端单元测试（vitest，130 项）
npm run build            # 前端类型检查 + 生产构建
cd src-tauri
cargo test --lib         # Rust 单元测试（当前 178 项）
```

另有 CI 门禁（`.github/workflows/ci.yml`）：每次 push / PR 在 Windows 上跑 `npm run verify`、`npm test`、`cargo test --lib`，与本地基线同一口径。

前端测试只覆盖「改坏了不明显」的纯逻辑：命令表数据（id 唯一 / 键位记法合法且互不冲突 / 菜单归属 / fixed 项）、键位记法解析与归一化、消息环形缓冲、日志扩展名归一化、**前后端默认值契约（共用夹具文件）**、工作区覆盖合并、CSV 分隔符与引号/截断、JSON 树摘要与超限、大纲锚点、大文件常量、运行配置。E2E（Playwright + tauri-driver）尚未接入，自动化覆盖不到的部分见 [`验收清单_V1.md`](./验收清单_V1.md)（手工验收 + 冒烟清单 §10）。

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
│   ├── gitHost.ts            # Git 状态/暂存/提交/历史/Blame 编排（串行队列 + 防抖 + 只读守卫）
│   ├── symbolHost.ts         # `F12` 跳定义的符号定位编排（定义优先 / 多候选 / 回退引用）
│   ├── noticeStore.ts        # 通知与消息历史数据（按 key 去重）
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
│   ├── csv.ts                # CSV/TSV 解析（分隔符探测、引号包裹、字段内换行）
│   ├── jsonView.ts           # JSON 树摘要与行展开（结构化只读视图用）
│   ├── outlineText.ts        # 大纲行提取与标题锚点
│   ├── textOps.ts            # 行/列文本操作纯函数（列编辑器、插入序号）
│   ├── indentDetect.ts       # 缩进风格探测（供编辑器与工作区覆盖取默认）
│   ├── errors.ts             # firstLine()：错误首行提取的唯一口径
│   ├── messageLog.ts         # 消息环形缓冲（状态栏瞬时消息 / 消息历史）
│   ├── logExtensions.ts      # 大文件日志扩展名归一化（小写 + 自动补点）
│   ├── workspaceOverrides.ts # 工作区覆盖的合并与归一（前端侧）
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
│   ├── keywordLanguage.ts    # 关键字级高亮（自定义语言与附加语言的共享底座）
│   ├── legacyModes.ts        # 附加语言（@codemirror/legacy-modes）按需启用表
│   ├── blame.ts              # 行内 Git Blame 渲染（随光标 / 编辑状态响应）
│   ├── minimap.ts            # 编辑器右侧 Minimap 缩略图
│   ├── rulers.ts             # 标尺线
│   ├── lineOps.ts            # 删行 / 移动行 / 复制行 / 切换注释
│   ├── input.ts              # 输入处理（多光标粘贴、智能回车等）
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
│   ├── compareWorkbench.ts   # 灵活比较工作台（两侧来源 / 可编辑 / 自动重算）
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
│   ├── gitView.ts            # 侧栏「源代码管理」（状态/提交/暂存）
│   ├── branchPicker.ts       # 分支切换面板（状态栏分支入口）
│   ├── searchView.ts         # 侧栏工作区搜索 / 批量替换
│   ├── outlineView.ts        # 侧栏大纲
│   ├── welcome.ts            # 首屏欢迎页（含最近工作区）
│   ├── recentWorkspaces.ts   # 最近工作区列表与切换
│   ├── bookmarksView.ts      # 侧栏「书签」分区
│   ├── gitHistoryPanel.ts    # 底部 Git 历史面板（提交列表 + 补丁）
│   ├── gitBlame.ts           # Blame 列表视图
│   ├── conflictGuide.ts      # 冲突文件横幅与处理引导
│   ├── structuredView.ts     # 表格视图（CSV）/ JSON 树视图（只读）
│   ├── noticePanel.ts        # 消息历史面板
│   ├── aboutDialog.ts        # 关于对话框（版本由构建注入）
│   ├── helpDialog.ts         # 内置帮助（渲染 docs/ 的用户指南与 FAQ）
│   ├── shortcutsDialog.ts    # 快捷键速查
│   ├── runConfig.ts          # 运行配置（超时 / 输出上限 / 环境变量 / stdin）
│   └── runPanel.ts           # Code Run 输出面板
├── settings/                 # 设置中心分类页
│   └── themeTab.ts / keybindingsTab.ts / layoutTab.ts / filesTab.ts / shared.ts
├── services/                 # 后端服务封装
│   ├── workspace.ts          # 工作区读写
│   ├── workspaceSettings.ts  # 工作区覆盖配置读写
│   ├── session.ts            # 会话与草稿
│   ├── fsWatch.ts            # 外部修改事件订阅
│   ├── treeWatch.ts          # 文件树变更事件（tree://changed，只监听已展开目录）
│   ├── launch.ts             # 文件关联冷启动（CLI 参数 / 待打开文件）
│   ├── updater.ts            # 检查更新封装（未配置时友好失败）
│   ├── userAssets.ts         # `themes/` 与 `languages/` 用户资产读取
│   └── diagnostics.ts        # 诊断包导出（配置 + 日志 + 环境摘要）
├── store/
│   └── tabs.ts               # 多标签状态（惰性快照、指纹基线、结构/内容双事件）
├── config/
│   ├── settings.ts           # config.json 读写与热更新（含默认值与迁移）
│   ├── keybindings.ts        # 键位覆盖、冲突检测、分发表缓存
│   ├── formatters.ts         # CLI 格式化器定义与安装提示
│   ├── userThemes.ts         # 自定义编辑器主题加载与校验
│   └── userLanguages.ts      # 自定义语言加载与冲突处理
├── ui/
│   ├── statusBar.ts          # 状态栏渲染 / 主题 / 字段显隐 / 配置写回
│   ├── gitStatusItem.ts      # 状态栏左下角 Git 入口（分支 / 同步）
│   ├── openGesture.ts        # 列表行的单击 / 双击打开手势（files.openWithDoubleClick）
│   ├── statusMenu.ts         # 状态栏弹出菜单工厂（换行 / 语言 / 编码）
│   ├── tabsBar.ts            # 标签栏渲染与右键菜单（含溢出下拉与 a11y 键位）
│   ├── breadcrumb.ts         # 面包屑与目录下钻
│   ├── editorMenu.ts         # 编辑器右键菜单机器
│   ├── menu.ts               # 弹出菜单定位（视口钳制）
│   ├── dialogs.ts            # 确认 / 输入对话框
│   ├── formControls.ts       # 设置中心控件工厂
│   ├── icons.ts              # 文件图标工厂
│   ├── sidebar.ts            # 侧栏视图切换与分区折叠
│   ├── a11y.ts               # aria-live 播报（屏幕阅读器）
│   ├── busy.ts               # 全局忙标 / 进度提示
│   ├── highlight.ts          # 文本高亮片段（搜索命中复用）
│   └── settingsHelp.ts       # 配置说明
├── types/
│   └── app.ts                # 前后端共享类型
└── styles/                   # 按域拆分（保持原有规则顺序，依赖 main.css 统一入口）
    ├── main.css              # 汇总入口（@import 各模块）
    ├── tokens.css            # 语义化设计令牌（三套主题共用：强调色、--accent-ink、间距、圆角）
    ├── base.css / shell.css  # 重置与基础 / 窗口外壳（标题栏、拖拽区）
    ├── chrome.css / status.css   # 侧栏与分区头 / 状态栏
    ├── editor-extras.css / motion.css  # 编辑器增强（标尺、Minimap、行内 Blame）/ 动效
    ├── panels.css / views.css / preview.css / git.css  # 面板 / 侧栏列表 / 预览 / Git 视图
    ├── controls.css / dialogs.css / welcome.css  # 控件 / 弹框 / 欢迎页

src-tauri/src/                # Rust 后端
├── main.rs                   # 入口
├── lib.rs                    # Tauri Builder、命令注册、应用状态
└── commands/
    ├── file.rs               # 读取 / 探测 / 保存（原子写、BOM 与换行符）
    ├── encoding.rs           # 编码检测与乱码诊断
    ├── large.rs              # 大文件稀疏索引、窗口读取、过滤、Minimap、续扫索引与尾窗（跟随）
    ├── diff.rs               # 文本 / 文件 / Git 差异与补丁导出
    ├── format.rs             # CLI 格式化调度
    ├── run.rs                # Code Run（进程组、超时、输出上限）
    ├── terminal.rs           # 内置终端（多会话 PTY 会话表 ≤8、输入/尺寸、在终端运行）
    ├── fetch.rs              # 网页抓取（URL 校验 / 私网拦截 / 原子落盘）
    ├── watch.rs              # 外部修改监听（notify）
    ├── tree_watch.rs         # 文件树变更监听（watch_dirs / tree://changed，非递归、上限 200）
    ├── session.rs            # 会话与草稿持久化（含滚动位置、`list_drafts`）
    ├── batch.rs              # 批量另存为编码（非破坏式）
    ├── workspace.rs          # 工作区持久化与**按工作区覆盖**（`workspaces/<hash>.json`）
    ├── fs.rs                 # 文件树文件系统操作（多选拖拽/复制）/ 路径类型探测
    ├── clipboard.rs          # 写 Windows 系统剪贴板（`CF_HDROP`，与资源管理器互通）
    ├── paths.rs              # 路径作用域守卫（PathGuard）
    ├── search.rs             # 文件列表 / 工作区搜索（包含与排除 glob）/ 批量替换与撤销历史
    ├── regex.rs              # 正则测试与替换预览（Rust `regex` 双引擎统一）
    ├── git.rs                # Git 状态 / 暂存 / 提交 / 历史 / 分支 / Blame / hunk 暂存；`ensure_writable()` 只读拦截
    ├── cli.rs                # 命令行参数接收（文件关联双击打开）
    ├── association.rs        # 「打开方式」候选登记（HKCU，需显式开关；不改默认程序）
    ├── logging.rs            # 滚动日志（2MB × 3）、panic hook、`log_event`、诊断包
    ├── startup.rs            # 启动耗时采样（覆盖写 `startup.json`）
    └── config.rs             # config.json 读写与版本迁移、主题/语言目录、只读快照

scripts/                      # 开发辅助脚本（图标生成、版本号统一修改）
```

## 本地数据文件

均位于 Tauri 应用配置目录：

| 文件 / 目录 | 内容 |
| --- | --- |
| `config.json` | 主题、快捷键、布局、编辑器增强、会话与大文件、网页抓取、终端 shell、Git 只读开关等配置（迁移前备份为 `config.json.bak`） |
| `workspace.json` | 工作区根目录与文件树展开状态 |
| `session.json` | 打开文件列表、光标与滚动位置、激活文件、分栏比例 |
| `workspaces/<hash>.json` | **按工作区覆盖的配置**（缩进宽度、忽略目录；存在应用目录，不写进用户仓库） |
| `drafts/` | 未保存内容的草稿副本（防抖写入，按保留天数清理） |
| `themes/` | 自定义编辑器主题 JSON（文件名即主题名，可在设置页重新读取） |
| `languages/` | 自定义语言 JSON（关键字级高亮） |
| `replace-history/` | 批量替换的原文快照与清单（撤销用，保留最近 10 批 / 7 天） |
| `discard-backup/` | 放弃 Git 更改前的文件快照（保留最近 10 次，按时间戳分目录） |
| `logs/` | 本地滚动日志（2MB × 3）；菜单可「打开日志目录」与「导出诊断包」 |
| `startup.json` | 最近一次启动耗时采样（覆盖写，不滚动） |

## 快捷键

| 快捷键 | 功能 |
| --- | --- |
| Ctrl/Cmd+S / Ctrl/Cmd+Shift+S | 保存 / 另存为 |
| Ctrl/Cmd+O / Ctrl/Cmd+N | 打开文件 / 新建未命名文档 |
| Ctrl/Cmd+Shift+U | 从网址抓取网页 |
| Ctrl/Cmd+W / Ctrl/Cmd+Q | 关闭标签 / 退出 |
| Ctrl/Cmd+F / Ctrl/Cmd+H | 当前文档查找 / 替换（纯预览模式下 Ctrl+F 改为在预览内容中查找） |
| Ctrl/Cmd+Shift+P | 命令面板 |
| Ctrl/Cmd+P | 快速打开文件 |
| Ctrl/Cmd+Shift+F | 工作区搜索 / 替换 |
| Ctrl/Cmd+Alt+S | 全部保存 |
| Ctrl/Cmd+R | 重新载入当前文件（丢弃未保存修改） |
| Ctrl/Cmd+Alt+D / Ctrl/Cmd+Alt+Shift+D | 选中下一个 / 全部相同词 |
| Ctrl/Cmd+Shift+T | 重新打开关闭的标签 |
| Ctrl/Cmd+Shift+[ / ] | 折叠 / 展开代码块 |
| Ctrl/Cmd+B | 切换侧栏 |
| Ctrl/Cmd+Shift+M | 切换 Minimap 缩略图 |
| Ctrl/Cmd+, | 打开设置 |
| Ctrl/Cmd+PageUp / PageDown | 上一个 / 下一个标签 |
| F5 | 运行当前文件（Code Run） |
| Ctrl/Cmd+F5 | 在终端运行当前文件 |
| ``Ctrl/Cmd+` `` | 打开 / 隐藏内置终端 |
| Shift+Alt+F | 格式化文档（备用键 `Ctrl+Alt+Shift+F`；`Ctrl+Shift+L` 已还给 CM6 的列选择） |
| Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z | 撤销 / 重做 |
| Ctrl/Cmd+/ | 切换注释 |
| Ctrl/Cmd+D | 删除当前行 |
| Alt+↑ / Alt+↓ | 上移 / 下移当前行 |
| Ctrl/Cmd+Alt+↑ / ↓ | 复制行到上方 / 下方 |
| Alt+拖选 | 列选择 |
| Alt+C | 列编辑器 |
| Ctrl/Cmd+F2 / F2 / Shift+F2 | 切换书签 / 下一个 / 上一个 |
| F12 | 转到定义（工作区文本级定位，非 LSP） |

状态栏可点击切换：编码、换行符、语言模式、空白字符显示。

## 已知取舍

这一节说明**能力边界**：没做的功能以及为什么不做，避免装完才发现。

**没有的能力（不是 bug，是取舍）**

- **没有 LSP**：没有类型检查、没有语义补全、没有重命名重构，改函数名要用工作区搜索的批量替换（带历史，可撤销）。**跳定义有 `F12`，但那是文本级定位**（按定义关键字找同名符号），不是类型解析——重载与同名不同义会不准
- **没有插件体系**：语法高亮开箱可用 16 种（内置 7 + 懒加载 9），另有 13 种附加语言可在设置里勾选按需加载，合计约 29 种；装不了 npm 语言包、没有扩展 API。可扩展的只有三样：编辑器配色（主题文件）、关键字级自定义语言（无语法树，因此没有补全 / 诊断 / 折叠）、CLI 格式化工具（`config.json` 的 `formatters`）
- **没有 AI 辅助，没有 OCR**：不引入模型依赖与额外体积
- **没有调试器**：`F5` 是「直接运行当前文件」，不是断点调试
- **没有 TODO 列表视图**：用侧栏搜索（`Ctrl+Shift+F`）按关键词筛标题即可
- **界面只有简体中文**，无多语言切换。README 有英文版，只为方便非中文读者了解项目
- **只有 Windows 安装包**：macOS / Linux 没有实测数据，也未签名 / 公证
- **内置终端多会话（≤ 8 个 PTY）**，但不随会话恢复（重启后需重建）
- **自动更新只能算半成品**：`tauri-plugin-updater` 与「帮助 ▸ 检查更新…」已接入，但 `tauri.conf.json` 的 endpoint 仍是 `updates.example.com` 占位、`pubkey` 为空，发布产物也不含 `latest.json` 与签名——实际使用时会友好失败。要真能用，需按 `.doc/自动更新与签名配置-2026-10-31.md` 配好密钥与 Secrets

**能力受限的地方**

- 批量编码转换只做非破坏式的「批量另存为编码」；就地改写请用工作区搜索的批量替换
- 格式转换只做 JSON ↔ YAML、Properties ↔ YAML、Java → JSON；JSON ↔ XML / CSV 延期
- 网页抓取只保存原始 HTML，不下载 / 重写图片、CSS、JS 等子资源；重定向后的最终地址不再复查（私网默认拦截 + CSP 主防线）
- 内置终端是任意命令执行入口、非沙箱；终端内命令不受 Code Run 的超时 / 输出上限约束
- `cmd.exe` 不支持「在终端运行」（请用 PowerShell）；终端 ANSI 16 色沿用 xterm 默认
- 单侧 4 MB 以上不比较差异、大文件过滤命中上限 5 万条、单行超过 4000 字符会裁剪——都为了不 OOM，触发时会说明原因与替代办法

**工程上待补**

- E2E（Playwright + tauri-driver）关键路径未接入；替代品是 [`验收清单_V1.md`](./验收清单_V1.md) 的人工冒烟清单

## 许可证

MIT，见 [`LICENSE`](./LICENSE)。
