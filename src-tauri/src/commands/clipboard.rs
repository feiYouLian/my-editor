//! 系统剪贴板里的「文件列表」（Windows `CF_HDROP`）。
//!
//! 两个方向：
//! - 写出：在文件树里复制 → 放到系统剪贴板 → 在资源管理器里 `Ctrl+V` 能把文件粘出去
//! - 读入：在资源管理器里复制 → 文件树里 `Ctrl+V` → 粘进工作区目录
//!
//! 为什么不用第三方剪贴板 crate：只为一件事引一个跨平台库不值。`windows` crate 本来就在
//! 依赖图里（`trash` 拉进来的），这里显式声明并只打开需要的 feature，增量体积接近 0。
//! 非 Windows 平台直接给明确错误，前端提示"请在应用内复制"。
//!
//! 安全：这两个命令**不写盘**、也不接受客户端指定的目标路径，因此不经 `PathGuard`
//! （与 `reveal_config_dir` 同理）；真正的写入在 `commands/fs.rs::paste_files` 里守卫。

use std::path::Path;

/// 构造 `CF_HDROP` 的数据块：`DROPFILES` 头 + UTF-16 路径列表（双 NUL 结尾）。
///
/// 手写字节而不是填 `DROPFILES` 结构体：结构体布局随 windows crate 版本变化，
/// 而 `pFiles / pt / fNC / fWide` 的偏移是 Win32 固定的（4 + 8 + 4 + 4 = 20）。
pub fn build_dropfiles(paths: &[&Path]) -> Vec<u8> {
    let mut wide: Vec<u16> = Vec::new();
    for path in paths {
        wide.extend(path.to_string_lossy().encode_utf16());
        wide.push(0);
    }
    wide.push(0); // 列表结束再补一个 NUL

    const HEADER: usize = 20;
    let mut buf = vec![0u8; HEADER + wide.len() * 2];
    buf[0..4].copy_from_slice(&(HEADER as u32).to_le_bytes()); // pFiles：数据起点
    // pt（8 字节）与 fNC（4 字节）保持 0：不关联鼠标位置、不是拖放
    buf[16..20].copy_from_slice(&1u32.to_le_bytes()); // fWide = TRUE
    for (i, unit) in wide.iter().enumerate() {
        let off = HEADER + i * 2;
        buf[off..off + 2].copy_from_slice(&unit.to_le_bytes());
    }
    buf
}

#[cfg(windows)]
mod imp {
    use std::ptr;
    use windows::Win32::Foundation::{HANDLE, HWND};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_HDROP;
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

    use super::build_dropfiles;

    /// 离开作用域必定关闭剪贴板：不关会让资源管理器等其他程序读到"被占用"而失败
    struct CloseGuard;
    impl Drop for CloseGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }

    pub fn read_files() -> Result<Vec<String>, String> {
        unsafe {
            OpenClipboard(Some(HWND::default())).map_err(|e| format!("打开剪贴板失败: {e}"))?;
            let _guard = CloseGuard;
            let handle = match GetClipboardData(CF_HDROP.0 as u32) {
                Ok(h) => h,
                // 剪贴板里是文本 / 图片 / 空的：不是错误，交给调用方回退
                Err(_) => return Ok(Vec::new()),
            };
            let hdrop = HDROP(handle.0);
            let count = DragQueryFileW(hdrop, u32::MAX, None);
            let mut out = Vec::with_capacity(count as usize);
            for index in 0..count {
                let len = DragQueryFileW(hdrop, index, None);
                if len == 0 {
                    continue;
                }
                let mut buf = vec![0u16; len as usize + 1];
                let written = DragQueryFileW(hdrop, index, Some(&mut buf));
                if written == 0 {
                    continue;
                }
                out.push(String::from_utf16_lossy(&buf[..written as usize]));
            }
            Ok(out)
        }
    }

    pub fn write_files(paths: &[&std::path::Path]) -> Result<(), String> {
        if paths.is_empty() {
            return Err("没有可复制的文件".to_string());
        }
        let buf = build_dropfiles(paths);
        unsafe {
            OpenClipboard(Some(HWND::default())).map_err(|e| format!("打开剪贴板失败: {e}"))?;
            let _guard = CloseGuard;
            EmptyClipboard().map_err(|e| format!("清空剪贴板失败: {e}"))?;

            let hmem = GlobalAlloc(GMEM_MOVEABLE, buf.len())
                .map_err(|e| format!("分配剪贴板内存失败: {e}"))?;
            let dst = GlobalLock(hmem);
            if dst.is_null() {
                return Err("锁定剪贴板内存失败".to_string());
            }
            ptr::copy_nonoverlapping(buf.as_ptr(), dst as *mut u8, buf.len());
            let _ = GlobalUnlock(hmem);

            // 成功后这块内存的所有权归系统，不能再 GlobalFree
            SetClipboardData(CF_HDROP.0 as u32, Some(HANDLE(hmem.0)))
                .map_err(|e| format!("写入剪贴板失败: {e}"))?;
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn read_files() -> Result<Vec<String>, String> {
        // 没有文件列表概念：返回空，调用方回退到应用内剪贴板
        Ok(Vec::new())
    }

    pub fn write_files(_paths: &[&std::path::Path]) -> Result<(), String> {
        Err("当前平台不支持把文件放进系统剪贴板，请在应用内用复制 / 粘贴".to_string())
    }
}

/// 读系统剪贴板中的文件列表（无则空表）
#[tauri::command]
pub fn clipboard_get_files() -> Result<Vec<String>, String> {
    imp::read_files()
}

/// 把若干路径写进系统剪贴板的文件列表（资源管理器可粘贴）
#[tauri::command]
pub fn clipboard_set_files(paths: Vec<String>) -> Result<(), String> {
    let refs: Vec<&Path> = paths.iter().map(Path::new).collect();
    imp::write_files(&refs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 头 20 字节：pFiles=20、pt/fNC 归零、fWide=TRUE
    #[test]
    fn dropfiles_header_is_well_formed() {
        let buf = build_dropfiles(&[Path::new(r"C:\a\b.txt")]);
        assert_eq!(u32::from_le_bytes(buf[0..4].try_into().unwrap()), 20);
        assert_eq!(&buf[4..16], &[0u8; 12]);
        assert_eq!(u32::from_le_bytes(buf[16..20].try_into().unwrap()), 1);
    }

    /// 路径按 UTF-16LE 写入，每项以 NUL 结尾，整体再补一个 NUL（= DROPFILES 的双 NUL 结束）
    #[test]
    fn dropfiles_payload_is_utf16_double_null_terminated() {
        let buf = build_dropfiles(&[Path::new("a.txt"), Path::new("dir/b.txt")]);
        let units: Vec<u16> = buf[20..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let expected: Vec<u16> = "a.txt\0dir/b.txt\0\0".encode_utf16().collect();
        assert_eq!(units, expected);
        assert_eq!(*units.last().unwrap(), 0);
        assert_eq!(units[units.len() - 2], 0, "末尾必须是双 NUL");
    }

    /// 中文 / 空格路径原样编码（不做任何转义）
    #[test]
    fn dropfiles_keeps_unicode_paths_intact() {
        let path = PathBuf::from(r"D:\工作 目录\说明 文档.md");
        let buf = build_dropfiles(&[path.as_path()]);
        let units: Vec<u16> = buf[20..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let text = String::from_utf16(&units[..units.len() - 2]).unwrap();
        assert_eq!(text, r"D:\工作 目录\说明 文档.md");
    }
}
