/**
 * 文件条目图标：内联 SVG（按类别着色）。
 * 原在 panels/fileTree.ts，因面包屑下拉（ui/breadcrumb.ts）也要用、
 * 且它是无状态纯工厂，下沉到 ui 层避免 ui → panels 的跨层依赖。
 */

const SVG_NS = "http://www.w3.org/2000/svg";

const EXT_CATEGORY: Record<string, "code" | "config" | "image" | "archive"> = {
  js: "code", mjs: "code", cjs: "code", ts: "code", tsx: "code", jsx: "code",
  c: "code", cpp: "code", h: "code", hpp: "code", cs: "code", rs: "code",
  go: "code", py: "code", java: "code", kt: "code", swift: "code", rb: "code",
  php: "code", sh: "code", bash: "code", ps1: "code", sql: "code",
  html: "code", htm: "code", xml: "code", css: "code", less: "code", scss: "code", vue: "code",
  json: "config", jsonc: "config", yaml: "config", yml: "config", toml: "config",
  ini: "config", conf: "config", env: "config", properties: "config",
  png: "image", jpg: "image", jpeg: "image", gif: "image", ico: "image", webp: "image", svg: "image", bmp: "image",
  zip: "archive", tar: "archive", gz: "archive", rar: "archive", "7z": "archive", pdf: "archive",
};

function iconCategory(name: string): "file" | "code" | "config" | "image" | "archive" {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "file";
  return EXT_CATEGORY[name.slice(dot + 1).toLowerCase()] ?? "file";
}

/**
 * 生成条目图标：目录（闭合 / 展开）与文件（普通 / 代码 / 配置 / 图片 / 压缩包）。
 * 线条图标统一 16 网格，颜色由 CSS 类别类决定。
 */
export function createEntryIcon(name: string, isDir: boolean, expanded = false): SVGSVGElement {
  const category = isDir ? (expanded ? "folder-open" : "folder") : iconCategory(name);
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.2");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("tree-svg", `cat-${category}`);

  const add = (d: string): void => {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  };

  if (category === "folder") {
    add("M1.75 4.25a1 1 0 0 1 1-1h3.1l1.4 1.5h5.95a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z");
  } else if (category === "folder-open") {
    add("M2.75 3.25h3.1l1.4 1.5h5.95a1 1 0 0 1 1 1v1.1");
    add("M1.9 12.4l1.25-4.9a1 1 0 0 1 .97-.75h10.05a.75.75 0 0 1 .73.93l-1.15 4.4a1 1 0 0 1-.97.75H2.62a.75.75 0 0 1-.72-.93z");
  } else if (category === "image") {
    add("M2.75 3.25h10.5v9.5H2.75z");
    add("M2.9 10.9l3-3.15 2.2 2.3 1.7-1.75 3.15 3.1");
    add("M5.85 5.4a.95.95 0 1 1 0 1.9.95.95 0 0 1 0-1.9z");
  } else {
    add("M3.9 1.75h5l3.2 3.2v9.3H3.9z");
    add("M8.85 1.95v3.05h3.1");
  }
  return svg;
}
