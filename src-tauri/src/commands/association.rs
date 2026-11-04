//! 文件关联：「用 my-editor 打开」的选项（仅 Windows 有实际动作）。
//!
//! 设计底线：**只做候选，不抢默认**。
//! - 不写 `Software\Classes\.<ext>` 的默认值（那才是「默认打开方式」）
//! - 不写 `Explorer\FileExts\.<ext>\UserChoice`（Win10+ 有哈希保护，硬写会被系统重置）
//! - 只写 HKCU（无需管理员），卸载 / 关闭时只删自己写的键和值
//!
//! 写入位置：
//! - `Software\Classes\Applications\<exe>`：资源管理器「打开方式」读取的应用条目
//! - `Software\Classes\my-editor.openwith`：ProgID（图标 / 命令行 / 显示名）
//! - `Software\Classes\.<ext>\OpenWithProgids`：把 ProgID 挂到各扩展名的候选列表
//!
//! 写入位置不含 `.ext` 默认值，安装包无需声明 `bundle.fileAssociations`。

use serde::Serialize;

/// 支持的扩展名（不带点）
pub const ASSOCIATED_EXTENSIONS: &[&str] = &[
    "txt",
    "text",
    "log",
    "md",
    "markdown",
    "json",
    "jsonc",
    "yaml",
    "yml",
    "toml",
    "ini",
    "conf",
    "cfg",
    "properties",
    "xml",
    "html",
    "htm",
    "css",
    "js",
    "jsx",
    "ts",
    "tsx",
    "rs",
    "py",
    "go",
    "java",
    "c",
    "h",
    "cpp",
    "hpp",
    "cs",
    "php",
    "rb",
    "sh",
    "bat",
    "ps1",
    "sql",
    "csv",
    "diff",
    "patch",
];

/// 一个 ProgID 服务所有文本扩展名
pub const PROGID: &str = "my-editor.openwith";
/// 「打开方式」列表里显示的应用名
const APP_NAME: &str = "my-editor";
/// 「打开方式」列表里显示的类型描述
const TYPE_NAME: &str = "my-editor 文本文档";

/// 当前实际状态：配置开关只是「意图」，这里读的是注册表里的「事实」
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssociationStatus {
    /// 当前平台是否支持（仅 Windows）
    pub supported: bool,
    /// 是否已登记到「打开方式」候选
    pub registered: bool,
    /// 当前进程的可执行文件路径（用于让用户确认指向了哪个安装）
    pub executable: String,
    /// 登记的扩展名数量
    pub extensions: usize,
}

/// 旧版安装器留下的默认关联：`.ext` 默认值直接指向 my-editor（新版只登记候选，不会产生这种项）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyAssociation {
    pub ext: String,
    /// `.ext` 当前默认 ProgID（旧 NSIS 包为 "Text Document"，MSI 包为 "my-editor.<ext>"）
    pub progid: String,
    /// 安装前备份的原默认 ProgID；None = 没有备份，只能去掉默认
    pub backup: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyClearOutcome {
    /// 恢复为原默认程序的扩展名数
    pub restored: usize,
    /// 无备份、已去掉默认关联的扩展名数
    pub cleared: usize,
}

#[tauri::command]
pub fn file_association_status() -> AssociationStatus {
    platform::status()
}

/// 扫描旧版默认关联（只读，不动注册表）
#[tauri::command]
pub fn scan_legacy_associations() -> Vec<LegacyAssociation> {
    platform::scan_legacy()
}

/// 一键恢复：有备份的写回原程序，没有备份的去掉默认值
#[tauri::command]
pub async fn clear_legacy_associations() -> Result<LegacyClearOutcome, String> {
    tauri::async_runtime::spawn_blocking(platform::clear_legacy)
        .await
        .map_err(|e| format!("恢复旧关联任务失败: {e}"))?
}

/// 打开 / 关闭「在打开方式中显示 my-editor」。
/// 幂等：已登记且指向当前 exe 时直接返回，不重复写注册表。
#[tauri::command]
pub async fn set_file_association(enabled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || platform::apply(enabled))
        .await
        .map_err(|e| format!("文件关联任务失败: {e}"))?
}

/// `"<exe>" "%1"`：路径含空格时必须带引号
fn command_for(exe: &str) -> String {
    format!("\"{exe}\" \"%1\"")
}

/// 取可执行文件名（资源管理器的 Applications 子键按 exe 文件名索引）
fn exe_name(exe: &str) -> String {
    std::path::Path::new(exe)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "my-editor.exe".to_string())
}

/// 从命令行取可执行文件名：`"C:\Path\my-editor.exe" "%1"` → `my-editor.exe`
fn exe_name_from_command(command: &str) -> Option<String> {
    let trimmed = command.trim();
    let exe = if let Some(rest) = trimmed.strip_prefix('"') {
        rest.split('"').next().unwrap_or("")
    } else {
        trimmed.split_whitespace().next().unwrap_or("")
    };
    if exe.is_empty() {
        return None;
    }
    std::path::Path::new(exe)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
}

fn applications_key(exe_name: &str) -> String {
    format!("Software\\Classes\\Applications\\{exe_name}")
}

fn open_with_progids_key(ext: &str) -> String {
    format!("Software\\Classes\\.{ext}\\OpenWithProgids")
}

#[cfg(windows)]
mod platform {
    use super::*;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, WIN32_ERROR};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyW, RegDeleteTreeW, RegDeleteValueW, RegOpenKeyW, RegQueryValueExW,
        RegSetValueExW, HKEY, HKEY_CURRENT_USER, REG_SZ, REG_VALUE_TYPE,
    };
    use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn check(code: WIN32_ERROR, action: &str) -> Result<(), String> {
        if code == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(format!("{action}失败（Windows 错误码 {}）", code.0))
        }
    }

    /// HKEY 的 RAII 包装：任何路径提前返回都不会泄漏句柄
    struct Key(HKEY);

    impl Key {
        fn create(path: &str) -> Result<Self, String> {
            let path_w = wide(path);
            let mut hkey = HKEY::default();
            let code =
                unsafe { RegCreateKeyW(HKEY_CURRENT_USER, PCWSTR(path_w.as_ptr()), &mut hkey) };
            check(code, &format!("创建注册表键 {path}"))?;
            Ok(Self(hkey))
        }

        fn open(path: &str) -> Option<Self> {
            let path_w = wide(path);
            let mut hkey = HKEY::default();
            let code =
                unsafe { RegOpenKeyW(HKEY_CURRENT_USER, PCWSTR(path_w.as_ptr()), &mut hkey) };
            (code == ERROR_SUCCESS).then_some(Self(hkey))
        }
    }

    impl Drop for Key {
        fn drop(&mut self) {
            // 关闭句柄失败没有可补救的动作，忽略错误码即可
            let _ = unsafe { RegCloseKey(self.0) };
        }
    }

    /// 写 REG_SZ（`value` 里的 NUL 由这里补）
    fn set_string(key: &Key, name: &str, value: &str) -> Result<(), String> {
        let name_w = wide(name);
        let value_w = wide(value);
        // REG_SZ 的字节内容就是 UTF-16LE，cbData 必须含结尾 NUL
        let bytes =
            unsafe { std::slice::from_raw_parts(value_w.as_ptr().cast::<u8>(), value_w.len() * 2) };
        let code =
            unsafe { RegSetValueExW(key.0, PCWSTR(name_w.as_ptr()), None, REG_SZ, Some(bytes)) };
        check(code, &format!("写入注册表值 {name}"))
    }

    /// 读默认值（REG_SZ）；不存在 / 类型不对返回 None
    fn default_string(key: &Key) -> Option<String> {
        value_string(key, "")
    }

    /// 按值名读 REG_SZ；不存在 / 类型不对返回 None
    fn value_string(key: &Key, name: &str) -> Option<String> {
        let name_w = wide(name);
        let mut kind = REG_VALUE_TYPE::default();
        let mut len = 0u32;
        let code = unsafe {
            RegQueryValueExW(
                key.0,
                PCWSTR(name_w.as_ptr()),
                None,
                Some(&mut kind),
                None,
                Some(&mut len),
            )
        };
        if code != ERROR_SUCCESS || kind != REG_SZ || len == 0 {
            return None;
        }
        let mut buf = vec![0u8; len as usize];
        let code = unsafe {
            RegQueryValueExW(
                key.0,
                PCWSTR(name_w.as_ptr()),
                None,
                Some(&mut kind),
                Some(buf.as_mut_ptr()),
                Some(&mut len),
            )
        };
        if code != ERROR_SUCCESS {
            return None;
        }
        buf.truncate(len as usize);
        let units: Vec<u16> = buf
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        Some(
            String::from_utf16_lossy(&units)
                .trim_end_matches('\0')
                .to_string(),
        )
    }

    /// 删除整棵子键；不存在视为成功（关闭开关时重复调用不应报错）
    fn delete_tree(path: &str) -> Result<(), String> {
        let path_w = wide(path);
        let code = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(path_w.as_ptr())) };
        if code == ERROR_SUCCESS || code == ERROR_FILE_NOT_FOUND {
            Ok(())
        } else {
            Err(format!(
                "删除注册表键 {path} 失败（Windows 错误码 {}）",
                code.0
            ))
        }
    }

    fn delete_value(key: &Key, name: &str) {
        let name_w = wide(name);
        // 值不存在返回 ERROR_FILE_NOT_FOUND，与成功同样处理
        let _ = unsafe { RegDeleteValueW(key.0, PCWSTR(name_w.as_ptr())) };
    }

    /// 通知资源管理器刷新关联缓存，否则「打开方式」要等下次登录才变
    fn notify_shell() {
        unsafe {
            SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
        }
    }

    fn current_exe() -> Result<String, String> {
        std::env::current_exe()
            .map(|path| path.to_string_lossy().to_string())
            .map_err(|e| format!("取当前程序路径失败: {e}"))
    }

    pub(super) fn status() -> AssociationStatus {
        let executable = current_exe().unwrap_or_default();
        let expected = command_for(&executable);
        let command_key = format!(
            "{}\\shell\\open\\command",
            applications_key(&exe_name(&executable))
        );
        // 只有命令行确实指向当前 exe 才算已登记（升级换了目录时视为未登记，下次自愈重写）
        let registered = Key::open(&command_key)
            .and_then(|key| default_string(&key))
            .map(|command| command == expected)
            .unwrap_or(false);
        AssociationStatus {
            supported: true,
            registered,
            executable,
            extensions: ASSOCIATED_EXTENSIONS.len(),
        }
    }

    pub(super) fn apply(enabled: bool) -> Result<(), String> {
        let exe = current_exe()?;
        if enabled {
            register(&exe)
        } else {
            unregister(&exe)
        }
    }

    pub(super) fn scan_legacy() -> Vec<LegacyAssociation> {
        scan_legacy_in(ASSOCIATED_EXTENSIONS)
    }

    pub(super) fn clear_legacy() -> Result<LegacyClearOutcome, String> {
        clear_legacy_in(ASSOCIATED_EXTENSIONS)
    }

    /// 扩展名列表由调用方传入：生产用固定清单，测试注入临时扩展名避免碰真实关联
    fn scan_legacy_in(exts: &[&str]) -> Vec<LegacyAssociation> {
        let mut out = Vec::new();
        for ext in exts {
            let Some(key) = Key::open(&format!("Software\\Classes\\.{ext}")) else {
                continue;
            };
            let Some(progid) = default_string(&key) else {
                continue;
            };
            // 空默认值 / 新开关自己的 ProgID 都不是旧版遗留；
            // 含分隔符的 ProgID 不接受，避免后续 delete_tree 拼出越界键
            if progid.is_empty()
                || progid.eq_ignore_ascii_case(PROGID)
                || progid.contains('\\')
                || progid.contains('/')
            {
                continue;
            }
            if !progid_points_to_us(&progid) {
                continue;
            }
            let backup = value_string(&key, &format!("{progid}_backup"));
            out.push(LegacyAssociation {
                ext: (*ext).to_string(),
                progid,
                backup,
            });
        }
        out
    }

    fn clear_legacy_in(exts: &[&str]) -> Result<LegacyClearOutcome, String> {
        let legacy = scan_legacy_in(exts);
        let mut restored = 0usize;
        let mut cleared = 0usize;
        let mut progids = std::collections::BTreeSet::new();

        for item in &legacy {
            let Some(key) = Key::open(&format!("Software\\Classes\\.{}", item.ext)) else {
                continue;
            };
            match item.backup.as_deref() {
                Some(backup) if !backup.is_empty() => {
                    set_string(&key, "", backup)?;
                    restored += 1;
                }
                // 没有安装前的备份：直接去掉默认值（双击时由系统询问用什么打开）
                _ => {
                    delete_value(&key, "");
                    cleared += 1;
                }
            }
            delete_value(&key, &format!("{}_backup", item.progid));
            if let Some(progids_key) = Key::open(&open_with_progids_key(&item.ext)) {
                delete_value(&progids_key, &item.progid);
            }
            progids.insert(item.progid.clone());
        }

        // 旧 ProgID 键共享（NSIS 的 "Text Document" 覆盖全部扩展名），去重后统一删
        for progid in progids {
            if progid_points_to_us(&progid) {
                delete_tree(&format!("Software\\Classes\\{progid}"))?;
            }
        }
        if !legacy.is_empty() {
            notify_shell();
        }
        Ok(LegacyClearOutcome { restored, cleared })
    }

    /// 只认「命令行指向 my-editor」的 ProgID，避免误删其它程序
    fn progid_points_to_us(progid: &str) -> bool {
        let Some(command) = Key::open(&format!("Software\\Classes\\{progid}\\shell\\open\\command"))
            .and_then(|key| default_string(&key))
        else {
            return false;
        };
        let Some(name) = exe_name_from_command(&command) else {
            return false;
        };
        let current = exe_name(&current_exe().unwrap_or_default());
        name.eq_ignore_ascii_case("my-editor.exe") || name.eq_ignore_ascii_case(&current)
    }

    fn register(exe: &str) -> Result<(), String> {
        register_with(exe, PROGID)
    }

    fn register_with(exe: &str, progid: &str) -> Result<(), String> {
        let command = command_for(exe);
        let app = applications_key(&exe_name(exe));
        let command_key = format!("{app}\\shell\\open\\command");

        // 已登记且指向当前 exe：幂等返回，避免每次启动重写 40 个扩展名
        if Key::open(&command_key)
            .and_then(|key| default_string(&key))
            .map(|existing| existing == command)
            .unwrap_or(false)
        {
            return Ok(());
        }

        let icon = format!("\"{exe}\",0");
        {
            let key = Key::create(&app)?;
            set_string(&key, "FriendlyAppName", APP_NAME)?;
            set_string(&key, "DefaultIcon", &icon)?;
        }
        {
            let key = Key::create(&command_key)?;
            set_string(&key, "", &command)?;
        }
        {
            let key = Key::create(&format!("{app}\\SupportedTypes"))?;
            for ext in ASSOCIATED_EXTENSIONS {
                // 值名是带点的扩展名，内容是空
                set_string(&key, &format!(".{ext}"), "")?;
            }
        }
        {
            let key = Key::create(&format!("Software\\Classes\\{progid}"))?;
            set_string(&key, "", TYPE_NAME)?;
            set_string(&key, "DefaultIcon", &icon)?;
        }
        {
            let key = Key::create(&format!("Software\\Classes\\{progid}\\shell\\open\\command"))?;
            set_string(&key, "", &command)?;
        }
        // 只挂候选，不动 `.ext` 的默认值
        for ext in ASSOCIATED_EXTENSIONS {
            let key = Key::create(&open_with_progids_key(ext))?;
            set_string(&key, progid, "")?;
        }

        notify_shell();
        Ok(())
    }

    fn unregister(exe: &str) -> Result<(), String> {
        unregister_with(exe, PROGID)
    }

    fn unregister_with(exe: &str, progid: &str) -> Result<(), String> {
        delete_tree(&applications_key(&exe_name(exe)))?;
        delete_tree(&format!("Software\\Classes\\{progid}"))?;
        // 只删自己写的值；OpenWithProgids 里可能还有其它编辑器
        for ext in ASSOCIATED_EXTENSIONS {
            if let Some(key) = Key::open(&open_with_progids_key(ext)) {
                delete_value(&key, progid);
            }
        }
        notify_shell();
        Ok(())
    }

    /// 真实写一次 HKCU 的可选验证：用测试专用 ProgID，跑完自清理。
    /// 默认 ignore（会短暂改动注册表）：
    /// `cargo test --lib -- --ignored association_registry_roundtrip`
    #[cfg(test)]
    mod registry_tests {
        use super::*;

        #[test]
        #[ignore = "会写当前用户注册表（测试专用 ProgID，跑完自清理）"]
        fn association_registry_roundtrip() {
            let exe = current_exe().expect("当前 exe");
            let progid = "my-editor.openwith.test";
            let app = applications_key(&exe_name(&exe));
            let command_key = format!("{app}\\shell\\open\\command");

            // 先清一次：上次异常退出可能留下同一测试 ProgID
            unregister_with(&exe, progid).expect("预清理");

            register_with(&exe, progid).expect("登记");
            // 设置页开关以 status 为准：登记后必须能读回「已登记」
            assert!(status().registered, "登记后 status 应识别为已登记");
            {
                let key = Key::open(&command_key).expect("Applications 命令行键应存在");
                assert_eq!(
                    default_string(&key).as_deref(),
                    Some(command_for(&exe).as_str())
                );
            }
            {
                let key = Key::open(&format!("{app}\\SupportedTypes")).expect("SupportedTypes");
                assert_eq!(value_string(&key, ".txt").as_deref(), Some(""));
            }
            for ext in ["txt", "md", "rs"] {
                let key = Key::open(&open_with_progids_key(ext)).expect("OpenWithProgids");
                // 值存在且为空串（候选标记的约定写法）
                assert_eq!(value_string(&key, progid).as_deref(), Some(""), "候选: {ext}");
            }

            unregister_with(&exe, progid).expect("清理");
            assert!(!status().registered, "清理后 status 应恢复未登记");
            assert!(Key::open(&command_key).is_none(), "清理后 Applications 应消失");
            assert!(
                Key::open(&format!("Software\\Classes\\{progid}")).is_none(),
                "清理后 ProgID 应消失"
            );
        }

        /// 旧默认关联的扫描 / 恢复：用临时扩展名，避免碰真实 `.txt` 等关联。
        /// 默认 ignore：`cargo test --lib -- --ignored legacy_association_restore_roundtrip`
        #[test]
        #[ignore = "会写当前用户注册表（测试专用扩展名与 ProgID，跑完自清理）"]
        fn legacy_association_restore_roundtrip() {
            let exe = current_exe().expect("当前 exe");
            let ext = "myeditortest";
            let other = "myeditortest2";
            let progid = "my-editor.legacy.test";
            let progid2 = "my-editor.legacy.test2";
            let ext_path = format!("Software\\Classes\\.{ext}");
            let ext2_path = format!("Software\\Classes\\.{other}");
            let progid_path = format!("Software\\Classes\\{progid}");
            let progid2_path = format!("Software\\Classes\\{progid2}");

            // 预清理：上次异常退出可能留下同一测试键
            let _ = delete_tree(&ext_path);
            let _ = delete_tree(&ext2_path);
            let _ = delete_tree(&progid_path);
            let _ = delete_tree(&progid2_path);

            // 有备份：模拟旧 NSIS（默认值 = ProgID，_backup = 安装前的 txtfilelegacy）
            {
                let key = Key::create(&ext_path).expect("扩展名键");
                set_string(&key, "", progid).expect("默认值");
                set_string(&key, &format!("{progid}_backup"), "txtfilelegacy").expect("备份值");
            }
            {
                let key = Key::create(&format!("{progid_path}\\shell\\open\\command"))
                    .expect("命令键");
                set_string(&key, "", &command_for(&exe)).expect("命令");
            }
            // 无备份：模拟 MSI 的 my-editor.<ext> ProgID
            {
                let key = Key::create(&ext2_path).expect("扩展名键");
                set_string(&key, "", progid2).expect("默认值");
            }
            {
                let key = Key::create(&format!("{progid2_path}\\shell\\open\\command"))
                    .expect("命令键");
                set_string(&key, "", &command_for(&exe)).expect("命令");
            }

            let found = scan_legacy_in(&[ext, other]);
            assert_eq!(found.len(), 2, "两个旧默认关联都应被识别");
            assert_eq!(found[0].ext, ext);
            assert_eq!(found[0].backup.as_deref(), Some("txtfilelegacy"));
            assert_eq!(found[1].ext, other);
            assert_eq!(found[1].backup, None);

            let outcome = clear_legacy_in(&[ext, other]).expect("恢复");
            assert_eq!(outcome.restored, 1, "有备份的恢复原程序");
            assert_eq!(outcome.cleared, 1, "无备份的去掉默认");
            {
                let key = Key::open(&ext_path).expect("扩展名键仍在");
                assert_eq!(default_string(&key).as_deref(), Some("txtfilelegacy"));
                assert_eq!(value_string(&key, &format!("{progid}_backup")), None);
            }
            {
                let key = Key::open(&ext2_path).expect("扩展名键仍在");
                assert_eq!(default_string(&key), None, "无备份时默认为空");
            }
            assert!(Key::open(&progid_path).is_none(), "旧 ProgID 键应删除");
            assert!(Key::open(&progid2_path).is_none(), "旧 ProgID 键应删除");
            assert!(scan_legacy_in(&[ext, other]).is_empty(), "恢复后不应再检出");

            // 测试扩展名本身（空键）也要清掉
            let _ = delete_tree(&ext_path);
            let _ = delete_tree(&ext2_path);
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;

    pub(super) fn status() -> AssociationStatus {
        AssociationStatus {
            supported: false,
            registered: false,
            executable: std::env::current_exe()
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_default(),
            extensions: ASSOCIATED_EXTENSIONS.len(),
        }
    }

    pub(super) fn apply(_enabled: bool) -> Result<(), String> {
        Err("仅 Windows 支持在「打开方式」中登记；其它平台请在系统设置里手动选择打开方式".into())
    }

    pub(super) fn scan_legacy() -> Vec<LegacyAssociation> {
        Vec::new()
    }

    pub(super) fn clear_legacy() -> Result<LegacyClearOutcome, String> {
        Err("仅 Windows 支持恢复文件关联".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 扩展名列表是注册表键名的一部分：不能带点、不能重复、不能为空
    #[test]
    fn extension_list_is_clean() {
        let mut seen = std::collections::BTreeSet::new();
        for ext in ASSOCIATED_EXTENSIONS {
            assert!(!ext.is_empty(), "扩展名不能为空");
            assert!(!ext.starts_with('.'), "扩展名不应带点: {ext}");
            assert!(
                ext.chars().all(|c| c.is_ascii_alphanumeric()),
                "扩展名只允许 ASCII 字母数字: {ext}"
            );
            assert!(seen.insert(*ext), "扩展名重复: {ext}");
        }
        assert_eq!(seen.len(), 40, "扩展名数量与 README 说明保持一致");
    }

    /// 路径含空格时必须加引号，否则资源管理器会把路径截断成两段
    #[test]
    fn command_quotes_executable_and_argument() {
        assert_eq!(
            command_for("C:\\Program Files\\my-editor.exe"),
            "\"C:\\Program Files\\my-editor.exe\" \"%1\""
        );
    }

    #[test]
    fn exe_name_handles_windows_and_posix_paths() {
        assert_eq!(exe_name("C:\\Program Files\\my editor\\my-editor.exe"), "my-editor.exe");
        assert_eq!(exe_name("/usr/bin/my-editor"), "my-editor");
        assert_eq!(exe_name(""), "my-editor.exe");
    }

    /// Applications 子键按 exe 文件名索引，路径不参与
    #[test]
    fn applications_key_uses_exe_name() {
        assert_eq!(
            applications_key("my-editor.exe"),
            "Software\\Classes\\Applications\\my-editor.exe"
        );
        assert_eq!(
            open_with_progids_key("txt"),
            "Software\\Classes\\.txt\\OpenWithProgids"
        );
    }

    /// 旧关联检测靠 command 里的 exe 名：带引号 / 不带引号都要能取到
    #[test]
    fn command_exe_name_handles_quotes_and_bare_paths() {
        assert_eq!(
            exe_name_from_command("\"C:\\Program Files\\my-editor.exe\" \"%1\"").as_deref(),
            Some("my-editor.exe")
        );
        assert_eq!(
            exe_name_from_command("C:\\tools\\my-editor.exe \"%1\"").as_deref(),
            Some("my-editor.exe")
        );
        assert_eq!(exe_name_from_command(""), None);
        assert_eq!(exe_name_from_command("\"\""), None);
    }
}
