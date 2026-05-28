//! Static SQL classifier that decides whether a statement (or batch)
//! should require user confirmation before running.
//!
//! Intentionally narrow: we don't parse SQL, only inspect the first
//! significant keyword of each top-level statement and probe for a
//! `WHERE` clause. That's enough for the safety guard surface — false
//! positives are tolerable (they just trigger a confirm), false
//! negatives are not.

use serde::{Deserialize, Serialize};

/// The high-level kind of a SQL statement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StatementKind {
    Select,
    Insert,
    Update,
    Delete,
    Drop,
    Truncate,
    Alter,
    Create,
    /// Anything else — vendor extensions, CTE-only batches, etc.
    Other,
}

impl StatementKind {
    fn from_keyword(kw: &str) -> Self {
        match kw {
            "select" | "with" | "values" | "table" | "show" | "explain" => Self::Select,
            "insert" => Self::Insert,
            "update" => Self::Update,
            "delete" => Self::Delete,
            "drop" => Self::Drop,
            "truncate" => Self::Truncate,
            "alter" => Self::Alter,
            "create" => Self::Create,
            _ => Self::Other,
        }
    }

    /// Whether this kind mutates the database.
    pub fn is_destructive(self) -> bool {
        matches!(
            self,
            Self::Insert
                | Self::Update
                | Self::Delete
                | Self::Drop
                | Self::Truncate
                | Self::Alter
                | Self::Create
        )
    }
}

/// Classification of one top-level statement inside a batch.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatementInfo {
    pub kind: StatementKind,
    /// `true` when an `UPDATE`/`DELETE` has any `WHERE` clause. Always
    /// `false` for non-`UPDATE`/`DELETE` statements.
    pub has_where: bool,
    /// `true` when the statement contains a `LIMIT` keyword anywhere
    /// outside of literals. Used by `run_query` to decide whether to
    /// inject a safety cap on free-form `SELECT`s.
    pub has_limit: bool,
    /// First ~140 chars of the statement, with whitespace collapsed —
    /// safe to render in a confirmation dialog.
    pub preview: String,
}

/// Outcome of [`analyze`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlAnalysis {
    /// One entry per top-level statement (split naively on `;`).
    pub statements: Vec<StatementInfo>,
    /// `true` when at least one statement is destructive.
    pub destructive: bool,
    /// `true` when at least one destructive statement is `UPDATE`/`DELETE`
    /// with no `WHERE` — the "blast radius" case worth its own warning.
    pub unbounded_dml: bool,
}

/// Analyse a SQL string. The classifier intentionally doesn't follow
/// arbitrarily nested string / dollar-quoted literals — for `WHERE`
/// detection that's good enough because the keyword has to appear
/// outside any literal to take effect.
pub fn analyze(sql: &str) -> SqlAnalysis {
    let cleaned = strip_comments(sql);
    let statements: Vec<StatementInfo> = split_statements(&cleaned)
        .into_iter()
        .filter_map(|stmt| {
            let trimmed = stmt.trim();
            if trimmed.is_empty() {
                return None;
            }
            let lower = trimmed.to_lowercase();
            let first = first_keyword(&lower);
            let kind = StatementKind::from_keyword(first);
            let has_where = matches!(kind, StatementKind::Update | StatementKind::Delete)
                && contains_keyword(&lower, "where");
            let has_limit =
                matches!(kind, StatementKind::Select) && contains_keyword(&lower, "limit");
            Some(StatementInfo {
                kind,
                has_where,
                has_limit,
                preview: preview(trimmed),
            })
        })
        .collect();

    let destructive = statements.iter().any(|s| s.kind.is_destructive());
    let unbounded_dml = statements
        .iter()
        .any(|s| matches!(s.kind, StatementKind::Update | StatementKind::Delete) && !s.has_where);

    SqlAnalysis {
        statements,
        destructive,
        unbounded_dml,
    }
}

/// Drop line (`-- ...`) and block (`/* ... */`) comments. Keeps
/// characters inside string literals untouched.
fn strip_comments(sql: &str) -> String {
    let bytes = sql.as_bytes();
    let mut out = String::with_capacity(bytes.len());
    let mut i = 0;
    let mut in_single = false;
    let mut in_double = false;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if in_single {
            out.push(c);
            if c == '\'' {
                in_single = false;
            }
            i += 1;
            continue;
        }
        if in_double {
            out.push(c);
            if c == '"' {
                in_double = false;
            }
            i += 1;
            continue;
        }
        // Line comment.
        if c == '-' && bytes.get(i + 1).copied() == Some(b'-') {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        // Block comment.
        if c == '/' && bytes.get(i + 1).copied() == Some(b'*') {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            continue;
        }
        if c == '\'' {
            in_single = true;
        } else if c == '"' {
            in_double = true;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// Split on semicolons, ignoring those inside string literals.
fn split_statements(sql: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    for c in sql.chars() {
        if in_single {
            current.push(c);
            if c == '\'' {
                in_single = false;
            }
            continue;
        }
        if in_double {
            current.push(c);
            if c == '"' {
                in_double = false;
            }
            continue;
        }
        if c == ';' {
            out.push(std::mem::take(&mut current));
            continue;
        }
        if c == '\'' {
            in_single = true;
        } else if c == '"' {
            in_double = true;
        }
        current.push(c);
    }
    if !current.trim().is_empty() {
        out.push(current);
    }
    out
}

fn first_keyword(lower: &str) -> &str {
    lower
        .split(|c: char| !c.is_ascii_alphabetic())
        .find(|s| !s.is_empty())
        .unwrap_or("")
}

/// Whole-word match for `keyword` in `lower` — surrounded by characters
/// that aren't ASCII letters or digits. Cheap proxy for "this keyword
/// appears outside of an identifier".
fn contains_keyword(lower: &str, keyword: &str) -> bool {
    let bytes = lower.as_bytes();
    let kw = keyword.as_bytes();
    if kw.is_empty() || bytes.len() < kw.len() {
        return false;
    }
    let mut i = 0;
    while i + kw.len() <= bytes.len() {
        if &bytes[i..i + kw.len()] == kw {
            let before_ok = i == 0 || !is_ident_byte(bytes[i - 1]);
            let after_ok = i + kw.len() == bytes.len() || !is_ident_byte(bytes[i + kw.len()]);
            if before_ok && after_ok {
                return true;
            }
        }
        i += 1;
    }
    false
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn preview(stmt: &str) -> String {
    let collapsed: String = stmt.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= 140 {
        collapsed
    } else {
        let head: String = collapsed.chars().take(139).collect();
        format!("{head}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(sql: &str) -> Vec<StatementKind> {
        analyze(sql).statements.iter().map(|s| s.kind).collect()
    }

    #[test]
    fn select_is_not_destructive() {
        let a = analyze("SELECT * FROM users WHERE id = 1");
        assert_eq!(a.statements.len(), 1);
        assert_eq!(a.statements[0].kind, StatementKind::Select);
        assert!(!a.destructive);
        assert!(!a.unbounded_dml);
    }

    #[test]
    fn delete_without_where_flags_unbounded_dml() {
        let a = analyze("DELETE FROM users");
        assert_eq!(a.statements[0].kind, StatementKind::Delete);
        assert!(a.destructive);
        assert!(a.unbounded_dml);
        assert!(!a.statements[0].has_where);
    }

    #[test]
    fn update_with_where_is_destructive_but_bounded() {
        let a = analyze("UPDATE users SET name = 'x' WHERE id = 1");
        assert_eq!(a.statements[0].kind, StatementKind::Update);
        assert!(a.destructive);
        assert!(a.statements[0].has_where);
        assert!(!a.unbounded_dml);
    }

    #[test]
    fn insert_drop_truncate_alter_create_are_all_destructive() {
        let cases = [
            ("INSERT INTO t VALUES (1)", StatementKind::Insert),
            ("DROP TABLE t", StatementKind::Drop),
            ("TRUNCATE t", StatementKind::Truncate),
            ("ALTER TABLE t ADD COLUMN c text", StatementKind::Alter),
            ("CREATE TABLE t (id int)", StatementKind::Create),
        ];
        for (sql, expected) in cases {
            let a = analyze(sql);
            assert_eq!(a.statements[0].kind, expected, "{sql}");
            assert!(a.destructive, "{sql} should be destructive");
            assert!(!a.unbounded_dml, "{sql} should not be unbounded DML");
        }
    }

    #[test]
    fn batch_with_mixed_statements_flags_destructive_overall() {
        let a = analyze("SELECT 1; DELETE FROM users WHERE id = 1;");
        assert_eq!(
            kinds("SELECT 1; DELETE FROM users WHERE id = 1;"),
            vec![StatementKind::Select, StatementKind::Delete,]
        );
        assert!(a.destructive);
        assert!(!a.unbounded_dml);
    }

    #[test]
    fn semicolons_inside_string_literals_dont_split() {
        let a = analyze("UPDATE users SET name = ';hi;' WHERE id = 1");
        assert_eq!(a.statements.len(), 1);
        assert!(a.statements[0].has_where);
    }

    #[test]
    fn comments_are_stripped_before_classifying() {
        let a = analyze("-- preamble\n/* also */ DELETE FROM users");
        assert_eq!(a.statements[0].kind, StatementKind::Delete);
        assert!(a.unbounded_dml);
    }

    #[test]
    fn where_inside_an_identifier_does_not_count() {
        // `wherever` mustn't trip the WHERE detector.
        let a = analyze("UPDATE wherever_table SET x = 1");
        assert!(!a.statements[0].has_where);
        assert!(a.unbounded_dml);
    }

    #[test]
    fn empty_or_whitespace_input_yields_no_statements() {
        assert!(analyze("").statements.is_empty());
        assert!(analyze("   \n\t").statements.is_empty());
        assert!(!analyze("").destructive);
    }

    #[test]
    fn preview_collapses_whitespace_and_caps_length() {
        let info = &analyze("SELECT\n  *\n  FROM\tusers").statements[0];
        assert_eq!(info.preview, "SELECT * FROM users");

        let long = format!("SELECT {}", "a".repeat(300));
        let info = &analyze(&long).statements[0];
        assert!(info.preview.chars().count() <= 140);
        assert!(info.preview.ends_with('…'));
    }

    #[test]
    fn with_cte_is_classified_as_select() {
        let a = analyze("WITH cte AS (SELECT 1) SELECT * FROM cte");
        assert_eq!(a.statements[0].kind, StatementKind::Select);
        assert!(!a.destructive);
    }

    #[test]
    fn unknown_keyword_lands_in_other_and_is_not_destructive() {
        let a = analyze("VACUUM users");
        assert_eq!(a.statements[0].kind, StatementKind::Other);
        assert!(!a.destructive);
    }

    #[test]
    fn statement_kind_is_destructive_matches_classification() {
        assert!(StatementKind::Insert.is_destructive());
        assert!(StatementKind::Update.is_destructive());
        assert!(StatementKind::Delete.is_destructive());
        assert!(StatementKind::Drop.is_destructive());
        assert!(StatementKind::Truncate.is_destructive());
        assert!(StatementKind::Alter.is_destructive());
        assert!(StatementKind::Create.is_destructive());
        assert!(!StatementKind::Select.is_destructive());
        assert!(!StatementKind::Other.is_destructive());
    }
}
