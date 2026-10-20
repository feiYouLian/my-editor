// 生成应用图标源文件（512x512 PNG，无第三方依赖）
// 用法：node scripts/gen-icon.mjs  →  输出 icons/app-icon.png
// 之后执行：npx tauri icon icons/app-icon.png  →  生成 src-tauri/icons/ 全量图标
//
// 设计：深靛蓝渐变圆角底 + 柔光，白色折角文档上绘主题蓝 </> 符号；
// 内部按 2 倍尺寸绘制再降采样，得到平滑边缘。
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = 512;
const SS = 2; // 超采样倍数
const SIZE = OUT * SS;
const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, "..", "icons", "app-icon.png");

// ---------- CRC32 / PNG ----------
const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// ---------- 几何工具（坐标一律按 512 设计稿，内部乘 SS） ----------
const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function roundRectSdf(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hw = (x1 - x0) / 2;
  const hh = (y1 - y0) / 2;
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp01(((px - ax) * dx + (py - ay) * dy) / len2);
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

// ---------- 画布 ----------
const bg = Buffer.alloc(SIZE * SIZE * 4, 0); // 背景层
const fg = Buffer.alloc(SIZE * SIZE * 4, 0); // 前景层（文档 / 符号）

function put(buf, x, y, r, g, b, a) {
  const i = (y * SIZE + x) * 4;
  buf[i] = r;
  buf[i + 1] = g;
  buf[i + 2] = b;
  buf[i + 3] = a;
}

// 背景：铺满画布的对角渐变（不留深色外边），左上柔光 + 内描边
const BG_X0 = 0;
const BG_Y0 = 0;
const BG_X1 = 512;
const BG_Y1 = 512;
const BG_R = 104;
const TOP_LEFT = [0x5b, 0x8f, 0xff];
const BOTTOM_RIGHT = [0x43, 0x3f, 0xd6];
const GLOW = [0xff, 0xff, 0xff];

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const px = x / SS;
    const py = y / SS;
    if (roundRectSdf(px, py, BG_X0, BG_Y0, BG_X1, BG_Y1, BG_R) > 0) continue;

    const t = clamp01((px - BG_X0 + (py - BG_Y0)) / (2 * (BG_X1 - BG_X0)));
    let r = mix(TOP_LEFT[0], BOTTOM_RIGHT[0], t);
    let g = mix(TOP_LEFT[1], BOTTOM_RIGHT[1], t);
    let b = mix(TOP_LEFT[2], BOTTOM_RIGHT[2], t);

    // 左上柔光：让底色更有体积
    const gd = Math.hypot(px - 140, py - 96);
    const glow = 0.3 * Math.pow(clamp01(1 - gd / 340), 2);
    r = mix(r, GLOW[0], glow);
    g = mix(g, GLOW[1], glow);
    b = mix(b, GLOW[2], glow);

    // 内描边：贴近边缘处提亮
    const edge = roundRectSdf(px, py, BG_X0, BG_Y0, BG_X1, BG_Y1, BG_R);
    if (edge > -3) {
      const k = 0.14 * clamp01(1 + edge / 3);
      r = mix(r, 255, k);
      g = mix(g, 255, k);
      b = mix(b, 255, k);
    }
    put(bg, x, y, r | 0, g | 0, b | 0, 255);
  }
}

// 文档投影：偏移 + 距离衰减（用底色阴影，不压暗整体）
const PAPER = { x0: 130, y0: 84, x1: 386, y1: 404, r: 30 };
const SHADOW_DY = 14;
const SHADOW_BLUR = 24;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const px = x / SS;
    const py = y / SS;
    const d = roundRectSdf(px, py - SHADOW_DY, PAPER.x0, PAPER.y0, PAPER.x1, PAPER.y1, PAPER.r);
    if (d > SHADOW_BLUR) continue;
    const alpha = 0.2 * Math.pow(clamp01(1 - d / SHADOW_BLUR), 2);
    if (alpha <= 0) continue;
    const i = (y * SIZE + x) * 4;
    if (bg[i + 3] === 0) continue;
    bg[i] = mix(bg[i], 0x1a, alpha) | 0;
    bg[i + 1] = mix(bg[i + 1], 0x1d, alpha) | 0;
    bg[i + 2] = mix(bg[i + 2], 0x52, alpha) | 0;
  }
}

// 折角：右上角沿对角切掉，内侧 flap 用浅灰蓝
const PAPER_COLOR = [0xf7, 0xf9, 0xfd];
const FLAP_COLOR = [0xd2, 0xdd, 0xf2];
const CUT = 64;
const cutX = PAPER.x1 - CUT;
const cutY = PAPER.y0;

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const px = x / SS;
    const py = y / SS;
    if (roundRectSdf(px, py, PAPER.x0, PAPER.y0, PAPER.x1, PAPER.y1, PAPER.r) > 0) continue;
    // 切口上方（含原右上角）不画
    if (px >= cutX && py <= cutY + (px - cutX)) continue;
    const flap = px >= cutX && py <= cutY + CUT && py >= cutY + (px - cutX);
    const c = flap ? FLAP_COLOR : PAPER_COLOR;
    put(fg, x, y, c[0], c[1], c[2], 255);
  }
}

// </> 代码符号：粗线条 + 圆头，主题蓝
const ACCENT = [0x2f, 0x63, 0xe6];
const STROKE = 27;

function drawStroke(ax, ay, bx, by) {
  const x0 = Math.max(0, Math.floor((Math.min(ax, bx) - STROKE) * SS));
  const x1 = Math.min(SIZE - 1, Math.ceil((Math.max(ax, bx) + STROKE) * SS));
  const y0 = Math.max(0, Math.floor((Math.min(ay, by) - STROKE) * SS));
  const y1 = Math.min(SIZE - 1, Math.ceil((Math.max(ay, by) + STROKE) * SS));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x / SS;
      const py = y / SS;
      if (distToSegment(px, py, ax, ay, bx, by) > STROKE / 2) continue;
      put(fg, x, y, ACCENT[0], ACCENT[1], ACCENT[2], 255);
    }
  }
}

function drawDot(cx, cy, r) {
  const x0 = Math.max(0, Math.floor((cx - r) * SS));
  const x1 = Math.min(SIZE - 1, Math.ceil((cx + r) * SS));
  const y0 = Math.max(0, Math.floor((cy - r) * SS));
  const y1 = Math.min(SIZE - 1, Math.ceil((cy + r) * SS));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (Math.hypot(x / SS - cx, y / SS - cy) > r) continue;
      put(fg, x, y, ACCENT[0], ACCENT[1], ACCENT[2], 255);
    }
  }
}

const marks = [
  [226, 214, 190, 256],
  [190, 256, 226, 298],
  [256, 320, 288, 204],
  [296, 214, 332, 256],
  [332, 256, 296, 298],
];
for (const [ax, ay, bx, by] of marks) drawStroke(ax, ay, bx, by);
for (const [ax, ay] of marks) drawDot(ax, ay, STROKE / 2);
for (const [, , bx, by] of marks) drawDot(bx, by, STROKE / 2);

// ---------- 合成 + 降采样 ----------
const out = Buffer.alloc(OUT * OUT * 4);
for (let y = 0; y < OUT; y++) {
  for (let x = 0; x < OUT; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * SIZE + (x * SS + sx)) * 4;
        const fa = fg[i + 3] / 255;
        const ba = bg[i + 3] / 255;
        const oa = fa + ba * (1 - fa);
        const or = fa * fg[i] + ba * (1 - fa) * bg[i];
        const og = fa * fg[i + 1] + ba * (1 - fa) * bg[i + 1];
        const ob = fa * fg[i + 2] + ba * (1 - fa) * bg[i + 2];
        r += oa > 0 ? or / oa : 0;
        g += oa > 0 ? og / oa : 0;
        b += oa > 0 ? ob / oa : 0;
        a += oa;
      }
    }
    const samples = SS * SS;
    const j = (y * OUT + x) * 4;
    out[j] = Math.round(r / samples);
    out[j + 1] = Math.round(g / samples);
    out[j + 2] = Math.round(b / samples);
    out[j + 3] = Math.round((a / samples) * 255);
  }
}

// ---------- PNG 编码 ----------
const raw = Buffer.alloc(OUT * (OUT * 4 + 1));
for (let y = 0; y < OUT; y++) {
  raw[y * (OUT * 4 + 1)] = 0; // filter: none
  out.copy(raw, y * (OUT * 4 + 1) + 1, y * OUT * 4, (y + 1) * OUT * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(OUT, 0);
ihdr.writeUInt32BE(OUT, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, png);
console.log(`written: ${outPath} (${png.length} bytes)`);
