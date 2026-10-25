//! Git 源代码管理：状态查询、暂存 / 取消暂存、提交，以及分支列表 / 切换 / 拉取。
//!
//! 全部通过 git CLI 执行，参数以数组传递（不拼 shell）；
//! 状态与分支解析抽成纯函数便于单测；命令均放 spawn_blocking，避免阻塞主线程。
//! 安全边界：工作区根经 PathGuard 校验；relative 路径拒绝 `..` 与绝对路径；
//! 分支名拒绝 `-` 开头与空白 / 控制字符。

use serde::Serialize;
use std::path::Path;
use std::process::Command;

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
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
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
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
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
    state: tauri::State<'_, PathGuard>,
    root: String,
    paths: Vec<String>,
) -> Result<(), String> {
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
    state: tauri::State<'_, PathGuard>,
    root: String,
    paths: Vec<String>,
) -> Result<(), String> {
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

/// 放弃更改：把指定路径恢复到「暂存区 / HEAD」的状态（不可撤销）。
///
/// 按每个路径的实际状态分别处理，不信任前端传来的分组：
/// - 未跟踪（`??`）：无版本可恢复，删除文件（`git clean -f`）；
/// - 已暂存：先取消暂存；新增文件取消后成为未跟踪，同样删除；
/// - 其余：`git restore --worktree` 用索引内容覆盖工作区。
#[tauri::command]
pub async fn git_discard(
    state: tauri::State<'_, PathGuard>,
    root: String,
    paths: Vec<String>,
) -> Result<usize, String> {
    state.ensure_file_scope(&root)?;
    let relatives = normalize_relatives(&paths)?;
    tauri::async_runtime::spawn_blocking(move || discard_blocking(&root, &relatives))
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
    state: tauri::State<'_, PathGuard>,
    root: String,
    message: String,
) -> Result<String, String> {
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
    state: tauri::State<'_, PathGuard>,
    root: String,
    branch: String,
) -> Result<String, String> {
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

/// 拉取：`git pull --ff-only`。
///
/// 只做快进，不产生合并提交、不弹编辑器；分叉时如实报错由用户自行处理。
/// 无上游分支时给中文提示（git 原文是英文且较长）。
#[tauri::command]
pub async fn git_pull(
    state: tauri::State<'_, PathGuard>,
    root: String,
) -> Result<String, String> {
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
    state: tauri::State<'_, PathGuard>,
    root: String,
) -> Result<String, String> {
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
        let mut dir = std::env::temp_dir();
        dir.push(format!("my_editor_git_test_{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
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
}
