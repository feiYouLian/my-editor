#!/usr/bin/env node
/**
 * Rust 生产代码 panic 点护栏。
 *
 * 判据：`#[cfg(test)]` 之前（生产代码）不得出现 `.unwrap()` / `.expect(...)`。
 * 测试代码里的 unwrap/expect 是正常的断言写法，只统计、不判失败。
 *
 * 输出形如：
 *   生产代码 panic 点: 0
 *   测试代码 panic 点: 329
 *
 * 有生产 panic 点时退出码 1，可直接挂进 CI。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src-tauri", "src");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".rs")) out.push(full);
  }
  return out;
}

function rel(p) {
  return relative(ROOT, p).split(sep).join("/");
}

/** 屏蔽注释：注释里提到 .unwrap() 不算 panic 点；保留换行与长度 */
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
      if (c === '"') {
        state = "string";
        i++;
        continue;
      }
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
      // Rust 块注释可嵌套
      if (c === "/" && next === "*") {
        chars[i] = " ";
        chars[i + 1] = " ";
        state = "block";
        i += 2;
        continue;
      }
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
    // string：只关心结束符与转义
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"') state = "code";
    i++;
  }
  return chars.join("");
}

function lines(text) {
  return text.split("\n");
}

function main() {
  const files = walk(SRC).sort();
  const prod = [];
  const test = [];

  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    const text = maskComments(raw);
    const all = lines(text);
    const cut = all.findIndex((line) => line.trim() === "#[cfg(test)]");
    const prodCount = cut < 0 ? all.length : cut;

    all.forEach((line, idx) => {
      const isProd = idx < prodCount;
      // 只匹配 .unwrap() / .expect(，不匹配 unwrap_or / unwrap_or_else
      const re = /\.(unwrap|expect)\s*\(/g;
      let m;
      while ((m = re.exec(line))) {
        // expect 允许带参数（消息），unwrap 必须无参：`unwrap(x)` 不是标准方法，仅 .unwrap() 有意义
        if (m[1] === "unwrap") {
          const rest = line.slice(m.index + m[0].length - 1);
          if (!/^\(\s*\)/.test(rest)) continue;
        }
        const site = `${rel(file)}:${idx + 1}`;
        (isProd ? prod : test).push(site);
      }
    });
  }

  console.log(`生产代码 panic 点: ${prod.length}`);
  console.log(`测试代码 panic 点: ${test.length}`);
  for (const site of prod) console.log(`  [生产] ${site}`);
  if (prod.length > 0) {
    console.log("生产代码不得使用 unwrap()/expect()：改为显式错误处理或返回 Result。");
    process.exitCode = 1;
  }
}

main();
