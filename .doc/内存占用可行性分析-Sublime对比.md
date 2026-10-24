# 内存占用可行性分析：能否做到 Sublime Text 3 级别

> 结论先行：**不能**。这不是优化力度问题，而是渲染架构决定的固定成本；把前端压到极致，本项目现实下限约 **160–200 MB 私有内存**，仍是 Sublime Text 3 的 3–5 倍。

## 1 当前实测基线（来源：技术设计文档 11.19.2，2026-10-21）

| 场景 | 应用进程 ws / 私有 | 整体私有 |
| ---- | ---- | ---- |
| 空会话 | 23.9 / 5.8 MB | 267.7 MB |
| 10 个 200KB 标签 | 24.0 / 5.9 MB | 267.5 MB |
| 24MB 日志（只读虚拟视图） | 24.0 / 5.9 MB | 262.7 MB |

拆解：**应用自身（Rust + 业务逻辑）仅 5.8 MB 私有**，其余约 **262 MB 全部属于 WebView2 进程组**（browser / GPU / renderer / utility）。GPU 进程占工作集大头，见 11.19.5。

Sublime Text 3 在 Windows 空载通常为几十 MB 量级（打开若干文件后数十至一百 MB），**属参考量级，需本机任务管理器核对**。差距方向明确：一个数量级以内、数倍之差。

## 2 为什么改不到

Chromium 内核的固定开销不随业务代码变化：

| 组成 | 性质 | 是否可削减 |
| ---- | ---- | ---- |
| WebView2 browser 进程 | 运行时固定 | 否 |
| GPU 进程 + 显存/合成缓存 | 固定，随开关变化 | 部分（禁硬件加速） |
| renderer 进程（V8 堆 + DOM + 样式 + 合成层） | 固定基线 | 否，只能压增量 |
| CodeMirror 6 文档/语法树/撤销历史 | 业务增量 | 是，已有上限控制 |
| 预览 iframe / data URL / xterm 缓冲 / 大数组 | 业务增量 | 是 |

Tauri 相对 Electron 省掉的是「包体」与「Node 常驻」，**没有省掉渲染引擎**。9 MB 的可执行文件是真实收益，但运行期仍要承载一个 Chromium。

## 3 分档预期（估算，需实测验证）

| 档位 | 措施 | 预估整体私有 | 代价 |
| ---- | ---- | ---- | ---- |
| 现状 | — | 263–268 MB | — |
| A 低内存模式 | 禁硬件加速 + 限 V8 堆 + 限进程数 | 180–230 MB | 滚动/动画流畅度下降 |
| B A + 严格释放 | iframe / data URL / 大数组 / 标签状态收紧 | 160–200 MB | 功能响应略变慢 |
| C 后台挂起 | 最小化时 `TrySuspend` | 最小化后降至个位数 MB | 需 wry/COM 层手写，工程量大 |
| D 换渲染栈 | egui / Qt / Skia 自绘 | 60–100 MB | 等于重写项目 |

**< 100 MB 只有 D 路线能达到**，本项目不适合走。

## 4 可落地动作清单（按性价比排序）

1. **低内存模式开关**（收益最大、风险可控）
   - `tauri.conf.json` 的 `app.windows[].additionalBrowserArgs` 传入 `--disable-gpu`、`--renderer-process-limit=1`、`--js-flags=--max-old-space-size=384`。
   - 注意：Tauri 默认会传 `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`，自行设置该字段时**必须手动补回**，否则 WebView2 内置 UI/安全组件行为改变。
   - 该参数只在 webview 创建时生效，**必须做成设置项 + 重启生效**，不能运行时热切换；默认关闭，保证默认体验不变。
   - 不要用 `--single-process`（崩溃风险陡增），V8 堆不要低于 256 MB（频繁 GC 反而更慢）。
2. ✅ **已实施（2026-10-24）**：预览图片 data URL 上限 10 MB → 4 MB、缓存 24 → 8 张，缓存池最坏从 ≈320 MB 压到 ≈43 MB。注意：已渲染进 DOM 的 `img.src` 仍持有字符串，直到预览重渲染；且 >4 MB 的图片不再内联，预览显示失败占位。
3. ✅ **已实施（2026-10-24）**：`matches` 改为 `MatchBuffer`（Uint32Array 定长缓冲，上限 5 万行）。**实际收益仅 0.2 MB 级**——本条第 3 项原先写的"百万级命中约 8 MB+"是错的：后端 `MAX_FILTER_MATCHES = 50_000`，且 V8 的 SMI 数组本就是 4 字节/元素，与 Uint32Array 相同。此项价值在于上界确定、不产生中间数组，不是量级优化。
4. ✅ **已实施（2026-10-24）**：标签状态缓存 5 MB / 16 条 → 2 MB / 8 条，按文档文本计的受控上界 80 MB → 16 MB。
5. ✅ **已实施（2026-10-24）**：预览面板在切到非 md/html 标签、关闭当前标签时清空 `contentEl`（原先只切 CSS class，整棵预览树一直驻留）。核对结论：差异面板 `close()` 已移除 backdrop 并置空 payload；运行输出有 2000 节点上限且每次运行前清空；大文件视图只保留视口窗口；终端为「隐藏不杀进程」的刻意设计（xterm 实例复用，滚动缓冲默认 1000 行），未改。
6. **后台挂起**：最小化/失焦后调用 `ICoreWebView2_3::TrySuspend`，收益巨大但 Tauri 未暴露该能力，需评估是否值得。

## 5 验收口径

- 指标：**整体私有内存（Private Bytes）求和**，工作集受 GPU 进程轮次波动影响不适合横向对比（见 11.19.2 结论）。
- 方法：启动后静置 7 秒采样，3 次取中位数；场景固定为空会话 / 10 标签 / 24MB 日志三档。
- 目标：A 档 ≤ 230 MB，B 档 ≤ 200 MB；低于此区间需说明是测量噪声还是真实回归。

## 6 明确不建议做的事

- 为省内存牺牲 CodeMirror 能力（自研 textarea 渲染）：会丢掉语法高亮、撤销树、多光标，得不偿失。
- 全局默认关闭硬件加速：影响所有用户滚动体验，正确做法是给开关。
- 靠 `setInterval` 主动 GC 或频繁 `location.reload`：无效且破坏会话状态。

## 7 实施记录（2026-10-24）

| 改动 | 位置 | 最坏常驻堆变化 | 口径 |
| ---- | ---- | ---- | ---- |
| 图片内联 10 MB→4 MB、24→8 张 | `src/panels/preview/localImages.ts` | 320 MB → 42.7 MB（−277 MB） | 缓存池持有的 data URL 字符串（base64 为 ASCII，≈4/3 原始字节） |
| 状态缓存 5 MB/16→2 MB/8 | `src/editor/stateCache.ts` | 80 MB → 16 MB（−64 MB） | 按 `doc.length` 计的受控上界；实际 EditorState 含语法树与撤销历史，约为文本的 1–3 倍（估算） |
| `matches` number[]→Uint32Array | `src/panels/largeView/matchBuffer.ts` | 200 KB → 200 KB（≈0） | 上限 5 万行 × 4 字节；原实现若因扩容/元素类型退化可达 260–400 KB，新实现恒定 200 KB |
| 预览 DOM 释放 | `src/panels/preview.ts`、`src/app/previewHost.ts` | 无法给定值，按内容量级 | 释放被隐藏面板持有的渲染树与 iframe 文档；1 MB Markdown 渲染后的节点树约数万节点 |

结论：**前两项是唯一可精确量化的收益**（合计最多约 340 MB 的缓存侧上界）。第三项在 5 万行上限下与 `number[]` 基本等效；第五项释放的是 DOM 与 iframe 文档，量级依内容而定。

未覆盖的口径：Chromium 图片解码后的位图缓存（由 WebView2 image cache 管理，不受上述常量约束）；`MatchBuffer` 每批 IPC 仍会短暂产生 `number[]`（JSON 反序列化必然产物）；同一文档在「编辑 / 预览」之间切换时预览 DOM 仍保留（切回不重渲染，属缓存策略而非泄漏）。

## 8 全局 review 结论（2026-10-24）

### 8.1 review 发现并修复的 5 个问题

| # | 问题 | 位置 | 性质 |
| --- | --- | --- | --- |
| 1 | `matches.ts` 是未被引用的重复文件（Write 报失败但文件已落盘），与 `matchBuffer.ts` 的 `append` 激活语义已分叉 | `src/panels/largeView/matches.ts` | 已删除 |
| 2 | 4 MB 预览预算同时作用于导出，4–10 MB 本地图在导出 HTML/Word/PDF 中静默丢失 | `localImages.ts`、`preview.ts` | 导出改用独立的 10 MB 预算，缓存键带上限避免 null 污染 |
| 3 | 从预览切到「另一个 md 标签且模式为 edit」时旧预览树仍驻留（默认模式就是 edit，是最常见路径） | `preview.ts#apply` | 按 `prevId !== activeId` 判断后释放 |
| 4 | 2 MB 以上文档切标签不只丢撤销历史，还丢光标与滚动（`setState` 后 selection 归零） | `stateCache.ts`、`setup.ts` | 超限文档仍记光标 offset，切回后恢复 |
| 5 | 命令返回晚于末批事件时，迟到批次会被再追加一次（最多重复 1000 行） | `largeView.ts#applyFilterBatch` | 既有缺陷，本次把收尾守卫提到 append 之前 |

### 8.2 已核对为正确的实现（不动）

- 大文件只读视图：稀疏锚点索引、窗口读取、5000 行缓存、canvas 降采样缩略图；`close_large_file` 在标签关闭时释放索引。
- 会话恢复占位标签懒加载（10 标签与空会话内存几乎一致）。
- 运行输出面板 2000 节点上限；终端首屏缓冲 256 KB 上限；xterm scrollback 2000 行。
- 差异面板 `close()` 同时移除 backdrop、置空 payload、作废分帧渲染。
- 语言包 / Prettier / 格式化器按需加载，参数化面板懒加载。

### 8.3 剩余优化点（未实施，按性价比）

1. **按键路径的全量快照**：`onDocChange` 每键执行 `doc.toString()`（`main.ts#onDocChange` → `setup.ts#getContent`），再在 `tabs.ts#refreshDirty` 做一次全量字符串比较。10 MB 文档每键分配 10 MB 临时字符串并两次遍历全文，GC 与输入延迟可见。建议：按键时只置 dirty 与 length，`toString` 延迟到保存 / 切标签 / 渲染预览前；「撤销回原状即变干净」改在这些时机做一次精确比较。
2. **`tab.content` 与 `savedContent` 双份全文**：编辑中的大文件前端稳存 2 份字符串加 CM rope 1 份，20 MB 文件约 60–80 MB。建议 `savedContent` 改存内容哈希（FNV/xxhash），精确比较降为哈希比较。
3. ✅ **已实施（2026-10-24）**：见第 10 节。单侧 4 MB 阈值，读文件前先按大小拒绝，`payload` 内部再挡一次，前端 catch 显示提示。
4. ✅ **已实施（2026-10-24）**：见第 10 节。改为 16 MB 原始字节预算 + 32 条兜底。
5. **不改**：xterm scrollback 2000 行约占 3–6 MB，滚动历史是终端的常用能力，不建议为个位数 MB 牺牲。
6. **WebView2 内核**：仍占整体内存 90% 以上，可选手段见第 4 节第 1、6 项（需开关 + 重启 / COM 层挂起）。

判断：以上 1–4 项都不改变基线结论——空会话仍然是 263–268 MB，优化只作用于「业务增量」，且在特定场景（多图 Markdown、多个大文件标签、大文件 diff）才能观测到。

## 9 P1 实施：惰性快照 + 指纹基线（2026-10-24）

针对 8.3 的第 1、2 项。核心是把「每个按键都把全文复制进标签对象」改为「按键只标脏，读取时才同步」。

### 9.1 改动

| 项 | 位置 | 说明 |
| --- | --- | --- |
| 基线改指纹 | `store/tabs.ts` | `savedContent: string` → `savedFingerprint`（长度 + FNV-1a + djb2 双哈希）+ `savedTrailingNewline`；碰撞约 2^-64 |
| 惰性快照 | `store/tabs.ts` | `markEdited` 只置 `contentDirty`/`dirty`（O(1)）并自行排程停手精算；`snapshotOf` 读取时调 provider 拉全文；停手 800ms 后 `settleContent` 精算脏标记（由 store 内部 `scheduleSettle` 定时器触发，关闭标签时清理） |
| 内容入口 | `store/tabs.ts` | 新增 `ContentProvider`（docId / full / head），由 `main.ts` 在编辑器创建后注入；`head` 只做 `sliceString(0, N)` |
| 切换前落盘 | `store/tabs.ts` | `activate` / `open` / `openImage` / `openVirtual` 在改 `activeId` 前调 `syncContent(旧 id)`，保证跨标签读取不会拿到旧内容 |
| 读取点收口 | 6 个模块 | 保存（`fileService`）、草稿（`sessionHost`）、切标签（`tabSwitcher`）、预览与导出（`previewHost`）、diff（`diffService`）、cURL 检测（`runHost`）全部改走 `snapshotOf` / `contentHeadOf` |
| diff 磁盘基线 | `diffService.ts` | 不再常驻 `savedContent`：仅在发起比较/还原时按当前编码调 `reopen_with_encoding` 读一次 |
| 预览推迟快照 | `previewHost.ts` / `panels/preview.ts` | 编辑模式 / 非 md-html 时直接返回；双栏与预览模式下快照推迟到防抖真正触发时才取（`scheduleRender(() => toTab(tab))`），按键不再触发全文 toString |

### 9.2 效果（估算）

- **常驻内存**：编辑中的大文件从前端 2 份字符串（`content` + `savedContent`）+ CM rope 1 份，降为 2 份；20 MB 文件省约 20 MB。
- **按键延迟**：编辑模式从每键一次 `doc.toString()` + 一次全文比较，降为 O(1)（仅 cURL 检测取前 4 KB）；预览模式从 2×O(n) 降为 1×O(n)（toString 仍是渲染必需）。
- **打开/保存**：多一次指纹计算（10 MB 约 10–20 ms），与读盘/编码转换同量级。

### 9.3 不变量与已知边界

- 不变量：任何标签失去「激活」身份前，`content` 必须已同步（`activate`/`open*` 保证）；所有全文读取必须走 `snapshotOf`（grep `\.content\b` 已收口）。
- `markEdited` 无条件置 `dirty=true`，比原来保守：撤销回原状后需等 800 ms 精算才清脏点；若在此期间关闭标签会多弹一次未保存确认（数据安全方向）。
- 预览/双栏模式：按键不再取快照，全文只在 300 ms 防抖触发时取一次（渲染本身需要全文），属预期成本。
- 2–5 MB 文档切回仍不保留撤销历史（沿用上一轮的 2 MB 阈值），但光标会恢复。

## 10 剩余两项实施 + 一项不改（2026-10-24）

### 10.1 diff 大小阈值（`src-tauri/src/commands/diff.rs`）

- 单侧上限 `MAX_DIFF_BYTES = 4 MB`，`payload()` 入口统一检查（覆盖 `diff_texts` / `diff_files` / `git_diff` 三个命令）。
- `diff_files` 在 `read_text` 之前先 `metadata` 取大小；`git_diff` 的工作区分支同样前置检查。避免“先读入 100 MB 再报错”。
- 超限返回可读错误：`文本过大，已跳过比较（单侧上限 4 MB，当前 X MB）`，前端 `open()` 的 catch 显示为「比较失败：…」。
- 代价：原来能比的大文件现在会被拒绝。需要放宽时改这个常量即可。

### 10.2 图片缓存改字节预算（`src/panels/preview/localImages.ts`）

- 旧：纯条数 8 条。问题：一轮渲染会并发请求全文所有图，N > 8 时每轮重渲染都要回读前 N−8 张。
- 新：总量 16 MB（原始字节）+ 32 条兑底，按插入序淘汰，至少保留最新一条。`probe` 回填字节数后立即重算淘汰。
- 内存上界：16 MB 原始 → 约 21 MB data URL 字符串，比旧方案 8 × 4 MB = 32 MB（约 43 MB）更低；同时小图多的文档不再回读。
- 仍存在边界：单文档图片总字节超 16 MB 时仍会部分回读，这是内存约束下的必然，不是实现缺陷。

### 10.3 xterm scrollback：不改

2000 行约 3–6 MB。滚动历史是终端最常用的能力之一（日志/编译输出回溯），为个位数 MB 牺牲不合理。如确实需要，改 `terminalPanel.ts` 的 `scrollback: 2000` 一处即可。

### 10.4 验证

`npx tsc --noEmit`、`npm run build`、`cargo test`（84 项）均通过。未做实机内存采样——本轮两项都是“防极端情况”的兜底，正常会话不会观测到差异。

### 10.5 代码评审修复（2026-10-24）

| 问题 | 位置 | 修复 |
| --- | --- | --- |
| 测试模块未跟随 `payload` 改为 `Result`，`cargo test` 编译失败 | `src-tauri/src/commands/diff.rs` | 抽测试专用 `diff_of()`；补 `oversized_side_is_rejected` 覆盖 4 MB 上限 |
| 超限文档的光标恢复永不生效（`stateCache.delete` 先清了光标表） | `editor/setup.ts` | 先 `takeCursor` 再 `delete` |
| 未命名文档（`path` 为空）「与磁盘比较 / 还原改动」失效 | `app/diffService.ts` | `diskBaseline()` 对空路径按空基线处理，还原给明确提示 |
| 双栏模式下每次按键一次全文 toString + 指纹 | `app/previewHost.ts` / `panels/preview.ts` | `scheduleRender` 改收 thunk，快照推迟到防抖触发时 |
| 800ms 精算定时器挂在 `main.ts`，store 自身不自洽 | `store/tabs.ts` / `main.ts` | 定时器下沉到 `markEdited`，关闭标签时 `clearSettle` |
| `contentOf` 命名像纯 getter，实际 O(n) 且改状态 | `store/tabs.ts` | 改名 `snapshotOf`，`settleContent` 收为私有 |
| `reopen_with_encoding` 四参数 invoke 在两处重复拼装 | `app/fileService.ts` | 抽出 `readDiskAs()`，`main.ts` 与 `diffService` 共用 |
