#!/usr/bin/env node
/**
 * Rust 生产代码 panic 点护栏。
 *
 * 判据：`#[cfg(test)]` 标注的项（fn / mod，可嵌套、可在文件任意位置）整体算测试代码，
 * 其余算生产代码；生产代码不得出现 `.unwrap()` / `.expect(...)`。
 * 测试代码里的 unwrap/expect 是正常的断言写法，只统计、不判失败。
 * 统计前先抹掉注释 / 字符串 / 字符字面量：注释与字符串里的 ".unwrap()" 不算，
 * 大括号深度只看代码，`'{'` 这类字符字面量不会扰乱项边界。
 * 限制：`#[cfg(test)]` 必须独占一行；不带大括号的标注项（如 const）不在支持范围。
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

/**
 * 抹掉一切非代码内容（注释 / 字符串 / 字符字面量），保留换行与长度。
 * 大括号深度与 unwrap 统计都只看真正的代码；
 * 生命周期 `'a` 不是字符字面量，不能吞掉后面的代码。
 */
function maskNonCode(text) {
  const chars = [...text];
  let i = 0;
  let state = "code";
  let blockDepth = 0;
  let rawHashes = 0;
  const blank = (idx) => {
    if (chars[idx] !== "\n") chars[idx] = " ";
  };
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (state === "code") {
      if (c === "/" && next === "/") {
        blank(i);
        blank(i + 1);
        i += 2;
        state = "line";
        continue;
      }
      if (c === "/" && next === "*") {
        blank(i);
        blank(i + 1);
        i += 2;
        state = "block";
        blockDepth = 1;
        continue;
      }
      if (c === '"') {
        blank(i);
        i++;
        state = "string";
        continue;
      }
      // 原始字符串 r"…" / r#"…"#（br#"…"# 从 r 处进入即可）
      if (c === "r" && (next === '"' || next === "#")) {
        let j = i + 1;
        let hashes = 0;
        while (text[j] === "#") {
          hashes++;
          j++;
        }
        if (text[j] === '"') {
          for (let k = i; k <= j; k++) blank(k);
          i = j + 1;
          state = "raw";
          rawHashes = hashes;
          continue;
        }
      }
      // 字符字面量（'\'' / '\\' / '{'）；不带转义且第 3 位不是 ' 视为生命周期
      if (c === "'") {
        if (next === "\\") {
          let j = i + 2;
          if (text[j] === "u") {
            while (j < text.length && text[j] !== "'") j++;
          } else {
            j += 1;
          }
          if (text[j] === "'") {
            for (let k = i; k <= j; k++) blank(k);
            i = j + 1;
            continue;
          }
        } else if (next !== undefined && text[i + 2] === "'") {
          blank(i);
          blank(i + 1);
          blank(i + 2);
          i += 3;
          continue;
        }
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (state === "line") {
      if (c === "\n") state = "code";
      else blank(i);
      i++;
      continue;
    }
    if (state === "block") {
      if (c === "/" && next === "*") {
        blank(i);
        blank(i + 1);
        blockDepth++;
        i += 2;
        continue;
      }
      if (c === "*" && next === "/") {
        blank(i);
        blank(i + 1);
        blockDepth--;
        i += 2;
        if (blockDepth === 0) state = "code";
        continue;
      }
      blank(i);
      i++;
      continue;
    }
    if (state === "string") {
      if (c === "\\") {
        blank(i);
        blank(i + 1);
        i += 2;
        continue;
      }
      if (c === '"') {
        blank(i);
        state = "code";
        i++;
        continue;
      }
      blank(i);
      i++;
      continue;
    }
    // raw：结束 = 一个引号后跟恰好 rawHashes 个 #
    if (state === "raw") {
      if (c === '"') {
        let j = i + 1;
        let hashes = 0;
        while (text[j] === "#") {
          hashes++;
          j++;
        }
        if (hashes === rawHashes) {
          for (let k = i; k < j; k++) blank(k);
          i = j;
          state = "code";
          continue;
        }
      }
      blank(i);
      i++;
      continue;
    }
  }
  return chars.join("");
}

/** 每行是否落在 #[cfg(test)] 标注的项内部：用大括号深度定项边界，项外即生产代码 */
function classifyTestLines(all) {
  const isTest = new Array(all.length).fill(false);
  let depth = 0;
  let pendingTest = false;
  let testEndDepth = null;
  all.forEach((line, idx) => {
    const isAttr = line.trim() === "#[cfg(test)]";
    isTest[idx] = isAttr || pendingTest || testEndDepth !== null;
    for (const ch of line) {
      if (ch === "{") {
        if (pendingTest && testEndDepth === null) testEndDepth = depth;
        depth++;
      } else if (ch === "}") {
        depth--;
        if (testEndDepth !== null && depth === testEndDepth) {
          testEndDepth = null;
          pendingTest = false;
        }
      }
    }
    if (isAttr) pendingTest = true;
  });
  return isTest;
}

function lines(text) {
  return text.split("\n");
}

function main() {
  const files = walk(SRC).sort();
  const prod = [];
  const test = [];

  for (const file of files) {
    const all = lines(maskNonCode(readFileSync(file, "utf8")));
    const isTest = classifyTestLines(all);

    all.forEach((line, idx) => {
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
        (isTest[idx] ? test : prod).push(site);
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
