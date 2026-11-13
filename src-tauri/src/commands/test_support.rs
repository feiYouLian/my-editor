//! 测试专用临时目录 / 文件辅助。
//!
//! 统一实现只负责「按 `<module>_test_<tag>` 命名 + 清理同名残留」；
//! 模块名必须作为参数传入，否则不同模块的同名 tag 会在并行测试里互删目录。
//!
//! 每个函数都标 `#[cfg(test)]`：panic 点扫描按文件内标注分类，
//! 只靠 `mod.rs` 的模块级 cfg 会被误判为生产代码。

use std::path::PathBuf;

/// 临时目录：先删同名残留再创建
#[cfg(test)]
pub(crate) fn temp_dir(module: &str, tag: &str) -> PathBuf {
    let mut dir = std::env::temp_dir();
    dir.push(format!("my_editor_{module}_test_{tag}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// 临时文件（带 `.txt` 后缀）
#[cfg(test)]
pub(crate) fn temp_file(module: &str, tag: &str, content: &[u8]) -> PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!("my_editor_{module}_test_{tag}.txt"));
    std::fs::write(&path, content).unwrap();
    path
}

/// 临时文件（无扩展名，供需要「无后缀路径」的夹具使用）
#[cfg(test)]
pub(crate) fn temp_file_raw(module: &str, tag: &str, content: &[u8]) -> PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!("my_editor_{module}_test_{tag}"));
    std::fs::write(&path, content).unwrap();
    path
}
