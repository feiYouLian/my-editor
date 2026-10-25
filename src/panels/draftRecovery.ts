/**
 * 草稿恢复列表对话框：一次列出全部可恢复草稿，勾选后批量恢复。
 *
 * 取代逐个 confirm（多草稿时连续弹窗、且"稍后处理"与"丢弃"语义混在一起）。
 * 返回值约定：
 * - string[]：用户勾选的草稿 key（空数组 = 全部忽略，调用方删除全部草稿）
 * - null：关闭 / 稍后处理（不删除任何草稿，下次启动再提示）
 */

export interface DraftRow {
  key: string;
  name: string;
  /** 已格式化的写入时间 */
  savedAt: string;
  sizeText: string;
  /** 原文件是否已变化（变化后只能另存为新的未命名文档） */
  stale: boolean;
}

export function pickDraftsToRecover(rows: DraftRow[]): Promise<string[] | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";

    const dialog = document.createElement("div");
    dialog.className = "dialog draft-recovery";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", "恢复草稿");

    const title = document.createElement("h3");
    title.textContent = `发现 ${rows.length} 个未保存草稿`;

    const hint = document.createElement("p");
    hint.className = "dialog-text";
    hint.textContent = "勾选要恢复的草稿；原文件已变化的草稿将另存为新的未命名文档。";

    const list = document.createElement("div");
    list.className = "draft-list";

    const checks: HTMLInputElement[] = [];
    for (const row of rows) {
      const item = document.createElement("label");
      item.className = "draft-row";

      const check = document.createElement("input");
      check.type = "checkbox";
      // 原文件已变化的不默认勾选：恢复后只能另存为副本，交给用户明确选择
      check.checked = !row.stale;
      check.dataset.key = row.key;
      checks.push(check);

      const name = document.createElement("span");
      name.className = "draft-row-name";
      name.textContent = row.name;

      const meta = document.createElement("span");
      meta.className = `draft-row-meta${row.stale ? " stale" : ""}`;
      meta.textContent = row.stale
        ? `${row.savedAt} · ${row.sizeText} · 原文件已变化`
        : `${row.savedAt} · ${row.sizeText}`;

      item.append(check, name, meta);
      list.append(item);
    }

    const actions = document.createElement("div");
    actions.className = "dialog-actions";

    const ignore = document.createElement("button");
    ignore.type = "button";
    ignore.textContent = "全部忽略";
    ignore.title = "丢弃全部草稿（不可撤销）";

    const later = document.createElement("button");
    later.type = "button";
    later.textContent = "稍后处理";

    const recover = document.createElement("button");
    recover.type = "button";
    recover.className = "primary";

    const selected = (): string[] =>
      checks.filter((c) => c.checked).map((c) => c.dataset.key ?? "");

    const refresh = (): void => {
      const n = selected().length;
      recover.textContent = n > 0 ? `恢复选中（${n}）` : "恢复选中";
      recover.disabled = n === 0;
    };
    checks.forEach((c) => c.addEventListener("change", refresh));
    refresh();

    actions.append(ignore, later, recover);
    dialog.append(title, hint, list, actions);
    backdrop.append(dialog);
    document.body.append(backdrop);

    const close = (value: string[] | null): void => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(null);
      }
    };
    document.addEventListener("keydown", onKey);

    recover.addEventListener("click", () => close(selected()));
    later.addEventListener("click", () => close(null));
    ignore.addEventListener("click", () => close([]));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close(null);
    });
    dialog.addEventListener("click", (e) => e.stopPropagation());

    recover.focus();
  });
}
