/**
 * 路径面包屑：层级渲染（签名优化）+ 目录下拉（内容预览、下钻、快速打开）。
 *
 * 工作区根由调用方经 deps 注入（它是 app 级状态，不在此模块持有）。
 */

import { invoke } from "@tauri-apps/api/core";
import { splitAbsolutePath, workspaceRelativeParts } from "../core/paths";
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

  /** 展开目录内容预览；点击子目录继续下钻，点击文件快速打开 */
  private async fillMenu(menu: HTMLElement, dir: string, anchor: HTMLElement): Promise<void> {
    this.menuDir = dir;
    menu.innerHTML = "";

    const title = document.createElement("div");
    title.className = "bc-title";
    title.textContent = dir;
    title.title = dir;
    menu.append(title);

    const place = (): void => {
      const rect = anchor.getBoundingClientRect();
      placeMenu(menu, rect.left, rect.bottom + 2);
    };
    place();

    let entries: { name: string; path: string; is_dir: boolean }[];
    try {
      entries = await invoke("list_dir", { path: dir });
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
      const row = document.createElement("div");
      row.className = "bc-entry";
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
          void this.fillMenu(menu, entry.path, anchor);
        } else {
          this.closeMenu();
          this.deps.onOpenFile(entry.path);
        }
      });
      menu.append(row);
    }
    place();
  }

  private async showMenu(dir: string, anchor: HTMLElement): Promise<void> {
    // 再次点击同一层级＝收起
    if (this.menu && this.menuDir === dir) {
      this.closeMenu();
      return;
    }
    this.closeMenu();
    const menu = document.createElement("div");
    menu.className = "context-menu breadcrumb-menu";
    menu.addEventListener("click", (e) => e.stopPropagation());
    document.body.append(menu);
    this.menu = menu;
    await this.fillMenu(menu, dir, anchor);
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

    this.crumbs(tab).forEach((crumb, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "breadcrumb-sep";
        sep.textContent = ">";
        this.container.append(sep);
      }
      const el = document.createElement("span");
      el.className = crumb.dir ? "breadcrumb-item" : "breadcrumb-item current";
      el.textContent = crumb.label;
      el.title = crumb.dir ?? tab.path ?? tab.name;
      if (crumb.dir) {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.showMenu(crumb.dir!, el);
        });
      }
      this.container.append(el);
    });
  }
}
