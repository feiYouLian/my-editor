# 全局 Code Review 与渐进式重构计划

> 状态：**待评审**｜建立日期 2026-11-12｜基线分支 `master`（工作区干净）
> 本文件是本次重构的唯一执行依据。进度在 §6，问题台账在附录 A。
> 文中行号取自 2026-11-12 的工作区快照；每批开工前按符号名重新定位，不按行号硬找。

---

## 0. 一页总览

### 0.1 要解决的四类问题

| 类别 | 典型表现 | 本次收敛方式 |
| --- | --- | --- |
| 重复实现 | 同一模板写了 4–10 份（模态骨架、空态、防抖写盘、格式化编排、原子写） | 抽到已有分层，保留一个实现，其余改为调用 |
| 高度耦合 / 绕弯 | 保存链穿 8 个文件、同一 getter 重复注入 14–17 次、7 处反向 import | 收短链路、合并重复注入、按依赖方向归位 |
| 前后冲突 | 文档把「没有 / 做不到」写成现状、多处自称「唯一真源」、同概念 3–6 套状态 | 明确四个唯一真源，其余改为派生或删除 |
| 简单逻辑复杂化 | 单调用点中间层、为一次使用引入接口 / 回调、注释描述已不存在的行为 | 立「抽象准入规则」，删中间层，注释只写当前代码 |

### 0.2 目标形态：四个唯一真源

| 概念 | 唯一真源 | 其余位置应有的形态 |
| --- | --- | --- |
| 命令 / 默认键位 / 结果去向 | `src/app/commandTable.ts` 的命令表 | `docs/COMMANDS.md`、README 键位表、菜单文案、脚本常量一律派生 |
| 配置生效值 | `config.json` + `src/config/settings.ts` 的 `getConfig()` | 工作区覆盖只做差值；前端不再持有第二套可变副本 |
| 保存基线 / 脏判定 | `src/store/tabs.ts` 的 `savedFingerprint` + `markSaved()` | 草稿、diff、main.ts 的 dirty 判断改为查询，不自行判定 |
| 结果反馈出口 | `src/app/resultCenter.ts` 的 `reportResult` / `reportFailure` | 卡片、通知中心、最近消息为同一动作的三种呈现，不再各写一套 |

### 0.3 红线（每批都适用）

1. **行为不变**：不改功能、不改键位功能与默认键、不改 IPC 命令名与参数形状、不改 `config.json` 字段名、不改用户可见文案（文档纠错除外）。
2. **轻量不变**：新增依赖 0、新增常驻定时器 0、新增模块级可变状态 0、主包体积只减不增（`npm run build` 前后对比 `dist/assets/*.js` 合计字节）。
3. **抽象准入**：新抽象必须有 ≥ 2 个真实调用点；只有一个调用点的接口 / 回调 / 工厂 / 转发函数一律内联或删除。反向同样成立——已有抽象若只剩 1 个调用点，本批删除。
4. **注释只描述当前代码**：不写历史、阶段编号、已删除模块、未实现能力；清理历史叙述与行为不符的注释。
5. **一批一主题**：不跨层混合（前端逻辑 / CSS / 文档 / Rust 不放在同一 commit）。单步 diff 控制在 ~200 行内，便于人工审核。
6. **一批一停**：每步一个 commit，每批结束跑全量基线并交人工评审，评审通过才进下一批。
7. **可回退**：每批在独立分支上做，回退粒度 = 一个 commit；禁止顺手改无关代码。

### 0.4 明确不做

- 不重写 `main.ts` / `commandTable.ts`，只按功能域拆装配与数据；
- 不做目录大搬迁、不重命名公共 API 的整体改名；
- 不合并 Rust 的 102 个命令注册、不改 IPC 序列化契约；
- 不新增测试框架 / 门禁脚本，只复用 `scripts/` 现有门禁；
- 不调整 E2E 用例语义，不为重构改断言。

### 0.5 批次总表

| 组 | 批次 | 主题 | 风险 | 文件数 | 预估改动行 | 主包 | 新增定时器 | 建议审核量 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A 口径与卫生 | B1 | 文档与真源口径纠偏 | 无 | 6–8 | ~120 | 0 | 0 | 30 分钟 |
| A | B2a | 单调用中间层 / 死代码 / 注释与行为不符 | 低 | 11 | ~60 | 略降 | 0 | 30 分钟 |
| A | B2b | 历史叙述注释全量收口（核实后 33 处） | 无 | ~24 | ~60 | 0 | 0 | 40 分钟 |
| B 基础件与反馈 | B3 | core/ui 基础件复用（核实后收敛） | 低 | 7 | ~15 | -130 B | 0 | 15 分钟 |
| B | B4 | 结果反馈出口统一 | 低-中 | ~12 | ~200 | 略降 | 0 | 1 小时 |
| C 编排与依赖 | B5 | app 层编排去重 | 中 | ~10 | ~350 | 略降 | 0 | 1.5 小时 |
| C | B6 | 依赖方向 / 全局状态收口 | 中-高 | ~15 | ~300 | 0 | 0 | 2 小时 |
| D 后端与命令体系 | B7 | Rust 公共 helper 与安全复核 | 中 | ~12 | ~250 | 不适用 | 0 | 2 小时 |
| D | B8 | 命令表 / 键位单一真源 + 装配分域 | 高 | ~8 | ~500 | 略降 | 0 | 2.5 小时 |

> 顺序按「审核前提 → 零行为改动 → 机械替换 → 逻辑合并 → 依赖方向 → 契约面」递增风险。
> B7 与前端批次语言独立，可在 B4 之后并行安排；B8 必须最后做，且开工前先补契约测试。

---

## 1. 现状体检（结论与证据）

### 1.1 重复实现

> R2 / R6 / R7 / R8 / R14 与 X11 经 B3 开工核实后判定为「表面相似、语义不同，不合并」；结论与证据见 §3 B3。本节的「重复量 / 合并难度」是初判，不是最终处置。

| ID | 证据 | 重复量 | 合并难度 |
| --- | --- | --- | --- |
| R1 | 模态骨架：`src/ui/dialogs.ts:52,113,254,314`；`src/panels/saveEncoding.ts:24`；`src/panels/batchEncoding.ts:64`；20+ 面板各自监听 `keydown` 处理 Esc | 4 份主模板 + 20 处 Esc | 中 |
| R2 | 空态与「?」帮助：`src/panels/searchView.ts:306`、`outlineView.ts:139`、`gitView.ts:288`、`noticePanel.ts:92,153`；`?` 按钮散在 `settingsPanel.ts:79`、`diffPanel.ts:159`、`convertPanel.ts:142`、`largeView/dom.ts:125`；统一入口已存在 `src/panels/helpDialog.ts:87` | 10+ 份 | 低 |
| R3 | 结果卡被绕过：`src/app/resultCenter.ts:13,24` 是编排出口，但 `src/app/previewHost.ts:319,374`、`diffService.ts:226,252`、`searchView.ts:704,714`、`largeView.ts:804,855` 直调 `src/ui/resultCard.ts:148,176` | 8 处 | 低 |
| R4 | 导出写盘：`src/app/previewHost.ts:327-348` 与 `:351-372` 逐行同构；`src/app/fileService.ts:411` 第三份 `save_file` 包装 | 3 份 | 低 |
| R5 | 格式化编排：`src/app/formatHost.ts:39-84` 与 `:87-121` 两份，`:61-79` 与 `:100-116` 完全同构；`:127` 第三条调用口径不同 | 2.5 份 | 低 |
| R6 | 防抖写盘：`src/services/session.ts:68`、`workspace.ts:31`、`src/ui/statusBar.ts:285,300`、`src/settings/shared.ts:62,98` | 5 份 | 中 |
| R7 | 常量多套：`src/app/fileService.ts:76`、`panels/batchEncoding.ts:31`、`panels/largeView/constants.ts:19`、`app/statusActions.ts:22` 四套编码 / 换行候选；BOM 规则只在 `panels/saveEncoding.ts:77` | 4 套 | 低 |
| R8 | 路径工具被绕过：`src/core/paths.ts:21,40,46` 已统一，但 `ui/icons.ts:21`、`editor/languages.ts:359`、`panels/preview/pathKind.ts:8`、`app/diffService.ts:411` 各写一份 | 4 份 | 低 |
| R9 | 失败反馈三件套：`formatHost.ts:67-76` 与 `:104-113` 复制两遍；`gitHost.ts:250`、`sessionHost.ts:177,445`、`main.ts:1487` 又各写一份 `addNotice` | 6 份 | 低 |
| R10 | Rust `spawn_blocking` 样板：49 处 `.await.map_err(|e| format!("任务…失败: {e}"))?`，见 `src-tauri/src/commands/file.rs:173,197,265`、`git.rs:282,357,388`、`search.rs:306,376`、`fs.rs:52,111`、`config.rs:614,623` 等 | 49 处 | 低 |
| R11 | Rust 原子写 4 份：`file.rs:270` 为通用实现（含 fsync + rename 重试），`config.rs:709-714`、`workspace.rs:62-64`、`session.rs:274-278`、`diff.rs:364-366` 另写简易版 | 4 份 | 低-中 |
| R12 | Rust 路径守卫样板：`git.rs` 15 处四连（`ensure_writable` + `ensure_file_scope` + `spawn_blocking`），`fs.rs` 8 处 `ensure_root_scope` | 23 处 | 中 |
| R13 | Rust `watch` 写标记：仅 `file.rs:355,368` 与 `search.rs:667,669` 手工成对（且一个在闭包外、一个在闭包内）；`fs.rs:73,89,190,244`、`diff.rs:365`、`batch.rs:131`、`fetch.rs:363`、`large.rs:897`、`git.rs:573,654,700` 等写盘未包裹 | 10+ 处缺口 | 中 |

### 1.2 耦合与绕弯

| ID | 证据 | 问题 |
| --- | --- | --- |
| C1 | 保存链：`main.ts:2229,2237` → `core/commands.ts:111,116` → `app/commandTable.ts:231` →（`main.ts:1903-1975` 装配 ctx）→ `app/fileService.ts:228,419-461` → `main.ts:1441-1444` → `app/sessionHost.ts:421,455,729` → `store/tabs.ts:839` → `app/resultCenter.ts:13` → `ui/resultCard.ts` | 8 文件 / 10 跳；`main.ts:1441-1444` 三个保存后回调可合成一个接口 |
| C2 | 关闭标签链：`app/commandTable.ts:310` → `main.ts:396,405` → `store/tabs.ts:575,584` → `main.ts:432-441`（一个回调里转调 5 个宿主） | 集中转发可改为各宿主构造时自订阅 `tabStore.onTabClosed`（`main.ts:432` 已有订阅范式） |
| C3 | 重复注入：`getActiveTab` 在 `main.ts` 出现 14 次，`showMessage: statusBar.showMessage` 17 次，`getView` 8 次（如 `:180,290,385,755,1320,1391,1522,1666,1920`） | 36 个 `*Deps` 接口里同一字段在 12–14 个接口重复声明 |
| C4 | 反向 import 7 处：`ui/gitStatusItem.ts:14`→panels、`panels/noticePanel.ts:14`→`app/noticeStore`、`panels/openEditorsView.ts:10`→store、`services/updater.ts:10`→`ui/dialogs`、`editor/searchPanel.ts:3`→`ui/idle`、`config/settings.ts:2`→`editor/languages`、`config/defaults.contract.test.ts:3`→panels | 与 `CODEBUDDY.md:29-32` 声明方向不符 |
| C5 | 包级环：`config/settings.ts:2` → `editor/languages`，而 `editor/setup.ts:15`、`extensions.ts:20`、`keymap.ts:16`、`minimap.ts:26` 等 8 处 → `config/settings` | config ↔ editor 互咬，超出 `CODEBUDDY.md:36` 声明的可接受范围 |
| C6 | 模块级可变状态：`core/commands.ts:95,97` 与 `core/messageLog.ts:21-23` 在 core 层持有全局可变状态；`app/noticeStore.ts:29-31` 是第二套同构通知状态；`config/settings.ts:357,359,360` 三份配置态；`editor/languages.ts:67,119,425` 原地改写全局表 | 与「core = 纯函数」「共享状态经 Deps 注入」两条约定冲突 |
| C7 | 装配层：`main.ts` 现 2440 行，`commandTable.ts` 1821 行；`:1895-1902` 两段重复注释、`:1903-1976` 73 行 ctx 字面量对应 `commandTable.ts:47-112` 的 44 字段接口；同一注册表被 palette / menubar / shortcutRows / keydown 派生 4 次且各写接线（`:1987-1992,1994,2004,2220-2240`） | 审核者追一个菜单项要跨 4 层 |

### 1.3 前后冲突 / 假真源

| ID | 证据 | 冲突 |
| --- | --- | --- |
| X1 | `docs/MIGRATION.md:3` 称「键位唯一权威来源是 README.md → 快捷键（从命令注册表派生）」，但 `README.md:499` 是手写表；派生的只有 `src/panels/shortcutsDialog.ts:4` | 假真源，且 `./README.md` 在 docs/ 下是坏链 |
| X2 | `docs/MIGRATION.md:28`「项目级覆盖：没有｜只有一份全局配置」 | 与 `README.md:99,488`、`src/core/workspaceOverrides.ts` 的 `workspaces/<hash>.json` 覆盖矛盾 |
| X3 | `docs/MIGRATION.md:48`「多终端并行：做不到（单会话）」 | 与 `README.md:147`「多会话（≤8 PTY）」、`docs/ACCEPTANCE.md:57` 矛盾 |
| X4 | `docs/MIGRATION.md:31`「17 种内置不可扩展」紧接 `:44` 列三条扩展路径；`README.md:541` 又说 16+13 | 同页自相矛盾 |
| X5 | 测试数量四处不一致：`README.md:272,275`（130 / 178）、`CODEBUDDY.md:76`（131+33 / 210）、`CONTRIBUTING.md:41`（131+18 / 201）、`docs/ACCEPTANCE.md:18`（131+26 / 205）；实测为 131 + 渲染层 40 / 210 passed + 2 ignored | 验收依据不唯一，且验收文档自身数量过时；统一引用 `docs/ACCEPTANCE.md` 并更新其判据 |
| X6 | `docs/COMMANDS.md:9` 的「134 条」实为 `scripts/gen-command-index.mjs:193` 生成值（正确）；过时的是 `CODEBUDDY.md:80`、验收记录与 `docs/ACCEPTANCE.md` A-11 里的 133 | 其他文档不得复述命令总数；验收判据改用「全覆盖」表述 |
| X7 | 四处自称唯一来源：`core/commands.ts:2`、`app/commandTable.ts:4`、`scripts/gen-command-index.mjs:5`、`main.ts:2136` | 实为「数据 / 机制 / 生成物」三层，注释未区分 |
| X8 | `scripts/gen-command-index.mjs:146` 的 `MENU_LABELS` 与 `core/commands.ts:83` 各手写一份且顺序不同；`:137` 的 `KIND_LABELS` 中文标签只在脚本里，`core/commands.ts:31` 另有一份 `OutcomeKind` 成员集合；`app/commandTable.test.ts:5-16` 还有第三处手写菜单 id | 同一枚举 3 处手写；新增 kind 或改菜单时脚本与测试会漏 |
| X9 | `src/config/settings.ts:357,359,355` 同时有 `settings` / `current` / `workspaceOverrides` 三套生效值；`defaultConfig()` `:255` 与 `config/fixtures/defaults-contract.json` 两处默认值 | 需明确只读快照由单一来源派生 |
| X10 | `src/services/session.ts:30` 的 `splitRatio` 仍存在，`app/sessionHost.ts:265` 恒写 `null` 且注明不读；`main.ts:2288`、`app/layout.ts:31` 说 `config.json` 才是真源 | 僵尸字段 + 第四份内存状态 |
| X11 | 会话 / 载入代际 6 套：`app/tabSwitcher.ts:41`、`editor/setup.ts:180,292`、`editor/stateCache.ts:11`、`services/treeWatch.ts:23`、`panels/preview.ts:98`、`panels/regexTester.ts:49` | 同一「await 后丢弃旧代」语义手写 6 遍 |
| X12 | 键位说明 ≥5 处手写：`README.md:499`、`docs/MIGRATION.md:8`、`docs/USER-GUIDE.md:19`、`src/editor/keymap.ts:36`、`config/keybindings.ts:69` | 与「只增不改 + 单一来源」的既有要求冲突 |
| X13 | `src/app/menuContent.ts:149,157` 右键菜单硬编码「Shift+Alt+F」「F5」 | 与 `CommandDef.defaultKey` 构成第二套真源 |
| X14 | 注释与行为不符：`core/commands.ts:11` 声明 `menuOnly: true`，但 `CommandDef`（`:41-76`）无该字段，实际用 `hidden`；`panels/helpDialog.ts:5` 只说两页，`:40` 实际有第三页 | 审核者会被误导 |

### 1.4 简单逻辑复杂化 / 审核不友好

| ID | 证据 | 问题 |
| --- | --- | --- |
| S1 | `src/editor/occurrences.ts:8` 函数体仅 `return highlightSelectionMatches()`，调用点只在 `editor/extensions.ts:218,265` | 单用途中间层 |
| S2 | `src/config/keybindings.ts:20-30` 转发 8 个 `core/keyNotation` 符号，注释自认「保持既有导入路径可用」；实际消费方是 `settings/keybindingsTab.ts:11-24` 与 `main.ts:94-99`；`:33` 类型别名、`:36` 包装函数又各加一层 | 三层转发无新增语义 |
| S3 | `src/app/fetchHost.ts:30` 公共 `open()` 仅 `void this.openAsync()`；`app/commandTable.ts:51` 为这一次调用专门声明接口 | 为吞 Promise 引入接口 |
| S4 | `src/app/resultCenter.ts:13` 两行组合；`ui/resultCard.ts:31` 的 `helpId` 只为这一次转换存在 | 单次使用的字段 / 回调 |
| S5 | 一个「弹出菜单」拆成 `app/menuContent.ts:48`、`ui/editorMenu.ts`、`ui/menu.ts`、`ui/statusMenu.ts` 四个文件，且状态栏菜单与右键菜单交互规则不同 | 同类交互两套 |
| S6 | 核实后需处理 33 处：应删 4 处（`core/errors.ts:7`、`config/keybindings.ts:119`、`scripts/scan-innerhtml.mjs:15`、`main.ts:2195-2196`），应改写 29 处（含「从 main.ts 迁出」3 处、`settings/shared.ts:59-60`、`panels/runConfig.ts:2` 的 G10、`core/commands.ts:90`、CSS 里 6 处阶段编号 / 「原先 / 改为」、两个基线 JSON 与脚本里的 S1/S3/S5/S6 排期）。`app/commandTable.ts:2` 已在 B1 修正；`app/tabSwitcher.ts:5` 的不变式说明应保留 | 违反「注释只描述当前代码」 |
| S7 | `src/panels/noticePanel.ts:24` 自定义 `p = padStart(2,"0")`，与 `core/format.ts:15` 的 `pad2` 同义；`app/symbolHost.ts:78` 先归一化 Error 再传给已自带归一化的 `core/errors.ts:9 firstLine` | 同类语义两套命名 / 多绕一层 |
| S8 | `src/config/settings.ts:336` 字段 `legacyLanguages`、文件 `editor/legacyModes.ts`、用户可见名「附加语言」 | 字段名是 `config.json` 契约（连带夹具与 Rust 测试），不在本轮单独改名，移到 B6 决策 |
| S9 | `CODEBUDDY.md:64-93` 与 `README.md:39,41` 保留版本编年史 / 阶段编号，与同文件 `:7`「README 为当前真源」口径不一 | 建议由用户拍板后统一（见 §5 D-3） |

### 1.5 Rust 侧补充

| ID | 证据 | 问题 |
| --- | --- | --- |
| B1 | `src-tauri/src/commands/fs.rs:21` `list_dir(path)` 直接 `fs::read_dir(&path)`，`:10` 只导入 `PathGuard` 未使用 | 与「目录树操作限工作区根」约定不符，**需先核实调用来源与威胁模型** |
| B2 | `git.rs:48-58`、`git.rs:65-87`、`git.rs:554-588` 三套 `Command::new("git")`；`diff.rs:7,267,293` 与 `git.rs:150` 同一条 `rev-parse --show-toplevel` | git 被 `git.rs` / `diff.rs` 分管，注册也分两段 `lib.rs:102-117`、`lib.rs:147-151` |
| B3 | 「读字节 → 探测编码 → 解码」六份：`file.rs:76-96`、`diff.rs:216-221`、`batch.rs:119-123`、`search.rs:755-763`、`large.rs:321-324`、`encoding.rs:372-374` | 抽取低风险，但须保留 `search.rs:762` 严格版语义 |
| B4 | 「可回滚快照」两套：`search.rs:186-187,676,849,894`（replace-history + manifest）与 `git.rs:611-655,698`（discard-backup + manifest.json） | 机制同构，本轮**只抽公共 helper，不合并业务语义** |
| B5 | 调度失败文案 8 种口径：`file.rs:173`、`git.rs:282`、`fs.rs:52`、`config.rs:614`、`search.rs:1016`、`startup.rs:51`、`association.rs:118,127`、`format.rs:130` | 统一 helper 的附带收益 |
| B6 | 测试辅助 `temp_dir` 5 份、`temp_file` 3 份：`batch.rs:167`、`fs.rs:332`、`logging.rs:162`、`git.rs:1240`、`search.rs:1112`、`large.rs:1123`、`run.rs:895`、`session.rs:404` | 抽 `#[cfg(test)]` 公共模块，风险低 |

---

## 2. 分组与执行规范

### 2.1 分组

- **组 A 口径与卫生**（B1–B2）：先把审核依据摆正，零行为改动。
- **组 B 基础件与反馈**（B3–B4）：低风险机械替换，让后续批次有可复用的单一实现。
- **组 C 编排与依赖**（B5–B6）：动 app 层编排与依赖方向，需单测与 E2E 兜底。
- **组 D 后端与命令体系**（B7–B8）：Rust helper 与命令单一真源，风险最高，放最后。

### 2.2 每批固定动作

1. 从 `master` 建 `refactor/B<n>-<主题>` 分支，先跑 §4 全量基线并记下数据（测试数、体积、diff 基线）；
2. 按「步」提交，每步一个 commit，commit 只含该步文件；
3. 每步跑 `npx tsc --noEmit && npm test`；每批结束跑 §4 全量；
4. 更新 §6 进度表与附录 A 状态；交人工评审，通过后再合入并开下一批；
5. 任一步基线变红：就地修复或整体回退该 commit，不带着红灯继续。

### 2.3 成本口径

每批在记录里填这五项：改动文件数、`git diff --stat` 行数、`dist/assets/*.js` 合计字节前后差、新增常驻定时器数（目标 0）、新增模块级可变状态数（目标 0）。本轮不引入任何新依赖，因此无安装体积与许可证成本。

---

## 3. 批次明细

### 组 A：口径与卫生

#### B1 文档与真源口径纠偏｜风险 无

**范围与证据**：X1–X8、X12、S9（仅文档部分）。

**步骤**（每步一个 commit）
1. 修 `docs/MIGRATION.md`：`:3` 指向 `src/app/commandTable.ts` 的 `defaultKey` 数据真源 + `docs/COMMANDS.md` 生成物，去掉坏链；`:28` 改为「全局 config.json + 工作区覆盖」；`:48` 改为多会话（≤8 PTY）；`:31/:44` 按 `src/editor/languages.ts` / `legacyModes.ts` 统一为 16 种开箱 + 13 种附加；`docs/USER-GUIDE.md:244` 的 17 同步改 16。
2. 测试数量口径：`README.md:272,275`、`CONTRIBUTING.md:41` 删手写数字，改为引用 `docs/ACCEPTANCE.md`；`docs/ACCEPTANCE.md` A-2/A-3/A-9/A-11 按实测更新为 131+40 / 210+2 ignored / 40 / 134-134（说明与索引各 134/134），表头注明「数量为最近实测，以命令输出为准」。`CODEBUDDY.md:76` 属项目 guidance，按 §5 D-3 待用户确认，本批不动。
3. 命令总数：`docs/COMMANDS.md:9` 已由 `npm run gen:commands` 生成（134 条），保持生成物不变，其他文档不复述；验收记录里的 133 属当时快照，不改。
4. 四处「唯一来源」注释（`core/commands.ts:2`、`app/commandTable.ts:4`、`scripts/gen-command-index.mjs:5`、`main.ts:2136`）改成明确区分「数据真源 / 派生机制 / 生成物」。
5. 脚本常量收口：`scripts/gen-command-index.mjs` 已用 `typescript` AST 解析 `.ts`（见 `:27-31 parseTs` 与 `:71-99 parseCaseLabels`），因此不能 `import` TS 模块；把中文标签写成 `core/commands.ts` 的 `OUTCOME_LABELS: Record<OutcomeKind, string>`，脚本用新增的 `parseStringRecord()` 读取 `MENU_LABELS` 与 `OUTCOME_LABELS`，删掉两份手写映射；`MENU_LABELS` 改为 `export`，`src/app/commandTable.test.ts:5-16` 的手写菜单 id 改为 `Object.keys(MENU_LABELS)`。不新增依赖。

**不改**：任何运行时逻辑、命令 id、键位、文案；`CODEBUDDY.md`（待 D-3）。
**验收**：§4 全量 + `npm run gen:commands` 后 `git diff` 无变化 + 文档链接可点开。
**成本**：6–8 文件、~120 行、主包 0、定时器 0、审核 ~30 分钟。
**风险 / 回退**：AST 解析依赖常量名稳定，改名需同步脚本；标签映射本身与现有值一致，`docs/COMMANDS.md` 输出应无 diff。若 diff 非空，以 `core/commands.ts` 为准调整脚本，不反向改命令表。回退 = revert 该 commit。
**执行记录**：已完成，数据见 §6.1。

#### B2 注释 / 死代码 / 单调用中间层｜风险 低（执行时拆为 B2a / B2b）

> 开工核实发现原范围偏大：S6 清单从 14 处扩到 33 处，`keybindings.ts` 的转发层还牵动 3 个文件、10 个符号。
> 按「不要步子跨太大」拆成两批，各自独立验收与评审。

##### B2a 单调用中间层 / 死代码 / 注释与行为不符（已完成）

1. 删 `config/keybindings.ts:20-38` 的 8 个转发导出、`KeyCommand` 别名与 `keyCommands()` 包装；内部 6 处类型、2 处调用改用 `core/commands` 的 `BindableCommand` / `bindableCommands()`；`settings/keybindingsTab.ts:11-24` 与 `main.ts:94-99` 的导入改为直连 `core/keyNotation` / `core/commands`。
2. `editor/occurrences.ts` 内联为 `editor/extensions.ts:218,265` 的 `highlightSelectionMatches()`，删除该文件。
3. `app/fetchHost.ts` 的 `open()` / `openAsync()` 合并为一个 `async open()`；`app/commandTable.ts:51` 接口改 `Promise<void>`，`:350` 用 `void` 吞掉返回值。
4. `app/symbolHost.ts:78` 去掉与 `firstLine` 重复的归一化；`panels/noticePanel.ts:24` 改用 `core/format.ts:15 pad2`。
5. 修正注释与行为不符：`core/commands.ts:11` 的 `menuOnly` → `hidden`；`panels/helpDialog.ts:5,7,16` 补齐第三页 / 第三份文档 / 三份 Markdown。

**不改**：命令 id、键位、IPC、配置字段、公共 API 语义。
**验收**：§4 全量（除 E2E），结果见 §6.2。
**成本**：11 文件（含删除 1 个）、净减行、主包略降、定时器 0、审核 ~30 分钟。
**风险 / 回退**：删转发层若有遗漏引用会编译失败，`tsc --noEmit` 直接暴露；`scripts/` 门禁按文本扫 src，不解析这些导出名。回退按文件粒度 `git checkout`。

##### B2b 历史叙述注释全量收口（已完成，见 §6.3）

已按核实后的清单处理：删除 4 处、改写 29 处，另补 `helpDialog.ts:16` 的「三份 Markdown」计数，明细见 §1.4 S6。
**已保留**：`app/tabSwitcher.ts:5` 的不变式说明、「历史」功能名、「之前」时序词、仍成立的 why 注释、UI 文案与测试事实；`docs/acceptance/*` 与 `CHANGELOG.md` 属历史记录，不在清理范围。
**数据字符串**：`scripts/discoverability-baseline.json` 的 `generatedFrom` 由版本快照改为 `current`，两个基线 JSON 的 `note` 去掉 S1/S3/S5/S6 排期；键名未动，门禁判据未受影响。
**S8 处置**：`legacyLanguages` 改名涉及 `config.json` 契约 / 夹具 / Rust 测试，不在本轮单独改名，移到 B6 决策。
**成本**：23 个文件（19 个本批新增）、净 -11 行、主包 0、定时器 0、审核 ~40 分钟。

---

### 组 B：基础件与反馈

#### B3 core / ui 基础件复用｜风险 低（开工核实后大幅收敛）

> 2026-11-12 逐条核实后，原计划 5 步里有 4 步的「重复」是表面相似、语义不同，按原计划抽取会制造过度抽象或破坏契约。
> 本批只保留经代码验证等价的替换，其余登记为「不合并」。

##### 已完成

1. 删除 `src/services/session.ts:66-74` 的 `saveSessionDebounced`（全仓零调用点）及其模块级 `saveTimer`；`saveWorkspaceDebounced` 保留（唯一调用点 `main.ts:626`，无需抽象）。
2. 6 处手写 `path.split(/[\\/]/).pop() ?? path` 改用已有的 `core/paths.ts:40 basenameOf`：`app/diffService.ts:411`、`panels/batchEncoding.ts:211,249`、`panels/searchView.ts:92`、`panels/recentFiles.ts:94`、`app/runHost.ts:336`。逐处核对正/反斜杠、大小写、无扩展名、点开头与尾部斜杠，行为等价。

**验收**：§4 全量（除 E2E），结果见 §6.4。
**成本**：7 文件、净 -9 行、主包 -130 字节、定时器 0（删掉 1 个已有 timer）、审核 ~15 分钟。

##### 经核实不合并（原计划 4 步）

| 原步骤 | 核实结论 | 证据 |
| --- | --- | --- |
| 空态 / `?` 按钮统一 | 空态 className 有 9 种，追加 vs 清空、单/多按钮、loading 态各异；7 个「?」按钮的 className / title / 回调 / aria 全不同，`compareWorkbench.ts:164` 走 `showMessage` 而非帮助弹窗。抽 4 参数工厂会把 4 行直白 DOM 变成一层间接 | `panels/gitHistoryPanel.ts:217-254`、`panels/fileTree.ts:612-625`、`panels/helpDialog.ts:87` |
| 空态 C5 判据 | 审计按「文件路径 + 文案字面量子串」匹配空态，`--update-baseline` 不重写 `emptyStates`；文案移进公共组件会直接判失败，必须把 4 条字面量留在原文件，收益被抵消 | `scripts/audit-discoverability.mjs:598-609`、`scripts/discoverability-baseline.json:243-260` |
| CSS 按钮基类 / backdrop 合并 | 5 个按钮分属 22/24/26px 三套工具栏尺寸，`border`/`bg`/`transition`/`radius` 与 `.active`/`:disabled` 状态各异；`.dialog-backdrop` 四处是布局 / 进场 / 退场 / 高对比主题的职责拆分，属性集不重叠，无重复覆盖 | `styles/status.css:583-615,888-914`、`git.css:772-786`、`dialogs.css:78-97`、`shell.css:106-145`、`panels.css:322`、`motion.css:100,175`、`tokens.css:288`、`styles/main.css:3` |
| 防抖写盘统一 | 实为 3 种语义：`session`/`workspace` 模块级 last-wins（前者已删）、`statusBar.persistConfig` 闭包级累积补丁（`mergePatch` 是两层配置合并、不是防抖，last-wins 会丢改动）、`settings/shared` 立即写 + 失败回滚；另有第 6 份 `main.ts:1415-1433` | `ui/statusBar.ts:284-313`、`settings/shared.ts:57-69,92-102` |
| 编码 / 换行常量归一 | 4 套差异全是契约：Rust `CANDIDATES` 10 项顺序与 `lookup` 文案绑定；largeView 8 项含前端 + Rust 双向断言和 `starts_with("UTF-16")` 过滤；batch 6 项 + `KEEP`；状态栏 3 项；BOM 依赖 `startsWith("UTF-16")` 文案 | `encoding.rs:6-18,32-45`、`largeView/constants.ts:17-28`、`batchEncoding.ts:31-38`、`saveEncoding.ts:77-104` |
| 路径工具全面替换 | 7 处里只有 basename 类可等价替换（已做）；`stripExtension` 的 `dot>0` 与 `iconCategory` / `languageKeyFromPath` 的 `dot===0` 语义相反；`needVirtualView` 输入是带点后缀 `.log`；`normalizeLogExtensions` 是扩展名归一；`parentDirOf` 用 `idx>0` 而 `dirnameOf` 用 `idx>=0` | `core/paths.ts:40-50`、`ui/icons.ts:21-25`、`editor/languages.ts:359-375`、`app/largeFileHost.ts:65-73`、`panels/gitView.ts:668-672` |
| 代际令牌抽取 | 三处里只有 `regexTester.ts` 是纯 seq；`preview.ts` 是 `seq + activeId + mode` 复合谓词且有 4 处检查；`stateCache.ts:11` 是配置版本快照，根本不是代际令牌。抽 `createGeneration()` 后只剩 1 个真实调用点，违反抽象准入 | `panels/preview.ts:98-99,408-410,739-742`、`editor/stateCache.ts:8-17`、`editor/setup.ts:180` |

**保留未改**：`welcome.ts:137` 的 `filter(Boolean)` 版 basename（处理尾部斜杠，与 `basenameOf` 不等价）、`fileTree.ts:838,919` 的路径分段计数、`core/paths.ts:103` 的工具内部实现。

#### B4 结果反馈出口统一｜风险 低-中（开工核实后收敛）

> 核实后：`diffService.ts:227` 带「覆盖 / 换个名字」决策按钮，改走 `reportResult` 会丢按钮（该函数硬编码 `actions: []`）；`diffService.ts:253` 带 `retry`，`reportFailure` 不支持重试；`fileService.ts:463` 是唯一高频点（每次 Ctrl+S），审计 `EXEMPT` 已写明「保存成功走轻提示」的正当理由。这三处保留直调，其余接入。

##### 已完成

1. `app/formatHost.ts`：两份逐字符相同的失败三件套抽成模块级 `reportFormatFailure(tab, result, deps)`；保留全部差异（大文件确认只在文档级、`failure.code` 白名单、actions 顺序、`fmt:${tab.id}` 去重键、不传 durationMs / extraActions）。`beforeSave` 刻意不并入（`fileService.ts:419` 忽略返回值，失败不阻塞保存）。
2. `app/previewHost.ts`：导出失败改 `reportFailure`；PDF 分支保留直调（用户可能取消打印，未生成产物不应留底）。
3. `panels/searchView.ts`：批量替换成 / 失败两处改由 `SearchViewDeps.reportResult` / `reportFailure` 注入（面板不 import app 层）。
4. `panels/largeView.ts`：复制命中 / 导出命中的成功与失败 4 处改由 `LargeViewDeps` 注入；「已导出」带产物路径，通知中心 `detail` 可直接回看。
5. `scripts/audit-discoverability.mjs:472`：`resultCardAt` 正则改为 `/(^|\.)(reportResult|showResultCard)$/`，认可 Deps 注入形态；判据强度不变（仍要求该函数体内有结果卡调用）。

##### 经核实不接入

| 位置 | 理由 |
| --- | --- |
| `app/fileService.ts:463` 保存成功 | 唯一高频点（每次 Ctrl+S）；已有状态栏提示 + 脏标记 + `notifyOnSave` 开关三重反馈；`audit-discoverability.mjs:156-161` 的 `EXEMPT` 写明「产物就是用户选的路径，结果卡只会重复对话框已经说清的信息」 |
| `app/diffService.ts:227` 补丁已存在 | 带决策按钮，`reportResult` 硬编码 `actions: []`（`resultCenter.ts:21`），改后通知中心会出现点不了的死条目 |
| `app/diffService.ts:253` 导出补丁失败 | 带 `retry`，`reportFailure` 不支持 actions，改后重试按钮只剩卡片 |
| `panels/convertPanel.ts:437`、`compareWorkbench.ts:462` 复制 | 零风险即时动作，状态栏语义足够；接通知会让结果列表被低价值条目占用 |

**不改**：卡片文案、8 秒自动收起、通知中心 50 条上限。
**验收**：§4 全量 + E2E，结果见 §6.5。
**成本**：9 文件（含 2 个渲染层测试桩）、~60 行、主包 -78 字节、定时器 0、审核 ~40 分钟。

---

### 组 C：编排与依赖

#### B5 app 层编排去重｜风险 中

**范围与证据**：R4、R5、R12（前端部分）、C1、C2、C3、R6 第 4 步剩余。

**步骤**
1. `formatHost.ts`：把 `formatCurrent` / `formatSelectionCurrent` 合并为一个私有 `run(mode)`，公共方法只传 mode；`beforeSave` 的失败反馈改用 B4 的统一函数。
2. `previewHost.ts:327-372` 两段导出写盘合并为 `exportTo(ext, buildContent)`；`fileService.ts:411` 的 `writeTo` 与它共用一份 `save_file` 包装（抽到 `src/services/`）。
3. 四处「导出补丁」调用点（`diffService.ts:278,420,495,544`、`main.ts:892`、`gitHistoryPanel.ts:327`、`compareWorkbench.ts:465`）统一由 `PATCH_SOURCES`（`diffService.ts:35`）+ 一个 `exportPatch(source, payload)` 组装，去掉各自的 `label/title/run`。
4. 缩短保存链（C1）：`main.ts:1441-1444` 三个保存后回调合成一个接口；`main.ts:1380` 与 `:1440` 重复的 `onCheckMojibake` 去掉一处；`:1381,1581,1670` 三处 `reloadActiveTab()` 收敛为一个共享函数。
5. 缩短关闭链（C2）：`main.ts:432-441` 的「一个回调转调 5 个宿主」改为各宿主构造时自行订阅 tab 关闭事件；`main.ts:396` 单关与 `:524` 批关共用同一套「脏确认 + 释放 + 激活项修正」编排。
6. 重复注入（C3）：把 `getActiveTab` / `getView` / `showMessage` / `refreshStatus` 等高频 getter 收进一个组装对象，由 `main.ts` 一次性构造后展开进各 `*Deps`；**只减少重复传参，不改 36 个接口本身的字段**（接口合并放 B6 决策）。

**不改**：命令 id、IPC 调用顺序、保存 / 关闭的时序与提示。
**验收**：§4 全量 + E2E 中「保存保持原编码 / 关闭脏标签 / 导出补丁同名确认」用例 + 人工走查一次「改内容 → Ctrl+S → 关标签 → 重开」。
**成本**：~10 文件、~350 行、主包略降、定时器 0、审核 ~1.5 小时。
**风险 / 回退**：第 4–5 步动事件时序，是本批最高风险；两步各自独立 commit，并先给保存 / 关闭补一条针对性单测再改。回退按 commit 粒度。

#### B6 依赖方向 / 全局状态收口｜风险 中-高

**范围与证据**：C4、C5、C6、X9、X10、X12、S5。

**步骤**
1. 修 7 处反向 import（C4）：`panels/noticePanel.ts:14` 改由 Deps 注入通知数据；`services/updater.ts:10` 的对话框改注入（该文件已有 `showMessage` 参数化范式）；`ui/gitStatusItem.ts:14`、`panels/openEditorsView.ts:10`、`editor/searchPanel.ts:3` 改为类型 / 函数下沉到 core 或 ui；`config/settings.ts:2` 与 `editor/languages.ts` 的环（C5）把语言表的纯数据抽到 `src/core/`，两侧共同依赖。
2. 全局状态：`core/commands.ts:95,97` 的注册表改为装配期创建并注入（保留 `main.ts:1903` 单点注册），或明确在 `CODEBUDDY.md` 中把「唯一注册表」列为约定例外；`core/messageLog.ts` 与 `app/noticeStore.ts` 两套通知状态合并为一套，保留「最近消息 / 通知中心」两个视图。
3. 真源收口：X9 的三套配置态明确 `getConfig()` 为只读快照，其余为派生；X10 的 `splitRatio` 在确认旧会话反序列化兼容（读得到但忽略）后删除字段与写入。
4. 菜单四文件（S5）统一交互规则与关闭语义；`menuContent.ts:149,157` 硬编码键位先从注册表派生（B8 前的过渡）。
5. 更新 `CODEBUDDY.md:29-38` 的依赖方向表与已知越界说明，让文档与实际一致（已知越界 `store/tabs.ts → ui/dialogs.ts` 现已改为注入，见 `store/tabs.ts:1,167,170,603`）。

> 第 1 步的 config ↔ editor 环是结构改动，若影响面超出预估，单独拆成 B6a，不与状态合并同批。

**不改**：`config.json` 字段、命令键位、会话文件格式（除 X10 的只读兼容）。
**验收**：§4 全量 + 新增静态门禁或单测校验 import 方向（`scripts/` 已有门禁风格可复用）+ E2E 全量。
**成本**：~15 文件、~300 行、主包 0、定时器 0、审核 ~2 小时。
**风险 / 回退**：全局状态合并最容易产生隐蔽的初始化顺序问题；开工前先补「启动 → 打开配置 → 热更新」的针对性单测。每步独立 commit，失败按 commit 回退。

---

### 组 D：后端与命令体系

#### B7 Rust 公共 helper 与安全复核｜风险 中

**范围与证据**：R10–R13、B1–B6。

**步骤**
1. `blocking(label, f)` 统一 `spawn_blocking` + `map_err`，替换 49 处样板；保留 4 个特例语义：`format.rs:130`（`FormatFailure`）、`fetch.rs:365`（`??`）、`session.rs:217`（`unwrap_or_default`）、`config.rs:614`（`?` 链）。
2. `atomic_write_{bytes,json}` 统一，替换 `config.rs:709-714`、`workspace.rs:62-64`、`session.rs:274-278`、`diff.rs:364-366`；保留各自临时文件命名与 fsync 语义。
3. `read_text_auto(path, strict)` + `bom_kind` / eol helpers，替换 R-B3 六份；严格版必须保留 `search.rs:762` 与 `encoding.rs:173,193` 的行为。
4. `#[cfg(test)] test_support::TempPath` 统一 8–9 处临时目录辅助，保留 `batch.rs:169` 的 tag 区分避免并行冲突。
5. `write_guarded` RAII 包裹 `mark_writing` / `note_written`，替换 `file.rs:355,368`、`search.rs:667,669` 两份手工对，并补齐 R13 的 10+ 处写盘缺口；**先补「外部修改不被动吞掉」的单测再改**。
6. 安全复核：`fs.rs:21 list_dir` 的路径守卫缺口（B1）先核实调用来源与威胁模型，若确属越界则补 `ensure_root_scope` 并补单测；不作为机械重构处理。
7. `git.rs` / `diff.rs` 的 git 分管与三套 `Command::new("git")`：**本轮只抽公共构造 helper，不调整命令注册位置与 IPC**；模块划分重叠登记为遗留项，不在本轮搬迁。

**不改**：102 个命令的名称、参数、返回结构；`paths.rs` 守卫的判定语义。
**验收**：`cargo test --lib` + `cargo clippy` + `node scripts/check-ipc-contract.mjs` + `node scripts/scan-unsafe.mjs` + §4 全量。
**成本**：~12 个 `.rs`、~250 行、主包不适用、定时器 0、审核 ~2 小时。
**风险 / 回退**：第 5 步改变 watch 标记时机，可能引入「外部修改」误报 / 漏报，配单测 + 单独 commit；第 6 步若核实后需要改行为，单独一个 commit 并在验收记录里写明判据。

#### B8 命令表 / 键位单一真源 + 装配分域｜风险 高

**范围与证据**：C7、X7、X8、X12、X13、S2（收尾）。

**开工前置**：先补三条契约测试——① 菜单 / 右键 / 设置页展示的键位文案全部来自 `defaultKey`；② `docs/COMMANDS.md` 由 `gen:commands` 生成后无 diff；③ `MENU_LABELS` / `KIND_LABELS` 与 `core/commands.ts` 枚举一致。

**步骤**
1. `src/app/menuContent.ts:149,157` 等硬编码键位改为从注册表派生；`src/editor/keymap.ts:36` 的 CM6 手写键标注为 `fixed` 并由同一处生成说明。
2. README / MIGRATION / USER-GUIDE 的键位表改为生成或明确标为「只读快照」，并由 `gen:commands` + CI 校验；`docs/ACCEPTANCE.md` 里 48 处手写键位同步收口。
3. `main.ts:1895-1976` 的 73 行 ctx 字面量按功能域拆成 `buildFileCommands` / `buildGitCommands` / `buildViewCommands` 等子装配；`:1987-1992,1994,2004,2220-2240` 四处派生接线共用同一批构造结果。
4. `app/commandTable.ts`（1821 行）按域拆分数据文件，`CommandTableCtx`（`:47-112`，44 字段）切成 4–6 个域接口；`core/commands.ts:100 registerCommands` 已支持接收多批数组，无需改机制。
5. 收尾：删除 `:1895-1902` 重复注释，更新 `CODEBUDDY.md` 的装配层说明。

**不改**：命令 id、默认键、菜单分组的用户可见顺序、命令总数。
**验收**：§4 全量（含 `audit-discoverability.mjs` 的 C8「命令索引重生成后无 diff」）+ E2E 全量 + 人工抽查 3 条命令「菜单 / 命令面板 / 快捷键」三处文案一致。
**成本**：~8 文件、~500 行、主包略降、定时器 0、审核 ~2.5 小时。
**风险 / 回退**：装配分域会大范围改动 `main.ts` 接线，是本计划唯一可能超过单步 200 行 diff 的批次；拆成 5 个 commit，每步跑 `tsc + npm test`，任何一步失败只回退该步。

### 3.5 B5–B8 执行结果与偏差（2026-11-12）

| 批次 | 原计划 | 实际完成 | 未做与原因 |
| --- | --- | --- | --- |
| B5 app 层编排去重 | 导出写盘、导出补丁、保存链、关闭链、47 处重复注入 | `formatHost` 主流程合并为 `run(mode)`；`fileService.writeTextFile` 成为唯一 `save_file` 包装；`diffService.patchAction` 统一四处导出补丁（保留未保存比较的路径惰性求值） | **重复注入收进组装对象**：要改 36 个 `*Deps` 接口，且 `commandTable.test.ts` 的 Proxy 桩按字段名访问、改两级会静默失效；**关闭链拆成各宿主自订阅**：会隐式化 5 条顺序保证（`discardDraft` 仍是 fire-and-forget）；**session 三回调合并**：只省 2 行，收益不足 |
| B6 依赖方向 / 全局状态 | 7 处反向 import、两份通知状态合并、配置三套态、保存基线 | `ui/idle.ts` → `core/idle.ts`；Git 三类型 → `types/app.ts`（`gitView` 重新导出保持兼容）；`app/noticeStore.ts` → `store/noticeStore.ts`；`services/updater.ts` 改注入 `confirm` / `showError`；删 `session.splitRatio` 死字段（前端 + Rust） | **两份通知状态合并**：语义刻意分离（`messageLog` 不参与 ⚠ 角标）；**配置三套态收口**：`settings` 可变对象是编辑器热更新的前提，换 getter 会破坏原地刷新；**dirty 统一**：`main.ts` / `diffService` 的判定处在异步窗口内，改同步 `isClean` 会变行为；**`openEditorsView` 注入 tabStore**：`panels → store` 本身合理，单独改一处无意义 |
| B7 Rust 公共 helper | `blocking` 51 处、`atomic_write` 4 份、`read_text_auto` 6 份、`test_support`、watch 补齐、`list_dir` 守卫 | `commands/test_support.rs` 统一 8 份临时目录 / 文件辅助（保留各模块 tag 前缀，函数标 `#[cfg(test)]` 让 panic 扫描正确归类）；修掉 `large.rs` 未使用 import | **`atomic_write` 统一**：会新增 fsync 并改临时文件名，`write_draft` 约 1s 一次会变慢；**watch 补齐 10 处**：失败路径残留 `writing` 会永久吞掉真实外部修改；**`list_dir` 守卫**：套 `ensure_root_scope` 会破坏面包屑访问工作区外文件，需专门的 `ensure_list_scope`；**`blocking` 51 处**：错误文案用户可见，机械迁移风险/收益不匹配 |
| B8 命令表 / 键位真源 | 拆 `commandTable.ts`、切 `CommandTableCtx`、装配分域、键位派生 | 生成器提取并输出默认键位（`docs/COMMANDS.md` 成为全量键位真源）；README 键位段指向它并说明 `Mod` 含义；删除 `main.ts` 重复的两段注册表注释 | **拆 `commandTable.ts`**：`gen-command-index.mjs` 与 `audit-discoverability.mjs` 硬编码该路径，拆文件必须同步改门禁；**`CommandTableCtx` 62 字段切分**：要改几百处 `ctx.xxx` 引用；**装配分域**：收益是组织方式，diff 大而行为无变化；**`menuContent.ts` 硬编码键位**：需注入 `resolveKey`，扩散成本大于收益 |

---

## 4. 验收基线（每批结束全跑）

```bash
npm test                          # vitest + vitest.render.config.ts
npx tsc --noEmit
npm run build                     # 同时记录 dist/assets/*.js 合计字节
node scripts/check-ipc-contract.mjs
node scripts/scan-unsafe.mjs
node scripts/scan-innerhtml.mjs
node scripts/audit-discoverability.mjs
npm run gen:commands              # 重生成后 git diff 应为空
npm run typecheck:e2e
git diff --check

cd src-tauri                      # Windows PowerShell：cd 与下一条分开执行
cargo test --lib
cd ..

npm run build:e2e                 # 涉及 UI / app 层的批次（B3–B6、B8）必跑
npm run test:e2e
```

每批额外记录：断言数只增不减、IPC 命令数不变（当前 102）、`dist` 体积不增、新增常驻定时器 0、新增模块级可变状态 0。

---

## 5. 风险登记与待拍板决策

| 编号 | 决策点 | 建议 | 影响批次 |
| --- | --- | --- | --- |
| D-1 | 编码候选四套差异是否全部合并 | **不合并**：保留「一份基表 + 各视图子集」，大文件视图的 UTF-16 限制是真实约束 | B3 |
| D-2 | `session.splitRatio` 是否删除 | 先确认旧会话反序列化容错，再删；宁可留到 B6 末尾 | B2 / B6 |
| D-3 | `CODEBUDDY.md` / `README.md` 的版本编年史是否精简 | 涉及项目 guidance 文件，改前请用户确认；不在 B1 自动处理 | B1 |
| D-4 | `core/commands.ts` 的全局注册表是「合并到注入」还是「书面列为约定例外」 | 优先列为例外（改动面小、符合单一注册表语义），除非 B6 有更强理由 | B6 |
| D-5 | `fs.rs:21 list_dir` 路径守卫 | 先核实威胁模型再决定是否补；若属真实越界，按安全问题单独提交，不混进重构批次 | B7 |
| D-6 | B8 装配分域是否设定 `main.ts` 行数目标 | **不设硬指标**：按域拆完即可，避免为达标做无收益搬迁 | B8 |
| D-7 | 批次执行节奏 | 建议「一批一评审」；若用户希望连续执行，至少 B5 / B6 / B8 三批各自停下来确认 | 全程 |

---

## 6. 进度表

### 6.1 基线实测与 B1 验收（2026-11-12）

| 项目 | 实测 |
| --- | --- |
| `npm test` | 131 passed（node）+ 40 passed（渲染层） |
| `cargo test --lib` | 210 passed / 0 failed / 2 ignored |
| `npm run gen:commands` / 可发现性审计 | 134 条命令（固定 126 + 模板 8）；说明 134/134、索引 134/134、缺口 0 |
| IPC 契约 | 定义 102 / 注册 102 / 错误 0 |
| 静态门禁 | 生产 panic 点 0、DOM 注入面 0 |
| `dist/assets/*.js` 合计 | 10,043,671 字节（B1 后，后续批次以此为对比基线） |
| B1 改动规模 | 10 文件、+73 / -53 行 |
| 新增依赖 / 定时器 / 模块级可变状态 | 0 / 0 / 0 |
| 主包增量 | 0：`OUTCOME_LABELS` 只在 `core/commands.ts:34` 定义、无运行时 import，被 tree-shaking 移除；`MENU_LABELS` 原本已在 `:168` 使用，加 `export` 不改体积 |

B1 全量验收（§4 除 E2E）：`npm test` 0、`npx tsc --noEmit` 0、`npm run build` 0、`cargo test --lib` 0、四道门禁 0、`npm run typecheck:e2e` 0、`git diff --check` 0；`npm run gen:commands` 后 `docs/COMMANDS.md` 无 diff。E2E 按 §4 只在涉及 UI / app 层的批次跑，B1 未跑。改动未建分支、未提交，全部留在工作区供评审；用户已确认继续，视为评审通过。

### 6.2 B2a 执行记录（2026-11-12）

| 项目 | 实测 |
| --- | --- |
| 改动规模 | 11 个文件（8 个新增改动、1 个删除、3 个与 B1 重叠）；工作区累计 18 文件 +106 / -120 行 |
| 主包体积 | 10,043,520 字节，较 B1 基线 -151 字节（删掉 `occurrences.ts` 一层包装） |
| 新增依赖 / 定时器 / 模块级可变状态 | 0 / 0 / 0 |
| 验收 | `tsc --noEmit` 0、`npm test` 131+40、`npm run build` 0、`cargo test --lib` 210+2ignored、四道门禁 0、`typecheck:e2e` 0、`git diff --check` 0、`gen:commands` 后索引无 diff、lint 0 |
| 未跑 | E2E（按 §4，本批不涉及 UI 渲染路径） |

### 6.3 B2b 执行记录（2026-11-12）

| 项目 | 实测 |
| --- | --- |
| 改动规模 | 23 个文件（19 个本批新增、4 个与前批重叠），本批 +28 / -39 行；工作区累计 37 文件 +134 / -159 行 |
| 清理结果 | 关键词复查在 `src/` 与 `scripts/` 已无命中；命中项只剩 `docs/REFACTOR-PLAN.md` 台账、`docs/acceptance/*`、`CHANGELOG.md` 等历史记录 |
| 主包体积 | 10,043,520 字节，与 B2a 持平（注释不进包） |
| 新增依赖 / 定时器 / 模块级可变状态 | 0 / 0 / 0 |
| 验收 | `tsc --noEmit` 0、`npm test` 131+40、`npm run build` 0、`cargo test --lib` 210+2ignored、四道门禁 0、`typecheck:e2e` 0、`gen:commands` 后索引无 diff、`git diff --check` 0、lint 0 |
| 行尾处理 | `minimap.ts` / `idle.ts` 工作副本恢复 CRLF 后 `git diff --check` 无警告，两文件 diff 仍各为 1 行 |
| 未跑 | E2E（按 §4，本批为纯注释与数据文案改动） |

### 6.4 B3 执行记录（2026-11-12，开工核实后收敛）

| 项目 | 实测 |
| --- | --- |
| 改动规模 | 7 个文件（删除 1 个零调用函数 + 6 处 basename 替换），净 -9 行 |
| 主包体积 | 10,043,390 字节，较 B2b -130 字节 |
| 新增依赖 / 定时器 / 模块级可变状态 | 0 / 0 / -1（删掉 `session.ts` 的 `saveTimer`） |
| 验收 | `tsc --noEmit` 0、`npm test` 131+40、`npm run build` 0、`cargo test --lib` 210+2ignored、四道门禁 0、`typecheck:e2e` 0、`git diff --check` 0、`gen:commands` 后索引无 diff |
| 未跑 | E2E（按 §4，本批为等价替换与死代码清理） |
| 核实成果 | 原计划 5 步中 4 步经代码核实不成立，已在 §3 B3 登记为「不合并」，避免制造过度抽象或破坏双向契约 |

### 6.5 B4 执行记录（2026-11-12，开工核实后收敛）

| 项目 | 实测 |
| --- | --- |
| 改动规模 | 9 个文件（5 个实现 + 1 个门禁正则 + 2 个渲染层测试桩 + `main.ts`/`largeFileHost.ts` 注入），~60 行 |
| 主包体积 | 10,043,312 字节，较 B3 -78 字节 |
| 新增依赖 / 定时器 / 模块级可变状态 | 0 / 0 / 0 |
| 验收 | `tsc --noEmit` 0、`npm test` 131+40、`npm run build` 0、`cargo test --lib` 210+2ignored、四道门禁 0（可发现性仍 17 接入 / 0 缺口）、`typecheck:e2e` 0、`gen:commands` 后索引无 diff、`git diff --check` 0 |
| E2E | `npm run build:e2e` + `npm run test:e2e`：26 passed（46s） |
| 核实成果 | 8 处直调中 3 处经核实为正当例外（高频保存、带决策按钮、带 retry），已登记不接入；去重键 6 种语义不合并 |

### 6.6 B5–B8 执行记录（2026-11-12）

| 批次 | 改动规模 | 主包体积 | 关键验收 |
| --- | --- | --- | --- |
| B5 | 4 文件（formatHost / fileService / previewHost / diffService），净减约 60 行 | 10,042,818 字节（-494） | tsc / test / build / 四道门禁全绿 |
| B6 | 约 20 文件（2 个模块迁移 + 1 个新增 + 批量 import 调整 + 前端/Rust 死字段），净减约 20 行 | 10,042,846 字节（+28） | tsc / test / build / cargo 210+2ignored / 门禁全绿；E2E 26 条 |
| B7 | 9 个 `.rs`（新增 `test_support` + 8 处薄包装 + 2 处删字段 + 1 处删 import），净减约 45 行 | 不适用 | cargo 210+2ignored 且 0 warning；`scan-unsafe` 生产 panic 点 0（测试 376） |
| B8 | 4 文件（生成器 / 生成物 / README / `main.ts` 注释） | 10,044,194 字节（+1,348） | `gen:commands` 后审计 134/134；E2E 26 条 |

> B8 的 +1,348 字节来自 `docs/COMMANDS.md` 新增的 46 行「默认键位」：该文档经 `?raw` 进入**懒加载的帮助 chunk**，不进首屏；首屏体积未变。

### 6.7 B9 遗留修复记录（2026-11-13）

| 项目 | 改动 | 验收 |
| --- | --- | --- |
| `list_dir` 只读守卫 | `paths.rs` 新增 `ensure_list_scope`（工作区内 / 已登记路径的祖先 / 所在目录子树）；`fs.rs::list_dir` 接入；`cli.rs::take_pending_workspace` 取走命令行目录时立即 `add_root`；`main.ts` 统一 `openWorkspacePath` 先登记再列目录（对话框 / 拖放 / 最近工作区 / 命令行四条入口） | cargo 211 passed（新增 1 条守卫单测）；E2E 26 条 |
| 右键菜单键位真源 | `menuContent.ts` 的格式化 / 运行 / 在终端运行 / 选中同词 5 处硬编码改为 `shortcutOf(命令 id)`，用户改绑后菜单同步 | tsc / test / build 全绿 |
| 通知状态测试归位 | `app/noticeStore.test.ts` → `store/noticeStore.test.ts` | `npm test` 131+40 |
| 注释纠偏 | `ui/gitStatusItem.ts` 的依赖说明改为「Git 类型来自 types/app」 | lint 0 |

> 首轮 E2E 暴露了守卫与「工作区登记时机」的竞态：命令行目录在 `save_workspace`（300ms 防抖）之前列目录会被拒，
> `fileTree` 显示错误后不会自愈。修复是四条打开入口统一「先 `register_paths` 再 `setRoot`」，并在
> `take_pending_workspace` 里 `add_root`。这是守卫上线必须配套的改动，不是原计划遗漏。

| 批次 | 分支 | 状态 | 基线结果 | 体积前后 | 评审 |
| --- | --- | --- | --- | --- | --- |
| B1 | 未建分支（改动在工作区） | 已完成 | 全绿（见 6.1） | 10,043,671 字节，增量 0 | 已通过 |
| B2a | 未建分支（改动在工作区） | 已完成 | 全绿（见 6.2） | 10,043,520 字节，-151 字节 | 已通过 |
| B2b | 未建分支（改动在工作区） | 已完成 | 全绿（见 6.3） | 10,043,520 字节，增量 0 | 已通过 |
| B3 | 未建分支（改动在工作区） | 已完成 | 全绿（见 6.4） | 10,043,390 字节，-130 字节 | 已通过 |
| B4 | 未建分支（改动在工作区） | 已完成 | 全绿（见 6.5，含 E2E 26 条） | 10,043,312 字节，-78 字节 | 已通过 |
| B5 | 未建分支（改动在工作区） | 已完成 | 全绿（见 6.6） | 10,042,818 字节，-494 字节 | 已通过 |
| B6 | 未建分支（改动在工作区） | 已完成 | 全绿（见 6.6） | 10,042,846 字节，+28 字节 | 已通过 |
| B7 | 未建分支（改动在工作区） | 已完成 | 全绿（见 6.6） | 不适用（Rust） | 已通过 |
| B8 | 未建分支（改动在工作区） | 已完成 | 全绿（见 6.6） | 10,044,194 字节，+1,348（懒加载文档） | 已通过 |
| B9 | 未建分支（改动在工作区） | 已完成 | 全绿（见 6.7，含 E2E 26 条） | 10,044,310 字节，+116 | 已通过 |

---

## 附录 A 问题台账

> B5–B8 的实际处置以 §3.5 为准：下表的「批次」是原计划归属，状态列只更新了能明确判定的条目；
> 未做的项不是遗漏，而是核实后判定「合并会改变行为 / 破坏契约 / 收益低于风险」。

| ID | 一句话 | 证据 | 批次 | 状态 |
| --- | --- | --- | --- | --- |
| R1 | 模态骨架 4 份 + 20 处 Esc 各自实现 | `ui/dialogs.ts:52,113,254,314` | B4 | 未做：Esc 统一牵动 20+ 面板与 `isModalOpen()` 全局拦截，拆出单独评估 |
| R2 | 空态 / `?` 帮助 10+ 份 | `panels/searchView.ts:306` 等 | B3 | 经核实不合并（见 §3 B3） |
| R3 | 绕过 `resultCenter` 直调结果卡 | `app/resultCenter.ts:13`、`previewHost.ts:319` | B4 | 已完成（5 处接入；3 处经核实豁免） |
| R4 | 导出写盘 3 份同构 | `previewHost.ts:327-372`、`fileService.ts:411` | B5 | 待办 |
| R5 | 格式化两份逐行相同 | `formatHost.ts:39-121` | B5 | 待办 |
| R6 | 防抖写盘 5 份 | `services/session.ts:68` 等 | B3 | 经核实不合并（见 §3 B3） |
| R7 | 编码 / 换行常量 4 套 | `fileService.ts:76` 等 | B3 | 经核实不合并（见 §3 B3） |
| R8 | 路径工具被绕过 | `core/paths.ts:21,40,46` | B3 | 已完成（6 处 basename）；其余语义不同不合并 |
| R9 | 失败反馈三件套 6 份 | `formatHost.ts:67-76,104-113` | B4 | 已完成（formatHost 两份合并）；其余为不同 kind / 去重键，按原样保留 |
| R10 | Rust `spawn_blocking` 样板 49 处 | `file.rs:173`、`git.rs:282` | B7 | 待办 |
| R11 | Rust 原子写 4 份 | `file.rs:270`、`config.rs:709` | B7 | 待办 |
| R12 | Rust 路径守卫样板 23 处 | `git.rs:353`、`fs.rs:63` | B7 | 待办 |
| R13 | watch 写标记 10+ 处缺口 | `watch.rs:190,200` | B7 | 待办 |
| R14 | 面板小按钮 / backdrop CSS 重复 | `status.css:583,888`、`git.css:772` | B3 | 经核实不合并（见 §3 B3） |
| R15 | 导出补丁四处 action 组装 | `diffService.ts:35,278,420,495,544` | B5 | 待办 |
| R16 | IPC 裸调绕过 `services/` | `diagnostics.ts:37`、`fileService.ts:430` | B5 | 待办 |
| R17 | tab 单关 / 批关双编排 | `main.ts:396,524` | B5 | 待办 |
| R18 | Git 命令双轨（`GitHost` / 裸调） | `gitHost.ts:70-271`、`main.ts:857,928` | B6 | 待办 |
| R19 | 通知 / toast 三通道去重键互不相通 | `statusBar.ts:234,270`、`noticeStore.ts:46` | B4 | 经核实不合并（去重键 6 种语义：tabId / 操作名 / 路径 / 静态单例 / 标题 / 无键） |
| C1 | 保存链 8 文件 | `main.ts:2229` → `ui/resultCard.ts` | B5 | 待办 |
| C2 | 关闭链集中转发 5 个宿主 | `main.ts:432-441` | B5 | 待办 |
| C3 | 同一 getter 重复注入 14–17 次 | `main.ts:180,290,755,1920` | B5 | 待办 |
| C4 | 7 处反向 import | `panels/noticePanel.ts:14` 等 | B6 | 待办 |
| C5 | config ↔ editor 包级环 | `config/settings.ts:2`、`editor/setup.ts:15` | B6 | 待办 |
| C6 | core 层全局可变状态 + 第二套通知状态 | `core/commands.ts:95`、`app/noticeStore.ts:29` | B6 | 待办 |
| C7 | 装配层 2440 行 + 1821 行命令表 | `main.ts:1903-1976`、`commandTable.ts:47-112` | B8 | 待办 |
| X1 | MIGRATION 键位假真源 + 坏链 | `docs/MIGRATION.md:3` | B1 | 已完成 |
| X2 | MIGRATION 项目级覆盖写「没有」 | `docs/MIGRATION.md:28` | B1 | 已完成 |
| X3 | MIGRATION 多终端写「做不到」 | `docs/MIGRATION.md:48` | B1 | 已完成 |
| X4 | 语言数量同页矛盾 | `docs/MIGRATION.md:31,44` | B1 | 已完成 |
| X5 | 测试数量四处不一致 | `README.md:272,275` 等 | B1 | 已完成 |
| X6 | 命令总数在其他文档复述为 133 | `docs/ACCEPTANCE.md` A-11、`CODEBUDDY.md:80` | B1 / D-3 | 已完成（guidance 待拍板） |
| X7 | 四处自称唯一来源 | `core/commands.ts:2` 等 | B1 / B8 | 已完成（B8 收尾） |
| X8 | 菜单 / 产物标签 / 测试菜单 id 三处手写 | `scripts/gen-command-index.mjs:137,146`、`commandTable.test.ts:5` | B1 | 已完成 |
| X9 | 配置三套生效值 + 两处默认值 | `config/settings.ts:355,357,359` | B6 | 待办 |
| X10 | `session.splitRatio` 僵尸字段 | `services/session.ts:30` | B6 | 已完成（前端 + Rust 同步删除） |
| X11 | 代际令牌 6 套 | `app/tabSwitcher.ts:41` 等 | B3 / B5 | 经核实不合并（见 §3 B3） |
| X12 | 键位说明 ≥5 处手写 | `README.md:499`、`editor/keymap.ts:36` | B1 / B8 | 部分完成（B8 收尾） |
| X13 | 右键菜单硬编码键位 | `app/menuContent.ts:149,157` | B6 / B8 | 待办 |
| X14 | 注释与行为不符 | `core/commands.ts:11`、`helpDialog.ts:5` | B2a | 已完成 |
| X15 | 保存基线多处自行判 dirty | `store/tabs.ts:65,79,846`、`main.ts` 29 处 | B6 | 待办 |
| X16 | 「产物统一走结果卡」与实际不符 | `CODEBUDDY.md:81`、`fileService.ts:464` | B4 | 待办 |
| S1 | `occurrences.ts` 单调用中间层 | `editor/occurrences.ts:8` | B2a | 已完成（文件已删） |
| S2 | keybindings 三层转发 / 僵尸导出 | `config/keybindings.ts:20-38` | B2a | 已完成 |
| S3 | `fetchHost.open()` 只为吞 Promise | `app/fetchHost.ts:30` | B2a | 已完成 |
| S4 | `helpId` 单用途字段 | `ui/resultCard.ts:31` | B4 | 待办 |
| S5 | 弹出菜单拆 4 文件且规则不一 | `ui/editorMenu.ts` 等 | B6 | 待办 |
| S6 | 历史叙述注释 / 阶段编号（核实后 33 处） | `core/errors.ts:7` 等 | B2b | 已完成 |
| S7 | `pad2` / `firstLine` 重复实现 | `panels/noticePanel.ts:24`、`app/symbolHost.ts:78` | B2a | 已完成 |
| S8 | `legacyLanguages` 一名三称 | `config/settings.ts:336` | B6（契约字段） | 待办 |
| S9 | 版本编年史与「README 为真源」冲突 | `CODEBUDDY.md:64-93` | B1（待 D-3） | 待拍板 |
| B1 | `list_dir` 未过路径守卫 | `src-tauri/src/commands/fs.rs:21` | B7 | 待核实 |
| B2 | git 被 `git.rs` / `diff.rs` 分管 | `git.rs:48,150`、`diff.rs:293` | B7 | 待办 |
| B3 | 编码读取六份 | `file.rs:76-96` 等 | B7 | 待办 |
| B4 | 可回滚快照两套机制 | `search.rs:186`、`git.rs:611` | B7（只抽 helper） | 待办 |
| B5 | 调度失败文案 8 种 | `file.rs:173`、`git.rs:282` | B7 | 待办 |
| B6 | 测试 temp 辅助 8–9 份 | `batch.rs:167` 等 | B7 | 待办 |

---

## 附录 B 审核入口（按文件聚合）

| 想审核什么 | 先看哪里 |
| --- | --- |
| 装配总貌 | `src/main.ts:180-1976`、`src/app/commandTable.ts:47-160` |
| 保存 / 关闭链路 | `src/app/fileService.ts:228-461`、`src/app/sessionHost.ts:421-729`、`src/store/tabs.ts:575-846` |
| 反馈出口 | `src/app/resultCenter.ts`、`src/ui/resultCard.ts`、`src/app/noticeStore.ts`、`src/ui/statusBar.ts:234-300` |
| 格式化 | `src/app/formatHost.ts`、`src/editor/format.ts` |
| 导出 / 差异 | `src/app/previewHost.ts:315-374`、`src/app/diffService.ts:35-544` |
| 配置与键位 | `src/config/settings.ts:255-481`、`src/config/keybindings.ts`、`src/core/commands.ts` |
| Rust 命令 | `src-tauri/src/commands/paths.rs`、`watch.rs:190-200`、`file.rs:270`、`git.rs:48-87` |
| 门禁与生成物 | `scripts/*.mjs`、`docs/COMMANDS.md`、`docs/ACCEPTANCE.md` |
