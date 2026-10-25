/**
 * 命令注册表：全应用命令的唯一来源。
 *
 * 菜单栏 / 命令面板 / 快捷键 / 设置中心键位页全部由本注册表派生，
 * 取代原先三处各自声明（file.save 曾出现 3 次、edit.toggleWhitespace
 * 与 view.toggleWhitespace 同义两个 id、search.results 默认键为空串）的漂移局面。
 *
 * 注册方式：main.ts 装配期调用 registerCommands([...]) 一次完成。
 * 可见性由字段声明而非调用方过滤：
 * - defaultKey 缺省  → 不参与快捷键体系
 * - menu 缺省        → 不出现在菜单栏
 * - menuOnly: true   → 纯菜单项，不进命令面板（如剪切/复制/粘贴）
 */

/** 菜单项模型（MenuBar 消费；由 menuModel() 派生） */
export interface MenuItemModel {
  label?: string;
  shortcut?: string;
  run?: () => void;
  separator?: boolean;
}

export interface MenuModel {
  id: string;
  label: string;
  items: MenuItemModel[];
}

export interface CommandDef {
  id: string;
  /** 命令面板标题 */
  title: string;
  /** 命令面板分组 */
  section: string;
  run: () => void;
  // ---- 快捷键体系（defaultKey 缺省 = 不参与；"" = 参与但未绑定）----
  defaultKey?: string;
  /** 固定别名（不可改；如中文 Windows 下 Alt+Shift 被输入法吞掉时的备用键） */
  altKeys?: string[];
  /** 编辑器内置（CM6）绑定：仅展示，不可重绑定 */
  fixed?: boolean;
  // ---- 菜单栏（menu 缺省 = 不出现在菜单栏）----
  /** 所属一级菜单 id */
  menu?: string;
  /** 菜单标签（缺省用 title） */
  menuLabel?: string;
  /** 菜单内排序（小者靠前；缺省按注册序） */
  menuOrder?: number;
  /** 该项前插入分隔线 */
  menuSeparatorBefore?: boolean;
  /** 菜单展示的快捷键（不进键位体系；如系统剪贴板键 Ctrl+A） */
  menuShortcut?: string;
  // ---- 可见性 ----
  /** 不在命令面板显示（纯菜单项 / 纯键位展示项） */
  hidden?: boolean;
}

/** 一级菜单标签与顺序（对象键序即菜单栏顺序） */
const MENU_LABELS: Record<string, string> = {
  file: "文件",
  edit: "编辑",
  select: "选择",
  go: "转到",
  compare: "比较",
  tools: "工具",
  settings: "设置",
};

const registry = new Map<string, CommandDef>();
/** 注册代号：注册表变更后递增，供缓存派生物（快捷键分发表）判定失效 */
let registryVersion = 0;

/** 注册命令（同 id 后注册覆盖，保证单一来源语义） */
export function registerCommands(defs: readonly CommandDef[]): void {
  if (defs.length === 0) return;
  for (const def of defs) registry.set(def.id, def);
  registryVersion += 1;
}

/** 注册表版本（缓存键用） */
export function commandsVersion(): number {
  return registryVersion;
}

export function getCommand(id: string): CommandDef | undefined {
  return registry.get(id);
}

/** 全部命令（注册序） */
export function allCommands(): readonly CommandDef[] {
  return [...registry.values()];
}

/** 命令面板条目（过滤不进面板的命令） */
export function commandPaletteItems(): {
  id: string;
  title: string;
  section: string;
  run: () => void;
}[] {
  return allCommands()
    .filter((c) => !c.hidden)
    .map((c) => ({ id: c.id, title: c.title, section: c.section, run: c.run }));
}

/** 参与快捷键体系的命令（含 fixed 展示项） */
export type BindableCommand = CommandDef & { defaultKey: string };

export function bindableCommands(): BindableCommand[] {
  return allCommands().filter((c): c is BindableCommand => c.defaultKey !== undefined);
}

/**
 * 派生菜单栏结构。
 * shortcut 由调用方解析（main.ts 传入的解析函数内含用户键位覆盖与
 * 展示格式化），避免 core → config 反向依赖。
 */
export function menuModel(resolveShortcut: (cmd: CommandDef) => string): MenuModel[] {
  const menus: MenuModel[] = [];
  for (const [id, label] of Object.entries(MENU_LABELS)) {
    const entries = allCommands()
      .map((cmd, index) => ({ cmd, order: cmd.menuOrder ?? 1000 + index }))
      .filter((e) => e.cmd.menu === id)
      .sort((a, b) => a.order - b.order);
    const items: MenuItemModel[] = [];
    for (const { cmd } of entries) {
      if (cmd.menuSeparatorBefore && items.length > 0) items.push({ separator: true });
      const shortcut = resolveShortcut(cmd);
      items.push({
        label: cmd.menuLabel ?? cmd.title,
        shortcut: shortcut || undefined,
        run: cmd.run,
      });
    }
    if (items.length > 0) menus.push({ id, label, items });
  }
  return menus;
}
