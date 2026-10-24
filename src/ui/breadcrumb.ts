/**
 * 路径面包屑：层级渲染（签名优化）+ 层级下拉（同级预览、下钻、快速打开）。
 *
 * 点某一段面包屑时，下拉列出的是「这一段所在的层级」（即其父目录的内容，
 * 当前段高亮），便于在同一层横向切到兄弟目录/文件；需要看它内部时再点它。
 * 工作区根由调用方经 deps 注入（它是 app 级状态，不在此模块持有）。
 */

import { invoke } from "@tauri-apps/api/core";
import { dirnameOf, splitAbsolutePath, workspaceRelativeParts } from "../core/paths";
import type { Tab } from "../store/tabs";
import { createEntryIcon } from "./icons";
import { placeMenu } from "./menu";

export interface BreadcrumbDeps {
  /** 工作区根目录（null = 未打开目录） */
  getWorkspaceRoot: () => string | null;
  /** 当前激活标签 */
  getActiveTab: () => Tab | null;
  /** 下拉中点击文件 */
  onOpenFile: (path: string) => void;
}

/** 面包屑条目：dir 有值可下拉；无值为当前文件 */
interface Crumb {
  label: string;
  dir?: string;
}

/** 路径比较（Windows 下大小写与斜杠均不敏感） */
function samePath(a: string, b: string): boolean {
  const norm = (s: string): string => s.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * 取某一段面包屑「所在的层级」——即它的父目录。
 * 已是根（盘符 / UNC 根）时退回自身，盘符补尾斜杠才能被 list_dir 接受。
 */
function levelDirOf(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, "");
  if (trimmed.startsWith("\\\\")) {
    const segs = trimmed.slice(2).split("\\").filter(Boolean);
    if (segs.length <= 2) return dir; // UNC 根：没有可列的父目录
  }
  const parent = dirnameOf(trimmed);
  if (!parent || parent === trimmed || /^[A-Za-z]:$/.test(parent)) {
    return /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}\\` : dir;
  }
  return parent;
}

export class Breadcrumb {
  /** 上次渲染的面包屑签名：仅路径 / 工作区变化时重建 */
  private signature = "";
  private menu: HTMLElement | null = null;
  private menuDir: string | null = null;

  constructor(
    private container: HTMLElement,
    private deps: BreadcrumbDeps,
  ) {
    document.addEventListener("click", () => this.closeMenu());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.closeMenu();
    });
  }

  private crumbs(tab: Tab): Crumb[] {
    const root = this.deps.getWorkspaceRoot();
    if (!tab.path) return [{ label: tab.name }];
    const rel = workspaceRelativeParts(tab.path, root);
    if (rel && rel.length > 0) {
      const rootPath = root!.replace(/[\\/]+$/, "");
      const crumbs: Crumb[] = [];
      let acc = rootPath;
      rel.forEach((label, i) => {
        acc = `${acc}\\${label}`;
        crumbs.push(i === rel.length - 1 ? { label } : { label, dir: acc });
      });
      return crumbs;
    }
    const { base, parts } = splitAbsolutePath(tab.path);
    const crumbs: Crumb[] = base ? [{ label: base, dir: base }] : [];
    let acc = base;
    parts.forEach((label, i) => {
      acc = acc ? `${acc}\\${label}` : label;
      crumbs.push(i === parts.length - 1 ? { label } : { label, dir: acc });
    });
    return crumbs;
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
    this.menuDir = null;
  }

  /**
   * 列出 listDir 的内容：highlight 那一行标为「当前」，点击子目录继续下钻、点击文件快速打开。
   * highlight 为 null 表示纯下钻视角（没有同级项需要定位）。
   */
  private async fillMenu(
    menu: HTMLElement,
    listDir: string,
    anchor: HTMLElement,
    highlight: string | null,
  ): Promise<void> {
    menu.innerHTML = "";

    const title = document.createElement("div");
    title.className = "bc-title";
    title.textContent = listDir;
    title.title = listDir;
    menu.append(title);

    // 首行「上一级」：没有父目录（盘符根 / UNC 根）时不显示
    const up = levelDirOf(listDir);
    if (!samePath(up, listDir)) {
      const upRow = document.createElement("div");
      upRow.className = "bc-entry bc-up";
      upRow.title = up;
      const upIcon = document.createElement("span");
      upIcon.className = "bc-icon";
      upIcon.textContent = "\u2191";
      const upName = document.createElement("span");
      upName.className = "bc-name";
      upName.textContent = "上一级";
      upRow.append(upIcon, upName);
      upRow.addEventListener("click", (e) => {
        e.stopPropagation();
        // 回到上一层，并把刚离开的目录高亮为「当前」
        void this.fillMenu(menu, up, anchor, listDir);
      });
      menu.append(upRow);
    }

    const place = (): void => {
      const rect = anchor.getBoundingClientRect();
      placeMenu(menu, rect.left, rect.bottom + 2);
    };
    place();

    let entries: { name: string; path: string; is_dir: boolean }[];
    try {
      entries = await invoke("list_dir", { path: listDir });
    } catch (e) {
      const err = document.createElement("div");
      err.className = "bc-empty";
      err.textContent = `读取失败：${String(e).split("\n")[0]}`;
      menu.append(err);
      place();
      return;
    }

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "bc-empty";
      empty.textContent = "（空目录）";
      menu.append(empty);
      place();
      return;
    }

    for (const entry of entries) {
      const current = highlight !== null && samePath(entry.path, highlight);
      const row = document.createElement("div");
      row.className = current ? "bc-entry current" : "bc-entry";
      if (current) row.setAttribute("aria-current", "true");
      const icon = document.createElement("span");
      icon.className = "bc-icon";
      icon.append(createEntryIcon(entry.name, entry.is_dir));
      const name = document.createElement("span");
      name.className = "bc-name";
      name.textContent = entry.name;
      row.append(icon, name);
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        if (entry.is_dir) {
          // 主动点击才进入下一级，默认视图停留在当前层级
          void this.fillMenu(menu, entry.path, anchor, null);
        } else {
          this.closeMenu();
          this.deps.onOpenFile(entry.path);
        }
      });
      menu.append(row);
    }
    place();
  }

  /** target：该段对应的真实路径（目录段＝目录，文件段＝文件） */
  private async showMenu(target: string, anchor: HTMLElement): Promise<void> {
    // 再次点击同一段＝收起
    if (this.menu && this.menuDir === target) {
      this.closeMenu();
      return;
    }
    this.closeMenu();
    const menu = document.createElement("div");
    menu.className = "context-menu breadcrumb-menu";
    menu.addEventListener("click", (e) => e.stopPropagation());
    document.body.append(menu);
    this.menu = menu;
    this.menuDir = target;
    // 点这一段的用处是「换个同级项」，所以列它所在的那一层并把这一段高亮
    await this.fillMenu(menu, levelDirOf(target), anchor, target);
  }

  /** 渲染当前标签的面包屑：工作区内从子目录开始，工作区外用绝对路径 */
  render(): void {
    const active = this.deps.getActiveTab();
    const signature = `${this.deps.getWorkspaceRoot() ?? ""}\u0001${active?.id ?? ""}\u0001${active?.path ?? ""}\u0001${active?.name ?? ""}`;
    if (signature === this.signature) return;
    this.signature = signature;

    this.closeMenu();
    this.container.innerHTML = "";
    const tab = this.deps.getActiveTab();
    this.container.classList.toggle("hidden", !tab);
    if (!tab) return;

    const crumbs = this.crumbs(tab);
    crumbs.forEach((crumb, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "breadcrumb-sep";
        sep.textContent = ">";
        this.container.append(sep);
      }
      // 每段都能点：目录段看自身所在层，文件段看文件所在目录（同级文件）
      const isLast = i === crumbs.length - 1;
      const target = crumb.dir ?? (isLast ? (tab.path ?? undefined) : undefined);
      const el = document.createElement("span");
      el.className = crumb.dir ? "breadcrumb-item" : "breadcrumb-item current";
      if (target) el.classList.add("clickable");
      el.textContent = crumb.label;
      el.title = target ?? tab.name;
      if (target) {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.showMenu(target, el);
        });
      }
      this.container.append(el);
    });
  }
}
