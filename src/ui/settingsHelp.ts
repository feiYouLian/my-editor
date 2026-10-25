/**
 * 配置说明面板：列出 config.json 各字段的含义、取值与生效方式，便于查看 / 修改 / 验证。
 * 生效方式：即时 = 改完后「重新加载配置」立即生效；下次打开文件 = 重新打开该文件生效；
 * 重启后 = 需重启应用；预留 = 字段已定义但尚未接入。
 */

interface FieldHelp {
  key: string;
  meaning: string;
  effect: "即时" | "下次打开文件" | "重启后" | "预留";
}

interface Group {
  title: string;
  fields: FieldHelp[];
}

const GROUPS: Group[] = [
  {
    title: "编辑器",
    fields: [
      { key: "theme", meaning: "应用主题：dark / light / high-contrast / system（设置中心切换）", effect: "即时" },
      { key: "editorTheme", meaning: "编辑器语法主题：dark / light / high-contrast（独立于应用主题）", effect: "即时" },
      { key: "tabSize", meaning: "缩进宽度（空格数）", effect: "即时" },
      { key: "insertSpaces", meaning: "Tab 键插入空格（false 时插入制表符）", effect: "即时" },
      { key: "formatOnSave", meaning: "保存时自动格式化（大文件自动跳过）", effect: "即时" },
      { key: "highlighterDisabledOver", meaning: "行数超过此值禁用语法高亮、降级纯文本", effect: "下次打开文件" },
      { key: "largeFileThreshold", meaning: "文件字节数 ≥ 此值（默认 20MB）则打开为只读", effect: "即时" },
      { key: "longLineSkipChars", meaning: "单行超过此字符数则整篇降级纯文本", effect: "下次打开文件" },
      { key: "languageExtensions", meaning: '扩展名 → 语言 覆盖，如 ".log": "plaintext"', effect: "即时" },
      { key: "largeFile.logExtensions", meaning: '日志扩展名（默认 [".log"]）：命中任意大小时打开为只读', effect: "即时" },
    ],
  },
  {
    title: "editorEnhancements（编辑器增强，均可开关）",
    fields: [
      { key: "columnSelection", meaning: "启用列选择（修饰键 + 拖拽）", effect: "即时" },
      { key: "columnSelectionModifier", meaning: "列选择修饰键：Alt / Control / Shift / Meta", effect: "即时" },
      { key: "columnEditorKey", meaning: "列编辑器快捷键（CodeMirror 语法，如 Alt+c）", effect: "即时" },
      { key: "occurrenceHighlight", meaning: "选中文本后高亮文档内同名文本", effect: "即时" },
      { key: "showWhitespace", meaning: "显示空白字符（空格 / 制表符）", effect: "即时" },
      { key: "bracketMatching", meaning: "括号匹配高亮", effect: "即时" },
      { key: "indentGuides", meaning: "缩进参考线", effect: "即时" },
      { key: "codeFolding", meaning: "代码折叠（gutter 标记 + Ctrl+Shift+[ / ]）", effect: "即时" },
    ],
  },
  {
    title: "layout（窗口与布局）",
    fields: [
      { key: "sidebarVisible", meaning: "是否显示左侧文件树（启动时按此恢复）", effect: "即时" },
      { key: "splitRatio", meaning: "双栏预览默认分割比例（0.15–0.85，拖动后记忆到 localStorage）", effect: "即时" },
      { key: "defaultViewMode", meaning: "Markdown / HTML 默认视图：edit / preview / split", effect: "即时" },
      { key: "showLineNumbers / showActiveLine", meaning: "行号 / 当前行高亮开关", effect: "即时" },
      { key: "editorFontSize", meaning: "编辑器字号（px，10–24）", effect: "即时" },
      { key: "statusBarFields", meaning: "状态栏字段显隐与排序（id + visible 数组）", effect: "即时" },
      { key: "sidebarView", meaning: "侧栏当前分区：open / files / search / outline", effect: "即时" },
    ],
  },
  {
    title: "其余分组（部分预留）",
    fields: [
      { key: "largeFile.sparseIndexAnchorBytes", meaning: "稀疏行索引锚点字节间隔（打开大文件时读取）", effect: "下次打开文件" },
      { key: "largeFile.viewportPaddingLines", meaning: "虚拟视图视口上下额外渲染行数（打开大文件时读取）", effect: "下次打开文件" },
      { key: "keybindings", meaning: "自定义键位表（命令 → 键位），设置中心可重绑定 / 冲突检测", effect: "即时" },
      { key: "session", meaning: "会话恢复、草稿自动保存与保留天数", effect: "即时" },
      { key: "workspace", meaning: "工作区记忆开关与上次目录", effect: "即时" },
      { key: "search", meaning: "预留：当前工作区搜索使用固定上限（200 文件 / 2000 处），不读此项", effect: "预留" },
      { key: "fetch.allowPrivateNetwork", meaning: "允许「从网址抓取网页」访问内网 / 本机地址（默认 false）", effect: "即时" },
      { key: "terminal.shell", meaning: "内置终端 shell（空 = 自动：Windows 优先 pwsh，否则 PowerShell）；下次新建终端生效", effect: "即时" },
      { key: "globalReplace", meaning: "批量替换是否保留可撤销历史（存于应用配置目录，不生成 .bak）", effect: "即时" },
      { key: "ignoreDirs", meaning: "工作区搜索 / 快速打开忽略的目录名", effect: "即时" },
      { key: "fileEncodingMemory", meaning: "预留：按文件名记忆编码（尚未接入）", effect: "预留" },
      { key: "formatters", meaning: "CLI 格式化工具与参数（后端按语言键读取；新增语言只需改这里）", effect: "即时" },
      { key: "ai", meaning: "AI 提供商 / 模型 / 启用开关", effect: "预留" },
      { key: "log", meaning: "运行日志级别与目录", effect: "预留" },
    ],
  },
];

const EFFECT_LABEL: Record<FieldHelp["effect"], string> = {
  即时: "即时生效",
  下次打开文件: "下次打开文件生效",
  重启后: "重启后生效",
  预留: "预留（未接入）",
};

/** 打开配置说明面板 */
export function showSettingsHelp(): void {
  if (document.querySelector(".dialog-backdrop")) return;

  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";

  const dialog = document.createElement("div");
  dialog.className = "dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", "配置说明");
  dialog.style.width = "min(760px, 92vw)";

  const title = document.createElement("h3");
  title.textContent = "配置说明（config.json）";
  dialog.append(title);

  const intro = document.createElement("p");
  intro.className = "dialog-text";
  intro.textContent =
    "大多数设置也可在「设置」面板（Ctrl+,）中图形化修改，效果相同。改完 config.json 后，用「设置 ▸ 重新加载配置」立即生效，或重启应用。文件大小阈值等项标注了生效方式。";
  dialog.append(intro);

  const body = document.createElement("div");
  body.style.maxHeight = "52vh";
  body.style.overflow = "auto";
  body.style.margin = "8px 0";
  body.style.fontSize = "12px";
  body.style.lineHeight = "1.7";

  for (const group of GROUPS) {
    const groupTitle = document.createElement("div");
    groupTitle.textContent = group.title;
    groupTitle.style.fontWeight = "600";
    groupTitle.style.margin = "10px 0 4px";
    body.append(groupTitle);

    for (const field of group.fields) {
      const row = document.createElement("div");
      row.style.display = "grid";
      row.style.gridTemplateColumns = "240px 1fr auto";
      row.style.gap = "8px";
      row.style.padding = "3px 0";
      row.style.alignItems = "baseline";

      const key = document.createElement("code");
      key.textContent = field.key;
      const meaning = document.createElement("span");
      meaning.textContent = field.meaning;
      const effect = document.createElement("span");
      effect.textContent = EFFECT_LABEL[field.effect];
      effect.style.opacity = "0.65";
      effect.style.whiteSpace = "nowrap";

      row.append(key, meaning, effect);
      body.append(row);
    }
  }
  dialog.append(body);

  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "primary";
  closeBtn.textContent = "关闭";
  actions.append(closeBtn);
  dialog.append(actions);

  backdrop.append(dialog);
  document.body.append(backdrop);

  const done = () => backdrop.remove();
  closeBtn.addEventListener("click", done);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) done();
  });
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape") done();
  });
  closeBtn.focus();
}

/** 重新加载配置后的反馈面板：确认读到的确实是磁盘上的新值 */
export function showConfigReloaded(path: string, lines: string[]): void {
  if (document.querySelector(".dialog-backdrop")) return;

  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";

  const dialog = document.createElement("div");
  dialog.className = "dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", "配置已重新加载");
  dialog.style.width = "min(620px, 92vw)";

  const title = document.createElement("h3");
  title.textContent = "配置已重新加载";
  dialog.append(title);

  const source = document.createElement("p");
  source.className = "dialog-text";
  source.textContent = `来源：${path}`;
  source.style.wordBreak = "break-all";
  dialog.append(source);

  const list = document.createElement("div");
  list.style.fontFamily = "var(--font-mono, monospace)";
  list.style.fontSize = "12px";
  list.style.lineHeight = "1.8";
  list.style.maxHeight = "42vh";
  list.style.overflow = "auto";
  list.style.margin = "6px 0";
  for (const line of lines) {
    const row = document.createElement("div");
    row.textContent = line;
    list.append(row);
  }
  dialog.append(list);

  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const okBtn = document.createElement("button");
  okBtn.type = "button";
  okBtn.className = "primary";
  okBtn.textContent = "确定";
  actions.append(okBtn);
  dialog.append(actions);

  backdrop.append(dialog);
  document.body.append(backdrop);

  const done = () => backdrop.remove();
  okBtn.addEventListener("click", done);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) done();
  });
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape") done();
  });
  okBtn.focus();
}
