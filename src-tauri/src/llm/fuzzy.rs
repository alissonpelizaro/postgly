//! Tiny fuzzy matcher used to suggest schema-aware retries when the
//! agent reports `not_found`. Hand-rolled so we don't pull in a string
//! distance crate for a few dozen lines of code.

use crate::db::driver::DatabaseSchema;

/// Compute the Levenshtein distance between two strings.
pub fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut curr = vec![0usize; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        curr[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = if ca == cb { 0 } else { 1 };
            curr[j + 1] = (curr[j] + 1).min(prev[j + 1] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[b.len()]
}

/// Extract candidate identifiers from a free-form reason string —
/// alphanumeric runs (plus underscore) of at least 3 chars, lowercased.
pub fn extract_tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            current.push(ch.to_ascii_lowercase());
        } else if !current.is_empty() {
            if current.len() >= 3 {
                out.push(std::mem::take(&mut current));
            } else {
                current.clear();
            }
        }
    }
    if current.len() >= 3 {
        out.push(current);
    }
    out
}

/// Up-to-`max` schema-qualified table names from `schema` ranked by how
/// closely they match any token in `tokens`. Returns deduplicated
/// entries in best-first order. Filters out matches that are clearly
/// unrelated (distance > half the table-name length).
pub fn nearest_table_names(schema: &DatabaseSchema, tokens: &[String], max: usize) -> Vec<String> {
    if tokens.is_empty() {
        return Vec::new();
    }
    let mut scored: Vec<(usize, String)> = schema
        .tables
        .iter()
        .filter_map(|table| {
            let lower_name = table.name.to_ascii_lowercase();
            let table_len = lower_name.chars().count();
            // Pick the token that scored best AND ride its length when
            // deciding whether the score is meaningful — comparing a
            // 3-char token to a 12-char name should be stricter than a
            // 12-char token to a 12-char name.
            let (best, token_len) = tokens
                .iter()
                .map(|tok| (levenshtein(tok, &lower_name), tok.chars().count()))
                .min_by_key(|(dist, _)| *dist)?;
            let threshold = (table_len.max(token_len) / 2).max(2);
            if best > threshold {
                return None;
            }
            Some((best, format!("{}.{}", table.schema, table.name)))
        })
        .collect();
    scored.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    scored.into_iter().map(|(_, name)| name).take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::driver::{DatabaseSchema, RelationKind, TableSchema};

    fn schema(names: &[(&str, &str)]) -> DatabaseSchema {
        DatabaseSchema {
            tables: names
                .iter()
                .map(|(s, n)| TableSchema {
                    schema: (*s).into(),
                    name: (*n).into(),
                    kind: RelationKind::Table,
                    comment: None,
                    columns: vec![],
                    primary_key: vec![],
                    foreign_keys: vec![],
                })
                .collect(),
        }
    }

    #[test]
    fn levenshtein_basic_cases() {
        assert_eq!(levenshtein("", ""), 0);
        assert_eq!(levenshtein("abc", ""), 3);
        assert_eq!(levenshtein("", "abc"), 3);
        assert_eq!(levenshtein("kitten", "sitting"), 3);
        assert_eq!(levenshtein("user", "users"), 1);
    }

    #[test]
    fn extract_tokens_keeps_long_alphanumeric_runs() {
        let tokens = extract_tokens("Tabela 'usuarios' não encontrada — quis dizer users?");
        assert!(tokens.contains(&"usuarios".to_string()));
        assert!(tokens.contains(&"users".to_string()));
        assert!(!tokens.iter().any(|t| t.chars().count() < 3));
    }

    #[test]
    fn extract_tokens_drops_short_words() {
        let tokens = extract_tokens("a b cd users");
        assert_eq!(tokens, vec!["users".to_string()]);
    }

    #[test]
    fn nearest_table_names_ranks_by_distance() {
        let s = schema(&[
            ("public", "users"),
            ("public", "customers"),
            ("public", "orders"),
        ]);
        // "usuario" should rank `users` first (distance 3), then maybe nothing else within threshold.
        let hits = nearest_table_names(&s, &["usuarios".into()], 5);
        assert!(!hits.is_empty());
        assert_eq!(hits[0], "public.users");
    }

    #[test]
    fn nearest_table_names_skips_unrelated_tables() {
        let s = schema(&[
            ("public", "users"),
            ("public", "orders"),
            ("public", "metrics"),
        ]);
        // "cat" is far from every name → filtered out by the threshold.
        let hits = nearest_table_names(&s, &["cat".into()], 3);
        assert!(hits.is_empty());
    }

    #[test]
    fn nearest_table_names_returns_empty_for_no_tokens() {
        let s = schema(&[("public", "users")]);
        assert!(nearest_table_names(&s, &[], 3).is_empty());
    }

    #[test]
    fn nearest_table_names_dedupes_across_tokens_and_respects_max() {
        let s = schema(&[
            ("public", "users"),
            ("public", "userz"),
            ("public", "user_logs"),
        ]);
        let hits = nearest_table_names(&s, &["user".into(), "users".into()], 2);
        assert_eq!(hits.len(), 2);
        // Best match should be "users" (distance 0 from "users").
        assert_eq!(hits[0], "public.users");
    }
}
