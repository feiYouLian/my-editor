# 可发现性与产品化优化：执行记录（v0.8.0）

- 基线：`v0.7.1-baseline`（HEAD `78bf390`，比 tag `v0.7.1` 多 2 个收口修复提交）
- 工作分支：`dev/0.8.0`
- 执行日期：2026-11-06
- 依据：《my-editor 可发现性与产品化优化实施清单》

## 1. 与清单的偏差（以源码为准）

| 清单写法 | 实际 | 处理 |
| --- | --- | --- |
| 125 条命令 | 字面量 125 条 + `text.case.*` 模板展开 8 条 = **133** 条 | 审计按 133 条计数，字面量仍为 125 处（S3 补写在 `commandTable.ts` 内完成） |
| 基线 `0bdcc9d` | HEAD `78bf390` | baseline tag 打在 HEAD，清单里的行号已按当前源码复核 |
| `gitHistoryPanel.ts:185` | 空仓库文案在 184 行 | 按实际行号修改 |
| 25 个产物入口全部接结果卡 | 插件扫描到 24 个（15 自动 + 9 手工），其中 7 个属「保存确认 / 配置写盘 / 面板内结果清单」豁免 | 非豁免 17 个全部接入；豁免项在基线里写明理由 |
| `P/G/R/T` 四类 58 条关键词 | 未定义，按批 1（Git 11）+ 批 2（产物 16）+ 批 3（运行 6）+ 批 5（工具文本 25）= 58 推定 | 已写进 `KEYWORD_REQUIRED` 常量 |

## 2. 交付物与落点

| # | 交付物 | 落点 |
| --- | --- | --- |
| B1 | 可发现性审计脚本 | `scripts/audit-discoverability.mjs`（C0–C7 七类判据，TypeScript AST 读命令表） |
| B2 | 审计基线 | `scripts/discoverability-baseline.json`（确定性缺口全部归零，只剩「待补」不再存在） |
| B3 | 命令模型字段 | `src/core/commands.ts` 的 `description` / `keywords` / `outcome`（含 `OutcomeKind`） |
| B4 | 133 条命令元数据 | `src/app/commandTable.ts`（每条命令多行对象，说明在 `section` 之后） |
| B5 | 面板两行渲染 + 详情区 + 搜索扩字段 | `src/panels/commandPalette.ts` 的 `commandScore()` 与 `.palette-item-desc` / `.palette-detail` |
| B6 | 结果卡组件 | `src/ui/resultCard.ts`（成功三段 / 失败三段，8 秒收起、悬停暂停、最多 3 张） |
| B7 | 结果卡出口 + 覆盖确认 | `src/app/resultCenter.ts`（卡片 + 通知中心留底）、`src-tauri/src/commands/diff.rs` 的 `export_patch` |
| B8 | 四处导出补丁标签 | `src/app/diffService.ts` 的 `PATCH_SOURCES`、`src/panels/diffPanel.ts` 取来源标签 |
| B9 | Git 历史面板 | `src/panels/gitHistoryPanel.ts`（范围说明 / 空态 / 失败态 / 文件数 / 复制 / 导出） |
| B10 | 面板 `?` 入口 | Git 历史 / 差异 / 大文件 / 格式转换 / 搜索 / 设置，均调到用户指南对应章节 |
| B11 | 空态升级 | Git 历史 / 命令面板 / 书签 / 文件树过滤 |
| B12 | 测试断言 | 渲染层 18 → 26（`commandPalette` 5 条、`gitHistoryPanel` 5 条）；审计脚本 C7 三条查询 |
| B13 | 新手走查 | 本文件第 5 节（待桌面会话执行） |
| B14 | 文档同步 | `CHANGELOG.md`、`docs/USER-GUIDE.md`（新增 4.12）、`docs/ACCEPTANCE.md`（A-11 / B-4 / B-5 / C.17） |

## 3. 验收命令执行结果

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 0 错误 |
| `npm test` | 131 通过（node）/ 26 通过（渲染层） |
| `cd src-tauri && cargo test --lib` | 205 passed / 2 ignored |
| `node scripts/check-ipc-contract.mjs` | 命令定义 102 = 注册 102，错误 0 |
| `node scripts/scan-unsafe.mjs` | 生产代码 panic 点 0 |
| `node scripts/scan-innerhtml.mjs` | 当前 0 / 基线 0 |
| `node scripts/audit-discoverability.mjs` | 缺口合计 0，退出码 0（含 C8 命令索引 133/133） |
| `npm run build` | 构建通过 |
| `git diff --check` | 无输出 |
| `npx playwright test` | 24 passed（第二轮新增 4 条后） |

审计脚本输出（v0.8.0）：

```
命令总数 133（固定 125 + 模板展开 8）/ hidden 22 / 已写说明 133 / 缺说明 0
关键词覆盖 58 / 应覆盖 58
产物类入口 24（自动 15 + 手工 9，豁免 7）/ 已接入结果卡 17
暗入口登记 40 / 应登记 40
空态 4 处 / 含下一步 4
同名异源 0
缺口合计 0
```

## 4. 护栏演进（对照清单 6.4）

| 判据 | S1 建立时 | 收口时 |
| --- | --- | --- |
| C1 说明覆盖 | 133 条缺口记入基线 | 缺口集合清空 → 缺 1 条即失败 |
| C2 关键词覆盖 | 58 条缺口记入基线 | 缺口集合清空 → 硬判据 |
| C3 产物接入 | 24 个入口登记，0 个接入 | 17 个接入 + 7 个豁免（附理由） |
| C4 暗入口 | 40 条未声明 | 40 条全部声明 `outcome.entry` |
| C5 空态 | 4 条登记，1 条含下一步 | 4 条全部含下一步动词 |
| C6 同名异源 | 「导出补丁」×4、「打开目录」、「打开文件」 | 0（导出补丁四处标签互异；通用词进白名单） |
| C7 搜索可达性 | 新增 | 「发给别人」「git apply」「查看改动记录」各命中并列最高分命令 |

S1 出口判据已实测：临时插入一条 `{ id: "audit.probe", title: "审计探针" }`，脚本报
`audit.probe 缺 description` + `缺 outcome.entry`，退出码 1；删除后恢复 0。

## 5. 新手走查（待执行）

| # | 任务 | 改前 | 改后 | 卡点 |
| --- | --- | --- | --- | --- |
| T1 | 把这次改动发给同事 | 未测 | 未测 | — |
| T2 | 看看上周谁改了当前文件 | 未测 | 未测 | — |
| T3 | 找出 GBK 乱码文件并转 UTF-8 | 未测 | 未测 | — |
| T4 | 跑一下当前脚本并找到输出 | 未测 | 未测 | — |
| T5 | 把两个文件的差异留个底 | 未测 | 未测 | — |

> 需带桌面会话的环境执行；按清单判据（停顿 > 5 秒或 ≥3 次探索记 1 个卡点，≤1 为通过）。
> 未执行前，C.17 在 `docs/ACCEPTANCE.md` 中保持 `☐`。

## 6. 已知残留

1. `file.save` / `file.saveAll` 的 `outcome.kind` 为 `none`：就地写回不产生产物路径，不弹结果卡（避免每次 Ctrl+S 都打断）。清单把它算在 A 组，这里按语义收敛。
2. `convert.*` 六条转换命令写回编辑器，同样是 `none`；面板内（`convertPanel`）已有左右预览，不另弹卡。
3. `tools.batchEncoding` 的结果清单已逐条列在面板内，标为豁免。
4. 面板 `?` 按**章节标题**定位（`helpDialog` 的 `anchor` 参数），不是 HTML id：`docs/USER-GUIDE.md` 的标题因此不能随意改名，改名会让「?」跳到页首。已由 `scrollToHeading` 的前缀优先匹配兜住命令 id 的子串冲突（`file.save` vs `file.saveAs`）。

## 7. 第二轮：未完成项收口（同日）

| 项 | 处理 | 证据 |
| --- | --- | --- |
| 命令索引 | 新增 `scripts/gen-command-index.mjs` → `docs/COMMANDS.md`（133 条，按菜单分组，含说明 / 结果去向 / 可搜词 / 入口）；`docs/COMMANDS.md` 与命令表的一致性由审计 C8 判据把关（硬判据，未重生成即失败） | `npm run gen:commands`，审计输出「命令索引 133/133」 |
| 逐条深链 | `helpDialog` 新增 `commands` 主题；命令面板详情区加「查看完整说明」+ `Ctrl+Enter`；结果卡新增 `helpId`（`reportResult` 转成 `learnMore`），四处导出补丁 / 另存为 / 另存编码 / 剪贴板图片 / 网页抓取已接入 | `src/panels/helpDialog.ts`、`commandPalette.ts`、`src/app/resultCenter.ts` |
| E2E 补齐 | 新增 `e2e/discoverability.spec.ts` 4 条：用途搜索命中与两行渲染、`Ctrl+Enter` 打开命令索引并定位、侧栏「查看提交历史」入口 + 范围说明 + 复制/导出两个动作、导出补丁同名先确认且「换个名字」不丢旧文件 | `npx playwright test`（20 → 24 条） |
| 无障碍补强 | 历史面板三个图标按钮与差异面板关闭按钮补 `aria-label`（图标按钮此前只有 `title`，读屏与 E2E 都取不到名字） | `gitHistoryPanel.ts`、`diffPanel.ts` |

> 新手走查仍为人工项：E2E 覆盖了「入口是否可见 / 说明是否存在 / 动作是否可触发」，
> 但「停下来想了 5 秒」这类判据只能在桌面会话里观察，C.17 保持 `☐`。

## 8. 第三轮：代码审查发现收口（2026-11-07）

审查报告《my-editor v0.8.0 代码审查报告》提了 1 个 P0 产品化缺口、1 个人工验收缺口、
2 个 P1 判据缺口、3 个 P2 加固项。本轮处理除人工走查外的全部项：

| # | 发现 | 处理 | 落点 |
| --- | --- | --- | --- |
| P0-1 | 「发给别人」「git apply」四条 diff 命令并列最高分，意图没收敛 | 三条非工作区命令的关键词改成各自来源（未保存补丁 / 两个文件差异 / 暂存区补丁），三个口语词只留在 `diff.gitHead`；C7 判据由「期望命令在并列集合里」收紧为「最高分唯一且等于期望」 | `src/app/commandTable.ts:389/402/1547`、`scripts/audit-discoverability.mjs` 的 `SEARCH_PROBES` |
| P1-1 | C3 结果卡接入是文件级校验，同文件删一处发现不了 | 基线每条登记增加 `callSite`（写法「函数名#结果卡 title 片段」），审计用 AST 定位函数体并匹配 title，同一函数里的「已存在 / 已导出 / 失败」也能区分 | `scripts/discoverability-baseline.json`（17 条）、`audit-discoverability.mjs` 的 `resultCardAt()` |
| P1-2 | 审计与面板是两份近似评分，权重一改就漂移 | 打分抽到 `src/core/commandScore.ts`（纯函数、无 DOM），面板 import 后转出；审计用 `ts.transpileModule` 编译到临时目录 require，两边同一份实现 | `src/core/commandScore.ts`、`src/panels/commandPalette.ts`、`audit-discoverability.mjs` 的 `loadCoreFunction()` |
| P2-1 | C8 只校验索引的 id 集合，正文手改不管 | CI 新增 `npm run gen:commands && git diff --ignore-cr-at-eol --exit-code -- docs/COMMANDS.md` | `.github/workflows/ci.yml` |
| P2-2 | 说明过短只提示、不阻断 | `<12 字` 纳入 errors（硬失败），同时删除只服务该提示的 `--list-short` 开关 | `audit-discoverability.mjs` |

反向注入验证（每条注入后恢复源码，重跑正向缺口 0）：

| 注入 | 判据输出 | 退出码 |
| --- | --- | --- |
| 去掉 `diff.gitHead` 的「发给别人」关键词 | `搜索「发给别人」应唯一命中 diff.gitHead（当前最高：无）` | 1 |
| 删掉 `exportPatch` 里 title 为「已导出统一 diff 补丁」的 `reportResult` | 5 条 `结果卡调用点失效`（按钮 1 + manual 4） | 1 |
| 把 `diff.unsaved` 说明改成 7 字 | `说明过短（<12 字）` | 1 |
| 手改 `COMMANDS.md` 正文后重生成 | `git diff --exit-code` 非零（生成结果与提交内容不一致） | 1 |

结果固化：渲染层新增 1 条「唯一最高分是 `diff.gitHead`」用例（现 29 条全绿），E2E 第一个用例补
「搜用途词后首位是与 Git HEAD、列表里不再有第二条『比较：』」断言。

本轮验证范围（`npm test` 131 + 29、`tsc --noEmit`、`npm run build`、`cargo test --lib` 205、
三个既有门禁 + 审计缺口 0、`typecheck:e2e`、`git diff --check`、
`npm run build:e2e && npx playwright test` 24 条全绿）。

E2E 首次重跑全挂，根因是 `src-tauri/target/debug/my-editor.exe` 被 `tauri dev` 的产物覆盖：
页面去连 `http://localhost:5173`，而 Playwright 配置不启 dev server，`#ws-name` 自然找不到。
重新执行 `npm run build:e2e`（内置 `dist` 资源）后恢复。**同一路径下 `tauri dev` 与
`tauri build --debug` 会互相覆盖**，跑 E2E 前不要用 `npm run tauri dev` 编过同一个 profile。

P0-2 **未处理**：五个任务的桌面会话走查仍需人工执行，第 5 节与 `docs/ACCEPTANCE.md` 的 C.17
保持「未测 / `☐`」。本轮不伪造走查数据；按审查报告口径，这一格填完才算 `v0.8.0` 收口。
