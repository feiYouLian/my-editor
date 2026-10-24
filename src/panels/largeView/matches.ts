/**
 * 过滤命中行号的紧凑存储。
 *
 * 命中集上限与后端 `MAX_FILTER_MATCHES` 对齐（5 万行），用定长 Uint32Array
 * 代替 number[]：50 万级命中时 number[] 需要装箱 / 双精度槽位，而 Uint32Array
 * 恒定 4 字节/元素且不产生中间数组。数组长度不可变，故由 `count` 维护有效长度。
 */

/** 命中上限：与 src-tauri/src/commands/large.rs 的 MAX_FILTER_MATCHES 一致 */
export const MATCH_LIMIT = 50_000;

/** 首次分配的最小容量：命中少时不为大文件预留整块空间 */
const MIN_CAPACITY = 1024;

export class MatchBuffer {
  /** 惰性分配的缓冲，容量按 2 倍增长，封顶 MATCH_LIMIT */
  private buf = new Uint32Array(0);
  /** 有效元素数（buf.length 可能大于它） */
  private count = 0;
  /** 是否处于过滤模式：空结果也算过滤，用于区分「未过滤」与「过滤无命中」 */
  private on = false;

  get active(): boolean {
    return this.on;
  }

  get length(): number {
    return this.count;
  }

  /** 进入过滤模式并清空已有命中（保留已分配的缓冲） */
  begin(): void {
    this.on = true;
    this.count = 0;
  }

  /** 退出过滤模式并释放缓冲 */
  reset(): void {
    this.on = false;
    this.count = 0;
    this.buf = new Uint32Array(0);
  }

  /** 追加一批流式命中；超出上限的部分丢弃 */
  append(batch: ArrayLike<number>): void {
    if (!this.on || batch.length === 0) return;
    const room = Math.min(batch.length, MATCH_LIMIT - this.count);
    if (room <= 0) return;
    this.ensureCapacity(this.count + room);
    for (let i = 0; i < room; i += 1) this.buf[this.count + i] = batch[i];
    this.count += room;
  }

  /** 用命令返回的完整命中集替换（可能晚于流式批次到达） */
  replace(list: ArrayLike<number>): void {
    this.begin();
    this.append(list);
  }

  /** 按下标取原始行号；越界返回 0（与原 `matches[index] ?? 0` 一致） */
  at(index: number): number {
    if (index < 0 || index >= this.count) return 0;
    return this.buf[index];
  }

  /** 只读视图（subarray 不复制数据）；未进入过滤模式返回 null */
  view(): Uint32Array | null {
    return this.on ? this.buf.subarray(0, this.count) : null;
  }

  private ensureCapacity(need: number): void {
    const target = Math.min(need, MATCH_LIMIT);
    if (this.buf.length >= target) return;
    let cap = Math.max(this.buf.length, MIN_CAPACITY);
    while (cap < target) cap = Math.min(cap * 2, MATCH_LIMIT);
    const next = new Uint32Array(cap);
    next.set(this.buf.subarray(0, this.count));
    this.buf = next;
  }
}
