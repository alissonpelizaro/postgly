//! Application-wide error type.
//!
//! Every Tauri command returns `Result<T, AppError>`. `AppError` is
//! `Serialize` so it crosses the IPC boundary as a plain string the
//! frontend can display.

use serde::Serialize;

/// The single error type surfaced to the frontend.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// The driver could not reach or authenticate against the database.
    #[error("connection failed: {0}")]
    Connection(String),

    /// A query or statement failed to execute.
    #[error("query failed: {0}")]
    Query(String),

    /// The requested engine has no registered driver yet. Reserved for
    /// when a second engine is introduced post-v1.
    #[allow(dead_code)]
    #[error("unsupported database engine: {0}")]
    UnsupportedEngine(String),

    /// Anything that does not fit the cases above.
    #[error("{0}")]
    Other(String),
}

/// Serialize as a flat string so the frontend just receives the message.
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// Convenience alias for command and driver results.
pub type AppResult<T> = Result<T, AppError>;
