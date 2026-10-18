// 生成应用图标源文件（512x512 PNG，无第三方依赖）
// 用法：node scripts/gen-icon.mjs  →  输出 icons/app-icon.png
// 之后执行：npx tauri icon icons/app-icon.png  →  生成 src-tauri/icons/ 全量图标
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 512;
const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, "..", "icons", "app-icon.png");

// ---------- CRC32 ----------
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

// ---------- 绘制 ----------
const BG = [0x22, 0x25, 0x2d, 255]; // 应用底色
const PAPER = [0xe6, 0xe8, 0xee, 255]; // 纸张
const LINE = [0x9a, 0xa3, 0xb2, 255]; // 文本行
const ACCENT = [0x4c, 0x8d, 0xff, 255]; // 主题蓝

const pixels = Buffer.alloc(SIZE * SIZE * 4, 0);

function setPixel(x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  pixels[i] = r;
  pixels[i + 1] = g;
  pixels[i + 2] = b;
  pixels[i + 3] = a;
}

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || y < y0 || x > x1 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function fillRect(x0, y0, x1, y1, color) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setPixel(x, y, color);
}

// 外框：圆角方形底
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (inRoundRect(x, y, 24, 24, SIZE - 25, SIZE - 25, 96)) setPixel(x, y, BG);
  }
}
// 纸张
fillRect(148, 96, 364, 416, PAPER);
// 顶部色带
fillRect(148, 96, 364, 140, ACCENT);
// 文本行
fillRect(184, 176, 328, 196, LINE);
fillRect(184, 216, 328, 236, LINE);
fillRect(184, 256, 296, 276, LINE);
fillRect(184, 296, 328, 316, ACCENT);
fillRect(184, 336, 264, 356, LINE);

// ---------- PNG 编码 ----------
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
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
