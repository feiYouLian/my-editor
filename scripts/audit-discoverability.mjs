#!/usr/bin/env node
/**
 * 可发现性审计：把「用户能否看懂并找到功能」拆成机器可判定的集合比较。
 *
 * 判据：
 *   C0 字段合法：命令对象的顶层键必须在 CommandDef 接口里声明（防 descriptions 这类拼写错）
 *   C1 说明覆盖：每条命令（含 hidden）必须有 description
 *   C2 关键词覆盖：Git / 产物 / 运行 / 工具文本 四类共 58 条必须有 keywords
 *   C3 产物动作：产物类命令与按钮必须在 productActions 登记，登记的 resultCard 必须指向真实调用点
 *   C4 暗入口：无 menu 且非 hidden 的命令必须在 outcome.entry 里声明入口位置
 *   C5 空态：登记的空态文案必须含「下一步」动词
 *   C6 同名异源：同一动作 label 出现在多个来源时必须用 title 区分
 *
 * 基线 scripts/discoverability-baseline.json 记录「当前已知缺口」：
 *   - 新增缺口（不在基线里）立即失败——新功能不能绕过说明
 *   - 基线内缺口只提示——允许按批次收敛
 *   - --update-baseline 用当前扫描结果重写缺口集合（CI 不传；更新前先确认是收敛不是新增）
 *
 * 只读扫描，不改代码；有新增缺口时退出码 1。
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const COMMAND_TABLE = join(SRC, "app", "commandTable.ts");
const COMMAND_DEF = join(SRC, "core", "commands.ts");
const BASELINE_FILE = join(ROOT, "scripts", "discoverability-baseline.json");
const COMMAND_INDEX = join(ROOT, "docs", "COMMANDS.md");

/** C2 必填关键词的四类命令（Git 11 + 产物 16 + 运行 6 + 工具文本 25 = 58） */
const KEYWORD_REQUIRED = [
  // Git / 差异
  "diff.pickFile",
  "view.sidebarGit",
  "git.pull",
  "git.push",
  "git.pickBranch",
  "git.showHistory",
  "diff.gitHead",
  "diff.gitIndex",
  "git.blameDialog",
  "git.inlineBlame",
  "git.toggleReadOnly",
  // 产物 / 写盘
  "file.save",
  "file.saveAs",
  "file.saveAll",
  "file.saveAsEncoding",
  "file.exportMarkdown",
  "fetch.open",
  "help.exportDiagnostics",
  "tools.batchEncoding",
  "convert.open",
  "convert.json2yaml",
  "convert.yaml2json",
  "convert.properties2yaml",
  "convert.yaml2properties",
  "convert.json2java",
  "convert.java2json",
  "insert.clipboardImage",
  // 运行
  "code.run",
  "terminal.toggle",
  "code.runInTerminal",
  "code.runCurlInTerminal",
  "output.show",
  "code.stop",
  // 工具 / 文本
  "edit.sortLinesAsc",
  "edit.sortLinesDesc",
  "edit.sortLinesAscNumeric",
  "edit.dedupeLines",
  "edit.reverseLines",
  "edit.removeEmptyLines",
  "edit.trimTrailing",
  "edit.tabsToSpaces",
  "edit.spacesToTabs",
  "tools.regex",
  "md.bold",
  "md.italic",
  "md.highlight",
  "md.table",
  "view.docStats",
  "edit.deleteLine",
  "edit.moveLineUp",
  "edit.moveLineDown",
  "text.json.pretty",
  "text.json.minify",
  "view.structuredCsv",
  "view.structuredJson",
  "encoding.detectMojibake",
  "tools.cron",
  "run.curlScript",
];

/**
 * C3 的产物类命令按 outcome.kind === "file" 判定：
 * 只有「生成文件到某个路径」的动作才需要结果卡；就地写回的保存、写回编辑器的转换不算。
 */

/** C7 搜索可达性：用户口语必须能命中对应命令，且并列最高分 */
const SEARCH_PROBES = [
  { query: "发给别人", expect: "diff.gitHead" },
  { query: "git apply", expect: "diff.gitHead" },
  { query: "查看改动记录", expect: "git.showHistory" },
];

/** 空态「下一步」动词 */
const NEXT_STEP_VERBS = ["打开", "选择", "先", "前往", "配置"];

/** 产物类动作词 */
const PRODUCT_VERBS = ["导出", "生成", "转换", "保存", "写入"];

/** 通用动作词：同名同义，不构成「同名异源」 */
const GENERIC_LABELS = new Set([
  "保存",
  "取消",
  "确定",
  "关闭",
  "删除",
  "重置",
  "打开",
  "复制",
  "粘贴",
  "刷新",
  "新建",
  "应用",
  "清空",
  "重命名",
  "保存并关闭",
  "不保存",
  "全部保存",
  "关闭标签",
  "全部关闭",
  "打开目录",
  "打开文件",
]);

/**
 * 不要求结果卡的产物类入口：保存流程的确认按钮（产物就是用户选的路径，
 * 结果卡只会重复对话框已经说清的信息）。
 */
const EXEMPT = [
  { file: "src/ui/dialogs.ts", reason: "保存确认对话框" },
  { file: "src/panels/saveEncoding.ts", reason: "另存为编码对话框" },
  { file: "src/panels/runConfig.ts", reason: "运行器配置写盘" },
  { command: "tools.batchEncoding", reason: "结果清单在面板内逐条展示" },
];

const errors = [];
const notes = [];

function walk(dir, exts) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

function rel(p) {
  return relative(ROOT, p).split(sep).join("/");
}

function parseTs(file) {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return {
    text,
    sf,
    lineOf: (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
  };
}

function prop(obj, name) {
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const n = p.name;
    const key = ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) ? n.text : null;
    if (key === name) return p.initializer;
  }
  return undefined;
}

function str(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/** 字符串数组；含非字面量元素时返回 null（视为未完整声明） */
function strArray(node) {
  if (!node || !ts.isArrayLiteralExpression(node)) return null;
  const out = [];
  for (const el of node.elements) {
    const v = str(el);
    if (v == null) return null;
    out.push(v);
  }
  return out;
}

function outcomeOf(obj) {
  const node = prop(obj, "outcome");
  if (!node || !ts.isObjectLiteralExpression(node)) return null;
  return {
    kind: str(prop(node, "kind")),
    hint: str(prop(node, "hint")),
    entry: str(prop(node, "entry")),
  };
}

function keysOf(obj) {
  return obj.properties
    .filter((p) => ts.isPropertyAssignment(p))
    .map((p) => {
      const n = p.name;
      return ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : null;
    })
    .filter(Boolean);
}

/** CommandDef 接口声明的字段集合 */
function parseCommandDefFields() {
  const { sf } = parseTs(COMMAND_DEF);
  let fields = null;
  const visit = (node) => {
    if (fields) return;
    if (ts.isInterfaceDeclaration(node) && node.name.text === "CommandDef") {
      fields = node.members
        .map((m) => (ts.isPropertySignature(m) && ts.isIdentifier(m.name) ? m.name.text : null))
        .filter(Boolean);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return fields;
}

/** CASE_LABELS：text.case.* 命令由它展开（模式 → 中文标签） */
function parseCaseLabels() {
  const { sf } = parseTs(join(SRC, "editor", "transforms.ts"));
  let labels = null;
  const visit = (node) => {
    if (labels) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "CASE_LABELS") {
      let init = node.initializer;
      while (init && (ts.isAsExpression(init) || ts.isParenthesizedExpression(init))) init = init.expression;
      if (init && ts.isObjectLiteralExpression(init)) {
        labels = init.properties
          .map((p) =>
            ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)
              ? { mode: p.name.text, label: str(p.initializer) ?? p.name.text }
              : null,
          )
          .filter(Boolean);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return labels;
}

function parseCommands() {
  const { sf, lineOf } = parseTs(COMMAND_TABLE);
  const commands = [];
  const fieldErrors = [];
  const known = new Set(parseCommandDefFields() ?? []);
  const caseLabels = parseCaseLabels();

  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const idNode = prop(node, "id");
      const titleNode = prop(node, "title");
      if (idNode && titleNode) {
        const line = lineOf(node);
        for (const key of keysOf(node)) {
          if (!known.has(key)) fieldErrors.push(`${rel(COMMAND_TABLE)}:${line} 命令对象含未声明字段 ${key}`);
        }
        const hidden = prop(node, "hidden")?.kind === ts.SyntaxKind.TrueKeyword;
        const title = str(titleNode);
        const base = {
          line,
          title: title ?? "",
          hidden,
          menu: str(prop(node, "menu")),
          description: str(prop(node, "description")) ?? "",
          keywords: strArray(prop(node, "keywords")),
          outcome: outcomeOf(node),
        };
        const id = str(idNode);
        if (id) {
          commands.push({ ...base, id });
        } else if (ts.isTemplateExpression(idNode) && idNode.head.text === "text.case." && caseLabels) {
          const head = title ?? "";
          for (const { mode, label } of caseLabels) {
            commands.push({ ...base, id: `text.case.${mode}`, title: `${head}${label}`, dynamic: true });
          }
        } else {
          notes.push(`${rel(COMMAND_TABLE)}:${line} 命令 id 非字面量，跳过`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { commands, fieldErrors };
}

/**
 * 动作项扫描：面板 / 通用控件里的按钮与动作描述符。
 * - X.textContent = "..."，且 X 来自 createElement("button")
 * - label: "..."，且同一处邻近有 run: / onClick（动作描述符）
 */
function scanActions() {
  // 面板与通用控件；diffService 的比较动作也渲染成按钮，一并纳入
  const files = walk(SRC, [".ts"]).filter(
    (f) => /[\\/](panels|ui)[\\/]/.test(f) || rel(f) === "src/app/diffService.ts",
  );
  const hits = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    const buttonVars = new Set();
    for (const line of lines) {
      const m = /(?:const|let|var)\s+(\w+)\s*=\s*[^;]*createElement\("button"\)/.exec(line);
      if (m) buttonVars.add(m[1]);
    }
    const near = (idx, re) => {
      for (let i = Math.max(0, idx - 3); i <= Math.min(lines.length - 1, idx + 3); i++) {
        if (re.test(lines[i])) return true;
      }
      return false;
    };
    lines.forEach((line, idx) => {
      const tc = /\b(\w+)\.textContent\s*=\s*"([^"]+)"/g;
      let m;
      while ((m = tc.exec(line))) {
        if (!buttonVars.has(m[1])) continue;
        hits.push({ file: rel(file), line: idx + 1, text: m[2], title: titleNear(lines, idx), kind: "button" });
      }
      const lb = /\blabel\s*:\s*"([^"]+)"/g;
      while ((m = lb.exec(line))) {
        if (!near(idx, /\brun\s*:|onClick\s*:/)) continue;
        hits.push({ file: rel(file), line: idx + 1, text: m[1], title: titleNear(lines, idx), kind: "button" });
      }
    });
  }
  const grouped = new Map();
  for (const hit of hits) {
    const key = `button:${hit.file}#${hit.text}`;
    if (!grouped.has(key)) grouped.set(key, { key, ...hit, count: 0 });
    grouped.get(key).count += 1;
  }
  return { hits, grouped: [...grouped.values()] };
}

function titleNear(lines, idx) {
  for (let i = Math.max(0, idx - 3); i <= Math.min(lines.length - 1, idx + 3); i++) {
    const m = /\btitle\s*[:=]\s*"([^"]*)"/.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

function isProductLabel(text) {
  // 失败 / 成功态文案是反馈，不是入口
  if (/失败|错误|成功/.test(text)) return false;
  return PRODUCT_VERBS.some((v) => text.includes(v));
}

/**
 * C8：命令索引的条目 id（`### <id> · <标题>`）。
 * 生成器 scripts/gen-command-index.mjs 与这里共用同一份格式约定。
 */
function parseCommandIndex() {
  try {
    const text = readFileSync(COMMAND_INDEX, "utf8");
    const ids = [];
    for (const line of text.split(/\r?\n/)) {
      const m = /^### (\S+) · /.exec(line);
      if (m) ids.push(m[1]);
    }
    return ids;
  } catch {
    return null;
  }
}

function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
  } catch (e) {
    errors.push(`基线文件缺失或不可解析：${rel(BASELINE_FILE)}（${e.message}）`);
    return null;
  }
}

function diffNew(current, baseline) {
  const known = new Set(baseline);
  return current.filter((v) => !known.has(v));
}

function diffGone(current, baseline) {
  const now = new Set(current);
  return baseline.filter((v) => !now.has(v));
}

/** 只校验「该文件里确实调了结果卡」，不绑定行号（行号会随改动漂移） */
function resultCardExists(target) {
  const file = target.split(":")[0];
  try {
    return /showResultCard\s*\(|reportResult\s*\(/.test(readFileSync(join(ROOT, file), "utf8"));
  } catch {
    return false;
  }
}

function exemptReason(file) {
  const rule = EXEMPT.find((e) => e.file === file);
  return rule ? rule.reason : null;
}

function commandExemptReason(id) {
  const rule = EXEMPT.find((e) => e.command === id);
  return rule ? rule.reason : null;
}

function main() {
  const update = process.argv.includes("--update-baseline");
  const baseline = readBaseline();
  if (!baseline) {
    for (const err of errors) console.log(`  [缺口] ${err}`);
    process.exitCode = 1;
    return;
  }

  const { commands, fieldErrors } = parseCommands();
  for (const err of fieldErrors) errors.push(err);

  const hiddenCount = commands.filter((c) => c.hidden).length;
  const dynamicCount = commands.filter((c) => c.dynamic).length;
  const missingDescription = commands.filter((c) => !c.description.trim()).map((c) => c.id);
  const missingKeywords = commands
    .filter((c) => KEYWORD_REQUIRED.includes(c.id) && !(c.keywords ?? []).length)
    .map((c) => c.id);
  for (const id of KEYWORD_REQUIRED.filter((x) => !commands.some((c) => c.id === x))) {
    errors.push(`KEYWORD_REQUIRED 登记的 ${id} 不在命令表中（命令改名后需同步脚本）`);
  }

  // C4：无菜单且非 hidden = 只存在于命令面板
  const panelOnly = commands.filter((c) => !c.menu && !c.hidden);
  const undeclaredEntry = panelOnly.filter((c) => !c.outcome?.entry).map((c) => c.id);
  for (const c of commands) {
    const entry = c.outcome?.entry ?? "";
    if (entry.includes("菜单") && !c.menu) {
      errors.push(`${rel(COMMAND_TABLE)}:${c.line} ${c.id} 声明了菜单入口但未声明 menu 字段`);
    }
  }
  const tooShort = commands.filter((c) => c.description.trim().length > 0 && c.description.trim().length < 12);

  // C3：产物类命令 + 产物类按钮
  const { hits, grouped } = scanActions();
  const productButtons = grouped.filter((g) => isProductLabel(g.text));
  const productCommands = commands.filter((c) => c.outcome?.kind === "file").map((c) => c.id);
  const registered = baseline.productActions ?? [];
  const registeredKeys = new Set(registered.map((a) => a.key));
  const currentKeys = [
    ...productCommands.map((id) => `command:${id}`),
    ...productButtons.map((g) => g.key),
  ];
  for (const key of currentKeys.filter((k) => !registeredKeys.has(k))) {
    errors.push(`产物类入口未登记：${key}（先写进 discoverability-baseline.json 再改代码）`);
  }
  // manual 项由扫描覆盖不到（如预览导出、Git 提交），靠 resultCard 调用点校验
  for (const a of registered.filter((x) => !x.manual && !currentKeys.includes(x.key))) {
    errors.push(`基线登记的入口已不存在：${a.key}（删除该条后重跑）`);
  }
  const wired = registered.filter((a) => a.resultCard && !a.exempt);
  for (const a of wired) {
    if (!resultCardExists(a.resultCard)) errors.push(`结果卡调用点失效：${a.key} → ${a.resultCard}`);
  }
  for (const key of currentKeys) {
    const hit = productButtons.find((g) => g.key === key);
    const base = registered.find((a) => a.key === key);
    if (hit && base && hit.count !== base.count) {
      errors.push(`产物入口出现次数变化：${key} 基线 ${base.count} 处 / 实际 ${hit.count} 处`);
    }
  }

  // C5：空态登记（文案仍在源码里，且含下一步动词）
  const emptyStates = baseline.emptyStates ?? [];
  for (const item of emptyStates) {
    let text = "";
    try {
      text = readFileSync(join(ROOT, item.file), "utf8");
    } catch {
      errors.push(`空态登记的文件不存在：${item.file}`);
      continue;
    }
    if (!text.includes(item.text)) errors.push(`空态文案已变化：${item.file} 「${item.text}」需同步基线`);
  }
  const emptyWithoutNext = emptyStates.filter((item) => !NEXT_STEP_VERBS.some((v) => item.text.includes(v)));

  // C6：同名异源（同一动作 label 出现在 ≥2 个文件，且 title 相同）
  const byLabel = new Map();
  for (const hit of hits) {
    if (hit.text.length < 3 || GENERIC_LABELS.has(hit.text)) continue;
    // 反馈文案（已复制 / 导出失败）不是入口名，同名是正常的
    if (/^(已|正在)/.test(hit.text) || /失败|错误|成功/.test(hit.text)) continue;
    if (!byLabel.has(hit.text)) byLabel.set(hit.text, []);
    byLabel.get(hit.text).push(hit);
  }
  const sameLabel = [];
  for (const [label, list] of byLabel) {
    const files = [...new Set(list.map((h) => h.file))];
    if (files.length < 2) continue;
    const titles = [...new Set(list.map((h) => h.title ?? ""))];
    if (titles.length === 1) sameLabel.push({ label, sources: files.sort() });
  }
  const baselineSame = baseline.sameLabelGroups ?? [];
  const baselineLabels = new Set(baselineSame.map((g) => g.label));
  for (const g of sameLabel.filter((x) => !baselineLabels.has(x.label))) {
    errors.push(`同名异源（title 相同）：${g.label} 出现在 ${g.sources.join(" / ")}`);
  }
  const nowLabels = new Set(sameLabel.map((g) => g.label));
  for (const g of baselineSame) {
    if (!nowLabels.has(g.label)) errors.push(`基线里的同名异源已消失：${g.label}（从基线删除后重跑）`);
  }

  // C7：口径与 panels/commandPalette.ts 的 commandScore 一致（标题子序列 + 关键词 + 说明包含）
  const searchScore = (query, cmd) => {
    const q = query.trim().toLowerCase();
    let score = 0;
    let ti = 0;
    let titleHit = true;
    for (const ch of q) {
      const idx = cmd.title.toLowerCase().indexOf(ch, ti);
      if (idx < 0) {
        titleHit = false;
        break;
      }
      ti = idx + 1;
    }
    if (titleHit) score += 10;
    for (const kw of cmd.keywords ?? []) {
      const k = kw.toLowerCase();
      if (k === q) score += 100;
      else if (k.includes(q)) score += 40;
    }
    const desc = cmd.description.toLowerCase();
    if (desc && desc.includes(q)) score += 30;
    return score;
  };
  for (const probe of SEARCH_PROBES) {
    const scored = commands.map((c) => ({ id: c.id, score: searchScore(probe.query, c) })).filter((x) => x.score > 0);
    const top = Math.max(0, ...scored.map((x) => x.score));
    const winners = scored.filter((x) => x.score === top).map((x) => x.id);
    if (!winners.includes(probe.expect)) {
      errors.push(`搜索「${probe.query}」命中不到 ${probe.expect}（当前最高：${winners.join(", ") || "无"}）`);
    }
  }

  // C1 / C2 / C4 走基线比较：新增缺口立即失败
  const newDesc = diffNew(missingDescription, baseline.commands?.missingDescription ?? []);
  const newKw = diffNew(missingKeywords, baseline.commands?.missingKeywords ?? []);
  const newEntry = diffNew(undeclaredEntry, baseline.commands?.undeclaredEntry ?? []);
  const report = (ids, label, file) => {
    for (const id of ids) {
      const c = commands.find((x) => x.id === id);
      errors.push(`${file}:${c?.line ?? "?"} ${id} ${label}`);
    }
  };
  report(newDesc, "缺 description", rel(COMMAND_TABLE));
  report(newKw, "缺 keywords（C2 必填）", rel(COMMAND_TABLE));
  report(newEntry, "只在命令面板，缺 outcome.entry", rel(COMMAND_TABLE));

  // C8：命令索引与命令表同步（docs/COMMANDS.md 由 npm run gen:commands 生成，硬判据）
  let indexCoverage = "未生成";
  const indexIds = parseCommandIndex();
  if (indexIds === null) {
    errors.push(`${rel(COMMAND_INDEX)} 不存在：运行 npm run gen:commands 生成`);
  } else {
    const indexSet = new Set(indexIds);
    for (const c of commands) {
      if (!indexSet.has(c.id)) {
        errors.push(`${rel(COMMAND_INDEX)} 缺命令条目 ${c.id}（重跑 npm run gen:commands）`);
      }
    }
    const known = new Set(commands.map((c) => c.id));
    for (const id of indexIds) {
      if (!known.has(id)) {
        errors.push(`${rel(COMMAND_INDEX)} 有已删除的命令 ${id}（重跑 npm run gen:commands）`);
      }
    }
    indexCoverage = `${commands.length - commands.filter((c) => !indexSet.has(c.id)).length}/${commands.length}`;
  }

  const unwired = registered.filter((a) => !a.exempt && !a.resultCard);
  const gapCount =
    missingDescription.length +
    missingKeywords.length +
    undeclaredEntry.length +
    unwired.length +
    emptyWithoutNext.length +
    sameLabel.length;

  console.log("可发现性审计");
  console.log(
    `  命令总数 ${commands.length}（固定 ${commands.length - dynamicCount} + 模板展开 ${dynamicCount}）/ hidden ${hiddenCount}` +
      ` / 已写说明 ${commands.length - missingDescription.length} / 缺说明 ${missingDescription.length}`,
  );
  console.log(`  关键词覆盖 ${KEYWORD_REQUIRED.length - missingKeywords.length} / 应覆盖 ${KEYWORD_REQUIRED.length}`);
  const manualCount = registered.filter((a) => a.manual).length;
  const exemptCount = registered.filter((a) => a.exempt).length;
  console.log(
    `  产物类入口 ${registered.length}（自动 ${currentKeys.length} + 手工 ${manualCount}，豁免 ${exemptCount}）` +
      ` / 已接入结果卡 ${wired.length}`,
  );
  console.log(`  暗入口登记 ${panelOnly.length - undeclaredEntry.length} / 应登记 ${panelOnly.length}`);
  console.log(`  空态 ${emptyStates.length} 处 / 含下一步 ${emptyStates.length - emptyWithoutNext.length}`);
  console.log(`  同名异源 ${sameLabel.length}`);
  console.log(`  命令索引 ${indexCoverage}（docs/COMMANDS.md）`);
  console.log(`  缺口合计 ${gapCount}`);

  for (const c of tooShort) notes.push(`说明过短（<12 字）：${c.id} 「${c.description}」`);
  for (const item of emptyWithoutNext) notes.push(`空态缺下一步：${item.file} 「${item.text}」`);
  for (const a of unwired) notes.push(`产物入口待接入结果卡：${a.key}`);
  const gone = [
    `已补说明 ${diffGone(missingDescription, baseline.commands?.missingDescription ?? []).length} 条`,
    `已补关键词 ${diffGone(missingKeywords, baseline.commands?.missingKeywords ?? []).length} 条`,
    `已声明入口 ${diffGone(undeclaredEntry, baseline.commands?.undeclaredEntry ?? []).length} 条`,
  ].filter((s) => !s.endsWith(" 0 条"));
  if (gone.length) notes.push(`${gone.join(" / ")}（基线可收敛）`);

  if (process.argv.includes("--list-short")) {
    for (const c of tooShort) console.log(`  [短] ${c.id} ${c.description.length} ${c.description}`);
  }
  for (const note of notes.slice(0, 12)) console.log(`  [提示] ${note}`);
  if (notes.length > 12) console.log(`  [提示] …共 ${notes.length} 条`);
  for (const err of errors.slice(0, 40)) console.log(`  [缺口] ${err}`);
  if (errors.length > 40) console.log(`  [缺口] …共 ${errors.length} 条`);

  if (update) {
    const next = {
      ...baseline,
      commands: { missingDescription, missingKeywords, undeclaredEntry },
      // 手工登记的入口扫描覆盖不到，重写基线时必须原样保留
      productActions: [...currentKeys, ...registered.filter((a) => a.manual).map((a) => a.key)].map((key) => {
        const old = registered.find((a) => a.key === key);
        const hit = productButtons.find((g) => g.key === key);
        if (old?.manual) return old;
        const reason =
          exemptReason(key.split(":")[1]?.split("#")[0] ?? "") ??
          commandExemptReason(key.slice("command:".length));
        if (old) return { ...old, count: hit?.count ?? old.count, ...(reason ? { exempt: reason } : {}) };
        if (key.startsWith("command:")) {
          const id = key.slice("command:".length);
          const c = commands.find((x) => x.id === id);
          return {
            key,
            source: "command",
            id,
            file: rel(COMMAND_TABLE),
            line: c?.line ?? 0,
            label: c?.title ?? "",
            ...(reason ? { exempt: reason } : {}),
            resultCard: null,
          };
        }
        return {
          key,
          source: "button",
          file: hit?.file ?? "",
          line: hit?.line ?? 0,
          label: hit?.text ?? "",
          count: hit?.count ?? 1,
          ...(reason ? { exempt: reason } : {}),
          resultCard: null,
        };
      }),
      sameLabelGroups: sameLabel,
    };
    writeFileSync(BASELINE_FILE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    console.log(`  [基线] 已重写 ${rel(BASELINE_FILE)}`);
  }

  if (errors.length > 0) {
    console.log(`  失败 ${errors.length} 条`);
    process.exitCode = 1;
  } else {
    console.log("  通过");
  }
}

main();
