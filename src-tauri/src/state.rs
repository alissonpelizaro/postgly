//! Shared application state held by Tauri.
//!
//! An *open connection* is a connected [`DatabaseDriver`] kept alive in
//! the `sessions` map and addressed by a session id. Drivers hold a
//! cheaply-cloneable pool, so query commands lock the map only long
//! enough to clone the `Arc` — never across an `await`.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::db::driver::DatabaseSchema;
use crate::db::DatabaseDriver;
use crate::llm::agent::AgentOutput;

/// A live, connected driver shared across query commands.
pub type Session = Arc<dyn DatabaseDriver>;

/// One natural-language → SQL exchange stored in the session history.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NlHistoryEntry {
    pub instruction: String,
    pub output: AgentOutput,
    /// Unix timestamp (seconds) when the exchange completed.
    pub created_at: i64,
}

/// Per-session NL history cap. Old entries fall off the front; the
/// frontend is in charge of pruning further when rendering.
pub const NL_HISTORY_CAP: usize = 50;

/// Tauri-managed application state.
#[derive(Default)]
pub struct AppState {
    /// Open connections, keyed by session id.
    pub sessions: Mutex<HashMap<String, Session>>,
    /// Cached schema introspection per session. Built lazily on first
    /// access and invalidated explicitly (the schema isn't going to
    /// change underneath us mid-session except when the user runs DDL,
    /// at which point they can refresh). Wrapped in an `Arc` so reads
    /// release the lock quickly.
    pub schema_cache: Mutex<HashMap<String, Arc<DatabaseSchema>>>,
    /// Natural-language query history per session — newest entries at
    /// the back. Lives in-memory only; closing the session drops it.
    pub nl_history: Mutex<HashMap<String, VecDeque<NlHistoryEntry>>>,
}

impl AppState {
    /// Push a new entry onto a session's NL history, dropping the
    /// oldest one when the cap is reached.
    pub fn push_nl_history(&self, session_id: &str, entry: NlHistoryEntry) {
        let mut guard = match self.nl_history.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let queue = guard.entry(session_id.to_string()).or_default();
        if queue.len() == NL_HISTORY_CAP {
            queue.pop_front();
        }
        queue.push_back(entry);
    }

    /// Snapshot the session's NL history, newest first.
    pub fn nl_history_snapshot(&self, session_id: &str) -> Vec<NlHistoryEntry> {
        let guard = match self.nl_history.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        guard
            .get(session_id)
            .map(|q| q.iter().rev().cloned().collect())
            .unwrap_or_default()
    }

    /// Drop the NL history for a session (called on close).
    pub fn clear_nl_history(&self, session_id: &str) {
        if let Ok(mut g) = self.nl_history.lock() {
            g.remove(session_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::agent::{AgentOutput, AgentStatus};
    use crate::llm::chat::TokenUsage;

    fn entry(instruction: &str) -> NlHistoryEntry {
        NlHistoryEntry {
            instruction: instruction.into(),
            output: AgentOutput {
                status: AgentStatus::Ok,
                sql: Some("SELECT 1".into()),
                reason: None,
                suggestions: vec![],
                trace: vec![],
                usage: TokenUsage::default(),
            },
            created_at: 0,
        }
    }

    #[test]
    fn default_app_state_has_empty_maps() {
        let state = AppState::default();
        assert!(state.sessions.lock().unwrap().is_empty());
        assert!(state.schema_cache.lock().unwrap().is_empty());
        assert!(state.nl_history.lock().unwrap().is_empty());
    }

    #[test]
    fn push_nl_history_appends_and_snapshot_returns_newest_first() {
        let state = AppState::default();
        state.push_nl_history("s", entry("a"));
        state.push_nl_history("s", entry("b"));
        let snap = state.nl_history_snapshot("s");
        assert_eq!(snap.len(), 2);
        assert_eq!(snap[0].instruction, "b");
        assert_eq!(snap[1].instruction, "a");
    }

    #[test]
    fn push_nl_history_drops_oldest_when_cap_reached() {
        let state = AppState::default();
        for i in 0..(NL_HISTORY_CAP + 5) {
            state.push_nl_history("s", entry(&format!("e{i}")));
        }
        let snap = state.nl_history_snapshot("s");
        assert_eq!(snap.len(), NL_HISTORY_CAP);
        // The newest 50 entries: e54 down to e5.
        assert_eq!(
            snap.first().unwrap().instruction,
            format!("e{}", NL_HISTORY_CAP + 4)
        );
        assert_eq!(snap.last().unwrap().instruction, format!("e{}", 5));
    }

    #[test]
    fn clear_nl_history_drops_only_that_session() {
        let state = AppState::default();
        state.push_nl_history("s1", entry("a"));
        state.push_nl_history("s2", entry("b"));
        state.clear_nl_history("s1");
        assert!(state.nl_history_snapshot("s1").is_empty());
        assert_eq!(state.nl_history_snapshot("s2").len(), 1);
    }

    #[test]
    fn snapshot_for_unknown_session_is_empty() {
        let state = AppState::default();
        assert!(state.nl_history_snapshot("ghost").is_empty());
    }
}
