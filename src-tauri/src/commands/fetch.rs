//! 网页抓取：把 URL 指向的原始 HTML 保存到本地文件。
//!
//! 安全模型（与 paths.rs 的威胁模型对齐）：
//! - 只允许 http/https，拒绝 userinfo（`user:pass@`）与其它 scheme；
//! - 默认拦截 loopback / 链路本地 / 私网 / 未指定地址，防止注入脚本借
//!   `fetch_url` 探测内网；`config.json` 的 `fetch.allowPrivateNetwork`
//!   是明确的逃生开关（Rust 侧直接读文件，不信任前端入参）；
//! - 目标路径必须过 `PathGuard::ensure_file_scope`，落盘复用
//!   `file::atomic_write`（临时文件 → fsync → rename）；
//! - 响应体积上限 10MB（Content-Length 预检 + 读后复检）、总超时 15s、
//!   重定向上限 10 跳。
//!
//! 已知限制（v1）：reqwest 的 redirect policy 不暴露中间 URL，
//! 重定向后的最终地址不复查；私网默认拦截 + CSP 仍是主防线。

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};
use std::path::Path;
use std::time::Duration;

use serde::Serialize;

use crate::commands::file::atomic_write;
use crate::commands::paths::PathGuard;

/// 响应体积硬上限（10MB）
const MAX_FETCH_BYTES: u64 = 10 * 1024 * 1024;
/// 单次抓取总超时（含连接与读取）
const FETCH_TIMEOUT_SECS: u64 = 15;
/// 重定向上限
const MAX_REDIRECTS: usize = 10;
/// 文件名最大字符数
const MAX_FILE_NAME_CHARS: usize = 100;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchResult {
    /// 实际落盘路径
    pub path: String,
    pub bytes: u64,
    /// 响应 Content-Type（可能为空）
    pub content_type: String,
    /// 重定向后的最终 URL
    pub final_url: String,
}

// ---------------------------------------------------------------------------
// 纯函数：URL 校验 / 私网判定 / 文件名净化
// ---------------------------------------------------------------------------

/// IPv4 保留段：loopback、未指定、广播、链路本地、私网、CGNAT、基准测试段
fn is_private_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_link_local()
        || o[0] == 0
        || o[0] == 10
        || (o[0] == 172 && (16..=31).contains(&o[1]))
        || (o[0] == 192 && o[1] == 168)
        || (o[0] == 100 && (64..=127).contains(&o[1]))
        || (o[0] == 198 && (o[1] == 18 || o[1] == 19))
}

/// IPv6 保留段：loopback、未指定、ULA（fc00::/7）、链路本地（fe80::/10）、
/// IPv4 映射地址按内嵌 IPv4 再判一次
fn is_private_v6(ip: Ipv6Addr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() {
        return true;
    }
    let seg = ip.segments();
    if seg[0] & 0xfe00 == 0xfc00 || seg[0] & 0xffc0 == 0xfe80 {
        return true;
    }
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_private_v4(v4);
    }
    false
}

fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_private_v4(v4),
        IpAddr::V6(v6) => is_private_v6(v6),
    }
}

/// 主机名是否指向私网：IP 字面量直接判；域名解析后逐个检查。
/// 解析失败按错误处理（不做抓取）。
fn is_private_host(host: &str, port: u16) -> Result<bool, String> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(is_private_ip(ip));
    }
    let addrs = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("域名解析失败（{host}）：{e}"))?;
    let mut any = false;
    for addr in addrs {
        any = true;
        if is_private_ip(addr.ip()) {
            return Ok(true);
        }
    }
    if !any {
        return Err(format!("域名解析失败（{host}）：无可用地址"));
    }
    Ok(false)
}

/// URL 校验：scheme 白名单 + 拒绝 userinfo + 私网拦截（可配置放开）
pub fn validate_fetch_url(raw: &str, allow_private: bool) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|e| format!("URL 无效：{e}"))?;
    match url.scheme() {
        "http" | "https" => {}
        other => return Err(format!("仅支持 http/https 链接（当前：{other}）")),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URL 不能包含账号密码（user:pass@）".to_string());
    }
    let host = url.host_str().ok_or_else(|| "URL 缺少主机名".to_string())?;
    let port = url.port_or_known_default().unwrap_or(80);
    if !allow_private && is_private_host(host, port)? {
        return Err(format!(
            "已拦截内网 / 本机地址：{host}（确需抓取请在 config.json 设置 fetch.allowPrivateNetwork: true）"
        ));
    }
    Ok(url)
}

/// 百分号解码（路径段）：非法序列原样保留，非 UTF-8 以替换字符回退
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Windows 保留设备名（CON / PRN / AUX / NUL / COM1-9 / LPT1-9）
fn is_reserved_name(stem: &str) -> bool {
    let upper = stem.trim_end().to_ascii_uppercase();
    if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    let b = upper.as_bytes();
    b.len() == 4
        && (upper.starts_with("COM") || upper.starts_with("LPT"))
        && b[3].is_ascii_digit()
        && b[3] != b'0'
}

/// 文件名净化：剔非法字符、避开 Windows 保留名、去尾点/空格、限长、
/// 无扩展名补 `.html`；无有效内容时回落 `page.html`。
pub fn sanitize_filename(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "page.html".to_string();
    }
    let mut out: String = trimmed
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let stem = out.split('.').next().unwrap_or("");
    if is_reserved_name(stem) {
        out.insert(0, '_');
    }
    while out.ends_with('.') || out.ends_with(' ') {
        out.pop();
    }
    if out.is_empty() {
        return "page.html".to_string();
    }
    if !out.contains('.') {
        out.push_str(".html");
    }
    if out.chars().count() > MAX_FILE_NAME_CHARS {
        let ext = Path::new(&out)
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let keep = MAX_FILE_NAME_CHARS.saturating_sub(ext.chars().count());
        let mut stem: String = out.chars().take(keep).collect();
        stem.push_str(&ext);
        out = stem;
    }
    out
}

/// 由 URL 派生文件名建议：取 path 末段 → percent-decode → 净化。
/// URL 无效或末段为空时返回 `page.html`。
pub fn suggest_filename_from_url(raw: &str) -> String {
    let Ok(url) = reqwest::Url::parse(raw) else {
        return "page.html".to_string();
    };
    let last = url
        .path_segments()
        .and_then(|segments| segments.last())
        .unwrap_or("");
    sanitize_filename(&percent_decode(last))
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// 文件名建议命令：对话框输入 URL 时调用（规则与 Rust 侧净化保持单一来源）
#[tauri::command]
pub fn suggest_fetch_filename(url: String) -> String {
    suggest_filename_from_url(&url)
}

/// 抓取 URL 并原子落盘。
/// 私网开关在 Rust 侧直接读 config.json（不信任前端入参），注入脚本无法绕过。
#[tauri::command]
pub async fn fetch_url(
    app: tauri::AppHandle,
    guard: tauri::State<'_, PathGuard>,
    url: String,
    target: String,
    overwrite: bool,
) -> Result<FetchResult, String> {
    let allow_private = crate::commands::config::fetch_allow_private(&app);
    let _ = validate_fetch_url(&url, allow_private)?;
    let target = guard.ensure_file_scope(&target)?;
    if target.is_dir() {
        return Err("保存目标是一个目录，请指定文件名".to_string());
    }
    if !overwrite && target.exists() {
        return Err(format!(
            "目标文件已存在：{}（确认覆盖后重试）",
            target.to_string_lossy()
        ));
    }
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::limited(MAX_REDIRECTS))
        .user_agent(format!("my-editor/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("初始化网络客户端失败: {e}"))?;

    let resp = client.get(url).send().await.map_err(|e| {
        if e.is_timeout() {
            format!("抓取超时（{FETCH_TIMEOUT_SECS}s）：目标站点未在限时内响应")
        } else if e.is_redirect() {
            format!("重定向次数超过 {MAX_REDIRECTS} 跳，已停止")
        } else {
            format!("抓取失败: {e}")
        }
    })?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!(
            "服务器返回 {} {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("")
        ));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let final_url = resp.url().to_string();

    if let Some(len) = resp.content_length() {
        if len > MAX_FETCH_BYTES {
            return Err(format!(
                "响应体积 {} 超过上限 {}MB，已拒绝",
                len,
                MAX_FETCH_BYTES / 1024 / 1024
            ));
        }
    }
    let bytes = resp.bytes().await.map_err(|e| {
        if e.is_timeout() {
            format!("读取响应超时（{FETCH_TIMEOUT_SECS}s）")
        } else {
            format!("读取响应失败: {e}")
        }
    })?;
    // 服务端谎报 Content-Length 的兜底：内存瞬持后丢弃（v2 可改流式落盘）
    if bytes.len() as u64 > MAX_FETCH_BYTES {
        return Err(format!(
            "响应体积超过上限 {}MB，已拒绝",
            MAX_FETCH_BYTES / 1024 / 1024
        ));
    }

    // 落盘含 fsync，且响应可达数 MB：放 spawn_blocking，避免阻塞异步线程
    let target_bg = target.clone();
    let size = tauri::async_runtime::spawn_blocking(move || atomic_write(&target_bg, &bytes))
        .await
        .map_err(|e| format!("任务调度失败: {e}"))??;
    Ok(FetchResult {
        path: target.to_string_lossy().to_string(),
        bytes: size,
        content_type,
        final_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_scheme_whitelist() {
        assert!(validate_fetch_url("https://93.184.216.34/a", false).is_ok());
        assert!(validate_fetch_url("http://93.184.216.34/a", false).is_ok());
        assert!(validate_fetch_url("file:///C:/Windows/win.ini", false).is_err());
        assert!(validate_fetch_url("ftp://93.184.216.34/x", false).is_err());
        assert!(validate_fetch_url("data:text/html,hi", false).is_err());
    }

    #[test]
    fn url_rejects_userinfo() {
        assert!(validate_fetch_url("https://user:pass@93.184.216.34/", false).is_err());
    }

    #[test]
    fn private_ipv4_is_blocked_by_default() {
        for url in [
            "http://127.0.0.1:8080/",
            "http://10.1.2.3/",
            "http://172.16.0.1/",
            "http://192.168.1.1/",
            "http://169.254.10.1/",
            "http://0.0.0.0/",
            "http://100.64.1.1/",
        ] {
            assert!(validate_fetch_url(url, false).is_err(), "{url} 应被拦截");
            assert!(validate_fetch_url(url, true).is_ok(), "{url} 应可放开");
        }
    }

    #[test]
    fn private_ipv6_is_blocked_by_default() {
        for url in ["http://[::1]/", "http://[fe80::1]/", "http://[fc00::1]/"] {
            assert!(validate_fetch_url(url, false).is_err(), "{url} 应被拦截");
        }
    }

    #[test]
    fn localhost_is_blocked_by_default() {
        assert!(validate_fetch_url("http://localhost:3000/", false).is_err());
    }

    #[test]
    fn local_listener_is_blocked_even_when_port_is_alive() {
        // 文档 §8.1：本地起一个真实监听端口，默认行为仍应拦截（不打请求）
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let url = format!("http://127.0.0.1:{port}/");
        assert!(validate_fetch_url(&url, false).is_err());
        assert!(validate_fetch_url(&url, true).is_ok());
    }

    #[test]
    fn public_ip_is_allowed() {
        // 固定公网 IP，避免单测依赖 DNS
        assert!(validate_fetch_url("https://93.184.216.34/", false).is_ok());
    }

    #[test]
    fn filename_sanitization_rules() {
        assert_eq!(sanitize_filename(""), "page.html");
        assert_eq!(sanitize_filename("a<b>c:d\"e/f\\g|h?i*j"), "a_b_c_d_e_f_g_h_i_j.html");
        assert_eq!(sanitize_filename("CON"), "_CON.html");
        assert_eq!(sanitize_filename("con.txt"), "_con.txt");
        assert_eq!(sanitize_filename("doc.html..."), "doc.html");
        assert_eq!(sanitize_filename("报告 2026.md"), "报告 2026.md");
        let long = "a".repeat(200);
        assert_eq!(sanitize_filename(&long).chars().count(), MAX_FILE_NAME_CHARS);
    }

    #[test]
    fn filename_suggestion_from_url() {
        assert_eq!(
            suggest_filename_from_url("https://example.com/docs/index.html?x=1#top"),
            "index.html"
        );
        assert_eq!(
            suggest_filename_from_url("https://example.com/%E6%8A%A5%E5%91%8A"),
            "报告.html"
        );
        assert_eq!(suggest_filename_from_url("https://example.com/"), "page.html");
        assert_eq!(suggest_filename_from_url("not a url"), "page.html");
    }
}
