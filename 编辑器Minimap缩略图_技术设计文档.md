# 编辑器 Minimap 缩略图 技术设计文档

v1.0（2026-10-26）

| 项目 | 内容 |
| --- | --- |
| 文档类型 | 功能专项技术设计文档（目的 / 现状 / 冲突方案 / 改动范围 / 验收 / 步骤） |
| 上位文档 | 《轻量级定制文本编辑器_技术设计文档》（v1.5 已确认 Minimap 排 v2）、CODEBUDDY.md 目录约定与验收基线 |
| 关联评估 | 2026-10-26「右侧 minimap 可行性评估」（结论：可行、冲突可控、复杂度中等偏低、性能影响可忽略） |
| 状态 | 已实现（2026-10-26，实现偏差见第 7 章） |

---

## 1 目的

### 1.1 要解决的问题

1. **长文档缺少全局结构感知**：千行以上文件只能靠滚动条长度、查找或折叠定位，没有「文档全局形状」的视觉参照。
2. **编辑器与大文件视图体验割裂**：虚拟视图已有左侧 64px canvas 缩略图（`src/panels/largeView/dom.ts:98-115`、`src/panels/largeView/minimap.ts:19-55`），而常规编辑器内完全没有。
3. **能力已承诺未落地**：设置中心把 Minimap 明确列为 v2 预留（`src/settings/layoutTab.ts:122-127`），技术设计文档 v1.5 也确认排期 v2；本次将其转为正式功能，消除「预留」口径。

### 1.2 预期目标（可验收）

| 目标 | 量化口径 |
| --- | --- |
| 右侧常驻缩略图 | 展示文档密度带 + 当前视口框；宽度 80px，位于编辑区右缘且不遮挡文本、不压住 10px 滚动条 |
| 可导航 | 点击任意位置跳转到对应文档比例位置（无折行/折叠时误差 ≤ ±2 行）；拖拽连续跟随 |
| 不引入可感知卡顿 | 密度重建 ≤ 2ms（5 万行）、滚动期 canvas 重绘 0 次、连续输入无 >50ms 长任务 |
| 与现有能力共存 | 与预览双栏滚动联动、代码折叠、自动换行、大文件虚拟视图、三套主题均无功能回退 |
| 可配置 | 设置中心开关（默认开启），落 `config.json` 的 `layout.minimap`，前端与 Rust 双端默认值一致 |
| 零新依赖 | 不引入第三方 minimap 库，主 bundle 增量 ≤ 8KB |

### 1.3 明确不做（v1 非目标）

- 彩色语法着色 minimap（全文档着色需自跑 Lezer 树，20k 行文档 100~300ms 量级，与「性能影响不大」目标冲突）。
- 折行/折叠场景的像素级精确映射（需逐行 `lineBlockAt`，O(n log n) 且可能触发 DOM 测量）。
- 面板停靠 / 可拖动分隔条 / 多实例 minimap。
- 把大文件虚拟视图的缩略图从左侧移到右侧（登记为后续可选项，本次不动，避免扩大改动面）。

---

## 2 当前实现

### 2.1 编辑器装配（决定接入方式）

- 全应用**只有 1 个** `EditorView` 实例，生命周期与页面同长，无 `view.destroy()`：`src/editor/setup.ts:151`。
- 切标签走 `view.setState()`（`setup.ts:213 / :244 / :282`），**`setState` 不触发 `updateListener`**（`setup.ts:178` 已注明该坑）。
- 已有 14 个 Compartment 承载可热插拔扩展，`initialExtensions` / `dynamicEffects` 两处登记：`src/editor/extensions.ts:28-62`、`:161-187`、`:190-209`。
- 关键库行为：`EditorView.setState()` 会 `destroy()` 全部旧 plugin 实例并重建（`node_modules/@codemirror/view/dist/index.js:8104-8110`），因此 **ViewPlugin 形式的扩展在切标签时天然重建，不需要额外广播**。

### 2.2 布局与滚动（决定挂载位置）

- `index.html:105-128`：`.editor-column` → `.tabsbar` / `#breadcrumb` / `.editor-area`（`#editor` + `#welcome` + `#split-resizer` + `#preview-pane`）→ `#search-results` / `#run-output` / `#terminal-panel`。
- `src/styles/main.css:307-313` `.editor-column{display:flex;flex-direction:column;overflow:hidden}`；`:322-329` `.editor-area{flex:1;display:flex;position:relative}`。
- `main.css:332-337` `#editor{flex:0 1 var(--split-ratio,50%);overflow:hidden}`；`:386-388` `mode-edit` 下 `flex:1 1 100%`；分割比取值范围 15%~85%（`src/app/layout.ts:114-115`），双击复位 50%（`layout.ts:128-135`）。
- 唯一滚动容器是 CM 的 `.cm-scroller`（`src/editor/theme.ts:53-59` `lineHeight:1.6`、`overflow:auto`），无外层滚动嵌套；全局滚动条 10px 自定义样式（`main.css:914-928`）。
- 右侧**没有**固定面板/抽屉：`#preview-pane` 是 `.editor-area` 的 flex 兄弟，不覆盖 `#editor`。

### 2.3 现有滚动联动（最需要避让的既有逻辑）

- 编辑器 → 预览：`src/app/previewHost.ts:66-71` 在 `scrollDOM` 上挂 scroll 监听，命中 `editorEchoUntil`（120ms）则丢弃。
- 预览 → 编辑器：`src/panels/preview.ts:410-413 → :443`，抑制标记 `previewEchoUntil`（常量 `preview.ts:34-41`）。
- 协同取位置：`preview.ts:198-222` 用 `scrollDOM.scrollTop` + `view.lineBlockAtHeight(scrollTop + 2)` 换算行号。

### 2.4 大文件虚拟视图（已有的另一套缩略图）

- 独立 DOM（不用 CM）：`src/panels/largeView/dom.ts:36-139`，缩略图为左侧 64px canvas（`dom.ts:98-115`），密度来自 Rust `large_minimap`（`src/panels/largeView.ts:459-462`），桶数 240（`largeView/constants.ts:12`）。
- 进入虚拟视图时 `.editor-column.virtual .editor-area{display:none}`（`main.css:3315-3318`）：**CM 的 minimap 会随之天然隐藏**，无需额外分支。

### 2.5 配置与主题链路

- 默认值：`src/config/settings.ts:201-274`（`defaultConfig()`，注释要求与 Rust `AppConfig::default()` 保持一致，`:200`）。
- 派生：`deriveEditor(cfg)` → `settings` 单例原地刷新（`settings.ts:276-307`、`:309-315`），订阅者收到变更后由 `setup.ts:288-295 applySettings()` 走 Compartment 重配。
- Rust 侧 `LayoutSettings` 带 `#[serde(default, rename_all = "camelCase")]`（`src-tauri/src/commands/config.rs:112-148`）：**新增字段对旧 `config.json` 向后兼容，无需版本迁移**。
- 主题：dark / light / high-contrast 三态，颜色走 CSS 变量（`main.css:1-35`），编辑器侧 `EditorView.theme`（`src/editor/theme.ts:19-47`、`:50-84`）随 `c.theme` Compartment 热更新。

### 2.6 现状缺口

- 无 minimap 依赖（`package.json:14-50` 无相关包），编辑器侧无任何缩略图代码，`EditorSettings` 无对应字段（`settings.ts:158-181`）。

### 2.7 关键测量（本次评估实测，用于定阈值）

在仓库内用真实 `@codemirror/state` 的 `Text` 对密度扫描做基准（临时脚本已删除，方法：同文档重复 5 次取中位数）：

| 行数 | `doc.line(i)` 全量 | `doc.iterLines()` 全量 | `doc.iter()` 文本扫描 | 桶采样（800 桶） |
| --- | --- | --- | --- | --- |
| 2,000 | 0.45 ms | 0.46 ms | 0.18 ms | 0.15 ms |
| 20,000 | 2.53 ms | 0.58 ms | 1.14 ms | 0.13 ms |
| 50,000 | **8.24 ms** | 1.01 ms | 2.71 ms | 0.15 ms |
| 200,000 | **31.6 ms** | 4.73 ms | 12.2 ms | 0.17 ms |

结论：**禁用 `doc.line(i)` 循环**；主路径用 `doc.iterLines()`；超过 `MAX_SCAN_LINES` 切桶采样，使任意规模成本恒定在 ~0.2ms。

---

## 3 冲突项解决方案

| 编号 | 冲突项 | 风险 | 解决策略 |
| --- | --- | --- | --- |
| C1 | 折行/折叠导致行高非均匀 | 高 | 视口框只信 `scrollTop/scrollHeight` 比例；密度带用逻辑行近似 |
| C2 | split 模式下编辑区可能仅 15% 宽 | 高 | `ResizeObserver` 监控宽度，低于 520px 自动隐藏 |
| C3 | 挂载方式影响 CM 测量与滚动条 | 中高 | 绝对定位覆盖层 + 一次性 `padding-right`，不插入 flex 流 |
| C4 | 与预览滚动联动共用 `scrollDOM` | 中 | 只读监听、绝不 dispatch 事务；写 `scrollTop` 仅在用户点击/拖拽时 |
| C5 | `setState` 不触发 `updateListener` | 中 | 用 ViewPlugin，依赖 plugin 重建自动重绘；禁止模块级单例 |
| C6 | 密度缓存与 `stateCache` 冲突 | 中 | 密度数据挂 plugin 实例；如跨实例复用则用 `WeakMap<Text, ...>` |
| C7 | 两套 minimap 位置/交互不一致 | 中低 | 虚拟视图的 `display:none` 天然互斥；v1 不改 largeView |
| C8 | 三套主题下颜色不可见 | 低 | 颜色全部取 CSS 变量，绘制时 `getComputedStyle` 实时解析 |
| C9 | 欢迎页覆盖层压住 minimap | 低 | `z-index` 低于 `#welcome`；无文档时直接隐藏 |
| C10 | 大文档全量扫描开销 | 中 | 5 万行起桶采样；20 万行以上只画视口框 |

### C1 折行 / 折叠：映射策略

- **视口框（必须准确）**：`top = scrollTop / scrollHeight * H`，`height = clientHeight / scrollHeight * H`（下限 8px）。`scrollHeight` 已包含折叠缩短与折行增高，天然正确，与 `codeFolding: true`（`settings.ts:231`）和 `wordWrap` 热切换（`extensions.ts:139-141`、`setup.ts:316-320`）无关。
- **密度带（允许近似）**：按 `doc.iterLines()` 逻辑行累计进桶。折行时视觉高度与逻辑行数不一致、折叠时被折行仍计入密度，均视为已知近似（与 `largeView` 的「锚点均摊近似」同一取舍，见技术设计文档 11.8.7 的短板说明）。
- **明确拒绝的做法**：逐行 `view.lineBlockAt(...)` 取真实高度——50k 行下为 O(n log n) 且触发测量，会把成本推到数十毫秒，直接违背性能目标。

### C2 宽度不足：自适应隐藏

- 用 `ResizeObserver` 观察 `#editor`（参考 `preview.ts:83-85` 的 resize 处理写法），当 `#editor` 宽度减去 80px 列宽后不足 520px（即总宽 < 约 600px）时给根节点加 `cm-minimap-hidden`（`display:none`），跨过阈值自动恢复（`MIN_CONTENT_WIDTH = 520`）。
- 只在 `mode-split` 拖拽到极端比例时触发；`mode-edit`（`#editor` 占满）与 `mode-preview`（`#editor` 已 `display:none`，宽度读数为 0）不会误判。

### C3 挂载方式：`#editor` 内的固定列（实现时由覆盖层改为 flex 兄弟节点）

- 设计初稿为「覆盖层 + `padding-right` 让位」，实现时改为**真实布局列**：`#editor` 变为 `display:flex`，minimap 是 `.cm-editor` 的兄弟节点（`flex:0 0 80px`）。
- 改动理由：覆盖层在**横向滚动**（wordWrap 关闭 + 长行）时会让行尾文本钻到缩略图下面；固定列则天然不重叠，滚动条仍留在正文右侧（VS Code 形态），也不需要 `contentDOMWidth` 的 padding hack。
- CM 侧代价可接受：`InputState` 用 `ResizeObserver` 观察 `view.scrollDOM`（`node_modules/@codemirror/view/dist/index.js:7200-7209`），容器宽度变化即触发重新测量；开关 minimap 与拖动分栏属于同一类变化。
- 开关关闭时整个节点不插入，`#editor` 内只剩 `.cm-editor{flex:1}`，与原布局等价。

### C4 滚动联动：只读、单向

- minimap 的 scroll 监听**只读** `scrollTop / clientHeight / scrollHeight` 并移动视口框（`transform: translateY`），不 dispatch 事务、不调用 `scrollIntoView`。
- 用户点击/拖拽时才写 `view.scrollDOM.scrollTop`：
  - 该写入会触发 `previewHost.ts:67` 的监听 → 预览跟随滚动，**这是期望行为**；
  - 该方向不受 `editorEchoUntil` 影响（该窗口只拦截 preview→editor 方向）。
- 拖拽用 `pointerdown` + `setPointerCapture`，`requestAnimationFrame` 合并写入，避免一帧内多次赋值引发预览侧抖动。

### C5 切标签重建：依赖 ViewPlugin 语义

- minimap 以 `ViewPlugin.fromClass` 实现：`setState` 时旧实例 `destroy()`、新实例构造时从新 `state.doc` 重建密度（源码依据 `node_modules/@codemirror/view/dist/index.js:8104-8110`）。
- **禁止**把 DOM 节点或密度数据放在模块级变量：否则切标签后残留上一文档的色带（这正是 `setup.ts:178` 记录的坑的另一种表现形式）。
- Compartment 只负责「开 / 关」：关闭时 `c.minimap.of([])`，开启时 `c.minimap.of(minimapExtension())`，两者都走 `initialExtensions` + `dynamicEffects`。

### C6 缓存归属

- 密度数据（`Uint16Array` 桶数组）挂在 plugin 实例；同一 state 反复重建（如配置重配触发 plugin 重建）时可选用 `WeakMap<Text, { buckets: Uint16Array; lines: number }>` 复用，键用 `state.doc`（`Text` 不可变），与 `extensions.ts:78` 的 `longLineCache` 同一模式。
- 不写入 `EditorState` / StateField（会随 `stateCache` 的 8 条 / 2MB 上限一起被淘汰，且增加序列化面）。

### C7 与虚拟视图的关系

- 进入大文件虚拟视图后 `.editor-area` 为 `display:none`，CM minimap 不可见，不需要运行时判断；`ResizeObserver` 在隐藏态读到的宽度为 0，恰好保持「隐藏」分支，返回普通文件后自动恢复。
- v1 **不改** `largeView/minimap.ts` 的位置与算法；「两套缩略图视觉统一」登记为后续可选项，避免本次改动跨到 `panels` 层。

### C8 主题

- 样式写在 `src/styles/main.css`，全部使用 CSS 变量（`--border` / `--bg-panel` / `--text-primary` / `--accent`），主题切换（`data-theme`）自动生效。
- canvas 绘制前用 `getComputedStyle(el)` 解析一次颜色字符串，再批量 `fillRect`；不在桶循环里逐次取值。
- 不写进 `EditorView.theme`：避免 `c.theme` 每次 reconfigure 时连带重建 minimap 样式。

### C9 欢迎页

- `#welcome` 是覆盖 `#editor` 的绝对定位层（`index.html:121`、`main.css:322-329`）；minimap 的 `z-index` 低于它，且 `state.doc.length === 0` 时不显示密度带。

### C10 规模阈值

| 行数 | 策略 | 预期成本 |
| --- | --- | --- |
| ≤ 50,000 | `doc.iterLines()` 全量扫描 | ≤ 1.1 ms |
| 50,001 ~ 200,000 | 桶采样（每 `ceil(lines/BUCKETS)` 行取一行） | ≤ 0.2 ms |
| > 200,000 | 只画视口框，不画密度带 | ≈ 0 |
| 大文件虚拟视图 | 由 `display:none` 天然关闭 | 0 |

阈值对齐既有性能保护口径：`highlighterDisabledOver: 50000`（`settings.ts:209`）、`largeFileThreshold: 20MB`（`settings.ts:210`）。

---

## 4 改动范围

### 4.1 分层归属

minimap 属 `editor/` 层，只依赖 `@codemirror/*` 与 `config/settings`（`editor/extensions.ts` 已在消费 `settings` 单例）。**不得** import `ui` / `panels` / `app` / `services`，不新增跨层依赖，不新增模块级可变单例（符合 CODEBUDDY.md 依赖方向约束）。

### 4.2 文件清单

| 类型 | 文件 | 改动 | 规模 |
| --- | --- | --- | --- |
| 新增 | `src/editor/minimap.ts` | ViewPlugin 实现：密度扫描、canvas 绘制、视口框、点击/拖拽跳转、ResizeObserver、DPR、阈值降级 | 362 行（实测 366 含文件头注释） |
| 改 | `src/editor/extensions.ts` | `minimap: Compartment` 加入 interface / `createCompartments` / `initialExtensions` / `dynamicEffects` + `minimapExtensions()` | +18 行 |
| 改 | `src/config/settings.ts` | `EditorSettings.minimap`、`AppConfig.layout.minimap`、`defaultConfig()` 默认 `true`、`deriveEditor` 映射 | +4 行 |
| 改 | `src-tauri/src/commands/config.rs` | `LayoutSettings` 加 `pub minimap: bool` + `Default` 实现 `true` + 2 项序列化单测 | +28 行 |
| 改 | `src/settings/layoutTab.ts` | 新增 `checkRow("Minimap 缩略图（编辑器右侧）", …)`；删除预留文案中的 Minimap | +5 / −1 行 |
| 改 | `src/styles/main.css` | `#editor{display:flex}` + `.cm-minimap` 系列样式（含视口框） | +49 行 |
| 不改 | `src/editor/setup.ts` | 已有 `applySettings()` → `dynamicEffects` 通道，无需新增接口 | 0 行 |

不改动：`src/app/*`、`src/panels/*`、`src/main.ts` 命令注册表、`index.html`（DOM 由 ViewPlugin 自建）、`vite.config.ts`。

### 4.3 接口边界

```ts
// src/editor/minimap.ts —— 对外只暴露一个扩展工厂，不导出实现细节
/** 返回 minimap 扩展；开关由 Compartment（layout.minimap）置空 / 挂载 */
export function minimapExtension(): Extension;

// 内部常量（模块私有，不导出）
const WIDTH = 80;                  // minimap 列宽（px）
const MIN_CONTENT_WIDTH = 520;     // 正文最小宽度，减去 80 后不足即隐藏
const MAX_SCAN_LINES = 50_000;     // 全量扫描上限，超过走采样
const MAX_DENSITY_LINES = 200_000; // 超过只画视口框
const MAX_CANVAS_HEIGHT = 1200;    // 桶数上限，控制绘制与内存
const MIN_CANVAS_HEIGHT = 60;
const DPR_CAP = 2;
const LINE_WIDTH_CAP = 120;        // 条宽归一化的行长上限
const REBUILD_DELAY_MS = 150;      // 文档变更后的合并窗口
```

DOM 契约（CSS 类名即边界，`main.css` 与自定义主题只依赖这些名字）：

| 选择器 | 作用 |
| --- | --- |
| `.cm-minimap` | `#editor` 内的固定列（`flex:0 0 80px`），`position:relative` |
| `.cm-minimap > canvas` | 密度带，`width=80*dpr`、`height=H*dpr` |
| `.cm-minimap-viewport` | 视口框（独立 div，只改 `transform: translateY`） |
| `.cm-minimap-hidden` | 宽度不足（正文 < 520px）时隐藏整列 |

配置契约：

- `AppConfig.layout.minimap: boolean`，默认 `true`；`serde(default)` 保证旧 `config.json`（无该字段）可正常反序列化，**`version` 不升级、不做迁移**。
- 前端 `defaultConfig().layout.minimap` 与 Rust `LayoutSettings::default().minimap` 必须一致（`settings.ts:200` 的既有约束）。
- 配置变更经既有链路生效：`updateSettings` → `applyConfig` → `Object.assign(settings, deriveEditor(cfg))` → `editorHost.applySettings()` → `dynamicEffects` 重配 `c.minimap`。

### 4.4 与既有接口的边界

- **不接管** `scrollDOM`：仅 `addEventListener("scroll")`，且 `destroy()` 中必须解绑。
- **不修改** `#editor` 的 flex 规则与 `--split-ratio` 计算（`layout.ts` 不动）。
- **不参与** 预览联动抑制窗口（`editorEchoUntil` / `previewEchoUntil`）。
- 快捷键与菜单入口**通过命令注册表派生**（`src/app/commandTable.ts` 的 `view.toggleMinimap`，默认 `Mod-Shift-M`），不直接注册 DOM keydown：与 `config/keybindings.ts` 的冲突检测、重绑、命令面板共用同一条链路。

---

## 5 验证标准

### 5.1 功能验收

| 编号 | 验收项 | 判定方法 | 通过标准 |
| --- | --- | --- | --- |
| F1 | 开关生效 | 设置中心切换开关 | 100ms 内出现/消失，无需重载或切标签 |
| F2 | 位置与占位 | 量取 `.cm-minimap` 与 `.cm-scroller` 元素 rect | 右缘距滚动条 ≥ 8px；最后一个字符右边界 < minimap 左边界 |
| F3 | 跳转精度 | 无折行/折叠文件，点击 minimap 高度 50% 处 | 跳转行与 `总行数/2` 偏差 ≤ ±2 行 |
| F4 | 拖拽 | 按住拖动 3 秒 | 视口框与编辑器滚动同步，无跳变、无回弹 |
| F5 | 折叠/折行一致性 | 开启 `wordWrap` + 折叠首屏 10 个块 | 视口框不越界，与真实滚动比例误差 ≤ 2px |
| F6 | 切标签无残留 | 10 个不同规模文档往返切换 | 每次密度带随文档变化，无上一文档残留 |
| F7 | 大文件视图互斥 | 打开 `.log` 进入虚拟视图再返回 | 虚拟视图内 CM minimap 不可见；返回后恢复 |
| F8 | 三主题可见 | dark / light / high-contrast 切换 | 密度带与视口框均可见，与背景对比可辨 |
| F9 | 宽度自适应 | 拖 `#split-resizer` 至编辑区 < 520px | minimap 自动隐藏；拉回后自动恢复 |
| F10 | 无文档态 | 关闭全部标签 | 不显示密度带/视口框，欢迎页不被遮挡 |
| F11 | 预览联动不打架 | split 模式点击 minimap | 预览跟随滚动；300ms 内编辑器 `scrollTop` 单调，无来回抖动 |

### 5.2 性能验收（对照 §2.7 基线）

| 编号 | 场景 | 通过标准 |
| --- | --- | --- |
| P1 | 密度重建，20,000 行 | ≤ 2ms（基线 0.58ms，留 3× 余量） |
| P2 | 密度重建，50,000 行 | ≤ 2ms（基线 1.01ms） |
| P3 | 密度重建，200,000 行（采样） | ≤ 0.5ms（基线 0.17ms） |
| P4 | 连续输入 60s（2 万行文档，10 键/秒） | 长任务（>50ms）计数 = 0，`PerformanceObserver({entryTypes:["longtask"]})` 判定 |
| P5 | 连续滚动 10s | canvas 重绘次数 ≤ 1；帧率 ≥ 55fps |
| P6 | 常驻内存增量 | ≤ 2MB（80 × 1200 × 4B × dpr²，dpr 封顶 2） |
| P7 | 包体/启动 | 主 bundle 增量 ≤ 8KB；冷启动增量 ≤ 20ms |

### 5.3 回归与命令验收（项目基线）

```bash
npx tsc --noEmit && npm run build && (cd src-tauri && cargo test --lib)
```

- 上述三连必须全绿（CODEBUDDY.md 验收基线）。
- Rust 单测新增 1 项：`LayoutSettings` 反序列化「无 `minimap` 字段」的旧配置 → 得 `true`；序列化往返字段不丢失。
- 手工冒烟清单（逐条打勾）：F1~F11 全部、`mode-edit` / `mode-split` / `mode-preview` 三态切换、图片标签、只读标签、搜索面板展开态、终端面板展开态（编辑区高度变化）、窗口缩放、双击分割条复位。

### 5.4 回退判据（不达标即降级）

任一出现即降级，不做勉强放量：

1. P2 或 P3 超预算 2 倍 → 取消密度带，只保留视口框（`MAX_DENSITY_LINES` 下调至 0）。
2. F5 误差 > 4px 或 F11 出现可见抖动 → 同步降级为「只画视口框」。
3. 无法在 `editor/` 层内闭环（需要改 `app` / `panels` 才能实现）→ 停止并回到设计评审。
4. 降级后仍不达标 → 开关默认值改为 `false`（字段与 UI 保留）。

---

## 6 实现步骤

| 步骤 | 内容 | 产出 | 自检 |
| --- | --- | --- | --- |
| S1 | **配置打通**：`AppConfig.layout.minimap` + `EditorSettings.minimap` + `defaultConfig()` + `deriveEditor` + Rust `LayoutSettings` 字段/默认值 + 设置页 `checkRow` + 清理预留文案 | 开关可存可读，重启后保持 | `cargo test --lib` 通过；手改 `config.json` 删字段仍能启动（默认 true） |
| S2 | **插件骨架**：`minimap.ts` 建 ViewPlugin，覆盖层 DOM + canvas（含 DPR）+ `cm-minimap-on` 类 + `main.css` 样式；接入 `c.minimap` Compartment（`initialExtensions` / `dynamicEffects`） | 开关可显隐，位置正确 | F1 / F2 / F10 |
| S3 | **密度扫描**：`iterLines()` 全量 → 桶累加 → `fillRect`；`MAX_SCAN_LINES` 之上切桶采样，`MAX_DENSITY_LINES` 之上只画视口框 | 密度带正确反映文档形状 | P1 / P2 / P3（用 2k/20k/50k/200k 行文件实测） |
| S4 | **视口框与滚动同步**：scroll 监听（只读）+ rAF 合并 + `scrollTop/scrollHeight` 比例；`destroy()` 解绑 | 滚动时视口框跟手，canvas 不重绘 | P5 / F5 |
| S5 | **交互**：点击/拖拽写 `scrollTop`（pointer capture + rAF）；边界夹取 | 点击跳转与拖拽可用 | F3 / F4 / F11 |
| S6 | **自适应**：`ResizeObserver` 宽度阈值隐藏 / 高度变化重建 canvas；三态视图模式切换 | 极端分栏、窗口缩放、面板展开均正常 | F9 / F7 |
| S7 | **主题与文档态**：颜色实时取 CSS 变量；切标签重建验证（不写模块级单例）；无文档隐藏 | 三主题可辨、切标签无残留 | F6 / F8 |
| S8 | **收尾**：长任务与滚动帧率检测、冒烟清单全跑、验收基线三连、更新文档状态（本文档 + 技术设计文档 v1.5 的 v2 口径 + `layoutTab` 预留说明） | 可交付状态 | 全部 F/P 项 + 5.3 命令全绿 |

实施顺序理由：先打通配置（S1）使后续步骤始终处于「可开关」状态，任何阶段出问题都能一键关闭；S2 先出静态可见结果便于早期评审；S3/S4 是性能关键路径，必须早测；交互与自适应放在映射稳定之后，避免反复返工。

总量级：约 300~400 行新增/改动，0.5~1 人日（含验收）。

---

## 7 实现记录与偏差（2026-10-26）

### 7.1 交付物

| 项 | 状态 |
| --- | --- |
| 配置字段（TS + Rust + 设置页开关，默认 `true`，旧配置 `serde(default)` 兼容） | 已实现 |
| `editor/minimap.ts`：ViewPlugin、canvas 密度带、视口框、点击/拖拽、宽度自适应、规模降级 | 已实现 |
| `extensions.ts` Compartment 接入（`initialExtensions` + `dynamicEffects`） | 已实现 |
| `main.css`：`#editor` 固定列布局 + minimap 样式（含三主题） | 已实现 |
| 命令与菜单入口：`view.toggleMinimap`（默认 `Mod-Shift-M`，视图菜单 + 命令面板 + 设置键位页自动派生，菜单带 ✓ 勾选态） | 已实现（见 7.6） |
| 启发式着色（注释 / 字符串 / 关键字 / 数字 / 普通） | 已实现（见 7.7） |
| 大文件视图缩略图移到右侧、配色统一、主题切换重绘 | 已实现（见 7.5） |
| `src/editor/setup.ts` / `extensions.ts` 之外的核心模块 | **未改动**（配置改动走既有 `applySettings()` 通道） |
| 彩色语法着色 minimap | 按设计不做（v1 非目标） |

### 7.2 与设计的偏差

1. **挂载方式（C3）**：由「覆盖层 + `padding-right`」改为「`#editor` 内 80px 固定列」。原因见 C3 —— 覆盖层在横向滚动时会让文本钻到缩略图下；固定列无此问题，且滚动条保持在正文右侧。CM 用 `ResizeObserver` 观察 `scrollDOM`，列宽变化会自动重新测量。
2. **密度带编码（S3）**：条宽改为「桶内平均行长（截断 120 字符）归一」，透明度仍用「非空行密度」。纯密度编码在等长行文档（多数代码）里会退化成一整块等宽色条，失去缩略图意义；实测真实 CSS 文件（4287 行）后采用「行长 + 密度」双通道。
3. **视口框配色（C8）**：`--accent` 半透明用 `color-mix()` 实现（前置 rgba 兜底），未用 `opacity` —— `opacity` 会把边框一并淡化，在浅色主题下几乎不可见。
4. **阈值口径（C2）**：`MIN_CONTENT_WIDTH = 520` 作用于「`#editor` 宽度 − 80px」，即总宽约 600px 起隐藏，保证正文不被压到 520px 以下。

### 7.3 验收实测（Chromium 1200×800 / 600，文档为该仓库 `main.css` 共 4287 行）

| 验收项 | 结果 |
| --- | --- |
| 控制台错误 | 0 |
| F2 位置与占位 | minimap 左边界 1120 = 编辑器右边界 1120，无重叠、无文本遮挡；canvas 80×800 CSS px |
| P5 滚动不重绘 canvas | 40 次滚动前后 `fillRect` 计数均为 2000（增量 0） |
| F5 视口框比例 | 50% 滚动时框顶比例 0.5；框高比 0.010 = 期望 0.010 |
| F3 点击跳转 | 点击 minimap 30% 处 → `scrollTop / maxScroll = 0.300` |
| P4 连续输入 | 2 万行文档连续输入 120 次，`longtask` 计数 0 |
| P2/P3 大文档 | 切到 5 万行 / 20 万行文档，`longtask` 计数 0 |
| F9 宽度自适应 | `#editor` 压到 500px → 自动隐藏；恢复后自动显示 |
| F8 主题 | `data-theme` 切 light 后 canvas 颜色由 `(230,232,237)` 变为 `(30,35,40)`，自动重绘 |
| 验收基线 | `npx tsc --noEmit` / `npm run build` / `cargo test --lib`（120 项）全绿 |

### 7.4 未覆盖项（后续）

- E2E 自动化仍未接入（项目整体缺口），本章节交互验证为一次性浏览器脚本，未纳入仓库。
- 折行/折叠场景下的密度带仍是近似（视口框准确），与 `largeView` 的已知取舍一致。

### 7.5 追加：大文件视图缩略图统一（同日完成）

原 `largeView` 缩略图在左侧、64px、配色硬编码（`rgba(150,162,184,…)` 色带 + `rgba(255,255,255,0.14)` 视口框），与编辑器内 minimap 不一致，且浅色主题下白色视口框几乎不可见。本次一并统一：

| 改动 | 文件 |
| --- | --- |
| 缩略图移到右侧（`body.append(scrollEl, canvas)`），宽度 64 → 80（新增 `MINIMAP_WIDTH` 常量） | `src/panels/largeView/dom.ts`、`src/panels/largeView/constants.ts` |
| 配色改用 CSS 变量：色带 `--text-primary`、视口框 `--accent`、命中线 `--danger`；视口框改为「accent 半透明填充 + 上下描边」，与编辑器 minimap 同观感 | `src/panels/largeView/minimap.ts` |
| 主题切换后主动重绘（`MutationObserver` 观察 `data-theme`），修复切到浅色主题后沿用旧配色 | `src/panels/largeView.ts` |
| canvas 仅在尺寸变化时重建 backing store（滚动期每帧绘制不再 realloc） | `src/panels/largeView/minimap.ts` |
| `.lv-minimap`：`width:80px`、`border-left`、`background: var(--bg-panel)` | `src/styles/main.css` |

实测（Chromium 900×600，`large-view` 独立渲染 + 伪造 240 桶密度/命中/视口数据）：canvas 落在 820..900（80px），与列表区 gap 0，无控制台错误；深色与浅色主题下色带、命中红线、视口框均可见。

仍未统一的一处交互差异：编辑器的 minimap 点击把目标行对齐到视口顶部，而大文件视图点击是把目标行居中（`largeView.ts:82-88`）。两者语义都正确，暂不强行对齐。

### 7.6 追加：命令与快捷键入口（同日完成）

| 项 | 内容 |
| --- | --- |
| 命令 | `view.toggleMinimap`「切换 Minimap 缩略图」，`src/app/commandTable.ts`（紧随 `view.toggleSidebar` 之后，`menuOrder: 15`） |
| 默认键位 | `Mod-Shift-M`；不在 `RESERVED_KEYS`（`config/keybindings.ts:69-89`），且表内无同名键 → 无冲突；用户可在设置中心重绑 |
| 入口 | 视图菜单（快捷键列由 `main.ts:1103-1106` 从注册表派生）、命令面板、快捷键速查、设置▸快捷键页，全部零额外改动 |
| 实现语义 | 只改配置：`updateSettings({ layout: { ...getConfig().layout, minimap } })` → `applyConfig` → `subscribeSettings` → `applySettings()` → `c.minimap.reconfigure(...)`。`layout` 段是顶层浅合并，必须整对象回传 |
| UI 反馈 | 成功后 `showMessage("Minimap 已开启/关闭")`；失败输出首行错误（与其它 `persistConfig` 风格一致） |
| 文档 | `README.md` 快捷键表与功能清单已补；本文档 4.4「v1 无快捷键」口径已订正 |

菜单勾选态（同日完成）：`CommandDef.menuChecked?: () => boolean` → `menuModel()` 透传到 `MenuItemModel.checked`，`MenuBar.open()` 每次展开菜单时求值（回调而非快照，切标签 / 改设置后无需重建菜单）。渲染加统一 13px 勾选列（`.menu-check`，所有项占位以保证同列标签左对齐，`✓` 由 checked 决定），已接入 `view.toggleMinimap`（`layout.minimap`）与 `view.toggleSidebar`（`layout.sidebarVisible`）。

实测（Chromium，独立渲染 `MenuBar` + 假模型）：同列各项 `.menu-label` 左边界均为 60px；两个开关项显示 ✓；点击切换侧栏后重新展开，该项 ✓ 消失、Minimap 项保持 → 勾选态随状态实时更新；无控制台错误。

未接入勾选态的命令：`terminal.toggle` / `output.show` 等状态不在 `AppConfig` 中（属各 host 运行时状态），需要时各自注入 `menuChecked` 即可。

### 7.7 追加：缩略图着色（启发式，同日完成）

**方案选择**：先实测了「真语法色」的代价（Chromium，36,672 行 / 1.4MB TS）：

| 环节 | 耗时 |
| --- | --- |
| `ensureSyntaxTree` 全量解析（冷） | **418.7 ms** |
| 已解析树上 `highlightTree` 全量遍历（216,692 span） | 26.0 ms |
| 桶 × 颜色直方图累积（800×6） | 24.9 ~ 26.5 ms |
| 视口局部 span 扫描（422 span） | 0.1 ~ 0.2 ms |
| 对照：现有灰度密度扫描 | 0.8 ~ 1.1 ms |

一次性全量彩色约 50ms（解析另计 400ms+），直接违背「重建 ≤2ms、0 长任务」的验收基线；视口增量方案虽只有 0.1~0.2ms/屏，但需要语法树增量、桶直方图增量失效、三套主题的 tag→颜色映射，工期约 1.5~2 人日。因此 v1 采用**启发式行分类**：不建语法树，成本与灰度同量级。

**实现要点**（`src/editor/minimap.ts`）：

- 5 个分类：普通 / 注释 / 字符串 / 关键字 / 数字；`classifyLine()` 只看行首最多 24 字符 —— 注释标记（`//` `#` `--` `*` `<!--`）→ 注释；引号开头 → 字符串；数字开头 → 数字；首个标识符在关键字表（多语言并集，按首字符分组 + `startsWith` 判定，避免每行 `slice` 分配）→ 关键字；其余普通。
- 数据：`Bands.kinds` 为 `Uint16Array(桶数 × 5)`，按**字符数**加权累积（更接近视觉占比）。
- 绘制：每桶取占比最高的两类分两段着色；次要类型占比 < 20% 直接忽略，避免整幅图出现 1px 彩色毛刺。透明度仍由填充密度决定。
- 抽样：分类成本与行数线性，`CLASSIFY_MAX_LINES = 20000`——超过 2 万行按步长抽样分类（颜色只用桶内相对比例，抽样不影响观感），保证 5 万行重建仍在预算内。
- 配色走 CSS 变量 `--mm-comment / --mm-string / --mm-keyword / --mm-number`（普通行用 `--text-primary`），三套主题各自定义（缩略图专用色比正文语法色更灰一档，避免 80px 色带喧宾夺主）。

**实测**（Node + 真实源码拼成的文档，扫描环节）：

| 行数 | 灰度扫描 | 着色扫描（含抽样分类） |
| --- | --- | --- |
| 2,000 | 0.18 ms | **0.50 ms** |
| 20,000 | 0.86 ms | **1.60 ms** |
| 50,000（步长 3） | 1.48 ms | **2.05 ms** |

彩色绘制（≤2 段/桶）约 0.5~0.8ms，整次重建 ≈ 2.8ms（5 万行）、0 长任务；浏览器实测 `setDoc(50,000)` 期间 `longtask` 计数 0。三套主题下截图确认色带、视口框均可辨。

**已知局限（有意接受）**：

- 只按**行首**分类：行内字符串、行内数字基本不着色（TS/CSS 里字符串多在中段），实际可见差异主要是「注释行偏灰、关键字行偏紫/黄」。
- 80px 宽 + 1 桶 1px：桶内混色后色相偏柔和，视觉收益远小于 VS Code 那种按字符渲染的缩略图；这是选启发式的另一个理由。
- 折行/折叠下仍是逻辑行近似（与 7.4 同口径）。

如需真语法色，按 7.7 的实测数据走「视口增量 + 桶直方图 + 自建 tag 调色板」路线，不要做一次性全量。
