// 统一修改项目版本号（无第三方依赖）
//
// 用法：
//   node scripts/bump-version.mjs 0.1.3          # 指定版本
//   node scripts/bump-version.mjs patch          # 0.1.2 -> 0.1.3
//   node scripts/bump-version.mjs minor          # 0.1.2 -> 0.2.0
//   node scripts/bump-version.mjs major          # 0.1.2 -> 1.0.0
//   node scripts/bump-version.mjs patch --dry-run   # 只打印将改什么
//   node scripts/bump-version.mjs 0.1.1 --force     # 允许降级
//
// 涉及文件（package.json 的 version 是真源）：
//   package.json            顶层 version
//   package-lock.json       顶层 version + packages[""].version
//   src-tauri/tauri.conf.json
//   src-tauri/Cargo.toml    [package] 段下的 version
//   src-tauri/Cargo.lock    name = <crate> 那个 [[package]] 块
//
// 设计约束：
// 1. 只做「文本按行替换」，不整体重排 JSON —— 否则 CRLF、内联数组等会被一并改写，污染 diff
// 2. 替换后用 JSON 深度 diff 复核：除版本字段外出现任何改动即中止
// 3. 全部结果先在内存里算好并校验，通过后才统一写盘，不会出现「改了一半」的中间状态
// 4. 不碰 git，不提交、不打 tag，只打印后续命令

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const FILES = {
  pkg: "package.json",
  lock: "package-lock.json",
  tauri: join("src-tauri", "tauri.conf.json"),
  cargoToml: join("src-tauri", "Cargo.toml"),
  cargoLock: join("src-tauri", "Cargo.lock"),
};

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const input = args.find((a) => !a.startsWith("--"));
const dryRun = flags.has("--dry-run");
const force = flags.has("--force");

// 待写盘内容：只有全部校验通过后才会落到磁盘
const pending = new Map();

// ---------- 基础工具 ----------

const read = (file) => readFileSync(join(ROOT, file), "utf8");

// 读取「即将写入」的内容；没有待写内容时回落到磁盘
const textOf = (file) => (pending.has(file) ? pending.get(file) : read(file));

const stage = (file, text) => pending.set(file, text);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`版本号不符合 x.y.z 格式：${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function resolveVersion(target, current) {
  if (!target) {
    throw new Error("缺少版本参数：可传 0.1.3 / patch / minor / major");
  }
  const [major, minor, patch] = parseSemver(current);
  switch (target) {
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "major":
      return `${major + 1}.0.0`;
    default:
      parseSemver(target);
      return target;
  }
}

// 收集两个 JSON 结构的全部差异路径，如 "version" / packages[""].version
function diffPaths(a, b, path = [], out = []) {
  if (a === b) return out;
  const isObj = (v) => v !== null && typeof v === "object";
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) {
    out.push(path);
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) diffPaths(a[k], b[k], [...path, k], out);
  return out;
}

const pathToStr = (path) =>
  path.reduce((acc, k, i) => {
    const key = String(k);
    if (i === 0) return key;
    return /^[A-Za-z_$][\w$]*$/.test(key) ? `${acc}.${key}` : `${acc}[${JSON.stringify(key)}]`;
  }, "");

// ---------- JSON：按行替换版本字段 ----------

function bumpJson(file, newVersion, allowed) {
  const raw = read(file);
  const before = JSON.parse(raw);
  const oldVersion = before.version;
  if (typeof oldVersion !== "string") {
    throw new Error(`${file} 顶层没有 version 字段`);
  }

  // 只匹配「行首缩进 + "version": "旧值"」，行尾逗号原样保留，CRLF 由行尾的 \r 带过
  const re = new RegExp(`^(\\s*"version":\\s*)"${escapeRe(oldVersion)}"(,?)`, "gm");
  const text = raw.replace(re, `$1"${newVersion}"$2`);
  if (text === raw) {
    throw new Error(`${file} 未找到可替换的 version 行（当前 ${oldVersion}）`);
  }

  // 复核：改后文本必须仍是合法 JSON，且差异全部落在白名单内
  const after = JSON.parse(text);
  const illegal = diffPaths(before, after)
    .map(pathToStr)
    .filter((p) => !allowed.includes(p));
  if (illegal.length > 0) {
    throw new Error(
      `${file} 出现预期外的改动（${illegal.join("、")}），可能是某个依赖版本恰好等于 ${oldVersion}，已中止`,
    );
  }

  stage(file, text);
  return { file, oldVersion };
}

// ---------- TOML ----------

// Cargo.toml：只改 [package] 段下第一条 version
function bumpCargoToml(file, newVersion) {
  const lines = read(file).split("\n");
  let section = "";
  let hit = false;

  for (let i = 0; i < lines.length; i++) {
    const head = /^\s*\[([^\]]+)\]/.exec(lines[i]);
    if (head) {
      section = head[1].trim();
      continue;
    }
    if (section === "package" && !hit && /^\s*version\s*=\s*"/.test(lines[i])) {
      lines[i] = lines[i].replace(/(^\s*version\s*=\s*")[^"]*(")/, `$1${newVersion}$2`);
      hit = true;
    }
  }

  if (!hit) throw new Error(`${file} 的 [package] 段中未找到 version`);
  stage(file, lines.join("\n"));
  return { file };
}

// Cargo.lock：按 [[package]] 分块，只改 name 匹配的那个块
function bumpCargoLock(file, crateName, newVersion) {
  const blocks = read(file).split(/(?=^\[\[package\]\])/m);
  let hit = 0;

  const out = blocks.map((block) => {
    if (!block.startsWith("[[package]]")) return block;
    const nameMatch = /^\s*name\s*=\s*"([^"]+)"/m.exec(block);
    if (!nameMatch || nameMatch[1] !== crateName) return block;
    hit++;
    return block.replace(/(^\s*version\s*=\s*")[^"]*(")/m, `$1${newVersion}$2`);
  });

  if (hit !== 1) {
    throw new Error(`${file} 中 name = "${crateName}" 的包块数量为 ${hit}，预期 1`);
  }
  stage(file, out.join(""));
  return { file };
}

// 从 Cargo.toml 读 [package] 的 name，用于定位 Cargo.lock 中的包块
function readCrateName(file) {
  let section = "";
  for (const line of read(file).split("\n")) {
    const head = /^\s*\[([^\]]+)\]/.exec(line);
    if (head) {
      section = head[1].trim();
      continue;
    }
    if (section === "package") {
      const m = /^\s*name\s*=\s*"([^"]+)"/.exec(line);
      if (m) return m[1];
    }
  }
  throw new Error(`${file} 的 [package] 段中未找到 name`);
}

// ---------- 回读校验 ----------

function readVersions(crateName, getText) {
  const versions = {};
  for (const [key, file] of Object.entries(FILES)) {
    const raw = getText(file);
    if (key === "cargoToml") {
      const m = /\[package\][^[]*?^\s*version\s*=\s*"([^"]+)"/m.exec(raw);
      versions[file] = m ? m[1] : "(未找到)";
    } else if (key === "cargoLock") {
      const re = new RegExp(
        `^\\[\\[package\\]\\][^[]*?\\s*name\\s*=\\s*"${escapeRe(crateName)}"\\s*\\n\\s*version\\s*=\\s*"([^"]+)"`,
        "m",
      );
      const m = re.exec(raw);
      versions[file] = m ? m[1] : "(未找到)";
    } else {
      versions[file] = JSON.parse(raw).version ?? "(未找到)";
    }
  }
  return versions;
}

// ---------- 主流程 ----------

function main() {
  const currentVersion = JSON.parse(read(FILES.pkg)).version;
  const nextVersion = resolveVersion(input, currentVersion);

  if (!force && compareSemver(nextVersion, currentVersion) <= 0) {
    throw new Error(
      `新版本 ${nextVersion} 不大于当前版本 ${currentVersion}；确实要降级请加 --force`,
    );
  }

  const crateName = readCrateName(FILES.cargoToml);
  const before = readVersions(crateName, read);
  if (Object.values(before).some((v) => v !== currentVersion)) {
    console.log("提示：修改前各文件版本并不一致，将一并统一：");
    for (const [file, v] of Object.entries(before)) {
      console.log(`  ${file.padEnd(28)} ${v}`);
    }
    console.log("");
  }

  // 1) 先在内存里算出全部改动
  const changes = [];
  changes.push(bumpJson(FILES.pkg, nextVersion, ["version"]));

  const lockJson = JSON.parse(read(FILES.lock));
  const lockPaths = ["version"];
  if (lockJson.packages?.[""]) lockPaths.push('packages[""].version');
  changes.push(bumpJson(FILES.lock, nextVersion, lockPaths));

  changes.push(bumpJson(FILES.tauri, nextVersion, ["version"]));
  changes.push(bumpCargoToml(FILES.cargoToml, nextVersion));
  changes.push(bumpCargoLock(FILES.cargoLock, crateName, nextVersion));

  // 2) 内存校验：5 个文件必须都变成新版本，任何一处不符都不写盘
  const staged = readVersions(crateName, textOf);
  const bad = Object.entries(staged).filter(([, v]) => v !== nextVersion);
  if (bad.length > 0) {
    throw new Error(
      `校验失败，以下文件版本不是 ${nextVersion}：${bad
        .map(([f, v]) => `${f}(${v})`)
        .join("、")}；未写入任何文件`,
    );
  }

  // 3) 统一写盘
  if (!dryRun) {
    for (const [file, text] of pending) writeFileSync(join(ROOT, file), text, "utf8");
    const disk = readVersions(crateName, read);
    const mismatch = Object.entries(disk).filter(([, v]) => v !== nextVersion);
    if (mismatch.length > 0) {
      throw new Error(
        `写盘后回读不一致：${mismatch.map(([f, v]) => `${f}(${v})`).join("、")}`,
      );
    }
  }

  // 4) 汇报
  console.log(`${dryRun ? "[dry-run] " : ""}版本号 ${currentVersion} → ${nextVersion}`);
  for (const item of changes) {
    const extra = item.oldVersion ? `（原 ${item.oldVersion}）` : "";
    console.log(`  ✓ ${item.file}${extra}`);
  }
  console.log(`\n${dryRun ? "内存校验" : "写盘回读"}通过：${changes.length} 个文件版本一致 = ${nextVersion}`);

  if (dryRun) {
    console.log("\n（--dry-run 模式，未写入任何文件）");
    return;
  }

  const tag = `v${nextVersion}`;
  console.log("\n下一步（按需执行）：");
  console.log("  git add -A");
  console.log(`  git commit -m "chore(release): 版本号升级至 ${nextVersion}"`);
  console.log(`  git tag ${tag}`);
  console.log(`  git push github HEAD && git push github refs/tags/${tag}   # 触发 GitHub 发布`);
  console.log("  git push origin HEAD --tags                                # 同步 Gitee");
}

try {
  main();
} catch (err) {
  console.error(`错误：${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
}
