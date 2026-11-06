#!/usr/bin/env node
/**
 * 生成 docs/COMMANDS.md（命令索引）。
 *
 * 来源是 src/app/commandTable.ts（命令表的唯一真源）：
 *   id / title / section / description / keywords / outcome / menu / hidden
 * 按 section 分组，每条命令一个 `### <id> · <title>` 标题。
 *
 * 命令面板与结果卡的「了解更多」按该标题文本定位（helpDialog 的 anchor 参数），
 * 因此标题里必须保留 id。改格式前先看 src/panels/helpDialog.ts 的 scrollToHeading。
 *
 * 用法：npm run gen:commands
 * 与命令表的一致性由 scripts/audit-discoverability.mjs 的 C8 判据守着。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const COMMAND_TABLE = join(SRC, "app", "commandTable.ts");
const OUTPUT = join(ROOT, "docs", "COMMANDS.md");

const rel = (p) => relative(ROOT, p).split(sep).join("/");

function parseTs(file) {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return { sf, lineOf: (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 };
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

/** CASE_LABELS：text.case.* 命令由它展开（模式 → 中文标签） */
function parseCaseLabels() {
  const { sf } = parseTs(join(SRC, "editor", "transforms.ts"));
  let labels = null;
  const visit = (node) => {
    if (labels) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "CASE_LABELS"
    ) {
      let init = node.initializer;
      while (init && (ts.isAsExpression(init) || ts.isParenthesizedExpression(init))) {
        init = init.expression;
      }
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
  const { sf } = parseTs(COMMAND_TABLE);
  const commands = [];
  const caseLabels = parseCaseLabels();

  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const idNode = prop(node, "id");
      const titleNode = prop(node, "title");
      if (idNode && titleNode) {
        const title = str(titleNode) ?? "";
        const base = {
          title,
          section: str(prop(node, "section")) ?? "其它",
          menu: str(prop(node, "menu")),
          hidden: prop(node, "hidden")?.kind === ts.SyntaxKind.TrueKeyword,
          description: str(prop(node, "description")) ?? "",
          keywords: strArray(prop(node, "keywords")) ?? [],
          outcome: outcomeOf(node),
        };
        const id = str(idNode);
        if (id) {
          commands.push({ ...base, id });
        } else if (ts.isTemplateExpression(idNode) && idNode.head.text === "text.case." && caseLabels) {
          for (const { mode, label } of caseLabels) {
            commands.push({ ...base, id: `text.case.${mode}`, title: `${title}${label}` });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return commands;
}

const KIND_LABELS = {
  none: "不写盘",
  file: "生成文件",
  clipboard: "复制到剪贴板",
  view: "在面板里显示",
  git: "改动 Git 仓库",
};

/** 顶层菜单 id → 标题（与 index.html 的 .menu-title 一致） */
const MENU_LABELS = {
  file: "文件",
  edit: "编辑",
  select: "选择",
  go: "转到",
  view: "视图",
  tools: "工具",
  help: "帮助",
  settings: "设置",
  git: "Git",
};

function entryLine(cmd) {
  const parts = [];
  if (cmd.menu) parts.push(`菜单「${MENU_LABELS[cmd.menu] ?? cmd.menu}」`);
  if (cmd.hidden) parts.push("仅命令面板");
  else if (!cmd.menu) parts.push("命令面板");
  if (cmd.outcome?.entry) parts.push(cmd.outcome.entry);
  return parts.join(" · ");
}

function detailLines(cmd) {
  const kind = KIND_LABELS[cmd.outcome?.kind ?? "none"] ?? "不写盘";
  const hint = cmd.outcome?.hint ? ` —— ${cmd.outcome.hint}` : "";
  const lines = [`- 结果去向：${kind}${hint}`];
  if (cmd.keywords.length > 0) lines.push(`- 可搜词：${cmd.keywords.join("、")}`);
  const entry = entryLine(cmd);
  if (entry) lines.push(`- 入口：${entry}`);
  return lines;
}

function build(commands) {
  const groups = new Map();
  for (const cmd of commands) {
    if (!groups.has(cmd.section)) groups.set(cmd.section, []);
    groups.get(cmd.section).push(cmd);
  }

  const lines = [
    "# 命令索引",
    "",
    `> 本文件由 \`npm run gen:commands\` 从 \`${rel(COMMAND_TABLE)}\` 生成，**不要手改**；`,
    "> 与命令表是否同步由 `npm run audit:discoverability` 的 C8 判据把关。",
    ">",
    "> 每条命令写明「解决什么问题 / 结果去哪 / 会不会写盘」。命令面板（`Ctrl+Shift+P`）",
    "> 支持按标题、说明和可搜词匹配，输入用途（如「发给别人」）也能命中。",
    "",
    `共 ${commands.length} 条命令，按菜单分组。`,
    "",
  ];

  for (const [section, items] of groups) {
    lines.push(`## ${section}`, "");
    for (const cmd of items) {
      lines.push(`### ${cmd.id} · ${cmd.title}`, "");
      if (cmd.description) lines.push(cmd.description, "");
      lines.push(...detailLines(cmd), "");
    }
  }

  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

const markdown = build(parseCommands());
writeFileSync(OUTPUT, markdown.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"), "utf8");
const count = (markdown.match(/^### /gm) ?? []).length;
console.log(`已生成 ${rel(OUTPUT)}：${count} 条命令`);
