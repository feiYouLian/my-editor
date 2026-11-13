//! Git 源代码管理：状态查询、暂存 / 取消暂存、提交，以及分支列表 / 切换 / 拉取。
//!
//! 全部通过 git CLI 执行，参数以数组传递（不拼 shell）；
//! 状态与分支解析抽成纯函数便于单测；命令均放 spawn_blocking，避免阻塞主线程。
//! 安全边界：工作区根经 PathGuard 校验；relative 路径拒绝 `..` 与绝对路径；
//! 分支名拒绝 `-` 开头与空白 / 控制字符。

use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::commands::paths::PathGuard;

/// 状态条目上限：超大仓库截断，避免前端渲染与 IPC 负载失控
const MAX_ENTRIES: usize = 5000;

#[derive(Serialize)]
pub struct GitFileEntry {
    /// 绝对路径（前端打开 diff 用）
    pub path: String,
    /// 相对仓库根，`/` 分隔（git 命令入参）
    pub relative: String,
    /// porcelain 状态字母（M/A/D/R/C/U/?）
    pub status: String,
    /// 重命名的旧相对路径
    pub orig_relative: Option<String>,
}

#[derive(Serialize)]
pub struct GitStatus {
    /// 仓库根（绝对路径；非仓库时为空）
    pub root: String,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub staged: Vec<GitFileEntry>,
    pub changes: Vec<GitFileEntry>,
    /// 非 git 仓库 / git 不可用原因（空串 = 正常）
    pub error: String,
    /// 条目超过上限被截断
    pub truncated: bool,
}

/// 执行 git 命令（参数数组；失败返回 stderr 原文）
pub(crate) fn git(dir: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.current_dir(dir).args(args);
    let out = crate::commands::no_console(&mut cmd)
        .output()
        .map_err(|e| format!("git 不可用: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// 网络类命令（pull / push）。
///
/// 两点与普通命令不同：
/// - `GIT_TERMINAL_PROMPT=0`：无 TTY 时禁止交互式凭据询问，否则会挂死；
/// - 成功时 stdout + stderr 合并返回：`git push` 的摘要走的是 stderr。
fn git_net(dir: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.current_dir(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        // 网络命令防止永久挂住：低于 1KB/s 持续 30 秒由 git 自己中止
        .env("GIT_HTTP_LOW_SPEED_LIMIT", "1000")
        .env("GIT_HTTP_LOW_SPEED_TIME", "30");
    let out = crate::commands::no_console(&mut cmd)
        .output()
        .map_err(|e| format!("git 不可用: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    if !out.status.success() {
        let msg = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        return Err(msg.to_string());
    }
    Ok(format!("{stdout}{stderr}"))
}

/// 解析 `git status --porcelain=v1 -z` 输出。
///
/// - 每条以 NUL 结尾；`XY PATH`，重命名/复制条目后跟旧路径；
/// - `X` 为暂存区状态、`Y` 为工作区状态；
/// - 未跟踪（`??`）与冲突（`U` / `AA` / `DD`）单独归并到 changes。
fn parse_status_z(
    root: &Path,
    output: &str,
) -> (Vec<GitFileEntry>, Vec<GitFileEntry>, bool) {
    let mut staged = Vec::new();
    let mut changes = Vec::new();
    let mut truncated = false;
    let mut parts = output.split('\0').filter(|s| !s.is_empty());

    while let Some(record) = parts.next() {
        if record.len() < 4 {
            continue;
        }
        let bytes = record.as_bytes();
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        // 前两字节状态 + 一个空格，之后是路径
        let relative = &record[3..];
        let is_rename = matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C');
        let orig_relative = if is_rename {
            parts.next().map(|s| s.to_string())
        } else {
            None
        };

        let make = |status: char, rel: &str| GitFileEntry {
            path: root.join(rel).to_string_lossy().to_string(),
            relative: rel.to_string(),
            status: status.to_string(),
            orig_relative: orig_relative.clone(),
        };

        let conflict = matches!((x, y), ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D'));
        if conflict {
            changes.push(make('U', relative));
        } else if x == '?' {
            changes.push(make('?', relative));
        } else {
            if x != ' ' {
                staged.push(make(x, relative));
            }
            if y != ' ' {
                changes.push(make(y, relative));
            }
        }

        if staged.len() + changes.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
    }

    (staged, changes, truncated)
}

/// 工作区根 → 仓库根（非仓库返回 Err，供操作命令使用）
fn repo_root_of(dir: &str) -> Result<String, String> {
    Ok(git(dir, &["rev-parse", "--show-toplevel"])?
        .trim()
        .to_string())
}

#[derive(Serialize)]
pub struct GitBranch {
    pub name: String,
    /// 当前 HEAD 所在分支
    pub current: bool,
    /// 相对上游的领先 / 落后提交数（无上游为 0）
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub date: String,
    /// 分支 / tag 装饰（可能为空）
    pub refs: String,
    pub subject: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    /// 1 基行号
    pub line: usize,
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    /// Unix 秒；前端按本地时区格式化
    pub author_time: u64,
    pub summary: String,
    /// 该行内容（不含行尾）
    pub content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameReport {
    pub lines: Vec<BlameLine>,
    /// 超过展示上限（10000 行）
    pub truncated: bool,
}

/// 解析 `for-each-ref --format=%(HEAD)%09%(refname:short)%09%(upstream:track)`。
///
/// - `%(HEAD)` 当前分支为 `*`；
/// - `%(upstream:track)` 形如 `[ahead 1, behind 2]` / `[ahead 1]` / `[gone]` / 空；
/// - 当前分支置顶，其余按名称排序（展示顺序稳定）。
fn parse_branches(output: &str) -> Vec<GitBranch> {
    let mut out = Vec::new();
    for line in output.lines() {
        let mut it = line.split('\t');
        let head = it.next().unwrap_or("");
        let name = it.next().unwrap_or("").trim();
        if name.is_empty() {
            continue;
        }
        let (ahead, behind) = parse_track(it.next().unwrap_or(""));
        out.push(GitBranch {
            name: name.to_string(),
            current: head.trim() == "*",
            ahead,
            behind,
        });
    }
    out.sort_by(|a, b| b.current.cmp(&a.current).then_with(|| a.name.cmp(&b.name)));
    out
}

/// 解析上游跟踪信息：`[ahead 1, behind 2]` / `[ahead 1]` / `[gone]` / 空
fn parse_track(track: &str) -> (u32, u32) {
    let mut ahead = 0;
    let mut behind = 0;
    let inner = track.trim().trim_start_matches('[').trim_end_matches(']');
    for part in inner.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind)
}

/// 校验分支名：拒绝空值、前导 `-`、`..`、空白与控制字符。
/// 名单本身来自 git，这里是 IPC 层的防御性校验。
fn validate_branch(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    let bad = name.is_empty()
        || name.starts_with('-')
        || name.starts_with('/')
        || name.ends_with('/')
        || name.contains("..")
        || name.chars().any(|c| c.is_control() || c.is_whitespace());
    if bad {
        return Err(format!("非法分支名: {raw}"));
    }
    Ok(name.to_string())
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// 读取 Git 状态：分支、ahead/behind、暂存的更改、更改（含未跟踪）。
/// 非仓库 / git 不可用不抛 Err，写入 `error` 字段供前端展示空态。
/// Git 只读模式守卫：所有会改动仓库的命令都先过这里。
///
/// 开关从 config.json 现读（不信任前端传入），因此即使前端被绕过/改坏也拦得住。
fn ensure_writable(app: &tauri::AppHandle) -> Result<(), String> {
    if super::config::read_config_snapshot(app).git.read_only {
        return Err(
            "Git 只读模式已开启：只能查看，暂存 / 提交 / 推送 / 分支变更 / 放弃更改等写入操作已禁用"
                .to_string(),
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn git_status(root: String) -> Result<GitStatus, String> {
    tauri::async_runtime::spawn_blocking(move || git_status_blocking(&root))
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}

fn git_status_blocking(dir: &str) -> Result<GitStatus, String> {
    let failed = |error: String| GitStatus {
        root: String::new(),
        branch: String::new(),
        ahead: 0,
        behind: 0,
        staged: Vec::new(),
        changes: Vec::new(),
        error,
        truncated: false,
    };

    let root = match repo_root_of(dir) {
        Ok(root) => root,
        Err(e) => return Ok(failed(e)),
    };
    let branch = git(&root, &["symbolic-ref", "--short", "-q", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "HEAD (detached)".to_string());
    let (ahead, behind) = git(
        &root,
        &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    )
    .ok()
    .and_then(|s| {
        let mut it = s.split_whitespace();
        Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
    })
    .unwrap_or((0, 0));

    let output = match git(
        &root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    ) {
        Ok(out) => out,
        Err(e) => return Ok(failed(e)),
    };
    let (staged, changes, truncated) = parse_status_z(Path::new(&root), &output);
    Ok(GitStatus {
        root,
        branch,
        ahead,
        behind,
        staged,
        changes,
        error: String::new(),
        truncated,
    })
}

/// 规范化并校验前端传入的相对路径：拒绝绝对路径、`..` 与空段
fn safe_relative(raw: &str) -> Result<String, String> {
    let norm = raw.replace('\\', "/");
    if norm.starts_with('/') || norm.split('/').any(|seg| seg.is_empty() || seg == "..") {
        return Err(format!("非法路径: {raw}"));
    }
    Ok(norm)
}

/// 暂存：`git add -- <relative paths>`（重命名需同时传旧/新路径）
#[tauri::command]
pub async fn git_stage(
    app: tauri::AppHandle,
    state: tauri::State<'_, PathGuard>,
    root: String,
    paths: Vec<String>,
) -> Result<(), String> {
    ensure_writable(&app)?;
    state.ensure_file_scope(&root)?;
    let relatives = normalize_relatives(&paths)?;
    tauri::async_runtime::spawn_blocking(move || stage_blocking(&root, &relatives))
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}

fn normalize_relatives(paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("没有选择文件".to_string());
    }
    paths.iter().map(|p| safe_relative(p)).collect()
}

fn stage_blocking(dir: &str, relatives: &[String]) -> Result<(), String> {
    let root = repo_root_of(dir)?;
    let mut args: Vec<&str> = vec!["add", "--"];
    args.extend(relatives.iter().map(|s| s.as_str()));
    git(&root, &args).map(|_| ())
}

/// 取消暂存：`git restore --staged`（git < 2.23 回退 `reset HEAD`；
/// 无提交的仓库回退 `rm --cached`，否则 HEAD 无法解析）
#[tauri::command]
pub async fn git_unstage(
    app: tauri::AppHandle,
    state: tauri::State<'_, PathGuard>,
    root: String,
    paths: Vec<String>,
) -> Result<(), String> {
    ensure_writable(&app)?;
    state.ensure_file_scope(&root)?;
    let relatives = normalize_relatives(&paths)?;
    tauri::async_runtime::spawn_blocking(move || unstage_blocking(&root, &relatives))
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}

fn unstage_blocking(dir: &str, relatives: &[String]) -> Result<(), String> {
    let root = repo_root_of(dir)?;
    for rel in relatives {
        unstage_one(&root, rel)?;
    }
    Ok(())
}

/// 取消暂存单个路径：`git restore --staged`（git < 2.23 回退 `reset HEAD`；
/// 无提交的仓库回退 `rm --cached`，否则 HEAD 无法解析）
fn unstage_one(root: &str, rel: &str) -> Result<(), String> {
    if git(root, &["rev-parse", "--verify", "HEAD"]).is_err() {
        return git(root, &["rm", "--cached", "--force", "--", rel]).map(|_| ());
    }
    if git(root, &["restore", "--staged", "--", rel]).is_ok() {
        return Ok(());
    }
    git(root, &["reset", "HEAD", "--", rel]).map(|_| ())
}

/// 差异块级暂存 / 取消暂存（G8）。
///
/// 用 `git diff -U0` 取最小 hunk，前端传入当前差异块的 oldStart/newStart；
/// 只把匹配到的那一个 hunk 拼成补丁，再用 `git apply --cached --unidiff-zero` 应用。
/// 这样不需要交互式 `git add -p`，也不会因上下文变化误暂存相邻改动。
#[tauri::command]
pub async fn git_stage_hunk(
    app: tauri::AppHandle,
    state: tauri::State<'_, PathGuard>,
    path: String,
    old_start: usize,
    new_start: usize,
    from_index: bool,
) -> Result<(), String> {
    ensure_writable(&app)?;
    state.ensure_file_scope(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        stage_hunk_blocking(&path, old_start, new_start, from_index)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

#[derive(Debug)]
struct GitPatchHunk {
    old_start: usize,
    new_start: usize,
    text: String,
}

fn stage_hunk_blocking(
    path: &str,
    old_start: usize,
    new_start: usize,
    from_index: bool,
) -> Result<(), String> {
    let (root, rel) = repo_relative(path)?;
    let mut args: Vec<String> = vec![
        "diff".into(),
        "--no-color".into(),
        "--no-ext-diff".into(),
        "--unified=0".into(),
    ];
    if from_index {
        args.push("--cached".into());
    }
    args.push("--".into());
    args.push(rel);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let patch = git(&root, &refs)?;
    if patch.trim().is_empty() {
        return Err(if from_index {
            "暂存区没有可取消的差异块（文件可能是未跟踪 / 已删除）".to_string()
        } else {
            "没有可暂存的差异块（未跟踪文件请整文件暂存）".to_string()
        });
    }
    let (header, hunks) = split_git_patch(&patch)?;
    let hunk = select_patch_hunk(&hunks, old_start, new_start)?;
    let mut full = header;
    full.push_str(&hunk.text);
    if !full.ends_with('\n') {
        full.push('\n');
    }
    run_git_patch(&root, &full, from_index, true)?;
    run_git_patch(&root, &full, from_index, false)?;
    Ok(())
}

/// 绝对路径 → (仓库根, 仓库内相对路径)；文件已删除时用父目录 + 文件名推导。
fn repo_relative(path: &str) -> Result<(String, String), String> {
    let p = Path::new(path);
    let parent = p.parent().ok_or_else(|| "无法确定文件所在目录".to_string())?;
    let root = repo_root_of(&parent.to_string_lossy())?;
    let root_path = Path::new(&root)
        .canonicalize()
        .unwrap_or_else(|_| Path::new(&root).to_path_buf());
    let name = p.file_name().ok_or_else(|| "路径缺少文件名".to_string())?;
    let abs = p
        .canonicalize()
        .or_else(|_| parent.canonicalize().map(|dir| dir.join(name)))
        .map_err(|e| format!("解析文件路径失败: {e}"))?;
    let rel = abs
        .strip_prefix(&root_path)
        .map_err(|_| "文件不在 Git 仓库内".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    Ok((root, rel))
}

/// 拆分 git 统一补丁：header + 每个 hunk 的原始文本（含 `@@` 行）。
fn split_git_patch(patch: &str) -> Result<(String, Vec<GitPatchHunk>), String> {
    let mut header = String::new();
    let mut hunks: Vec<GitPatchHunk> = Vec::new();
    let mut current: Option<GitPatchHunk> = None;
    for line in patch.split_inclusive('\n') {
        if line.starts_with("@@") {
            if let Some(hunk) = current.take() {
                hunks.push(hunk);
            }
            let (old_start, new_start) = parse_hunk_header(line)
                .ok_or_else(|| format!("无法解析补丁块头: {line}"))?;
            current = Some(GitPatchHunk {
                old_start,
                new_start,
                text: line.to_string(),
            });
        } else if let Some(hunk) = current.as_mut() {
            hunk.text.push_str(line);
        } else {
            header.push_str(line);
        }
    }
    if let Some(hunk) = current {
        hunks.push(hunk);
    }
    if hunks.is_empty() {
        return Err("补丁中没有差异块".to_string());
    }
    Ok((header, hunks))
}

fn parse_hunk_header(line: &str) -> Option<(usize, usize)> {
    let mut parts = line.trim_start_matches("@@").split_whitespace();
    let old = parts.next()?.trim_start_matches('-');
    let new = parts.next()?.trim_start_matches('+');
    let parse = |value: &str| value.split(',').next()?.parse::<usize>().ok();
    Some((parse(old)?, parse(new)?))
}

/// 按差异块起始行匹配；优先 new 行号，纯删除（new=0）时用 old 行号。
fn select_patch_hunk<'a>(
    hunks: &'a [GitPatchHunk],
    old_start: usize,
    new_start: usize,
) -> Result<&'a GitPatchHunk, String> {
    hunks
        .iter()
        .find(|h| new_start > 0 && h.new_start == new_start)
        .or_else(|| hunks.iter().find(|h| old_start > 0 && h.old_start == old_start))
        .ok_or_else(|| "差异块已变化，请重新打开差异视图后再试".to_string())
}

fn run_git_patch(root: &str, patch: &str, reverse: bool, check: bool) -> Result<(), String> {
    let mut cmd = Command::new("git");
    cmd.current_dir(root)
        .args(["apply", "--cached", "--unidiff-zero", "--whitespace=nowarn"]);
    if reverse {
        cmd.arg("--reverse");
    }
    if check {
        cmd.arg("--check");
    }
    cmd.arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = crate::commands::no_console(&mut cmd)
        .spawn()
        .map_err(|e| format!("git 不可用: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(patch.as_bytes())
            .map_err(|e| format!("写入补丁失败: {e}"))?;
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("等待 git apply 失败: {e}"))?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if msg.is_empty() {
            "git apply 失败".to_string()
        } else {
            msg
        });
    }
    Ok(())
}

/// 放弃更改前的快照上限：单文件
const MAX_SNAPSHOT_FILE_BYTES: u64 = 8 * 1024 * 1024;
/// 放弃更改前的快照上限：单次总量
const MAX_SNAPSHOT_TOTAL_BYTES: u64 = 32 * 1024 * 1024;
/// 保留最近多少批放弃备份
const KEEP_DISCARD_BACKUPS: usize = 10;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardOutcome {
    pub count: usize,
    /// 备份目录（没有可备份的文件时为 None）
    pub backup_dir: Option<String>,
    /// 因体积超限未备份的文件数
    pub skipped: usize,
}

/// 放弃更改前，把它将要覆盖 / 删除的工作区内容复制到配置目录。
///
/// 目录结构按相对路径保留，并写一份 `manifest.json`（仓库根 / 时间 / 文件清单），
/// 用户事后即使不在应用内也能直接翻文件找回。体积超限的文件跳过并计数。
fn snapshot_for_discard(
    repo_root: &str,
    relatives: &[String],
    backup_root: &Path,
) -> Result<(Option<String>, usize), String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dir = backup_root.join(stamp.to_string());
    let mut saved: Vec<String> = Vec::new();
    let mut skipped = 0usize;
    let mut total = 0u64;
    for rel in relatives {
        let src = Path::new(repo_root).join(rel);
        let Ok(meta) = fs::metadata(&src) else {
            continue; // 已被外部删除：没有可备份的内容
        };
        if !meta.is_file() {
            continue; // git restore 只处理文件，目录不在放弃范围内
        }
        if meta.len() > MAX_SNAPSHOT_FILE_BYTES || total + meta.len() > MAX_SNAPSHOT_TOTAL_BYTES {
            skipped += 1;
            continue;
        }
        let dst = dir.join(rel);
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建备份目录失败: {e}"))?;
        }
        fs::copy(&src, &dst).map_err(|e| format!("备份 {rel} 失败: {e}"))?;
        total += meta.len();
        saved.push(rel.clone());
    }
    if saved.is_empty() {
        return Ok((None, skipped));
    }
    let body = format!(
        "{{\"repoRoot\":{},\"savedAtUnixMs\":{},\"files\":{},\"skipped\":{}}}\n",
        serde_json::to_string(repo_root).unwrap_or_else(|_| "\"\"".to_string()),
        stamp,
        serde_json::to_string(&saved).unwrap_or_else(|_| "[]".to_string()),
        skipped,
    );
    fs::write(dir.join("manifest.json"), body).map_err(|e| format!("写入备份说明失败: {e}"))?;
    Ok((Some(dir.to_string_lossy().to_string()), skipped))
}

/// 只保留最近 KEEP_DISCARD_BACKUPS 批（目录名即 epoch 毫秒，可直接排序）
fn prune_discard_backups(backup_root: &Path) {
    let Ok(entries) = fs::read_dir(backup_root) else {
        return;
    };
    let mut stamps: Vec<u64> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().to_string_lossy().parse::<u64>().ok())
        .collect();
    if stamps.len() <= KEEP_DISCARD_BACKUPS {
        return;
    }
    stamps.sort_unstable();
    let drop_count = stamps.len() - KEEP_DISCARD_BACKUPS;
    for stamp in stamps.into_iter().take(drop_count) {
        let _ = fs::remove_dir_all(backup_root.join(stamp.to_string()));
    }
}

/// 放弃更改：把指定路径恢复到「暂存区 / HEAD」的状态。
///
/// 按每个路径的实际状态分别处理，不信任前端传来的分组：
/// - 未跟踪（`??`）：无版本可恢复，删除文件（`git clean -f`）；
/// - 已暂存：先取消暂存；新增文件取消后成为未跟踪，同样删除；
/// - 其余：`git restore --worktree` 用索引内容覆盖工作区。
///
/// **动作本身仍不可撤销**，但覆盖 / 删除前会先把工作区内容快照到
/// `<配置目录>/discard-backup/<时间戳>/`，并在结果里带出目录路径。
#[tauri::command]
pub async fn git_discard(
    app: tauri::AppHandle,
    state: tauri::State<'_, PathGuard>,
    root: String,
    paths: Vec<String>,
) -> Result<DiscardOutcome, String> {
    ensure_writable(&app)?;
    state.ensure_file_scope(&root)?;
    let relatives = normalize_relatives(&paths)?;
    let backup_root =
        crate::commands::config::app_config_dir(&app)?.join("discard-backup");
    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&backup_root).map_err(|e| format!("创建备份目录失败: {e}"))?;
        prune_discard_backups(&backup_root);
        let repo_root = repo_root_of(&root)?;
        let (backup_dir, skipped) = snapshot_for_discard(&repo_root, &relatives, &backup_root)?;
        let count = discard_blocking(&root, &relatives)?;
        Ok(DiscardOutcome {
            count,
            backup_dir,
            skipped,
        })
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

fn discard_blocking(dir: &str, relatives: &[String]) -> Result<usize, String> {
    let root = repo_root_of(dir)?;
    let mut done = 0usize;
    for rel in relatives {
        discard_one(&root, rel)?;
        done += 1;
    }
    Ok(done)
}

fn discard_one(root: &str, rel: &str) -> Result<(), String> {
    // `status --porcelain -z` 单条记录：`XY PATH\0`
    let status = git(root, &["status", "--porcelain=v1", "-z", "--", rel])?;
    let x = status.chars().next().unwrap_or(' ');
    if status.starts_with("??") {
        return git(root, &["clean", "-f", "--", rel]).map(|_| ());
    }
    if x != ' ' {
        unstage_one(root, rel)?;
        // 新增文件取消暂存后已无任何版本（成为未跟踪），只能删除
        if x == 'A' {
            return git(root, &["clean", "-f", "--", rel]).map(|_| ());
        }
    }
    match git(root, &["restore", "--worktree", "--", rel]) {
        Ok(_) => Ok(()),
        Err(e) if is_missing_subcommand(&e) => git(root, &["checkout", "--", rel]).map(|_| ()),
        Err(e) => Err(e),
    }
}

/// git < 2.23 没有 `restore` / `switch`：用 stderr 原文判断后回退旧命令
fn is_missing_subcommand(stderr: &str) -> bool {
    stderr.contains("is not a git command")
}

/// 提交：消息 trim 非空；成功返回 short hash
#[tauri::command]
pub async fn git_commit(
    app: tauri::AppHandle,
    state: tauri::State<'_, PathGuard>,
    root: String,
    message: String,
) -> Result<String, String> {
    ensure_writable(&app)?;
    state.ensure_file_scope(&root)?;
    let msg = message.trim().to_string();
    if msg.is_empty() {
        return Err("提交信息不能为空".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || commit_blocking(&root, &msg))
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}

fn commit_blocking(dir: &str, message: &str) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("提交信息不能为空".to_string());
    }
    let root = repo_root_of(dir)?;
    git(&root, &["commit", "-m", message])?;
    Ok(git(&root, &["rev-parse", "--short", "HEAD"])?
        .trim()
        .to_string())
}

/// 本地分支列表（当前分支置顶）；非仓库 / git 不可用返回 Err
#[tauri::command]
pub async fn git_branches(
    state: tauri::State<'_, PathGuard>,
    root: String,
) -> Result<Vec<GitBranch>, String> {
    state.ensure_file_scope(&root)?;
    tauri::async_runtime::spawn_blocking(move || branches_blocking(&root))
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}

fn branches_blocking(dir: &str) -> Result<Vec<GitBranch>, String> {
    let root = repo_root_of(dir)?;
    let out = git(
        &root,
        &[
            "for-each-ref",
            "--format=%(HEAD)%09%(refname:short)%09%(upstream:track)",
            "refs/heads",
        ],
    )?;
    Ok(parse_branches(&out))
}

/// 切换分支：git ≥ 2.23 用 `switch`（只切分支，不会被同名文件干扰），
/// 老版本回退 `checkout`。工作区有冲突修改时由 git 拒绝，错误原样回传。
#[tauri::command]
pub async fn git_checkout(
    app: tauri::AppHandle,
    state: tauri::State<'_, PathGuard>,
    root: String,
    branch: String,
) -> Result<String, String> {
    ensure_writable(&app)?;
    state.ensure_file_scope(&root)?;
    let name = validate_branch(&branch)?;
    tauri::async_runtime::spawn_blocking(move || checkout_blocking(&root, &name))
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}

fn checkout_blocking(dir: &str, branch: &str) -> Result<String, String> {
    let root = repo_root_of(dir)?;
    match git(&root, &["switch", branch]) {
        Ok(_) => Ok(branch.to_string()),
        Err(e) if is_missing_subcommand(&e) => {
            git(&root, &["checkout", branch])?;
            Ok(branch.to_string())
        }
        Err(e) => Err(e),
    }
}

/// 提交历史（最新在前）；空仓库返回空列表而不是报错。
#[tauri::command]
pub async fn git_log(
    state: tauri::State<'_, PathGuard>,
    root: String,
    limit: Option<usize>,
) -> Result<Vec<GitCommit>, String> {
    state.ensure_file_scope(&root)?;
    let limit = limit.unwrap_or(100).clamp(1, 500);
    tauri::async_runtime::spawn_blocking(move || log_blocking(&root, limit))
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}

fn log_blocking(dir: &str, limit: usize) -> Result<Vec<GitCommit>, String> {
    let root = repo_root_of(dir)?;
    if git(&root, &["rev-parse", "--verify", "HEAD"]).is_err() {
        return Ok(Vec::new());
    }
    let out = git(
        &root,
        &[
            "log",
            &format!("--max-count={limit}"),
            "--date=short",
            "--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%D%x1f%s",
        ],
    )?;
    Ok(parse_log(&out))
}

fn parse_log(output: &str) -> Vec<GitCommit> {
    output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\x1f').collect();
            if parts.len() < 6 {
                return None;
            }
            Some(GitCommit {
                hash: parts[0].to_string(),
                short_hash: parts[1].to_string(),
                author: parts[2].to_string(),
                date: parts[3].to_string(),
                refs: parts[4].trim().to_string(),
                subject: parts[5..].join("\x1f"),
            })
        })
        .collect()
}

/// 查看单个提交的详情（stat + patch 文本）；最多返回 256KB，避免超大提交撑爆面板。
#[tauri::command]
pub async fn git_show_commit(
    state: tauri::State<'_, PathGuard>,
    root: String,
    hash: String,
    max_bytes: Option<usize>,
) -> Result<String, String> {
    state.ensure_file_scope(&root)?;
    let hash = hash.trim().to_string();
    if hash.len() < 4 || hash.len() > 40 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("提交哈希格式不正确".to_string());
    }
    let max_bytes = max_bytes.unwrap_or(256 * 1024).clamp(16 * 1024, 1024 * 1024);
    tauri::async_runtime::spawn_blocking(move || show_commit_blocking(&root, &hash, max_bytes))
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}

fn show_commit_blocking(dir: &str, hash: &str, max_bytes: usize) -> Result<String, String> {
    let root = repo_root_of(dir)?;
    let mut text = git(
        &root,
        &[
            "show",
            "--no-color",
            "--no-ext-diff",
            "--date=short",
            "--stat",
            "--patch",
            hash,
        ],
    )?;
    if text.len() > max_bytes {
        let mut cut = max_bytes;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("\n…（提交内容过大，已截断）\n");
    }
    Ok(text)
}

/// 逐行 blame：基于磁盘与 HEAD 的差异计算；未保存改动可能导致行号偏移。
#[tauri::command]
pub async fn git_blame(
    state: tauri::State<'_, PathGuard>,
    path: String,
) -> Result<BlameReport, String> {
    state.ensure_file_scope(&path)?;
    tauri::async_runtime::spawn_blocking(move || blame_blocking(&path))
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}

fn blame_blocking(path: &str) -> Result<BlameReport, String> {
    const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
    const MAX_LINES: usize = 10_000;
    let size = fs::metadata(path)
        .map_err(|e| format!("读取文件信息失败: {e}"))?
        .len();
    if size > MAX_FILE_BYTES {
        return Err("文件超过 2MB，Git Blame 已跳过（可在终端执行 git blame）".to_string());
    }
    let (root, rel) = repo_relative(path)?;
    let output = git(&root, &["blame", "--line-porcelain", "--", &rel])
        .map_err(|e| format!("git blame 失败（文件可能未跟踪或尚无提交）：{e}"))?;
    let (mut lines, parsed_truncated) = parse_blame(&output);
    let truncated = parsed_truncated || lines.len() > MAX_LINES;
    if lines.len() > MAX_LINES {
        lines.truncate(MAX_LINES);
    }
    Ok(BlameReport { lines, truncated })
}

fn parse_blame(output: &str) -> (Vec<BlameLine>, bool) {
    #[derive(Default)]
    struct Meta {
        line: usize,
        hash: String,
        author: String,
        author_time: u64,
        summary: String,
    }
    let mut lines: Vec<BlameLine> = Vec::new();
    let mut current = Meta::default();
    for raw in output.lines() {
        if let Some(content) = raw.strip_prefix('\t') {
            if current.line > 0 {
                let hash = current.hash.trim_start_matches('^').to_string();
                lines.push(BlameLine {
                    line: current.line,
                    short_hash: hash.chars().take(8).collect(),
                    hash,
                    author: std::mem::take(&mut current.author),
                    author_time: current.author_time,
                    summary: std::mem::take(&mut current.summary),
                    content: content.to_string(),
                });
            }
            continue;
        }
        if let Some(rest) = raw.strip_prefix("author ") {
            current.author = rest.to_string();
        } else if let Some(rest) = raw.strip_prefix("author-time ") {
            current.author_time = rest.trim().parse().unwrap_or(0);
        } else if let Some(rest) = raw.strip_prefix("summary ") {
            current.summary = rest.to_string();
        } else {
            let mut parts = raw.split_whitespace();
            let Some(hash) = parts.next() else { continue };
            let Some(_orig) = parts.next() else { continue };
            let Some(final_line) = parts.next().and_then(|v| v.parse::<usize>().ok()) else {
                continue;
            };
            if hash.len() < 7 || !hash.chars().all(|c| c.is_ascii_hexdigit() || c == '^') {
                continue;
            }
            current = Meta {
                line: final_line,
                hash: hash.to_string(),
                ..Meta::default()
            };
        }
    }
    (lines, false)
}

/// 新建分支；checkout=true 时新建并切换。
#[tauri::command]
pub async fn git_create_branch(
    app: tauri::AppHandle,
    state: tauri::State<'_, PathGuard>,
    root: String,
    branch: String,
    checkout: bool,
) -> Result<String, String> {
    ensure_writable(&app)?;
    state.ensure_file_scope(&root)?;
    let name = validate_branch(&branch)?;
    tauri::async_runtime::spawn_blocking(move || create_branch_blocking(&root, &name, checkout))
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}

fn create_branch_blocking(dir: &str, name: &str, checkout: bool) -> Result<String, String> {
    let root = repo_root_of(dir)?;
    if checkout {
        match git(&root, &["switch", "-c", name]) {
            Ok(_) => {}
            Err(e) if is_missing_subcommand(&e) => {
                git(&root, &["checkout", "-b", name])?;
            }
            Err(e) => return Err(e),
        }
    } else {
        git(&root, &["branch", name])?;
    }
    Ok(name.to_string())
}

/// 删除本地分支；当前分支与未合并分支由 git 拒绝，错误原样返回。
#[tauri::command]
pub async fn git_delete_branch(
    app: tauri::AppHandle,
    state: tauri::State<'_, PathGuard>,
    root: String,
    branch: String,
    force: bool,
) -> Result<(), String> {
    ensure_writable(&app)?;
    state.ensure_file_scope(&root)?;
    let name = validate_branch(&branch)?;
    tauri::async_runtime::spawn_blocking(move || {
        delete_branch_blocking(&root, &name, force)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

fn delete_branch_blocking(dir: &str, name: &str, force: bool) -> Result<(), String> {
    let root = repo_root_of(dir)?;
    let current = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_string();
    if current == name {
        return Err("不能删除当前所在分支".to_string());
    }
    git(&root, &["branch", if force { "-D" } else { "-d" }, name]).map(|_| ())
}

/// 重命名本地分支：`git branch -m <old> <new>`。
/// 支持当前分支；重命名不改变分支指向，工作区与提交历史不受影响。
#[tauri::command]
pub async fn git_rename_branch(
    app: tauri::AppHandle,
    state: tauri::State<'_, PathGuard>,
    root: String,
    from: String,
    to: String,
) -> Result<String, String> {
    ensure_writable(&app)?;
    state.ensure_file_scope(&root)?;
    let from = validate_branch(&from)?;
    let to = validate_branch(&to)?;
    if from == to {
        return Ok(to);
    }
    tauri::async_runtime::spawn_blocking(move || rename_branch_blocking(&root, &from, &to))
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}

fn rename_branch_blocking(dir: &str, from: &str, to: &str) -> Result<String, String> {
    let root = repo_root_of(dir)?;
    git(&root, &["branch", "-m", from, to])?;
    Ok(to.to_string())
}

/// 拉取：`git pull --ff-only`。
///
/// 只做快进，不产生合并提交、不弹编辑器；分叉时如实报错由用户自行处理。
/// 无上游分支时给中文提示（git 原文是英文且较长）。
#[tauri::command]
pub async fn git_pull(
    app: tauri::AppHandle,
    state: tauri::State<'_, PathGuard>,
    root: String,
) -> Result<String, String> {
    ensure_writable(&app)?;
    state.ensure_file_scope(&root)?;
    tauri::async_runtime::spawn_blocking(move || pull_blocking(&root))
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}

fn pull_blocking(dir: &str) -> Result<String, String> {
    let root = repo_root_of(dir)?;
    if !has_upstream(&root) {
        return Err("当前分支没有上游分支，无法拉取".to_string());
    }
    let out = git_net(&root, &["pull", "--ff-only"])?;
    let last = out
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    // git 原文是英文；最常见的“已是最新”换中文，其余保留原文便于排查
    if last.is_empty() || last.contains("Already up to date") {
        return Ok("已是最新".to_string());
    }
    Ok(last.to_string())
}

/// 当前分支是否配置了上游（无上游时 pull / push 都会报错，提前给中文提示）
fn has_upstream(root: &str) -> bool {
    git(
        root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .is_ok()
}

/// 推送：`git push --porcelain`（输出可解析，失败原因原样回传）
#[tauri::command]
pub async fn git_push(
    app: tauri::AppHandle,
    state: tauri::State<'_, PathGuard>,
    root: String,
) -> Result<String, String> {
    ensure_writable(&app)?;
    state.ensure_file_scope(&root)?;
    tauri::async_runtime::spawn_blocking(move || push_blocking(&root))
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}

fn push_blocking(dir: &str) -> Result<String, String> {
    let root = repo_root_of(dir)?;
    if !has_upstream(&root) {
        return Err("当前分支没有上游分支，无法推送（可先执行 git push -u origin <分支>）".to_string());
    }
    let out = git_net(&root, &["push", "--porcelain"])?;
    Ok(summarize_push(&out))
}

/// 解析 `push --porcelain` 输出。
///
/// 每行 `<flag>\t<from>:<to>\t<summary>`，首尾另有 `To <url>` / `Done` 行；flag：
/// ` ` 快进、`+` 强推、`-` 删除、`*` 新引用、`=` 已是最新、`!` 被拒。
/// 注意：快进行的 flag 是空格，不能用 `split_whitespace` 取首段（会被跳过）。
fn summarize_push(out: &str) -> String {
    let mut pushed = 0u32;
    let mut up_to_date = false;
    let mut rejected: Vec<String> = Vec::new();
    for line in out.lines() {
        let flag = match line.chars().next() {
            Some(c) => c,
            None => continue,
        };
        match flag {
            ' ' | '+' | '-' | '*' => pushed += 1,
            '=' => up_to_date = true,
            '!' => {
                let reason = line
                    .split_whitespace()
                    .last()
                    .unwrap_or("推送被拒绝")
                    .to_string();
                rejected.push(reason);
            }
            _ => {}
        }
    }
    if !rejected.is_empty() {
        return format!("推送被拒绝：{}", rejected.join("；"));
    }
    if pushed > 0 {
        return format!("已推送 {pushed} 个引用");
    }
    if up_to_date {
        return "已是最新".to_string();
    }
    // 兼容不支持 --porcelain 的旧版本：退化为最后一行原文
    let last = out
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    if last.is_empty() {
        "已是最新".to_string()
    } else {
        last.to_string()
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        crate::commands::test_support::temp_dir("git", tag)
    }

    fn summary(entries: &[GitFileEntry]) -> Vec<(String, String)> {
        entries
            .iter()
            .map(|e| (e.relative.clone(), e.status.clone()))
            .collect()
    }

    #[test]
    fn parses_modified_added_deleted() {
        let root = Path::new("D:/repo");
        let (staged, changes, truncated) =
            parse_status_z(root, " M src/a.rs\0A  src/b.rs\0 D src/c.rs\0");
        assert!(!truncated);
        assert_eq!(summary(&staged), vec![("src/b.rs".into(), "A".into())]);
        assert_eq!(
            summary(&changes),
            vec![
                ("src/a.rs".into(), "M".into()),
                ("src/c.rs".into(), "D".into())
            ]
        );
    }

    #[test]
    fn parses_untracked_and_rename() {
        let root = Path::new("D:/repo");
        let (staged, changes, _) = parse_status_z(root, "?? notes.md\0R  new.rs\0old.rs\0");
        assert_eq!(summary(&changes), vec![("notes.md".into(), "?".into())]);
        assert_eq!(summary(&staged), vec![("new.rs".into(), "R".into())]);
        assert_eq!(staged[0].orig_relative.as_deref(), Some("old.rs"));
    }

    #[test]
    fn parses_conflict_as_single_entry() {
        let root = Path::new("D:/repo");
        let (staged, changes, _) = parse_status_z(root, "UU conflict.rs\0");
        assert!(staged.is_empty());
        assert_eq!(summary(&changes), vec![("conflict.rs".into(), "U".into())]);
    }

    #[test]
    fn parses_chinese_paths() {
        let root = Path::new("D:/repo");
        let (_, changes, _) = parse_status_z(root, " M 文档/说明.md\0");
        assert_eq!(summary(&changes), vec![("文档/说明.md".into(), "M".into())]);
    }

    #[test]
    fn empty_output_is_clean() {
        let (staged, changes, truncated) = parse_status_z(Path::new("D:/repo"), "");
        assert!(staged.is_empty() && changes.is_empty() && !truncated);
    }

    #[test]
    fn truncates_when_over_limit() {
        let root = Path::new("D:/repo");
        let mut out = String::new();
        for i in 0..(MAX_ENTRIES + 10) {
            out.push_str(&format!(" M f{i}.txt\0"));
        }
        let (_, changes, truncated) = parse_status_z(root, &out);
        assert!(truncated);
        assert!(changes.len() <= MAX_ENTRIES + 1);
    }

    #[test]
    fn rejects_unsafe_relative_paths() {
        assert!(safe_relative("../etc/passwd").is_err());
        assert!(safe_relative("/abs/path").is_err());
        assert!(safe_relative("a//b").is_err());
        assert_eq!(safe_relative("src\\a.ts").unwrap(), "src/a.ts");
    }

    #[test]
    fn parses_branch_track_info() {
        assert_eq!(parse_track("[ahead 1, behind 2]"), (1, 2));
        assert_eq!(parse_track("[ahead 3]"), (3, 0));
        assert_eq!(parse_track("[behind 4]"), (0, 4));
        assert_eq!(parse_track(""), (0, 0));
        // 上游被删除：无领先 / 落后可言
        assert_eq!(parse_track("[gone]"), (0, 0));
    }

    #[test]
    fn parses_branches_current_first() {
        let out = "*\tmain\t[ahead 1, behind 2]\n \tdev\t\n \talpha\t[behind 1]\n";
        let list = parse_branches(out);
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].name, "main");
        assert!(list[0].current);
        assert_eq!((list[0].ahead, list[0].behind), (1, 2));
        // 其余按名称排序
        assert_eq!(list[1].name, "alpha");
        assert_eq!(list[2].name, "dev");
        assert!(!list[2].current);
    }

    #[test]
    fn parses_push_porcelain() {
        assert_eq!(summarize_push("=\trefs/heads/main:refs/heads/main\t[up to date]\n"), "已是最新");
        assert_eq!(
            summarize_push(" \trefs/heads/main:refs/heads/main\tabc..def\n"),
            "已推送 1 个引用"
        );
        assert_eq!(
            summarize_push("*\trefs/heads/new:refs/heads/new\t[new branch]\n"),
            "已推送 1 个引用"
        );
        let rejected = summarize_push("!\trefs/heads/main:refs/heads/main\t[rejected] (non-fast-forward)\n");
        assert!(rejected.starts_with("推送被拒绝"), "{rejected}");
        // 无输出（旧版本不带 --porcelain）退化为已是最新
        assert_eq!(summarize_push(""), "已是最新");
    }

    #[test]
    fn rejects_unsafe_branch_names() {
        assert!(validate_branch("").is_err());
        assert!(validate_branch("-x").is_err());
        assert!(validate_branch("a b").is_err());
        assert!(validate_branch("a..b").is_err());
        assert!(validate_branch("a/b/").is_err());
        assert_eq!(validate_branch(" feature/x ").unwrap(), "feature/x");
    }

    // ---- 临时仓库集成测试（git 不可用时跳过） ----

    fn git_works() -> bool {
        Command::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    fn run(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {:?} 失败: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[test]
    fn status_stage_unstage_roundtrip() {
        if !git_works() {
            eprintln!("跳过：未安装 git");
            return;
        }
        let dir = temp_dir("roundtrip");
        let dir_str = dir.to_string_lossy().to_string();
        run(&dir, &["init", "-q"]);
        run(&dir, &["config", "user.email", "test@example.com"]);
        run(&dir, &["config", "user.name", "test"]);
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        run(&dir, &["add", "--", "a.txt"]);
        run(&dir, &["commit", "-q", "-m", "init"]);

        // 修改 → changes M
        std::fs::write(dir.join("a.txt"), "b\n").unwrap();
        let st = git_status_blocking(&dir_str).unwrap();
        assert!(st.error.is_empty());
        assert!(st
            .changes
            .iter()
            .any(|e| e.relative == "a.txt" && e.status == "M"));

        // 暂存 → staged M
        stage_blocking(&dir_str, &["a.txt".to_string()]).unwrap();
        let st = git_status_blocking(&dir_str).unwrap();
        assert!(st
            .staged
            .iter()
            .any(|e| e.relative == "a.txt" && e.status == "M"));

        // 取消暂存 → 回到 changes M
        unstage_blocking(&dir_str, &["a.txt".to_string()]).unwrap();
        let st = git_status_blocking(&dir_str).unwrap();
        assert!(st
            .changes
            .iter()
            .any(|e| e.relative == "a.txt" && e.status == "M"));

        // 未跟踪文件 → changes ?
        std::fs::write(dir.join("b.txt"), "b\n").unwrap();
        let st = git_status_blocking(&dir_str).unwrap();
        assert!(st
            .changes
            .iter()
            .any(|e| e.relative == "b.txt" && e.status == "?"));
    }

    #[test]
    fn commit_returns_short_hash() {
        if !git_works() {
            eprintln!("跳过：未安装 git");
            return;
        }
        let dir = temp_dir("commit");
        let dir_str = dir.to_string_lossy().to_string();
        run(&dir, &["init", "-q"]);
        run(&dir, &["config", "user.email", "test@example.com"]);
        run(&dir, &["config", "user.name", "test"]);
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        stage_blocking(&dir_str, &["a.txt".to_string()]).unwrap();

        let hash = commit_blocking(&dir_str, "init").unwrap();
        assert!(!hash.is_empty());
        assert!(hash.len() >= 7);

        // 空消息拒绝
        assert!(commit_blocking(&dir_str, "   ").is_err());
    }

    #[test]
    fn non_repo_reports_error_field() {
        let dir = temp_dir("non_repo");
        let st = git_status_blocking(&dir.to_string_lossy()).unwrap();
        assert!(!st.error.is_empty());
        assert!(st.staged.is_empty() && st.changes.is_empty());
    }

    /// 重命名：普通分支与当前分支都可改，当前分支改完 HEAD 跟随新名字
    #[test]
    fn rename_branch_moves_name_and_head() {
        if !git_works() {
            eprintln!("跳过：未安装 git");
            return;
        }
        let dir = temp_dir("rename_branch");
        let dir_str = dir.to_string_lossy().to_string();
        run(&dir, &["init", "-q"]);
        run(&dir, &["config", "user.email", "test@example.com"]);
        run(&dir, &["config", "user.name", "test"]);
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        run(&dir, &["add", "--", "a.txt"]);
        run(&dir, &["commit", "-q", "-m", "init"]);
        run(&dir, &["branch", "old"]);

        assert_eq!(
            rename_branch_blocking(&dir_str, "old", "new").unwrap(),
            "new"
        );
        let names = git(&dir_str, &["branch", "--format=%(refname:short)"]).unwrap();
        assert!(names.lines().any(|l| l.trim() == "new"));
        assert!(!names.lines().any(|l| l.trim() == "old"));

        let base = git(&dir_str, &["symbolic-ref", "--short", "HEAD"])
            .unwrap()
            .trim()
            .to_string();
        assert_eq!(
            rename_branch_blocking(&dir_str, &base, "renamed").unwrap(),
            "renamed"
        );
        assert_eq!(
            git(&dir_str, &["symbolic-ref", "--short", "HEAD"])
                .unwrap()
                .trim(),
            "renamed"
        );
    }

    #[test]
    fn checkout_switches_branch() {
        if !git_works() {
            eprintln!("跳过：未安装 git");
            return;
        }
        let dir = temp_dir("checkout");
        let dir_str = dir.to_string_lossy().to_string();
        run(&dir, &["init", "-q"]);
        run(&dir, &["config", "user.email", "test@example.com"]);
        run(&dir, &["config", "user.name", "test"]);
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        run(&dir, &["add", "--", "a.txt"]);
        run(&dir, &["commit", "-q", "-m", "init"]);
        // 默认分支名随 git 版本变化，从仓库实际值取
        let base = git(&dir_str, &["symbolic-ref", "--short", "HEAD"])
            .unwrap()
            .trim()
            .to_string();
        run(&dir, &["branch", "feature"]);

        assert_eq!(checkout_blocking(&dir_str, "feature").unwrap(), "feature");
        let head = git(&dir_str, &["symbolic-ref", "--short", "HEAD"])
            .unwrap()
            .trim()
            .to_string();
        assert_eq!(head, "feature");

        let list = branches_blocking(&dir_str).unwrap();
        assert!(list.iter().any(|b| b.name == "feature" && b.current));
        assert!(list.iter().any(|b| b.name == base && !b.current));
    }

    #[test]
    fn push_reports_result() {
        if !git_works() {
            eprintln!("跳过：未安装 git");
            return;
        }
        // 本地裸仓充当远端，测试不需要网络
        let bare = temp_dir("push_bare");
        run(&bare, &["init", "--bare", "-q", "."]);
        let work = temp_dir("push_work");
        let work_str = work.to_string_lossy().to_string();
        run(&work, &["init", "-q"]);
        run(&work, &["config", "user.email", "test@example.com"]);
        run(&work, &["config", "user.name", "test"]);
        std::fs::write(work.join("a.txt"), "a\n").unwrap();
        run(&work, &["add", "--", "a.txt"]);
        run(&work, &["commit", "-q", "-m", "init"]);

        let remote = bare.to_string_lossy().replace('\\', "/");
        run(&work, &["remote", "add", "origin", &remote]);
        let branch = git(&work_str, &["symbolic-ref", "--short", "HEAD"])
            .unwrap()
            .trim()
            .to_string();
        run(&work, &["push", "-q", "-u", "origin", &branch]);

        // 已推送过：再次推送应为已是最新
        assert_eq!(push_blocking(&work_str).unwrap(), "已是最新");

        // 新提交 → 推送 1 个引用
        std::fs::write(work.join("a.txt"), "b\n").unwrap();
        run(&work, &["add", "--", "a.txt"]);
        run(&work, &["commit", "-q", "-m", "second"]);
        let out = push_blocking(&work_str).unwrap();
        assert!(out.contains("已推送"), "unexpected: {out}");
    }

    #[test]
    fn discard_restores_and_deletes() {
        if !git_works() {
            eprintln!("跳过：未安装 git");
            return;
        }
        let dir = temp_dir("discard");
        let dir_str = dir.to_string_lossy().to_string();
        run(&dir, &["init", "-q"]);
        run(&dir, &["config", "user.email", "test@example.com"]);
        run(&dir, &["config", "user.name", "test"]);
        // Windows 默认 autocrlf 会把恢复出来的内容改成 CRLF，断言需固定行尾
        run(&dir, &["config", "core.autocrlf", "false"]);
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        run(&dir, &["add", "--", "a.txt"]);
        run(&dir, &["commit", "-q", "-m", "init"]);

        // 工作区修改 → 恢复为索引内容
        std::fs::write(dir.join("a.txt"), "b\n").unwrap();
        assert_eq!(discard_blocking(&dir_str, &["a.txt".to_string()]).unwrap(), 1);
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "a\n");

        // 未跟踪文件 → 删除
        std::fs::write(dir.join("b.txt"), "b\n").unwrap();
        discard_blocking(&dir_str, &["b.txt".to_string()]).unwrap();
        assert!(!dir.join("b.txt").exists());

        // 已暂存的新增文件 → 取消暂存 + 删除
        std::fs::write(dir.join("c.txt"), "c\n").unwrap();
        run(&dir, &["add", "--", "c.txt"]);
        discard_blocking(&dir_str, &["c.txt".to_string()]).unwrap();
        assert!(!dir.join("c.txt").exists());
        let st = git_status_blocking(&dir_str).unwrap();
        assert!(!st.staged.iter().any(|e| e.relative == "c.txt"));

        // 已暂存的修改 → 取消暂存 + 还原内容，工作区干净
        std::fs::write(dir.join("a.txt"), "b\n").unwrap();
        run(&dir, &["add", "--", "a.txt"]);
        discard_blocking(&dir_str, &["a.txt".to_string()]).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "a\n");
        let st = git_status_blocking(&dir_str).unwrap();
        assert!(st.staged.is_empty() && st.changes.is_empty());
    }

    /// 放弃前快照：按相对路径保留目录结构，内容与工作区一致，并带 manifest
    #[test]
    fn discard_snapshot_keeps_worktree_content() {
        let dir = temp_dir("discard_snapshot");
        let root = dir.to_string_lossy().to_string();
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("a.txt"), "modified\n").unwrap();
        let backup_root = dir.join("backups");
        std::fs::create_dir_all(&backup_root).unwrap();

        let (backup, skipped) =
            snapshot_for_discard(&root, &["sub/a.txt".to_string()], &backup_root).unwrap();

        assert_eq!(skipped, 0);
        let backup = backup.expect("应产生备份目录");
        let saved = std::fs::read_to_string(Path::new(&backup).join("sub").join("a.txt")).unwrap();
        assert_eq!(saved, "modified\n");
        assert!(Path::new(&backup).join("manifest.json").exists());
    }

    /// 超过单文件上限的内容不备份，但必须计数（不能静默当成备份成功）
    #[test]
    fn discard_snapshot_skips_oversized_file() {
        let dir = temp_dir("discard_snapshot_big");
        let root = dir.to_string_lossy().to_string();
        let big = dir.join("big.bin");
        std::fs::write(&big, "x").unwrap();
        let handle = std::fs::OpenOptions::new().write(true).open(&big).unwrap();
        handle.set_len(MAX_SNAPSHOT_FILE_BYTES + 1).unwrap();
        drop(handle);
        std::fs::write(dir.join("small.txt"), "s\n").unwrap();
        let backup_root = dir.join("backups");
        std::fs::create_dir_all(&backup_root).unwrap();

        let (backup, skipped) = snapshot_for_discard(
            &root,
            &["big.bin".to_string(), "small.txt".to_string()],
            &backup_root,
        )
        .unwrap();

        assert_eq!(skipped, 1);
        assert!(backup.is_some());
    }

    #[test]
    fn split_zero_context_patch_and_select_hunk() {
        let patch = "diff --git a/a.txt b/a.txt\n\
index 1111111..2222222 100644\n\
--- a/a.txt\n\
+++ b/a.txt\n\
@@ -2,0 +3,1 @@\n\
+foo\n\
@@ -10 +11,0 @@\n\
-bar\n";
        let (header, hunks) = split_git_patch(patch).unwrap();
        assert!(header.contains("diff --git a/a.txt b/a.txt"));
        assert_eq!(hunks.len(), 2);
        assert_eq!(select_patch_hunk(&hunks, 0, 3).unwrap().text, "@@ -2,0 +3,1 @@\n+foo\n");
        assert_eq!(select_patch_hunk(&hunks, 10, 0).unwrap().text, "@@ -10 +11,0 @@\n-bar\n");
    }

    #[test]
    fn stage_hunk_applies_only_selected_block() {
        if Command::new("git").arg("--version").output().is_err() {
            return; // 环境没有 git 时跳过
        }
        let dir = temp_dir("stage_hunk");
        let dir_str = dir.to_string_lossy().to_string();
        git(&dir_str, &["init"]).unwrap();
        git(&dir_str, &["config", "user.email", "test@example.com"]).unwrap();
        git(&dir_str, &["config", "user.name", "Test"]).unwrap();
        let file = dir.join("a.txt");
        std::fs::write(&file, "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n")
            .unwrap();
        git(&dir_str, &["add", "a.txt"]).unwrap();
        git(&dir_str, &["commit", "-m", "init"]).unwrap();
        std::fs::write(
            &file,
            "one\ntwo-changed\nthree\nfour\nfive\nsix\nseven\neight\nnine-changed\nten\n",
        )
        .unwrap();

        let patch = git(&dir_str, &["diff", "--unified=0", "--", "a.txt"]).unwrap();
        let (_, hunks) = split_git_patch(&patch).unwrap();
        assert_eq!(hunks.len(), 2);
        stage_hunk_blocking(
            &file.to_string_lossy(),
            hunks[0].old_start,
            hunks[0].new_start,
            false,
        )
        .unwrap();

        let cached = git(&dir_str, &["diff", "--cached", "--unified=0"]).unwrap();
        assert!(cached.contains("two-changed"));
        assert!(!cached.contains("nine-changed"));
        let work = git(&dir_str, &["diff", "--unified=0"]).unwrap();
        assert!(work.contains("nine-changed"));

        // 反向：把刚才暂存的同一块撤回，索引应回到 HEAD
        stage_hunk_blocking(
            &file.to_string_lossy(),
            hunks[0].old_start,
            hunks[0].new_start,
            true,
        )
        .unwrap();
        let cached_after = git(&dir_str, &["diff", "--cached", "--unified=0"]).unwrap();
        assert!(cached_after.trim().is_empty());
    }

    #[test]
    fn log_branch_and_commit_detail() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let dir = temp_dir("log_branch");
        let dir_str = dir.to_string_lossy().to_string();
        git(&dir_str, &["init"]).unwrap();
        git(&dir_str, &["config", "user.email", "test@example.com"]).unwrap();
        git(&dir_str, &["config", "user.name", "Test"]).unwrap();
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(&dir_str, &["add", "a.txt"]).unwrap();
        git(&dir_str, &["commit", "-m", "first commit"]).unwrap();
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        git(&dir_str, &["commit", "-am", "second commit"]).unwrap();

        let commits = log_blocking(&dir_str, 10).unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].subject, "second commit");
        assert!(!commits[0].short_hash.is_empty());

        let hash = git(&dir_str, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        let detail = show_commit_blocking(&dir_str, &hash, 64 * 1024).unwrap();
        assert!(detail.contains("second commit"));
        assert!(detail.contains("a.txt"));

        create_branch_blocking(&dir_str, "feature", false).unwrap();
        let branches = branches_blocking(&dir_str).unwrap();
        assert!(branches.iter().any(|b| b.name == "feature"));
        delete_branch_blocking(&dir_str, "feature", false).unwrap();
        let branches = branches_blocking(&dir_str).unwrap();
        assert!(!branches.iter().any(|b| b.name == "feature"));

        let blame = blame_blocking(&dir.join("a.txt").to_string_lossy()).unwrap();
        assert_eq!(blame.lines.len(), 2);
        assert_eq!(blame.lines[0].content, "one");
        assert_eq!(blame.lines[1].content, "two");
        assert!(!blame.lines[1].hash.is_empty());
    }

    #[test]
    fn parse_blame_reads_porcelain_metadata() {
        let sample = "1111111111111111111111111111111111111111 1 1 2\n\
author Alice\n\
author-time 1700000000\n\
summary first line\n\
\tone\n\
2222222222222222222222222222222222222222 2 2\n\
author Bob\n\
author-time 1700000100\n\
summary second line\n\
\ttwo\n";
        let (lines, _) = parse_blame(sample);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].author, "Alice");
        assert_eq!(lines[0].short_hash, "11111111");
        assert_eq!(lines[0].summary, "first line");
        assert_eq!(lines[1].line, 2);
        assert_eq!(lines[1].content, "two");
    }
}
