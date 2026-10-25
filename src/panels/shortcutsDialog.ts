/**
 * 快捷键速查：只读列表，按命令注册表的 section 分组。
 *
 * 数据由 main.ts 从命令注册表派生（与菜单 / 命令面板 / 设置同源），
 * 本模块只负责渲染，不感知命令定义与键位解析。
 */

export interface ShortcutRow {
  section: string;
  title: string;
  shortcut: string;
}

export function showShortcutsDialog(rows: ShortcutRow[]): void {
  if (document.querySelector(".dialog-backdrop")) return;

  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";

  const dialog = document.createElement("div");
  dialog.className = "dialog shortcuts-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", "快捷键速查");

  const title = document.createElement("h3");
  title.textContent = `快捷键速查（${rows.length} 项）`;
  const hint = document.createElement("p");
  hint.className = "dialog-text";
  hint.textContent = "可在「设置 ▸ 快捷键」中重绑定；此处仅列出当前已绑定键位的命令。";

  const list = document.createElement("div");
  list.className = "shortcuts-list";

  // 按 section 分组，保持注册顺序（Map 的插入序即分组首次出现顺序）
  const groups = new Map<string, ShortcutRow[]>();
  for (const row of rows) {
    const bucket = groups.get(row.section) ?? [];
    bucket.push(row);
    groups.set(row.section, bucket);
  }

  for (const [section, items] of groups) {
    const head = document.createElement("div");
    head.className = "shortcuts-group";
    head.textContent = section;
    list.append(head);
    for (const item of items) {
      const line = document.createElement("div");
      line.className = "shortcuts-row";
      const label = document.createElement("span");
      label.className = "shortcuts-label";
      label.textContent = item.title;
      const key = document.createElement("span");
      key.className = "shortcuts-key";
      key.textContent = item.shortcut;
      line.append(label, key);
      list.append(line);
    }
  }

  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "shortcuts-empty";
    empty.textContent = "当前没有已绑定的快捷键";
    list.append(empty);
  }

  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "primary";
  closeBtn.textContent = "关闭";
  actions.append(closeBtn);

  dialog.append(title, hint, list, actions);
  backdrop.append(dialog);
  document.body.append(backdrop);

  const done = (): void => backdrop.remove();
  closeBtn.addEventListener("click", done);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) done();
  });
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape") done();
  });
  closeBtn.focus();
}
