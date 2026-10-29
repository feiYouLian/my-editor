/**
 * 用户可扩展资源（主题 / 语言）的读写封装，对应 Rust 侧四个命令（commands/config.rs）：
 * - list_user_themes / open_user_themes_dir   → <配置目录>/themes/*.json
 * - list_user_languages / open_user_languages_dir → <配置目录>/languages/*.json
 *
 * 解析与校验在前端（config/userThemes.ts、config/userLanguages.ts）：
 * 配色键名与关键字语义都属于编辑器侧，后端只负责把文件读出来。
 * 任何失败都落在返回值的 errors 里，不抛出——启动路径不该被一个坏文件打断。
 */

import { invoke } from "@tauri-apps/api/core";
import { parseThemeEntries, type UserTheme } from "../config/userThemes";
import { parseLanguageEntries, type UserLanguageSpec } from "../config/userLanguages";

interface UserFilePayload {
  name: string;
  content: string;
}

export interface ThemeLoadResult {
  themes: UserTheme[];
  /** 需要告诉用户的问题（坏文件 / 未知键 / 目录读取失败），调用方汇总提示 */
  errors: string[];
}

export interface LanguageLoadResult {
  languages: UserLanguageSpec[];
  errors: string[];
}

function reason(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.split("\n")[0];
}

/** 读取并解析全部自定义主题 */
export async function loadUserThemes(): Promise<ThemeLoadResult> {
  try {
    const files = await invoke<UserFilePayload[]>("list_user_themes");
    return parseThemeEntries(files);
  } catch (e) {
    return { themes: [], errors: [`读取主题目录失败：${reason(e)}`] };
  }
}

/** 打开主题目录（首次会写入示例主题），返回目录绝对路径 */
export function openThemesDir(): Promise<string> {
  return invoke<string>("open_user_themes_dir");
}

/** 读取并解析全部自定义语言 */
export async function loadUserLanguages(): Promise<LanguageLoadResult> {
  try {
    const files = await invoke<UserFilePayload[]>("list_user_languages");
    return parseLanguageEntries(files);
  } catch (e) {
    return { languages: [], errors: [`读取语言目录失败：${reason(e)}`] };
  }
}

/** 打开语言目录（首次会写入示例语言文件），返回目录绝对路径 */
export function openLanguagesDir(): Promise<string> {
  return invoke<string>("open_user_languages_dir");
}
