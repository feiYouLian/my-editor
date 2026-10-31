/**
 * 大文件视图的 DOM 骨架：工具条 + 缩略图/虚拟列表主体 + 状态行。
 * 只负责建元素与返回引用，事件接线留在 panels/largeView.ts。
 */

import { ENCODINGS, MINIMAP_WIDTH } from "./constants";

export interface LargeViewDom {
  titleEl: HTMLSpanElement;
  indexEl: HTMLSpanElement;
  scrollEl: HTMLDivElement;
  spacerEl: HTMLDivElement;
  rowsEl: HTMLDivElement;
  statusEl: HTMLDivElement;
  canvas: HTMLCanvasElement;
  filterInput: HTMLInputElement;
  filterBtn: HTMLButtonElement;
  clearBtn: HTMLButtonElement;
  caseBtn: HTMLButtonElement;
  regexBtn: HTMLButtonElement;
  /** 换行开关：长日志行不换行时只能靠横向滚动，二者互补 */
  wrapBtn: HTMLButtonElement;
  /** 跟随文件尾部（日志追加时自动刷新；手动上滚暂停） */
  followBtn: HTMLButtonElement;
  gotoInput: HTMLInputElement;
  gotoBtn: HTMLButtonElement;
  copyBtn: HTMLButtonElement;
  encodingSelect: HTMLSelectElement;
  editorBtn: HTMLButtonElement;
}

function toggleBtn(label: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "lv-toggle";
  b.textContent = label;
  b.title = title;
  return b;
}

/** 在 host 内构建骨架并返回全部元素引用 */
export function buildLargeViewDom(host: HTMLElement): LargeViewDom {
  host.innerHTML = "";

  // ---- 工具条 ----
  const bar = document.createElement("div");
  bar.className = "lv-bar";

  const title = document.createElement("span");
  title.className = "lv-title";
  // 具体是日志还是普通大文件由 open() 按扩展名覆盖
  title.textContent = "大文件视图";

  // 文件名 / 体积 / 行数 / 编码 / 换行 一律由**状态栏**承载：
  // 早先这里也有一段 meta 文案，与右侧状态栏完全重复，且索引未完成时行数还是旧值。

  const filterInput = document.createElement("input");
  filterInput.className = "lv-filter";
  filterInput.placeholder = "过滤行（留空显示全部）";
  filterInput.spellcheck = false;
  const caseBtn = toggleBtn("Aa", "区分大小写");
  const regexBtn = toggleBtn(".*", "使用正则表达式");
  const wrapBtn = toggleBtn("↵", "自动换行（长行折行显示，不再横向滚动）");
  // 跟随：日志被追加时自动贴底刷新；用户手动上滚即暂停
  const followBtn = toggleBtn("跟随", "跟随文件尾部：日志追加时自动显示最新内容（手动上滚会暂停）");
  const gotoInput = document.createElement("input");
  gotoInput.className = "lv-filter lv-goto";
  gotoInput.type = "number";
  gotoInput.min = "1";
  gotoInput.placeholder = "行号";
  gotoInput.title = "跳到指定行（1 基）";
  const gotoBtn = document.createElement("button");
  gotoBtn.type = "button";
  gotoBtn.className = "lv-btn";
  gotoBtn.textContent = "跳转";
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "lv-btn";
  copyBtn.textContent = "复制行";
  copyBtn.title = "复制当前选中行（先点击行）";
  const filterBtn = document.createElement("button");
  filterBtn.type = "button";
  filterBtn.className = "lv-btn";
  filterBtn.textContent = "过滤";
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "lv-btn";
  clearBtn.textContent = "清除";

  const encodingSelect = document.createElement("select");
  encodingSelect.className = "lv-select";
  encodingSelect.title = "重新解释编码";
  for (const name of ENCODINGS) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    encodingSelect.append(opt);
  }

  const editorBtn = document.createElement("button");
  editorBtn.type = "button";
  editorBtn.className = "lv-btn";
  editorBtn.textContent = "以编辑器打开";
  editorBtn.title = "改用可编辑的编辑器打开（大文件会占用较多内存）";

  const indexEl = document.createElement("span");
  indexEl.className = "lv-index";

  bar.append(
    title,
    filterInput,
    caseBtn,
    regexBtn,
    wrapBtn,
    followBtn,
    filterBtn,
    clearBtn,
    gotoInput,
    gotoBtn,
    copyBtn,
    encodingSelect,
    editorBtn,
    indexEl,
  );

  // ---- 主体：虚拟列表 + 缩略图（缩略图在右侧，与编辑器内 minimap 同侧） ----
  const body = document.createElement("div");
  body.className = "lv-body";

  const canvas = document.createElement("canvas");
  canvas.className = "lv-minimap";
  canvas.width = MINIMAP_WIDTH;
  canvas.title = "缩略图：点击跳转，红线为过滤命中位置";

  const scrollEl = document.createElement("div");
  scrollEl.className = "lv-scroll";
  const spacerEl = document.createElement("div");
  spacerEl.className = "lv-spacer";
  const rowsEl = document.createElement("div");
  rowsEl.className = "lv-rows";
  spacerEl.append(rowsEl);
  scrollEl.append(spacerEl);

  body.append(scrollEl, canvas);

  const statusEl = document.createElement("div");
  statusEl.className = "lv-status";

  host.append(bar, body, statusEl);

  return {
    titleEl: title,
    indexEl,
    scrollEl,
    spacerEl,
    rowsEl,
    statusEl,
    canvas,
    filterInput,
    filterBtn,
    clearBtn,
    caseBtn,
    regexBtn,
    wrapBtn,
    followBtn,
    gotoInput,
    gotoBtn,
    copyBtn,
    encodingSelect,
    editorBtn,
  };
}
