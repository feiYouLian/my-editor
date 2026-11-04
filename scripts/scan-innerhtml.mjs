#!/usr/bin/env node
/**
 * DOM 注入面护栏：统计非清空用途的 innerHTML / outerHTML 赋值与 insertAdjacentHTML 调用。
 *
 * 清空（`el.innerHTML = ""`）不构成注入面，不计数；读取（`?? el.innerHTML`）也不计数。
 * 基线见 scripts/innerhtml-baseline.json：
 *   - S1 记录当前清单（收敛基线，数量不得增加）
 *   - S3 收敛完成后把基线改为 0，脚本即变为「必须为 0」
 *
 * 有新增点时退出码 1，可直接挂进 CI。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const BASELINE = join(ROOT, "scripts", "innerhtml-baseline.json");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

function rel(p) {
  return relative(ROOT, p).split(sep).join("/");
}

/** 屏蔽注释：注释里提到 innerHTML 不算注入点 */
function maskComments(text) {
  const chars = [...text];
  let i = 0;
  let state = "code";
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (state === "code") {
      if (c === "/" && next === "/") {
        state = "line";
        chars[i] = " ";
        chars[i + 1] = " ";
        i += 2;
        continue;
      }
      if (c === "/" && next === "*") {
        state = "block";
        chars[i] = " ";
        chars[i + 1] = " ";
        i += 2;
        continue;
      }
      if (c === "'") state = "single";
      else if (c === '"') state = "double";
      else if (c === "`") state = "template";
      i++;
      continue;
    }
    if (state === "line") {
      if (c === "\n") state = "code";
      else chars[i] = " ";
      i++;
      continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") {
        chars[i] = " ";
        chars[i + 1] = " ";
        i += 2;
        state = "code";
        continue;
      }
      if (c !== "\n") chars[i] = " ";
      i++;
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (state === "single" && c === "'") state = "code";
    else if (state === "double" && c === '"') state = "code";
    else if (state === "template" && c === "`") state = "code";
    i++;
  }
  return chars.join("");
}

/** RHS 是否为清空写法（"" / '' / `` / null / undefined） */
function isClearing(rhs) {
  const value = rhs.trim().replace(/;$/, "").trim();
  return (
    value === '""' ||
    value === "''" ||
    value === "``" ||
    value === "null" ||
    value === "undefined"
  );
}

function scan() {
  const sites = [];
  for (const file of walk(SRC).sort()) {
    const text = maskComments(readFileSync(file, "utf8"));
    const all = text.split(/\r?\n/);
    all.forEach((line, idx) => {
      if (/insertAdjacentHTML\s*\(/.test(line)) {
        sites.push({ file: rel(file), line: idx + 1, kind: "insertAdjacentHTML" });
        return;
      }
      const m = /\b[\w$]+\.(innerHTML|outerHTML)\s*=\s*(.*)$/.exec(line);
      if (!m) return; // 读取或比较，不是赋值
      let rhs = m[2];
      if (rhs.trim() === "") {
        // 多行赋值：看后续首个非空行
        for (let k = idx + 1; k < Math.min(idx + 6, all.length); k++) {
          if (all[k].trim() !== "") {
            rhs = all[k].trim();
            break;
          }
        }
      }
      if (isClearing(rhs)) return;
      sites.push({ file: rel(file), line: idx + 1, kind: m[1] });
    });
  }
  return sites;
}

function main() {
  const sites = scan();
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  const baseTotal = baseline.total ?? 0;
  const baseFiles = baseline.files ?? {};

  const counts = new Map();
  for (const site of sites) counts.set(site.file, (counts.get(site.file) ?? 0) + 1);

  const failures = [];
  if (sites.length > baseTotal) {
    failures.push(`总数 ${sites.length} 超过基线 ${baseTotal}`);
  }
  for (const [file, count] of counts) {
    const allowed = baseFiles[file] ?? 0;
    if (count > allowed) failures.push(`${file}: ${count} 处，基线 ${allowed}`);
  }

  console.log("DOM 注入面扫描（非清空用途的 innerHTML / insertAdjacentHTML）");
  console.log(`  当前 ${sites.length} / 基线 ${baseTotal}`);
  for (const site of sites) console.log(`  ${site.file}:${site.line} ${site.kind}`);
  for (const failure of failures) console.log(`  [超基线] ${failure}`);
  console.log(`  超基线项 ${failures.length}`);
  if (failures.length > 0) process.exitCode = 1;
}

main();
