declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";

  /** 一次性注册 GFM 扩展（表格 / 删除线 / 任务列表） */
  export function gfm(service: TurndownService): void;
  export function tables(service: TurndownService): void;
  export function strikethrough(service: TurndownService): void;
  export function taskListItems(service: TurndownService): void;
}
