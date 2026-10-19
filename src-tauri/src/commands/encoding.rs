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
}
