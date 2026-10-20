/**
 * Cron 表达式解析与描述（零依赖自研）。
 *
 * 支持三种写法：传统 **5 段**（分 时 日 月 周）、含秒 **6 段**（秒 分 时 日 月 周）、含年 **7 段**（秒 分 时 日 月 周 年）。
 * 秒与年均可留空：秒留空按「第 0 秒」处理（等价传统 5 段）；年留空表示不限制（输出时秒位自动补 0，保证 7 段位置对齐）。
 *
 * 支持语法：`*`、单值 `a`、范围 `a-b`、范围步长 `a-b/n`、通配步长（`*` 接 `/n`）、逗号列表；日/周字段为 0-7（7 视作周日）。
 * 日与周都受限时按常见实现的「或」语义匹配；只有一个受限时按该字段匹配。
 * `L` / `1L-7L` / `JAN-DEC` 等扩展语法不支持。
 */

export interface CronFields {
  /** 秒（留空 = 传统 5 段，按第 0 秒触发） */
  second: string;
  minute: string;
  hour: string;
  day: string;
  month: string;
  week: string;
  /** 年（留空 = 不限制） */
  year: string;
}

/** 年字段取值范围（Quartz 约定） */
export const YEAR_MIN = 1970;
export const YEAR_MAX = 2099;

export interface CronSpec {
  key: keyof CronFields;
  label: string;
  min: number;
  max: number;
}

/** 展示与解析顺序：秒 分 时 日 月 周 年（与 cron 的字段顺序一致） */
export const CRON_SPECS: CronSpec[] = [
  { key: "second", label: "秒", min: 0, max: 59 },
  { key: "minute", label: "分", min: 0, max: 59 },
  { key: "hour", label: "时", min: 0, max: 23 },
  { key: "day", label: "日", min: 1, max: 31 },
  { key: "month", label: "月", min: 1, max: 12 },
  { key: "week", label: "周", min: 0, max: 7 },
  { key: "year", label: "年", min: YEAR_MIN, max: YEAR_MAX },
];

export interface ParsedCron {
  error: string | null;
  fields?: Record<keyof CronFields, Set<number>>;
}

const isInt = (s: string): boolean => /^\d+$/.test(s.trim());

/** 解析单个字段；返回取值集合或错误文案 */
function parseField(text: string, min: number, max: number): Set<number> | string {
  const out = new Set<number>();
  const parts = text.split(",");
  if (parts.some((p) => p.trim() === "")) return "存在空项（逗号分隔）";
  for (const raw of parts) {
    const part = raw.trim();
    let step = 1;
    let range = part;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      range = part.slice(0, slash).trim();
      const stepText = part.slice(slash + 1).trim();
      if (!isInt(stepText)) return `步长无效：${part}`;
      step = Number(stepText);
      if (step < 1) return `步长需 ≥ 1：${part}`;
    }

    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-").map((s) => s.trim());
      if (!isInt(a) || !isInt(b)) return `范围无效：${part}`;
      lo = Number(a);
      hi = Number(b);
    } else {
      if (!isInt(range)) return `取值无效：${part}`;
      lo = Number(range);
      // 「单值/步长」按从该值到上限、按步长取（如 5/15 → 5,20,35,50）
      hi = slash >= 0 ? max : lo;
    }
    if (lo < min || hi > max || lo > hi) return `超出范围 ${min}-${max}：${part}`;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** 解析各字段（秒 / 年留空时的默认语义见文件头注释） */
export function parseCron(fields: CronFields): ParsedCron {
  const sets = {} as Record<keyof CronFields, Set<number>>;
  for (const spec of CRON_SPECS) {
    const text = fields[spec.key].trim();
    if (text === "" && spec.key === "second") {
      sets.second = new Set([0]); // 无秒字段 → 每分钟第 0 秒
      continue;
    }
    if (text === "" && spec.key === "year") {
      sets.year = fullRange(YEAR_MIN, YEAR_MAX); // 无年字段 → 不限制
      continue;
    }
    const r = parseField(text, spec.min, spec.max);
    if (typeof r === "string") return { error: `${spec.label} 字段：${r}` };
    if (r.size === 0) return { error: `${spec.label} 字段无有效取值` };
    sets[spec.key] = r;
  }
  // 周日 7 与 0 等价
  if (sets.week.has(7)) {
    sets.week.delete(7);
    sets.week.add(0);
  }
  return { error: null, fields: sets };
}

function fullRange(min: number, max: number): Set<number> {
  const set = new Set<number>();
  for (let v = min; v <= max; v += 1) set.add(v);
  return set;
}

/** 集合是否覆盖整个区间（用于判定字段是否「未限制」） */
export function isAll(set: Set<number>, min: number, max: number): boolean {
  for (let v = min; v <= max; v += 1) {
    if (!set.has(v)) return false;
  }
  return true;
}

/** 字段文本是否等价于「未限制」（留空即为未限制） */
function isAllText(text: string, min: number, max: number): boolean {
  if (text.trim() === "" || text.trim() === "*") return true;
  const r = parseField(text, min, max);
  return typeof r !== "string" && isAll(r, min, max);
}

/** 通配步长写法（`*` 接 `/n`）的步长值 */
function stepOf(text: string): number | null {
  const m = /^\*\/(\d+)$/.exec(text.trim());
  return m ? Number(m[1]) : null;
}

const pad2 = (n: number | string): string => String(n).padStart(2, "0");

/** 列表文案：逗号换顿号，范围用「–」 */
function listText(text: string): string {
  return text
    .split(",")
    .map((p) => p.trim().replace("-", "–"))
    .join("、");
}

const WEEK_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function weekText(text: string): string {
  return text
    .split(",")
    .map((raw) => {
      const p = raw.trim();
      if (p === "*") return "每天";
      if (p.includes("-")) {
        const [a, b] = p.split("-").map((x) => Number(x) % 7);
        return `${WEEK_NAMES[a]}至${WEEK_NAMES[b]}`;
      }
      return isInt(p) ? WEEK_NAMES[Number(p) % 7] : p;
    })
    .join("、");
}

function timeText(minute: string, hour: string): string {
  if (minute.trim() === "*" && hour.trim() === "*") return "每分钟";
  const mStep = stepOf(minute);
  if (mStep) return hour.trim() === "*" ? `每 ${mStep} 分钟` : `${listText(hour)} 时内每 ${mStep} 分钟`;
  if (isInt(minute) && isInt(hour)) return `${pad2(hour)}:${pad2(minute)}`;
  if (isInt(minute) && hour.trim() === "*") return `每小时第 ${minute} 分`;
  const hourPart = hour.trim() === "*" ? "每小时" : `${listText(hour)} 时`;
  return `${hourPart}的第 ${listText(minute)} 分`;
}

function dayText(fields: CronFields): string {
  const domAll = isAllText(fields.day, 1, 31);
  const dowAll = isAllText(fields.week, 0, 7);
  const dom = domAll ? "" : `${listText(fields.day)} 日`;
  const dow = dowAll ? "" : weekText(fields.week);
  if (!dom && !dow) return "每天";
  if (dom && !dow) return `每月${dom}`;
  if (!dom && dow) return `每${dow}`;
  return `每月${dom} 或 ${dow}`;
}

/** 秒字段文案（仅在有显式秒字段时使用） */
function secondText(text: string): string {
  const step = stepOf(text);
  if (step) return `每 ${step} 秒`;
  return `第 ${listText(text)} 秒`;
}

/** 中文描述 */
export function describeCron(fields: CronFields): string {
  const year = isAllText(fields.year, YEAR_MIN, YEAR_MAX) ? "" : `${listText(fields.year)} 年`;
  const month = isAllText(fields.month, 1, 12) ? "" : `仅 ${listText(fields.month)} 月`;
  const sec = fields.second.trim();
  return [
    year,
    month,
    dayText(fields),
    sec === "" ? "" : secondText(sec),
    timeText(fields.minute, fields.hour),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** 未来 count 次执行时刻（本地时间）。
 *  不匹配的年 / 月 / 日直接跳到次日、时跳到下一小时，因此带年字段时也不会逐分钟空转；
 *  命中分钟内再展开匹配的秒，故含秒表达式同样无需逐秒扫描。 */
export function nextRuns(fields: CronFields, count = 5, from = new Date()): Date[] {
  const parsed = parseCron(fields);
  if (parsed.error || !parsed.fields) return [];
  const { second, minute, hour, day, month, week, year } = parsed.fields;
  const domAll = isAll(day, 1, 31);
  const dowAll = isAll(week, 0, 6);
  const secondList = [...second].sort((a, b) => a - b);

  const dayMatches = (d: Date): boolean => {
    const dom = day.has(d.getDate());
    const dow = week.has(d.getDay());
    if (domAll && dowAll) return true;
    if (domAll) return dow;
    if (dowAll) return dom;
    return dom || dow; // 两者都受限 → 或
  };

  const out: Date[] = [];
  const fromMs = from.getTime();
  const cursor = new Date(fromMs);
  cursor.setMilliseconds(0);
  cursor.setSeconds(0);
  // 步进预算：按「天跳 + 命中日内的分 / 时」计，远小于逐分钟扫描；同时受年上限约束
  const maxSteps = 60_000;
  for (let step = 0; step < maxSteps && out.length < count; step += 1) {
    if (cursor.getFullYear() > YEAR_MAX) break;
    if (!year.has(cursor.getFullYear()) || !month.has(cursor.getMonth() + 1) || !dayMatches(cursor)) {
      cursor.setHours(24, 0, 0, 0); // 跳到次日 00:00
      continue;
    }
    if (!hour.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!minute.has(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
      continue;
    }
    for (const s of secondList) {
      const t = new Date(cursor.getTime());
      t.setSeconds(s);
      if (t.getTime() > fromMs) {
        out.push(t);
        if (out.length >= count) break;
      }
    }
    cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
  }
  return out;
}

/** 组合为表达式文本：秒 / 年留空时按 5 段或 6 段输出；带年则固定 7 段（秒位补 0） */
export function formatCron(fields: CronFields): string {
  const core = [fields.minute, fields.hour, fields.day, fields.month, fields.week].map(
    (s) => s.trim() || "*",
  );
  const sec = fields.second.trim();
  const year = fields.year.trim();
  if (year) return [sec || "0", ...core, year].join(" ");
  return (sec ? [sec, ...core] : core).join(" ");
}

/** 常用预设（点击直接填入各字段；秒 / 年留空分别表示「传统 5 段」与「年不限制」） */
export const CRON_PRESETS: { label: string; fields: CronFields }[] = [
  { label: "每分钟", fields: { second: "", minute: "*", hour: "*", day: "*", month: "*", week: "*", year: "" } },
  { label: "每 30 秒", fields: { second: "*/30", minute: "*", hour: "*", day: "*", month: "*", week: "*", year: "" } },
  { label: "整分（第 0 秒）", fields: { second: "0", minute: "*", hour: "*", day: "*", month: "*", week: "*", year: "" } },
  { label: "每 5 分钟", fields: { second: "", minute: "*/5", hour: "*", day: "*", month: "*", week: "*", year: "" } },
  { label: "每小时整点", fields: { second: "", minute: "0", hour: "*", day: "*", month: "*", week: "*", year: "" } },
  { label: "每天 0 点", fields: { second: "", minute: "0", hour: "0", day: "*", month: "*", week: "*", year: "" } },
  { label: "每天 9 点", fields: { second: "", minute: "0", hour: "9", day: "*", month: "*", week: "*", year: "" } },
  { label: "工作日 9 点", fields: { second: "", minute: "0", hour: "9", day: "*", month: "*", week: "1-5", year: "" } },
  { label: "每周一 9 点", fields: { second: "", minute: "0", hour: "9", day: "*", month: "*", week: "1", year: "" } },
  { label: "每月 1 号 0 点", fields: { second: "", minute: "0", hour: "0", day: "1", month: "*", week: "*", year: "" } },
  { label: "2026 年每天 9 点", fields: { second: "", minute: "0", hour: "9", day: "*", month: "*", week: "*", year: "2026" } },
];
