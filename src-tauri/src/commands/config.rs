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
    /// 代码折叠：gutter 折叠标记 + 折叠快捷键
    pub code_folding: bool,
    /// 自动闭合括号 / 引号
    pub auto_close_brackets: bool,
    /// 输入时按语言自动缩进
    pub auto_indent: bool,
    /// 文档内单词补全（无词库、无后台连接）
    pub word_completion: bool,
    /// 按文件检测缩进（Tab 宽度 / 空格 or Tab）
    pub detect_indent: bool,
    /// 列标尺：在这些字符列画竖线（空数组 = 关闭）
    pub rulers: Vec<u32>,
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
            code_folding: true,
            auto_close_brackets: true,
            auto_indent: true,
            word_completion: true,
            detect_indent: true,
            rulers: Vec::new(),
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
    /// 右侧 Minimap 缩略图
    pub minimap: bool,
    /// 编辑器字号（px）
    pub editor_font_size: u32,
    /// 状态栏字段（数组顺序即展示顺序）
    pub status_bar_fields: Vec<StatusBarFieldEntry>,
    /// 侧栏当前视图：files / search / outline
    pub sidebar_view: String,
    /// 启动时展开的侧栏分区组合（如 ["files", "outline"]；空 = 默认展开「文件」）
    pub sidebar_expanded: Vec<String>,
    /// 侧栏分区高度（px，键为分区 id；仅记录用户手拖的高度）
    pub sidebar_sizes: BTreeMap<String, f64>,
}

impl Default for LayoutSettings {
    fn default() -> Self {
        Self {
            sidebar_visible: true,
            split_ratio: 0.5,
            default_view_mode: "split".into(),
            show_line_numbers: true,
            show_active_line: true,
            minimap: true,
            editor_font_size: 13,
            status_bar_fields: default_status_bar_fields(),
            sidebar_view: "files".into(),
            sidebar_expanded: vec!["files".into()],
            sidebar_sizes: BTreeMap::new(),
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

/// 文件树 / 侧栏列表的交互设置
#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct FileSettings {
    /// 打开手势：true = 双击（首次点击仅选中），false = 单击
    pub open_with_double_click: bool,
    /// 保存前删除行尾空白（默认关：会改动用户文件）
    pub trim_trailing_whitespace_on_save: bool,
    /// 保存前补最终换行（默认关）
    pub ensure_final_newline_on_save: bool,
    /// 按文件记忆编码（默认开：只在自动检测不可靠时生效）
    pub encode_memory: bool,
}

impl Default for FileSettings {
    fn default() -> Self {
        Self {
            open_with_double_click: false,
            trim_trailing_whitespace_on_save: false,
            ensure_final_newline_on_save: false,
            encode_memory: true,
        }
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
    pub files: FileSettings,
    pub ignore_dirs: Vec<String>,
    pub file_encoding_memory: BTreeMap<String, String>,
    pub formatters: BTreeMap<String, FormatterEntry>,
    pub ai: AiSettings,
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
            files: FileSettings::default(),
            ignore_dirs: vec!["node_modules".into(), ".git".into(), "dist".into()],
            file_encoding_memory: BTreeMap::new(),
            formatters: default_formatters(),
            ai: AiSettings::default(),
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

/// 在系统文件管理器中打开配置目录。
///
/// 路径由后端自行解析、不接受前端传入，因此不经 PathGuard
/// （PathGuard 限制的是"可写文件的作用域"，配置目录不属于工作区）。
#[tauri::command]
pub fn reveal_config_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = config_dir(&app)?;
    crate::commands::fs::reveal_path(&dir, false)
}

fn config_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("config.json"))
}

// ---------------------------------------------------------------------------
// 自定义编辑器主题：<配置目录>/themes/*.json
// ---------------------------------------------------------------------------

/// 主题目录里的单个文件：名称取文件名（去扩展名），内容原样交给前端解析。
/// 不在后端解析配色——键名与 CodeMirror 语法 tag 的映射属于编辑器语义，
/// 后端只负责把文件读出来（与 formatters 表把工具解析留在后端是相反的分工，
/// 因为配色不涉及执行、不构成 RCE 面）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserThemeFile {
    pub name: String,
    pub content: String,
}

/// 目录扫描上限：主题是两三 KB 的色值表，超过这个量说明目录被塞了别的东西
const MAX_THEME_FILES: usize = 100;
/// 单文件上限：正常主题 < 4 KB
const MAX_THEME_BYTES: u64 = 512 * 1024;
/// 首次打开主题目录时写入的示例文件名
const SAMPLE_THEME_FILE: &str = "example-slate.json";
/// 示例主题：用户照它改比看文档快
/// 注意用 r##"..."## —— 内容里有 `"#rrggbb"`，`"#` 会提前终止 r#"..."#
const SAMPLE_THEME: &str = r##"{
  "name": "示例：石板蓝",
  "dark": true,
  "ui": {
    "background": "#0f172a",
    "foreground": "#cbd5e1",
    "caret": "#e2e8f0",
    "selection": "#1e3a5f",
    "activeLine": "#152033",
    "gutterBackground": "#0b1220",
    "gutterForeground": "#64748b"
  },
  "syntax": {
    "keyword": "#c792ea",
    "string": "#c3e88d",
    "number": "#f78c6c",
    "comment": "#64748b",
    "variableName": "#cbd5e1",
    "function": "#82aaff",
    "typeName": "#ffcb6b",
    "propertyName": "#89ddff",
    "operator": "#89ddff",
    "bracket": "#f07178",
    "tagName": "#f07178",
    "attributeName": "#f78c6c",
    "heading": "#82aaff",
    "link": "#82aaff",
    "invalid": "#ff5370"
  }
}
"##;

fn themes_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("themes"))
}

/// 列出 themes/*.json。目录不存在返回空表（= 没有自定义主题），不是错误。
#[tauri::command]
pub async fn list_user_themes(app: tauri::AppHandle) -> Result<Vec<UserThemeFile>, String> {
    let dir = themes_dir(&app)?;
    // 重活放阻塞线程：最多 100 次小文件读取，不占 async 主体
    tauri::async_runtime::spawn_blocking(move || collect_theme_files(&dir))
        .await
        .map_err(|e| format!("主题读取任务失败: {e}"))
}

fn collect_theme_files(dir: &Path) -> Vec<UserThemeFile> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        if out.len() >= MAX_THEME_FILES {
            break;
        }
        let path = entry.path();
        let is_json = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("json"))
            .unwrap_or(false);
        if !is_json {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        // 文件名会进 UI 与 config.json 的取值，白名单过滤奇怪字符
        if stem.is_empty()
            || !stem
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        {
            continue;
        }
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if size == 0 || size > MAX_THEME_BYTES {
            eprintln!("[theme] 跳过 {}：大小 {size} 字节", path.display());
            continue;
        }
        match fs::read_to_string(&path) {
            Ok(content) => out.push(UserThemeFile {
                name: stem.to_string(),
                content,
            }),
            Err(e) => eprintln!("[theme] 读取失败 {}: {e}", path.display()),
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// 打开主题目录；目录不存在则创建并写入示例主题（让「自定义主题」有个可改的起点）。
#[tauri::command]
pub fn open_user_themes_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = themes_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建主题目录失败: {e}"))?;
    let sample = dir.join(SAMPLE_THEME_FILE);
    if !sample.exists() {
        if let Err(e) = fs::write(&sample, SAMPLE_THEME) {
            eprintln!("[theme] 写入示例主题失败: {e}");
        }
    }
    crate::commands::fs::reveal_path(&dir, false)?;
    Ok(dir.to_string_lossy().to_string())
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 旧配置缺少 layout.minimap（v2 之前的 config.json）：应取默认 true，且不影响同段其它字段
    #[test]
    fn legacy_config_without_minimap_uses_default() {
        let legacy = r#"{"version":2,"layout":{"splitRatio":0.6,"showLineNumbers":false}}"#;
        let cfg: AppConfig = serde_json::from_str(legacy).expect("旧配置应可解析");
        assert!(cfg.layout.minimap);
        assert!(!cfg.layout.show_line_numbers);
        assert!((cfg.layout.split_ratio - 0.6).abs() < f64::EPSILON);
    }

    /// 输入手感 / 保存清理四组开关：JSON 往返不丢（新增字段必须有往返测试）
    #[test]
    fn input_and_save_cleanup_fields_roundtrip() {
        let mut cfg = AppConfig::default();
        cfg.editor_enhancements.auto_close_brackets = false;
        cfg.editor_enhancements.auto_indent = false;
        cfg.editor_enhancements.word_completion = false;
        cfg.editor_enhancements.detect_indent = false;
        cfg.files.trim_trailing_whitespace_on_save = true;
        cfg.files.ensure_final_newline_on_save = true;
        cfg.files.encode_memory = false;
        cfg.editor_enhancements.rulers = vec![80, 120];

        let json = serde_json::to_string(&cfg).expect("序列化");
        let back: AppConfig = serde_json::from_str(&json).expect("反序列化");

        assert!(!back.editor_enhancements.auto_close_brackets);
        assert!(!back.editor_enhancements.auto_indent);
        assert!(!back.editor_enhancements.word_completion);
        assert!(!back.editor_enhancements.detect_indent);
        assert!(back.files.trim_trailing_whitespace_on_save);
        assert!(back.files.ensure_final_newline_on_save);
        assert!(!back.files.encode_memory);
        assert_eq!(back.editor_enhancements.rulers, vec![80, 120]);
    }

    /// 旧配置缺少新字段时取默认值（默认开的三项不能被当成 false）
    #[test]
    fn legacy_config_without_input_fields_uses_defaults() {
        let legacy = r#"{"version":2,"editorEnhancements":{"bracketMatching":false}}"#;
        let cfg: AppConfig = serde_json::from_str(legacy).expect("旧配置应可解析");
        assert!(cfg.editor_enhancements.auto_close_brackets);
        assert!(cfg.editor_enhancements.auto_indent);
        assert!(cfg.editor_enhancements.word_completion);
        assert!(cfg.editor_enhancements.detect_indent);
        assert!(!cfg.files.trim_trailing_whitespace_on_save);
        assert!(!cfg.files.ensure_final_newline_on_save);
        assert!(cfg.files.encode_memory);
        assert!(!cfg.editor_enhancements.bracket_matching);
    }

    /// 显式关闭后往返一次不丢字段
    #[test]
    fn minimap_roundtrips() {
        let mut cfg = AppConfig::default();
        cfg.layout.minimap = false;
        let json = serde_json::to_string(&cfg).expect("序列化");
        assert!(json.contains("\"minimap\":false"));
        let back: AppConfig = serde_json::from_str(&json).expect("反序列化");
        assert!(!back.layout.minimap);
    }

    /// 主题目录扫描：只收 .json、文件名白名单、空文件跳过、按名字排序
    #[test]
    fn collect_theme_files_filters_and_sorts() {
        let dir = std::env::temp_dir().join(format!("my-editor-themes-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("建临时目录");
        fs::write(dir.join("b.json"), SAMPLE_THEME).expect("写 b");
        fs::write(dir.join("a.json"), "{\"syntax\":{\"keyword\":\"#fff\"}}").expect("写 a");
        fs::write(dir.join("empty.json"), "").expect("写空文件");
        fs::write(dir.join("note.txt"), "x").expect("写非 json");
        fs::write(dir.join("bad name.json"), "{}").expect("写带空格的文件名");

        let files = collect_theme_files(&dir);
        let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
        // empty.json 大小为 0 被跳过；note.txt 非 json；带空格名不在白名单
        assert_eq!(names, vec!["a", "b"]);
        assert!(files.iter().all(|f| !f.content.is_empty()));

        let _ = fs::remove_dir_all(&dir);
    }

    /// 目录不存在 = 没有自定义主题，不应报错
    #[test]
    fn collect_theme_files_missing_dir_is_empty() {
        let dir = std::env::temp_dir().join("my-editor-themes-does-not-exist");
        let _ = fs::remove_dir_all(&dir);
        assert!(collect_theme_files(&dir).is_empty());
    }
}
