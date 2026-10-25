/**
 * 大文件视图的 DOM 骨架：工具条 + 缩略图/虚拟列表主体 + 状态行。
 * 只负责建元素与返回引用，事件接线留在 panels/largeView.ts。
 */

import { ENCODINGS } from "./constants";

export interface LargeViewDom {
  titleEl: HTMLSpanElement;
  metaEl: HTMLSpanElement;
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
  const metaEl = document.createElement("span");
  metaEl.className = "lv-meta";

  const filterInput = document.createElement("input");
  filterInput.className = "lv-filter";
  filterInput.placeholder = "过滤行（留空显示全部）";
  filterInput.spellcheck = false;
  const caseBtn = toggleBtn("Aa", "区分大小写");
  const regexBtn = toggleBtn(".*", "使用正则表达式");
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
    metaEl,
    filterInput,
    caseBtn,
    regexBtn,
    filterBtn,
    clearBtn,
    encodingSelect,
    editorBtn,
    indexEl,
  );

  // ---- 主体：缩略图 + 虚拟列表 ----
  const body = document.createElement("div");
  body.className = "lv-body";

  const canvas = document.createElement("canvas");
  canvas.className = "lv-minimap";
  canvas.width = 64;
  canvas.title = "缩略图：点击跳转，红线为过滤命中位置";

  const scrollEl = document.createElement("div");
  scrollEl.className = "lv-scroll";
  const spacerEl = document.createElement("div");
  spacerEl.className = "lv-spacer";
  const rowsEl = document.createElement("div");
  rowsEl.className = "lv-rows";
  spacerEl.append(rowsEl);
  scrollEl.append(spacerEl);

  body.append(canvas, scrollEl);

  const statusEl = document.createElement("div");
  statusEl.className = "lv-status";

  host.append(bar, body, statusEl);

  return {
    titleEl: title,
    metaEl,
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
    encodingSelect,
    editorBtn,
  };
}
