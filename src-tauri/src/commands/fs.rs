//! 文件系统命令：文件树与工作区
//! 目录列举 / 新建 / 重命名 / 删除 / 在文件管理器中定位。
//! 权限最小化：仅响应用户在文件树上的显式操作，不扫描工作区之外的内容。

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::paths::PathGuard;

#[derive(Serialize, Clone)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// 列举目录直接子项（目录在前、名称不区分大小写排序）
#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries: Vec<DirEntry> = Vec::new();
    for entry in fs::read_dir(&path).map_err(|e| format!("读取目录失败: {e}"))? {
        let entry = entry.map_err(|e| format!("读取目录项失败: {e}"))?;
        let meta = entry
            .metadata()
            .map_err(|e| format!("读取元信息失败: {e}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        entries.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
        });
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

/// 路径类型探测（窗口拖放：判定文件 / 目录）。
/// 只读 metadata，不触碰作用域状态：拖入路径在打开/设为工作区时才登记。
#[tauri::command]
pub async fn path_kind(path: String) -> Result<&'static str, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let meta = fs::metadata(&path).map_err(|e| format!("读取路径失败: {e}"))?;
        Ok(if meta.is_dir() { "dir" } else { "file" })
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

/// 新建文件或目录（已存在则报错）。
/// 安全：仅允许已登记工作区根目录之内（文件树 UI 的可见范围）。
#[tauri::command]
pub fn create_entry(
    state: tauri::State<'_, PathGuard>,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let p = state.ensure_root_scope(&path)?;
    if p.exists() {
        return Err("目标已存在".to_string());
    }
    if is_dir {
        fs::create_dir_all(&p).map_err(|e| format!("创建目录失败: {e}"))
    } else {
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {e}"))?;
        }
        fs::write(&p, "").map_err(|e| format!("创建文件失败: {e}"))
    }
}

/// 重命名 / 移动。安全：源与目标都必须在已登记工作区根目录之内。
#[tauri::command]
pub fn rename_path(
    state: tauri::State<'_, PathGuard>,
    from: String,
    to: String,
) -> Result<(), String> {
    let src = state.ensure_root_scope(&from)?;
    let target = state.ensure_root_scope(&to)?;
    if target.exists() {
        return Err("目标已存在".to_string());
    }
    fs::rename(&src, &target).map_err(|e| format!("重命名失败: {e}"))
}

/// 复制 / 剪切（移动）文件或目录到目标目录，返回最终落盘路径。
///
/// 重名策略（与资源管理器一致，且不覆盖任何现有内容）：
/// - 复制：自动追加「 (副本)」「 (副本 2)」…；扩展名保留在末尾，避免 `a.txt (副本)` 丢高亮
/// - 剪切：目标已存在同名项直接报错——移动+覆盖等于静默丢数据
///
/// 安全：源与目标都必须在已登记工作区根目录之内；禁止把目录搬进它自己的子目录。
/// 重活（递归复制、跨卷回退）放 spawn_blocking。
#[tauri::command]
pub async fn copy_path(
    state: tauri::State<'_, PathGuard>,
    from: String,
    dest_dir: String,
    cut: bool,
) -> Result<String, String> {
    let src = state.ensure_root_scope(&from)?;
    let dest = state.ensure_root_scope(&dest_dir)?;
    tauri::async_runtime::spawn_blocking(move || copy_or_move(&src, &dest, cut))
        .await
        .map_err(|e| format!("任务调度失败: {e}"))?
}

/// 把一组路径（系统剪贴板里的文件 / 目录）复制或移动进目标目录，返回最终路径。
///
/// 安全边界比 `copy_path` 更严：
/// - **目标目录**必须在已登记工作区内（写入侧守卫）
/// - **移动（cut）** 要求每个源也在工作区内：跨工作区剪切等于"删除工作区外的文件"，
///   超出写入作用域。所以从资源管理器粘进来的文件一律只复制，不动源
#[tauri::command]
pub async fn paste_files(
    state: tauri::State<'_, PathGuard>,
    sources: Vec<String>,
    dest_dir: String,
    cut: bool,
) -> Result<Vec<String>, String> {
    let dest = state.ensure_root_scope(&dest_dir)?;
    if sources.is_empty() {
        return Err("剪贴板里没有文件".to_string());
    }
    let mut checked: Vec<PathBuf> = Vec::with_capacity(sources.len());
    for source in &sources {
        if cut {
            checked.push(state.ensure_root_scope(source)?);
        } else {
            checked.push(PathBuf::from(source));
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        // 移动前先整体检查同名冲突：剪切到一半失败会留下"一半搬完"的中间态
        if cut {
            for src in &checked {
                if let Some(name) = src.file_name() {
                    if dest.join(name).exists() {
                        return Err(format!(
                            "目标已存在同名项「{}」，请先改名或换个位置",
                            name.to_string_lossy()
                        ));
                    }
                }
            }
        }
        let mut out = Vec::with_capacity(checked.len());
        for src in &checked {
            out.push(copy_or_move(src, &dest, cut)?);
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("任务调度失败: {e}"))?
}

fn copy_or_move(src: &Path, dest_dir: &Path, cut: bool) -> Result<String, String> {
    if !src.exists() {
        return Err("源不存在（可能已被其它程序删除）".to_string());
    }
    if !dest_dir.is_dir() {
        return Err("目标不是目录".to_string());
    }
    // 目录不能搬进自己（含相等的边界）：否则会把自己无限复制进自身
    if dest_dir == src || dest_dir.starts_with(src) {
        return Err("不能把目录放进它自己里面".to_string());
    }
    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "源路径没有文件名".to_string())?;

    let is_dir = src.is_dir();
    let target = if cut {
        dest_dir.join(&name)
    } else {
        unique_copy_target(dest_dir, &name, is_dir)
    };

    if cut {
        if target.exists() {
            return Err(format!("目标已存在同名项「{name}」，请先改名或换个位置"));
        }
        if fs::rename(src, &target).is_err() {
            // 跨卷：rename 会失败，退回复制 + 删除源
            copy_recursive(src, &target)?;
            let removed = if is_dir {
                fs::remove_dir_all(src)
            } else {
                fs::remove_file(src)
            };
            removed.map_err(|e| format!("已复制到目标，但删除源失败: {e}"))?;
        }
    } else {
        copy_recursive(src, &target)?;
    }
    Ok(target.to_string_lossy().to_string())
}

/// 复制目标名：`a.txt` → `a (副本).txt` → `a (副本 2).txt`（目录不带扩展名拆分）
fn unique_copy_target(dest_dir: &Path, name: &str, is_dir: bool) -> PathBuf {
    let first = dest_dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = if is_dir {
        (name, "")
    } else {
        match name.rfind('.') {
            Some(i) if i > 0 => (&name[..i], &name[i..]),
            _ => (name, ""),
        }
    };
    for n in 0..1000 {
        let tag = if n == 0 {
            " (副本)".to_string()
        } else {
            format!(" (副本 {})", n + 1)
        };
        let candidate = dest_dir.join(format!("{stem}{tag}{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dest_dir.join(format!("{stem} (副本 999+){ext}"))
}

fn copy_recursive(src: &Path, target: &Path) -> Result<(), String> {
    let meta = fs::metadata(src).map_err(|e| format!("读取源失败: {e}"))?;
    if meta.is_dir() {
        fs::create_dir_all(target).map_err(|e| format!("创建目录失败: {e}"))?;
        for entry in fs::read_dir(src).map_err(|e| format!("读取目录失败: {e}"))? {
            let entry = entry.map_err(|e| format!("读取目录项失败: {e}"))?;
            copy_recursive(&entry.path(), &target.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(src, target)
            .map(|_| ())
            .map_err(|e| format!("复制失败: {e}"))
    }
}

/// 删除文件或目录（移入系统回收站；调用方必须已弹确认）。
/// 安全：仅允许已登记工作区根目录之内。
///
/// 走 `trash` 而不是 `remove_file/remove_dir_all`：确认框是唯一防线时，
/// 误点就是永久丢失；回收站给了第二道网，且用户能按系统习惯自行还原。
/// 大目录（node_modules 等）移入回收站也可能很慢：放 spawn_blocking。
#[tauri::command]
pub async fn delete_path(
    state: tauri::State<'_, PathGuard>,
    path: String,
) -> Result<(), String> {
    let p = state.ensure_root_scope(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !p.exists() {
            return Err("路径不存在（可能已被其它程序删除）".to_string());
        }
        trash::delete(&p).map_err(|e| format!("移入回收站失败: {e}"))
    })
    .await
    .map_err(|e| format!("任务调度失败: {e}"))?
}

/// 在系统文件管理器中打开 / 定位某个路径（跨平台，**不做路径校验**，调用方负责）。
///
/// `select = true` 表示在父目录中选中该项（文件定位），`false` 表示直接打开该目录。
pub(crate) fn reveal_path(p: &Path, select: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let result = {
        use std::os::windows::process::CommandExt;
        // /select 与路径必须拼成同一个参数；raw_arg 跳过标准参数转义，
        // 否则含空格的路径会被改写成 \"...\"，explorer 解析失败后落到默认目录
        let target = p.to_string_lossy().replace('/', "\\");
        let mut cmd = Command::new("explorer");
        if select {
            cmd.raw_arg(format!("/select,\"{target}\""));
        } else {
            cmd.raw_arg(format!("\"{target}\""));
        }
        cmd.spawn().map(|_| ())
    };

    #[cfg(target_os = "macos")]
    let result = {
        let mut cmd = Command::new("open");
        if select {
            cmd.arg("-R");
        }
        cmd.arg(p).spawn().map(|_| ())
    };

    #[cfg(target_os = "linux")]
    let result = {
        let target = if select {
            p.parent().map(|d| d.to_path_buf()).unwrap_or_else(|| p.to_path_buf())
        } else {
            p.to_path_buf()
        };
        Command::new("xdg-open").arg(target).spawn().map(|_| ())
    };

    result.map_err(|e| format!("打开文件管理器失败: {e}"))
}

/// 在系统文件管理器中定位（跨平台）。
/// 安全：仅允许已登记工作区根目录之内。
#[tauri::command]
pub fn reveal_in_file_manager(
    state: tauri::State<'_, PathGuard>,
    path: String,
) -> Result<(), String> {
    let p = state.ensure_root_scope(&path)?;
    reveal_path(&p, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("my_editor_fs_test_{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 复制：不覆盖、不动源文件，重名追加「 (副本)」且保留扩展名
    #[test]
    fn copy_appends_suffix_and_keeps_extension() {
        let base = temp_dir("copy");
        let dest = base.join("sub");
        fs::create_dir_all(&dest).unwrap();
        let src = base.join("a.txt");
        fs::write(&src, "hello").unwrap();

        let first = copy_or_move(&src, &dest, false).unwrap();
        assert_eq!(Path::new(&first).file_name().unwrap(), "a.txt");
        assert_eq!(fs::read_to_string(&first).unwrap(), "hello");

        let second = copy_or_move(&src, &dest, false).unwrap();
        assert_eq!(Path::new(&second).file_name().unwrap(), "a (副本).txt");

        let third = copy_or_move(&src, &dest, false).unwrap();
        assert_eq!(Path::new(&third).file_name().unwrap(), "a (副本 2).txt");
        assert!(src.exists(), "复制不能动源文件");

        let _ = fs::remove_dir_all(&base);
    }

    /// 目录递归复制
    #[test]
    fn copy_directory_recursively() {
        let base = temp_dir("copydir");
        let src = base.join("pkg");
        fs::create_dir_all(src.join("nested")).unwrap();
        fs::write(src.join("nested/x.txt"), "1").unwrap();
        let dest = base.join("dest");
        fs::create_dir_all(&dest).unwrap();

        let target = copy_or_move(&src, &dest, false).unwrap();
        assert!(Path::new(&target).join("nested/x.txt").is_file());

        let _ = fs::remove_dir_all(&base);
    }

    /// 剪切：移动后源消失
    #[test]
    fn cut_moves_and_removes_source() {
        let base = temp_dir("cut");
        let src = base.join("a.txt");
        fs::write(&src, "x").unwrap();
        let dest = base.join("sub");
        fs::create_dir_all(&dest).unwrap();

        let target = copy_or_move(&src, &dest, true).unwrap();
        assert!(!src.exists(), "剪切后源应消失");
        assert!(Path::new(&target).is_file());

        let _ = fs::remove_dir_all(&base);
    }

    /// 剪切遇到同名项：报错且不动源文件（移动+覆盖等于静默丢数据）
    #[test]
    fn cut_refuses_existing_target() {
        let base = temp_dir("cutclash");
        let src = base.join("a.txt");
        fs::write(&src, "x").unwrap();
        let dest = base.join("sub");
        fs::create_dir_all(&dest).unwrap();
        fs::write(dest.join("a.txt"), "y").unwrap();

        let err = copy_or_move(&src, &dest, true).unwrap_err();
        assert!(err.contains("同名"), "实际错误: {err}");
        assert!(src.exists(), "失败时不能动源文件");
        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "y");

        let _ = fs::remove_dir_all(&base);
    }

    /// 目录不能放进自己里面（否则会无限递归复制）
    #[test]
    fn refuses_directory_into_itself() {
        let base = temp_dir("selfmove");
        let src = base.join("pkg");
        fs::create_dir_all(src.join("inner")).unwrap();

        let err = copy_or_move(&src, &src.join("inner"), true).unwrap_err();
        assert!(err.contains("自己"), "实际错误: {err}");

        let _ = fs::remove_dir_all(&base);
    }

    /// 源不存在：给出可读原因，而不是"复制失败"
    #[test]
    fn missing_source_is_reported() {
        let base = temp_dir("missing");
        let dest = base.join("sub");
        fs::create_dir_all(&dest).unwrap();
        let err = copy_or_move(&base.join("nope.txt"), &dest, false).unwrap_err();
        assert!(err.contains("源不存在"), "实际错误: {err}");
        let _ = fs::remove_dir_all(&base);
    }
}
