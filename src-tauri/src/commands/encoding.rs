//! 编码检测与解码（三段式：BOM → UTF-8 有效性 → chardetng）

use encoding_rs::Encoding;
use serde::Serialize;

/// 「重新打开为」菜单的候选编码
pub const CANDIDATES: [&str; 6] = ["UTF-8", "GBK", "GB18030", "UTF-16 LE", "UTF-16 BE", "Big5"];

/// 检测结果
#[derive(Serialize)]
pub struct EncodingGuess {
    /// 展示名（UTF-8 / GBK / …）
    pub encoding: String,
    /// "bom" | "high" | "low"；low 为高混淆编码族，建议用户确认
    pub confidence: String,
    /// 候选编码列表
    pub candidates: Vec<String>,
}

/// 展示名 → encoding_rs 编码
pub fn lookup(name: &str) -> Option<&'static Encoding> {
    let label = match name.to_ascii_uppercase().as_str() {
        "UTF-8" => "utf-8",
        "GBK" => "gbk",
        "GB18030" => "gb18030",
        "UTF-16 LE" => "utf-16le",
        "UTF-16 BE" => "utf-16be",
        "BIG5" => "big5",
        _ => return None,
    };
    Encoding::for_label(label.as_bytes())
}

/// 编码 → 展示名
fn display_name(enc: &'static Encoding) -> String {
    if enc == encoding_rs::UTF_8 {
        "UTF-8".into()
    } else if enc == encoding_rs::GBK {
        "GBK".into()
    } else if enc == encoding_rs::GB18030 {
        "GB18030".into()
    } else if enc == encoding_rs::BIG5 {
        "Big5".into()
    } else if enc == encoding_rs::UTF_16LE {
        "UTF-16 LE".into()
    } else if enc == encoding_rs::UTF_16BE {
        "UTF-16 BE".into()
    } else {
        enc.name().to_string()
    }
}

/// 高混淆编码族（中文环境易与 UTF-8 互判）：命中时置信度记为 low
fn is_high_confusion(enc: &'static Encoding) -> bool {
    enc == encoding_rs::GBK || enc == encoding_rs::GB18030 || enc == encoding_rs::BIG5
}

fn candidate_list() -> Vec<String> {
    CANDIDATES.iter().map(|s| (*s).to_string()).collect()
}

/// 三段式检测：① BOM → ② 合法 UTF-8 → ③ chardetng
///
/// ② 优先判 UTF-8 是为了避免「无 BOM 的 UTF-8 被误判成 GBK」这一经典误判。
pub fn guess(bytes: &[u8]) -> EncodingGuess {
    // ① BOM
    let bom_hit = |name: &str| EncodingGuess {
        encoding: name.to_string(),
        confidence: "bom".to_string(),
        candidates: candidate_list(),
    };
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return bom_hit("UTF-8");
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return bom_hit("UTF-16 LE");
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return bom_hit("UTF-16 BE");
    }

    // ② 合法 UTF-8（抽样前 64KB）
    let sample = &bytes[..bytes.len().min(64 * 1024)];
    if std::str::from_utf8(sample).is_ok() {
        return EncodingGuess {
            encoding: "UTF-8".to_string(),
            confidence: "high".to_string(),
            candidates: candidate_list(),
        };
    }

    // ③ chardetng
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(sample, true);
    let enc = detector.guess(None, true);
    EncodingGuess {
        encoding: display_name(enc),
        confidence: if is_high_confusion(enc) { "low" } else { "high" }.to_string(),
        candidates: candidate_list(),
    }
}

/// 按指定编码名解码（宽松替换无法映射的字符，并处理该编码的 BOM）
pub fn decode(bytes: &[u8], name: &str) -> Result<String, String> {
    let enc = lookup(name).ok_or_else(|| format!("不支持的编码: {name}"))?;
    let (text, _used, _had_errors) = enc.decode(bytes);
    Ok(text.into_owned())
}

/// 按指定编码名编码为字节
/// bom=true 且编码为 UTF-8 时前置 UTF-8 BOM；UTF-16 LE/BE 的 BOM 由 encoding_rs 自动写入
pub fn encode(text: &str, name: &str, bom: bool) -> Result<Vec<u8>, String> {
    let enc = lookup(name).ok_or_else(|| format!("不支持的编码: {name}"))?;
    let (bytes, _used, _had_errors) = enc.encode(text);
    let mut out = bytes.into_owned();
    if bom && enc == encoding_rs::UTF_8 && !out.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let mut with_bom = Vec::with_capacity(out.len() + 3);
        with_bom.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        with_bom.extend_from_slice(&out);
        out = with_bom;
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// 乱码检测（只诊断、不改文件）
// ---------------------------------------------------------------------------

/// 硬标记：出现即判疑似乱码（UTF-8 被按 GBK 解读的典型产物 / BOM 被当 Latin-1）
const HARSH_MARKERS: [&str; 2] = ["锟斤拷", "ï»¿"];
/// 软标记：仅参与评分（UTF-8 多字节被按单字节解读的典型产物）
const SOFT_MARKERS: [&str; 2] = ["Ã", "Â"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MojibakeReport {
    /// 是否疑似乱码
    pub suspicious: bool,
    /// 建议的「重新打开为」编码（无建议时为空串）
    pub suggested: String,
    /// 异常字符占比（0-1），供提示文案使用
    pub severity: f64,
    /// 面向用户的说明
    pub reason: String,
}

/// 去掉前置 BOM（比较无损回编码时两侧统一处理）
fn strip_bom(bytes: &[u8]) -> &[u8] {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &bytes[3..]
    } else if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        &bytes[2..]
    } else {
        bytes
    }
}

/// 解码后重新编码能否还原原字节（证明该解码无损）
fn is_lossless(bytes: &[u8], decoded: &str, name: &str) -> bool {
    let Some(enc) = lookup(name) else {
        return false;
    };
    let (re, _, _) = enc.encode(decoded);
    strip_bom(&re) == strip_bom(bytes)
}

/// 异常字符占比：C1 控制符与替换字符各计 1，硬标记额外计 3
fn badness(text: &str) -> f64 {
    let total = text.chars().count().max(1) as f64;
    let mut bad = 0.0f64;
    for ch in text.chars() {
        let c = ch as u32;
        if (0x0080..=0x009F).contains(&c) || c == 0xFFFD {
            bad += 1.0;
        }
    }
    let harsh = HARSH_MARKERS
        .iter()
        .map(|m| text.matches(m).count() as f64)
        .sum::<f64>();
    (bad + harsh * 3.0) / total
}

/// 「像正常文本」的评分：CJK 加分，异常字符与乱码标记扣分
fn score(text: &str) -> i32 {
    let mut value = 0i32;
    for ch in text.chars() {
        let c = ch as u32;
        if (0x4E00..=0x9FFF).contains(&c) {
            value += 2;
        } else if (0x0080..=0x009F).contains(&c) || c == 0xFFFD {
            value -= 6;
        }
    }
    let harsh = HARSH_MARKERS
        .iter()
        .map(|m| text.matches(m).count() as i32)
        .sum::<i32>();
    let soft = SOFT_MARKERS
        .iter()
        .map(|m| text.matches(m).count() as i32)
        .sum::<i32>();
    value - (40 * harsh + 6 * soft)
}

/// 纯函数：按字节、当前解读结果与当前编码判定乱码
pub fn analyze_mojibake(bytes: &[u8], text: &str, current: &str) -> MojibakeReport {
    let not_suspicious = MojibakeReport {
        suspicious: false,
        suggested: String::new(),
        severity: badness(text),
        reason: String::new(),
    };

    // 规则一（强信号）：字节是合法 UTF-8，却按非 UTF-8 编码解读。
    // 这类乱码产出的仍是「中文样子」的字符，靠字符统计无法识别，故直接以字节形态判定。
    let is_utf16 = current.eq_ignore_ascii_case("UTF-16 LE") || current.eq_ignore_ascii_case("UTF-16 BE");
    if !current.eq_ignore_ascii_case("UTF-8") && !is_utf16 && std::str::from_utf8(bytes).is_ok() {
        return MojibakeReport {
            suspicious: true,
            suggested: "UTF-8".to_string(),
            severity: 1.0,
            reason: format!("字节是合法 UTF-8，但当前按 {current} 解读"),
        };
    }

    // 规则二：异常字符占比过高或命中乱码标记 → 逐个候选编码做「无损回编码 + 可读性」比较
    let severity = badness(text);
    let harsh_hit = HARSH_MARKERS.iter().any(|m| text.contains(m));
    if !harsh_hit && severity < 0.03 {
        return not_suspicious;
    }

    let base = score(text);
    let mut suggested = String::new();
    let mut best = base;
    for name in CANDIDATES {
        if name.eq_ignore_ascii_case(current) {
            continue;
        }
        let Ok(decoded) = decode(bytes, name) else {
            continue;
        };
        if !is_lossless(bytes, &decoded, name) {
            continue;
        }
        let value = score(&decoded);
        if value > best + 4 {
            best = value;
            suggested = name.to_string();
        }
    }

    let reason = if suggested.is_empty() {
        format!(
            "疑似乱码（当前按 {current} 解读，异常字符约 {:.0}%），未找到更优编码，可在状态栏手动切换",
            severity * 100.0
        )
    } else {
        format!("疑似乱码（当前按 {current} 解读），建议重新打开为 {suggested}")
    };
    MojibakeReport {
        suspicious: true,
        suggested,
        severity,
        reason,
    }
}

/// 检测文件是否存在乱码：读取字节后调用 `analyze_mojibake`（不修改磁盘，仅诊断）
#[tauri::command]
pub fn detect_mojibake(
    path: String,
    text: String,
    current: String,
) -> Result<MojibakeReport, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("读取失败: {e}"))?;
    Ok(analyze_mojibake(&bytes, &text, &current))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 「中文测试」的 GBK 字节
    const GBK_CJK: [u8; 8] = [0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4];

    #[test]
    fn bom_takes_priority() {
        let mut utf8 = vec![0xEF, 0xBB, 0xBF];
        utf8.extend_from_slice("中文".as_bytes());
        let g = guess(&utf8);
        assert_eq!(g.encoding, "UTF-8");
        assert_eq!(g.confidence, "bom");

        assert_eq!(guess(&[0xFF, 0xFE, 0x41, 0x00]).encoding, "UTF-16 LE");
        assert_eq!(guess(&[0xFE, 0xFF, 0x00, 0x41]).encoding, "UTF-16 BE");
        assert_eq!(guess(&[0xFF, 0xFE, 0x41, 0x00]).confidence, "bom");
    }

    #[test]
    fn valid_utf8_preferred() {
        let g = guess("你好，世界 hello".as_bytes());
        assert_eq!(g.encoding, "UTF-8");
        assert_eq!(g.confidence, "high");
    }

    #[test]
    fn non_utf8_cjk_not_judged_as_utf8() {
        let g = guess(&GBK_CJK);
        assert_ne!(g.encoding, "UTF-8");
        assert_eq!(decode(&GBK_CJK, "GBK").unwrap(), "中文测试");
    }

    #[test]
    fn candidates_always_returned() {
        assert_eq!(guess(&GBK_CJK).candidates.len(), CANDIDATES.len());
    }

    #[test]
    fn gbk_roundtrip() {
        let text = "中文测试 ABC 123";
        let bytes = encode(text, "GBK", false).unwrap();
        assert_eq!(decode(&bytes, "GBK").unwrap(), text);
    }

    #[test]
    fn utf8_bom_only_when_requested() {
        let plain = encode("hi", "UTF-8", false).unwrap();
        assert!(!plain.starts_with(&[0xEF, 0xBB, 0xBF]));
        let with_bom = encode("hi", "UTF-8", true).unwrap();
        assert!(with_bom.starts_with(&[0xEF, 0xBB, 0xBF]));
        assert_eq!(decode(&with_bom, "UTF-8").unwrap(), "hi");
    }

    #[test]
    fn unknown_label_rejected() {
        assert!(lookup("NO-SUCH-ENCODING").is_none());
        assert!(decode(b"x", "NO-SUCH-ENCODING").is_err());
        assert!(encode("x", "NO-SUCH-ENCODING", false).is_err());
    }

    #[test]
    fn utf8_bytes_read_as_gbk_is_flagged_with_suggestion() {
        let text = "中文测试内容";
        let bytes = text.as_bytes(); // 合法 UTF-8 字节
        let wrong = decode(bytes, "GBK").unwrap(); // 按 GBK 解读产生的乱码
        let report = analyze_mojibake(bytes, &wrong, "GBK");
        assert!(report.suspicious);
        assert_eq!(report.suggested, "UTF-8");
        assert!(report.reason.contains("GBK"));
    }

    #[test]
    fn correctly_decoded_text_is_not_flagged() {
        let text = "中文测试内容 plain text";
        let report = analyze_mojibake(text.as_bytes(), text, "UTF-8");
        assert!(!report.suspicious);
        assert!(report.suggested.is_empty());
    }

    #[test]
    fn genuine_gbk_file_is_not_flagged() {
        let text = "中文测试";
        let bytes = encode(text, "GBK", false).unwrap();
        let decoded = decode(&bytes, "GBK").unwrap();
        let report = analyze_mojibake(&bytes, &decoded, "GBK");
        assert!(!report.suspicious);
    }

    #[test]
    fn harsh_marker_triggers_detection() {
        let report = analyze_mojibake(b"x", "前锟斤拷后", "GBK");
        assert!(report.suspicious);
    }

    #[test]
    fn utf8_bytes_read_as_big5_is_flagged() {
        let text = "简体中文内容测试";
        let bytes = text.as_bytes();
        let wrong = decode(bytes, "Big5").unwrap();
        let report = analyze_mojibake(bytes, &wrong, "Big5");
        assert!(report.suspicious);
        assert_eq!(report.suggested, "UTF-8");
    }
}
