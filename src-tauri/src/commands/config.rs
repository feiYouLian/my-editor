//! 配置后端。
//! config.json 位于 Tauri 应用配置目录：
//! - load_config：读取 + 版本迁移（缺失字段以默认值补齐，迁移/首次生成前备份 .bak）
//! - save_config：临时文件 → rename 原子替换
//! - config_path：返回路径（供「打开配置文件」入口）
//!
//! 含 theme / keybindings / layout 段，供设置 UI 使用。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// 当前配置版本（迁移基准）
pub const CONFIG_VERSION: u32 = 2;

// ---------------------------------------------------------------------------
// 配置结构（serde container default = 缺失字段以 Default::default() 补齐）
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct EditorEnhancements {
    pub column_selection: bool,
    pub column_selection_modifier: String,
    pub column_editor_key: String,
    pub occurrence_highlight: bool,
    pub show_whitespace: bool,
    pub bracket_matching: bool,
    pub indent_guides: bool,
    /// 彩虹括号：括号对按嵌套深度循环着色
    pub rainbow_brackets: bool,
    /// 自动换行：长行按编辑区宽度折行
    pub word_wrap: bool,
}

impl Default for EditorEnhancements {
    fn default() -> Self {
        Self {
            column_selection: true,
            column_selection_modifier: "Alt".into(),
            column_editor_key: "Alt+c".into(),
            occurrence_highlight: true,
            show_whitespace: false,
            bracket_matching: true,
            indent_guides: true,
            rainbow_brackets: true,
            word_wrap: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct KeybindingEntry {
    pub command: String,
    pub key: String,
}

impl Default for KeybindingEntry {
    fn default() -> Self {
        Self {
            command: String::new(),
            key: String::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct StatusBarFieldEntry {
    pub id: String,
    pub visible: bool,
}

impl Default for StatusBarFieldEntry {
    fn default() -> Self {
        Self {
            id: String::new(),
            visible: true,
        }
    }
}

/// 状态栏字段默认显隐顺序（与前端 index.html data-field 对应）
fn default_status_bar_fields() -> Vec<StatusBarFieldEntry> {
    [
        "path",
        "readonly",
        "size",
        "encoding",
        "newline",
        "language",
        "whitespace",
        "wrap",
        "cursor",
        "lines",
        "dirty",
    ]
    .iter()
    .map(|id| StatusBarFieldEntry {
        id: (*id).into(),
        visible: true,
    })
    .collect()
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct LayoutSettings {
    pub sidebar_visible: bool,
    pub split_ratio: f64,
    /// "edit" | "preview" | "split"
    pub default_view_mode: String,
    pub show_line_numbers: bool,
    pub show_active_line: bool,
    /// 编辑器字号（px）
    pub editor_font_size: u32,
    /// 状态栏字段（数组顺序即展示顺序）
    pub status_bar_fields: Vec<StatusBarFieldEntry>,
}

impl Default for LayoutSettings {
    fn default() -> Self {
        Self {
            sidebar_visible: true,
            split_ratio: 0.5,
            default_view_mode: "split".into(),
            show_line_numbers: true,
            show_active_line: true,
            editor_font_size: 13,
            status_bar_fields: default_status_bar_fields(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionSettings {
    pub restore_on_startup: bool,
    pub draft_autosave: bool,
    pub draft_debounce_ms: u64,
    pub draft_retention_days: u32,
}

impl Default for SessionSettings {
    fn default() -> Self {
        Self {
            restore_on_startup: true,
            draft_autosave: true,
            draft_debounce_ms: 1000,
            draft_retention_days: 7,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkspaceSettings {
    pub remember_expanded: bool,
    pub last_directory: String,
}

impl Default for WorkspaceSettings {
    fn default() -> Self {
        Self {
            remember_expanded: true,
            last_directory: String::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct LargeFileSettings {
    pub log_extensions: Vec<String>,
    pub sparse_index_anchor_bytes: u64,
    pub viewport_padding_lines: u32,
}

impl Default for LargeFileSettings {
    fn default() -> Self {
        Self {
            log_extensions: vec![".log".into()],
            sparse_index_anchor_bytes: 65536,
            viewport_padding_lines: 200,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct SearchSettings {
    pub parallelism: String,
    pub chunk_size_bytes: u64,
}

impl Default for SearchSettings {
    fn default() -> Self {
        Self {
            parallelism: "auto".into(),
            chunk_size_bytes: 4 * 1024 * 1024,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct FetchSettings {
    /// 允许抓取私网/本机地址（默认关，服务内网文档站时手动放开）
    pub allow_private_network: bool,
}

impl Default for FetchSettings {
    fn default() -> Self {
        Self {
            allow_private_network: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct TerminalSettings {
    /// 终端 shell：空串 = 自动检测（Windows 优先 pwsh，否则 powershell）
    pub shell: String,
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            shell: String::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct GlobalReplaceSettings {
    pub backup: bool,
}

impl Default for GlobalReplaceSettings {
    fn default() -> Self {
        Self { backup: true }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct FormatterEntry {
    pub tool: String,
    pub args: Vec<String>,
}

impl Default for FormatterEntry {
    fn default() -> Self {
        Self {
            tool: String::new(),
            args: Vec::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct AiSettings {
    pub provider: String,
    pub model: String,
    pub enabled: bool,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            provider: "ollama".into(),
            model: "qwen2.5-coder:7b".into(),
            enabled: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct LogSettings {
    pub level: String,
    pub dir: String,
    pub enabled: bool,
}

impl Default for LogSettings {
    fn default() -> Self {
        Self {
            level: "info".into(),
            dir: "logs".into(),
            enabled: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct AppConfig {
    pub version: u32,
    /// "dark" | "light" | "high-contrast" | "system"
    pub theme: String,
    /// 编辑器语法主题："dark" | "light" | "high-contrast"
    pub editor_theme: String,
    pub tab_size: u32,
    pub insert_spaces: bool,
    pub format_on_save: bool,
    pub highlighter_disabled_over: u32,
    pub large_file_threshold: u64,
    pub long_line_skip_chars: u32,
    pub language_extensions: BTreeMap<String, String>,
    pub editor_enhancements: EditorEnhancements,
    pub keybindings: Vec<KeybindingEntry>,
    pub layout: LayoutSettings,
    pub session: SessionSettings,
    pub workspace: WorkspaceSettings,
    pub large_file: LargeFileSettings,
    pub search: SearchSettings,
    pub fetch: FetchSettings,
    pub terminal: TerminalSettings,
    pub global_replace: GlobalReplaceSettings,
    pub ignore_dirs: Vec<String>,
    pub file_encoding_memory: BTreeMap<String, String>,
    pub formatters: BTreeMap<String, FormatterEntry>,
    pub ai: AiSettings,
    pub log: LogSettings,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            theme: "dark".into(),
            editor_theme: "dark".into(),
            tab_size: 2,
            insert_spaces: true,
            format_on_save: false,
            highlighter_disabled_over: 50000,
            large_file_threshold: 20 * 1024 * 1024,
            long_line_skip_chars: 2000,
            language_extensions: default_language_extensions(),
            editor_enhancements: EditorEnhancements::default(),
            keybindings: Vec::new(),
            layout: LayoutSettings::default(),
            session: SessionSettings::default(),
            workspace: WorkspaceSettings::default(),
            large_file: LargeFileSettings::default(),
            search: SearchSettings::default(),
            fetch: FetchSettings::default(),
            terminal: TerminalSettings::default(),
            global_replace: GlobalReplaceSettings::default(),
            ignore_dirs: vec!["node_modules".into(), ".git".into(), "dist".into()],
            file_encoding_memory: BTreeMap::new(),
            formatters: default_formatters(),
            ai: AiSettings::default(),
            log: LogSettings::default(),
        }
    }
}

fn default_language_extensions() -> BTreeMap<String, String> {
    BTreeMap::from([
        (".js".into(), "javascript".into()),
        (".ts".into(), "typescript".into()),
        (".py".into(), "python".into()),
        (".rs".into(), "rust".into()),
        (".java".into(), "java".into()),
        (".md".into(), "markdown".into()),
        (".log".into(), "plaintext".into()),
    ])
}

fn default_formatters() -> BTreeMap<String, FormatterEntry> {
    BTreeMap::from([
        (
            "python".into(),
            FormatterEntry {
                tool: "black".into(),
                args: vec!["-q".into(), "-".into()],
            },
        ),
        (
            "go".into(),
            FormatterEntry {
                tool: "gofmt".into(),
                args: Vec::new(),
            },
        ),
        (
            "java".into(),
            FormatterEntry {
                tool: "google-java-format".into(),
                args: vec!["--aosp".into()],
            },
        ),
        (
            "rust".into(),
            FormatterEntry {
                tool: "rustfmt".into(),
                args: Vec::new(),
            },
        ),
        (
            "cpp".into(),
            FormatterEntry {
                tool: "clang-format".into(),
                args: vec!["-style=file".into(), "-assume-filename=__PLACEHOLDER__".into()],
            },
        ),
    ])
}

// ---------------------------------------------------------------------------
// 读写与迁移
// ---------------------------------------------------------------------------

fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("获取配置目录失败: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    Ok(dir)
}

fn config_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("config.json"))
}

/// 迁移前备份（config.json → config.json.bak），原文件不存在则跳过
fn backup(path: &Path) {
    if path.exists() {
        let bak = path.with_extension("json.bak");
        if let Err(e) = fs::copy(path, &bak) {
            eprintln!("[config] 备份失败: {e}");
        }
    }
}

/// 原子写入：临时文件 → rename 替换
fn write_config(path: &Path, cfg: &AppConfig) -> Result<(), String> {
    let json = serde_json::to_string_pretty(cfg).map_err(|e| format!("序列化失败: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| format!("写入失败: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("替换失败: {e}"))?;
    Ok(())
}

/// 网页抓取是否允许访问私网：直接读 config.json（不信任前端入参）。
/// 读不到 / 解析失败一律返回 false（安全默认）。
pub(crate) fn fetch_allow_private(app: &tauri::AppHandle) -> bool {
    let Ok(path) = config_file(app) else {
        return false;
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return false;
    };
    serde_json::from_str::<AppConfig>(&text)
        .map(|cfg| cfg.fetch.allow_private_network)
        .unwrap_or(false)
}

/// 版本迁移：旧版本在此逐版补默认值 / 移除废弃键（当前仅 bump 版本号）
fn migrate(cfg: &mut AppConfig) -> bool {
    if cfg.version < CONFIG_VERSION {
        cfg.version = CONFIG_VERSION;
        return true;
    }
    false
}

/// 读取配置：缺失/损坏/旧版本时回退默认并写回（写回前备份）
#[tauri::command]
pub fn load_config(app: tauri::AppHandle) -> AppConfig {
    let Ok(path) = config_file(&app) else {
        return AppConfig::default();
    };

    let raw = fs::read_to_string(&path).ok();
    let existed = raw.is_some();
    let (mut cfg, parse_ok) = match raw.as_deref() {
        Some(text) => match serde_json::from_str::<AppConfig>(text) {
            Ok(c) => (c, true),
            Err(e) => {
                eprintln!("[config] 解析失败，回退默认值: {e}");
                (AppConfig::default(), false)
            }
        },
        None => (AppConfig::default(), false),
    };

    let migrated = migrate(&mut cfg);
    if !existed || !parse_ok || migrated {
        backup(&path);
        if let Err(e) = write_config(&path, &cfg) {
            eprintln!("[config] 写回失败: {e}");
        }
    }
    cfg
}

/// 保存配置（临时文件 + 原子替换）
#[tauri::command]
pub fn save_config(app: tauri::AppHandle, config: AppConfig) -> Result<(), String> {
    let path = config_file(&app)?;
    write_config(&path, &config)
}

/// 配置文件绝对路径（供前端「打开配置文件」入口）
#[tauri::command]
pub fn config_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(config_file(&app)?.to_string_lossy().to_string())
}
