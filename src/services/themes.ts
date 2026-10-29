/**
 * 自定义主题服务：封装 Rust 侧两个命令（见 commands/config.rs）。
 * - list_user_themes：列出 <配置目录>/themes/*.json（原始文本）
 * - open_user_themes_dir：创建目录（首次写入示例主题）并在文件管理器中打开
 *
 * 解析与校验在前端（config/userThemes.ts）：配色键名是编辑器语义。
 */

import { invoke } from "@tauri-apps/api/core";
import { parseThemeEntries, type UserTheme } from "../config/userThemes";

interface ThemeFilePayload {
  name: string;
  content: string;
}

export interface ThemeLoadResult {
  themes: UserTheme[];
  /** 需要告诉用户的问题（坏文件 / 未知键 / 目录读取失败），调用方汇总提示 */
  errors: string[];
}

/** 读取并解析全部自定义主题；任何失败都落进 errors，不抛出 */
export async function loadUserThemes(): Promise<ThemeLoadResult> {
  try {
    const files = await invoke<ThemeFilePayload[]>("list_user_themes");
    return parseThemeEntries(files);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { themes: [], errors: [`读取主题目录失败：${reason.split("\n")[0]}`] };
  }
}

/** 打开主题目录（首次会写入示例主题），返回目录绝对路径 */
export function openThemesDir(): Promise<string> {
  return invoke<string>("open_user_themes_dir");
}
