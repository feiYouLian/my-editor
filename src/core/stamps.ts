/**
 * 时间戳 / UUID 生成（零依赖纯函数）。
 * 从 main.ts 下沉：命令注册表、右键菜单、文件服务都要用。
 */

import { pad2 } from "./format";

/** 常用时间戳格式 */
export function localStamps(): {
  local: string;
  iso: string;
  unix: string;
  date: string;
  time: string;
} {
  const d = new Date();
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return {
    local: `${date} ${time}`,
    iso: d.toISOString().replace(/\.\d{3}Z$/, "Z"),
    unix: String(Math.floor(d.getTime() / 1000)),
    date,
    time,
  };
}

/** 生成 UUID v4 */
export function newUuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = c.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}
