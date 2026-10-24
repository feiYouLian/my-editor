//! 路径安全守卫（纵深防御）。
//!
//! 背景：Tauri 2 的自定义命令不受 capability ACL 约束，任何能在 WebView
//! 内执行脚本的入口（XSS、被污染的预览内容）都可以直接 invoke 这些命令。
//! 本模块把「破坏性 / 覆盖类」命令限制在应用已知路径范围内：
//! - 已登记的工作区根目录（打开文件夹 / 会话恢复 / save_workspace）
//! - 已登记的路径（打开 / 探测 / 比较 / 保存 / 监听 / 对话框选取）
//! - 已登记路径所在目录（允许「另存在已打开文件旁边」）
//!
//! 读取类命令（打开文件 / 列举目录 / 探测）保持宽松：编辑器必须能打开
//! 用户在对话框里任意选取的文件，这类路径无法由后端验证来源。
//!
//! 说明：register_paths 可被 WebView 内脚本伪造，因此它只能收敛「与应用
//! UI 完全无关的任意路径」（系统目录、用户配置目录等）攻击面；真正的入口
//! 封闭依赖 CSP（tauri.conf.json）与预览内容消毒。

use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::sync::RwLock;

/// 作用域校验失败的统一提示
const SCOPE_ERR: &str = "路径不在已打开的工作区/文件范围内，操作已被阻止（安全策略）";

/// 已登记路径集合：roots 为目录（含工作区根），files 为文件
#[derive(Default)]
pub struct PathGuard {
    roots: RwLock<HashSet<PathBuf>>,
    files: RwLock<HashSet<PathBuf>>,
}

impl PathGuard {
    pub fn new() -> Self {
        Self::default()
    }

    /// 规范化路径：
    /// 1. 词法层去掉 `.`、弹出 `..`（越出根部即拒绝），消除 `..` 逃逸；
    /// 2. 文件系统层 canonicalize 最长存在前缀（解析符号链接），
    ///    再把不存在的剩余分量拼接回去（新建文件场景）。
    pub fn normalize(path: &Path) -> Result<PathBuf, String> {
        if path.as_os_str().is_empty() {
            return Err("路径为空".to_string());
        }
        if path.to_string_lossy().contains('\0') {
            return Err("路径含有非法字符".to_string());
        }

        let mut prefix: Option<OsString> = None;
        let mut rooted = false;
        let mut stack: Vec<OsString> = Vec::new();
        for comp in path.components() {
            match comp {
                Component::Prefix(p) => prefix = Some(p.as_os_str().to_os_string()),
                Component::RootDir => rooted = true,
                Component::CurDir => {}
                Component::ParentDir => {
                    if stack.pop().is_none() {
                        return Err("路径不合法：越出根目录".to_string());
                    }
                }
                Component::Normal(s) => stack.push(s.to_os_string()),
            }
        }
        let mut lexical = PathBuf::new();
        let has_prefix = prefix.is_some();
        if let Some(p) = prefix {
            lexical.push(p);
        }
        if rooted || has_prefix {
            lexical.push(std::path::MAIN_SEPARATOR.to_string());
        }
        for s in &stack {
            lexical.push(s);
        }
        if lexical.as_os_str().is_empty() {
            return Err("路径为空".to_string());
        }

        // 从已存在的最长祖先开始 canonicalize，逐级拼接剩余分量
        let mut cursor = lexical.clone();
        let mut tail: Vec<OsString> = Vec::new();
        loop {
            if cursor.exists() {
                let base = std::fs::canonicalize(&cursor)
                    .map_err(|e| format!("路径规范化失败: {e}"))?;
                let mut out = base;
                for t in tail.iter().rev() {
                    out.push(t);
                }
                return Ok(out);
            }
            match (cursor.file_name(), cursor.parent()) {
                (Some(name), Some(parent)) if !parent.as_os_str().is_empty() => {
                    tail.push(name.to_os_string());
                    cursor = parent.to_path_buf();
                }
                // 无任何已存在前缀（例如全新盘符路径）：退回词法规范化结果
                _ => return Ok(lexical),
            }
        }
    }

    /// 登记工作区根目录
    pub fn add_root(&self, raw: &str) {
        if let Ok(p) = Self::normalize(Path::new(raw)) {
            if p.is_dir() {
                self.roots
                    .write()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(p);
            }
        }
    }

    /// 登记单个路径：同时记为「已知文件」与「已知根」。
    /// 兼作根是为了覆盖「在已登记路径下新建子目录/文件」的场景
    /// （如导出的 xxx.md.assets/ 素材目录）；对真实文件而言，
    /// 以其为前缀的路径必然无法创建，不会有额外暴露面。
    pub fn add_path(&self, raw: &str) {
        if let Ok(p) = Self::normalize(Path::new(raw)) {
            {
                let mut files = self.files.write().unwrap_or_else(|e| e.into_inner());
                files.insert(p.clone());
            }
            let mut roots = self.roots.write().unwrap_or_else(|e| e.into_inner());
            roots.insert(p);
        }
    }

    /// 已登记根中的首个真实目录（供 run_curl 等无磁盘文件场景取工作目录）。
    /// 仅排序后取第一个，保证同一会话内行为稳定。
    pub fn first_dir_root(&self) -> Option<PathBuf> {
        let roots = self.roots.read().unwrap_or_else(|e| e.into_inner());
        let mut dirs: Vec<PathBuf> = roots.iter().filter(|p| p.is_dir()).cloned().collect();
        dirs.sort();
        dirs.into_iter().next()
    }

    /// 目录树操作（新建 / 重命名 / 删除 / 定位）：仅允许已登记根目录之内。
    /// 文件树 UI 本身也只展示工作区内的条目，零误伤。
    pub fn ensure_root_scope(&self, raw: &str) -> Result<PathBuf, String> {
        let p = Self::normalize(Path::new(raw))?;
        let roots = self.roots.read().unwrap_or_else(|e| e.into_inner());
        if roots.iter().any(|r| p.starts_with(r)) {
            return Ok(p);
        }
        Err(SCOPE_ERR.to_string())
    }

    /// 文件类操作（写二进制 / 导出补丁 / 运行 / 批量转码）：
    /// 允许 = 已登记根目录之内 / 已登记路径 / 已登记文件的同目录。
    pub fn ensure_file_scope(&self, raw: &str) -> Result<PathBuf, String> {
        let p = Self::normalize(Path::new(raw))?;
        {
            let roots = self.roots.read().unwrap_or_else(|e| e.into_inner());
            if roots.iter().any(|r| p.starts_with(r)) {
                return Ok(p);
            }
        }
        let files = self.files.read().unwrap_or_else(|e| e.into_inner());
        if files.contains(&p) {
            return Ok(p);
        }
        if let Some(parent) = p.parent() {
            if files.iter().any(|f| f.parent() == Some(parent)) {
                return Ok(p);
            }
        }
        Err(SCOPE_ERR.to_string())
    }
}

/// 前端登记对话框选取的路径（批量编码的文件与输出目录等）。
/// 打开/保存/比较等流程由后端在对应命令内自动登记，无需前端调用。
#[tauri::command]
pub fn register_paths(state: tauri::State<'_, PathGuard>, paths: Vec<String>) {
    for p in paths {
        state.add_path(&p);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lexical_dotdot_escape_rejected() {
        assert!(PathGuard::normalize(Path::new("..\\..\\x")).is_err());
        assert!(PathGuard::normalize(Path::new("../x")).is_err());
    }

    #[test]
    fn empty_and_nul_rejected() {
        assert!(PathGuard::normalize(Path::new("")).is_err());
        assert!(PathGuard::normalize(Path::new("a\0b")).is_err());
    }

    #[test]
    fn relative_path_passes_lexical_layer() {
        let p = PathGuard::normalize(Path::new("a\\.\\b\\c.txt")).unwrap();
        assert!(p.ends_with("a/b/c.txt") || p.ends_with("a\\b\\c.txt"));
    }

    #[test]
    fn nonexistent_path_keeps_tail() {
        // 临时目录一定存在；拼接一个不存在的新文件名
        let dir = std::env::temp_dir().join("my_editor_paths_test_dir");
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("new-file.txt");
        let p = PathGuard::normalize(&target).unwrap();
        assert!(p.ends_with("new-file.txt"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scope_allows_registered_root_and_sibling() {
        let guard = PathGuard::new();
        let dir = std::env::temp_dir().join("my_editor_paths_scope");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        std::fs::write(&file, b"x").unwrap();

        // 未登记：一律拒绝
        assert!(guard.ensure_file_scope(file.to_str().unwrap()).is_err());
        assert!(guard.ensure_root_scope(dir.to_str().unwrap()).is_err());

        // 登记文件后：允许写它自己与同目录新文件，但不允许删目录
        guard.add_path(file.to_str().unwrap());
        assert!(guard.ensure_file_scope(file.to_str().unwrap()).is_ok());
        assert!(guard
            .ensure_file_scope(dir.join("b.txt").to_str().unwrap())
            .is_ok());
        assert!(guard.ensure_root_scope(dir.to_str().unwrap()).is_err());

        // 登记根目录后：目录树操作放行
        guard.add_root(dir.to_str().unwrap());
        assert!(guard.ensure_root_scope(dir.to_str().unwrap()).is_ok());
        assert!(guard
            .ensure_root_scope(dir.join("sub").join("c.txt").to_str().unwrap())
            .is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
