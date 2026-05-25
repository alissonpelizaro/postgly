//! Application settings persistence.
//!
//! Settings are split the same way connections are: non-secret fields
//! land in a JSON file under the app config directory, secrets (e.g. the
//! LLM provider API key) go to encrypted `vault.json`.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::error::{AppError, AppResult};
use crate::vault;

/// Stable vault account name for the LLM API key.
pub const LLM_API_KEY_ACCOUNT: &str = "llm.api_key";

/// File name of the settings store inside the app config directory.
const STORE_FILE: &str = "settings.json";

/// Non-secret LLM provider configuration. The API key is stored
/// separately in the encrypted vault under [`LLM_API_KEY_ACCOUNT`].
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct LlmConfig {
    /// Free-form provider label (e.g. "openai", "ollama"). Kept as a
    /// string so any OpenAI-compatible endpoint works without code
    /// changes.
    #[serde(default)]
    pub provider: String,
    /// Base URL for the OpenAI-compatible API (no trailing slash).
    #[serde(default)]
    pub base_url: String,
    /// Default model name (e.g. "gpt-4o-mini").
    #[serde(default)]
    pub model: String,
    /// Sampling temperature applied to generated queries. Defaults to
    /// `0.0` so SQL generation stays deterministic.
    #[serde(default)]
    pub temperature: f32,
}

/// Safety preferences. Today this only governs the destructive-SQL
/// confirmation modal; future toggles (auto-explain, dry-run, ...)
/// slot in here as additional fields.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SafetyConfig {
    /// When `true`, the UI asks before running any INSERT/UPDATE/
    /// DELETE/DROP/TRUNCATE/ALTER/CREATE statement.
    pub confirm_destructive: bool,
}

impl Default for SafetyConfig {
    fn default() -> Self {
        Self {
            // Safe-by-default: protect rows over ergonomics.
            confirm_destructive: true,
        }
    }
}

/// Root of the on-disk settings document. New categories slot in here
/// as additional optional fields so older config files keep loading.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Settings {
    #[serde(default)]
    pub llm: LlmConfig,
    #[serde(default)]
    pub safety: SafetyConfig,
}

/// Resolve the settings file path, creating the config directory if needed.
fn store_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Other(format!("cannot resolve config dir: {e}")))?;
    fs::create_dir_all(&dir).map_err(|e| AppError::Other(e.to_string()))?;
    Ok(dir.join(STORE_FILE))
}

/// Load settings from an explicit file. A missing file yields defaults.
pub fn load_from(path: &Path) -> AppResult<Settings> {
    if !path.exists() {
        return Ok(Settings::default());
    }
    let raw = fs::read_to_string(path).map_err(|e| AppError::Other(e.to_string()))?;
    serde_json::from_str(&raw).map_err(|e| AppError::Other(format!("corrupt settings: {e}")))
}

/// Persist settings to an explicit file.
pub fn save_to(path: &Path, settings: &Settings) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| AppError::Other(e.to_string()))?;
    }
    let raw = serde_json::to_string_pretty(settings).map_err(|e| AppError::Other(e.to_string()))?;
    fs::write(path, raw).map_err(|e| AppError::Other(e.to_string()))
}

/// Load settings from the app config dir.
pub fn load<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> AppResult<Settings> {
    load_from(&store_path(app)?)
}

/// Persist settings to the app config dir.
pub fn save<R: tauri::Runtime>(app: &tauri::AppHandle<R>, settings: &Settings) -> AppResult<()> {
    save_to(&store_path(app)?, settings)
}

/// Store (or replace) a secret value for a settings account.
pub fn set_secret<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    account: &str,
    value: &str,
) -> AppResult<()> {
    vault::set_setting_secret(app, account, value)
}

/// Retrieve a secret. Returns an empty string when the entry doesn't
/// exist so callers can render "not configured" without special-casing.
pub fn get_secret<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    account: &str,
) -> AppResult<String> {
    vault::get_setting_secret(app, account)
}

/// Remove a settings secret. A missing entry is treated as success.
#[allow(dead_code)]
pub fn delete_secret<R: tauri::Runtime>(app: &tauri::AppHandle<R>, account: &str) -> AppResult<()> {
    vault::delete_setting_secret(app, account)
}

#[cfg(feature = "mock-keyring")]
#[allow(unused_imports)]
pub use crate::vault::reset_mock_setting_store as reset_mock_keyring;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::connections::test_utils::EnvSandbox;
    use tempfile::tempdir;

    #[test]
    fn load_from_returns_defaults_when_file_missing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let loaded = load_from(&path).unwrap();
        assert_eq!(loaded, Settings::default());
    }

    #[test]
    fn save_then_load_round_trip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nested").join("settings.json");
        let settings = Settings {
            llm: LlmConfig {
                provider: "openai".into(),
                base_url: "https://api.openai.com/v1".into(),
                model: "gpt-4o-mini".into(),
                temperature: 0.2,
            },
            safety: SafetyConfig {
                confirm_destructive: false,
            },
        };
        save_to(&path, &settings).unwrap();
        let loaded = load_from(&path).unwrap();
        assert_eq!(loaded, settings);
    }

    #[test]
    fn load_from_rejects_corrupt_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "{ not json").unwrap();
        let err = load_from(&path).unwrap_err();
        assert!(err.to_string().contains("corrupt settings"));
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "{}").unwrap();
        let loaded = load_from(&path).unwrap();
        assert_eq!(loaded, Settings::default());
        // The safety default is opt-out (i.e. confirmations are on).
        assert!(loaded.safety.confirm_destructive);
    }

    #[test]
    fn older_settings_file_without_safety_block_still_loads() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        // Simulates a config written by a pre-Phase-6 build.
        fs::write(
            &path,
            r#"{"llm":{"provider":"openai","base_url":"x","model":"y","temperature":0}}"#,
        )
        .unwrap();
        let loaded = load_from(&path).unwrap();
        assert_eq!(loaded.llm.base_url, "x");
        assert!(loaded.safety.confirm_destructive);
    }

    #[cfg(feature = "mock-keyring")]
    #[test]
    fn secret_round_trip_with_mock_keyring() {
        let _sandbox = EnvSandbox::new();
        reset_mock_keyring();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        assert_eq!(get_secret(app.handle(), "missing").unwrap(), "");
        set_secret(app.handle(), "k", "sk-test").unwrap();
        assert_eq!(get_secret(app.handle(), "k").unwrap(), "sk-test");
        delete_secret(app.handle(), "k").unwrap();
        assert_eq!(get_secret(app.handle(), "k").unwrap(), "");
    }
}
