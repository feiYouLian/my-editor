//! 正则测试与替换预览：与工作区搜索共用 Rust `regex` 引擎，
//! 避免前端用 JS RegExp 测试通过、实际搜索却报错的双轨问题。

use serde::Serialize;

/// 单次测试最多返回的匹配数（与前端列表上限一致）
const MAX_TEST_MATCHES: usize = 1000;
/// 替换预览默认最大字符数
const DEFAULT_PREVIEW_CHARS: usize = 2000;

#[derive(Debug, Serialize)]
pub struct RegexMatch {
    /// 字节起点（前端仅用于展示/定位）
    pub start: usize,
    pub end: usize,
    pub text: String,
    /// 捕获组 1..n；未参与匹配为 null
    pub groups: Vec<Option<String>>,
}

#[derive(Debug, Serialize)]
pub struct RegexTestResult {
    pub matches: Vec<RegexMatch>,
    pub truncated: bool,
}

#[derive(Serialize)]
pub struct RegexPreview {
    pub text: String,
    pub truncated: bool,
}

fn build(pattern: &str, flags: &str) -> Result<regex::Regex, String> {
    regex::RegexBuilder::new(pattern)
        .case_insensitive(flags.contains('i'))
        .multi_line(flags.contains('m'))
        .dot_matches_new_line(flags.contains('s'))
        .size_limit(4 * 1024 * 1024)
        .build()
        .map_err(|e| format!("正则表达式无效: {e}"))
}

/// 用 Rust regex 测试表达式；flags 支持 i/m/s（g、u 对结果无影响）。
#[tauri::command]
pub fn regex_test(
    pattern: String,
    flags: String,
    text: String,
    max_matches: usize,
) -> Result<RegexTestResult, String> {
    let re = build(&pattern, &flags)?;
    let cap = max_matches.clamp(1, MAX_TEST_MATCHES);
    let mut matches = Vec::new();
    let mut truncated = false;
    for caps in re.captures_iter(&text) {
        let Some(whole) = caps.get(0) else { continue };
        let groups = (1..caps.len())
            .map(|i| caps.get(i).map(|g| g.as_str().to_string()))
            .collect();
        matches.push(RegexMatch {
            start: whole.start(),
            end: whole.end(),
            text: whole.as_str().to_string(),
            groups,
        });
        if matches.len() >= cap {
            truncated = true;
            break;
        }
    }
    Ok(RegexTestResult { matches, truncated })
}

/// 用 Rust regex 展开替换模板（$1 / ${name} / $0），返回截断后的预览。
#[tauri::command]
pub fn regex_replace_preview(
    pattern: String,
    flags: String,
    replacement: String,
    text: String,
    max_chars: Option<usize>,
) -> Result<RegexPreview, String> {
    let re = build(&pattern, &flags)?;
    let replaced = re.replace_all(&text, replacement.as_str()).into_owned();
    let max = max_chars
        .unwrap_or(DEFAULT_PREVIEW_CHARS)
        .clamp(100, 20_000);
    let truncated = replaced.chars().count() > max;
    let text = if truncated {
        replaced.chars().take(max).collect()
    } else {
        replaced
    };
    Ok(RegexPreview { text, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_returns_groups_and_offsets() {
        let result = regex_test(
            r"(\w+)@(\w+\.\w+)".into(),
            "".into(),
            "a@b.com c@d.org".into(),
            10,
        )
        .unwrap();
        assert_eq!(result.matches.len(), 2);
        assert_eq!(result.matches[0].text, "a@b.com");
        assert_eq!(result.matches[0].groups[0].as_deref(), Some("a"));
        assert_eq!(result.matches[0].groups[1].as_deref(), Some("b.com"));
        assert_eq!(result.matches[0].start, 0);
    }

    #[test]
    fn test_rejects_js_only_lookaround() {
        let err = regex_test("(?=foo)".into(), "".into(), "foo".into(), 10).unwrap_err();
        assert!(err.contains("正则表达式无效"));
    }

    #[test]
    fn test_respects_case_and_multiline_flags() {
        let no_i = regex_test("foo".into(), "".into(), "FOO\nfoo".into(), 10).unwrap();
        assert_eq!(no_i.matches.len(), 1);
        let with_i = regex_test("foo".into(), "i".into(), "FOO\nfoo".into(), 10).unwrap();
        assert_eq!(with_i.matches.len(), 2);
        let anchors = regex_test("^foo".into(), "m".into(), "x\nfoo".into(), 10).unwrap();
        assert_eq!(anchors.matches.len(), 1);
    }

    #[test]
    fn replace_preview_expands_numbered_and_named_groups() {
        let numbered = regex_replace_preview(
            r"(\w+)-(\w+)".into(),
            "".into(),
            "$2/$1".into(),
            "a-b".into(),
            None,
        )
        .unwrap();
        assert_eq!(numbered.text, "b/a");

        let named = regex_replace_preview(
            r"(?P<left>\w+)-(?P<right>\w+)".into(),
            "".into(),
            "${right}/${left}".into(),
            "a-b".into(),
            None,
        )
        .unwrap();
        assert_eq!(named.text, "b/a");
    }

    #[test]
    fn replace_preview_truncates() {
        let preview = regex_replace_preview(
            "a".into(),
            "".into(),
            "bb".into(),
            "a".repeat(100),
            Some(100),
        )
        .unwrap();
        assert!(preview.truncated);
        assert_eq!(preview.text.chars().count(), 100);
    }
}
