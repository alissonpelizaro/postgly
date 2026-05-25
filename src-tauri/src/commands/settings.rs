//! Settings commands — IPC surface for the Settings screen.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::llm::{self, LlmConnectivity};
use crate::settings::{self, LlmConfig, SafetyConfig, LLM_API_KEY_ACCOUNT};

/// What the frontend receives when reading settings. The API key is
/// returned separately so the frontend can render a "configured" hint
/// without ever needing to keep the secret in component state when
/// editing.
#[derive(Debug, Serialize)]
pub struct SettingsView {
    pub llm: LlmConfig,
    /// `true` when an API key is stored in the keyring.
    pub llm_api_key_configured: bool,
    pub safety: SafetyConfig,
}

/// Form payload for saving the LLM config. An empty `api_key` keeps the
/// previously stored secret untouched.
#[derive(Debug, Deserialize)]
pub struct LlmConfigInput {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub temperature: f32,
    #[serde(default)]
    pub api_key: String,
}

impl LlmConfigInput {
    /// Resolve the effective API key: typed value, or fall back to the
    /// stored secret when the user is editing without retyping it.
    fn resolve_api_key(&self) -> AppResult<String> {
        if !self.api_key.is_empty() {
            return Ok(self.api_key.clone());
        }
        let stored = settings::get_secret(LLM_API_KEY_ACCOUNT)?;
        if stored.is_empty() {
            return Err(AppError::Connection("API key is required".into()));
        }
        Ok(stored)
    }
}

/// Read the full settings document plus the "is the API key set?" flag.
#[tauri::command]
pub fn get_settings<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> AppResult<SettingsView> {
    let settings = settings::load(&app)?;
    let configured = !settings::get_secret(LLM_API_KEY_ACCOUNT)?.is_empty();
    Ok(SettingsView {
        llm: settings.llm,
        llm_api_key_configured: configured,
        safety: settings.safety,
    })
}

/// Persist the LLM provider config. When `api_key` is non-empty it
/// replaces the stored secret; otherwise the existing secret stays.
#[tauri::command]
pub fn save_llm_config<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    input: LlmConfigInput,
) -> AppResult<SettingsView> {
    let mut current = settings::load(&app)?;
    current.llm = LlmConfig {
        provider: input.provider,
        base_url: input.base_url,
        model: input.model,
        temperature: input.temperature,
    };
    settings::save(&app, &current)?;

    if !input.api_key.is_empty() {
        settings::set_secret(LLM_API_KEY_ACCOUNT, &input.api_key)?;
    }

    let configured = !settings::get_secret(LLM_API_KEY_ACCOUNT)?.is_empty();
    Ok(SettingsView {
        llm: current.llm,
        llm_api_key_configured: configured,
        safety: current.safety,
    })
}

/// Save the safety preferences (currently just the destructive-SQL
/// confirmation toggle).
#[tauri::command]
pub fn save_safety_config<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    input: SafetyConfig,
) -> AppResult<SettingsView> {
    let mut current = settings::load(&app)?;
    current.safety = input;
    settings::save(&app, &current)?;
    let configured = !settings::get_secret(LLM_API_KEY_ACCOUNT)?.is_empty();
    Ok(SettingsView {
        llm: current.llm,
        llm_api_key_configured: configured,
        safety: current.safety,
    })
}

/// Drop the stored LLM API key. Other LLM fields stay so the user can
/// re-enter just the key without retyping the URL and model.
#[tauri::command]
pub fn clear_llm_api_key() -> AppResult<()> {
    settings::set_secret(LLM_API_KEY_ACCOUNT, "")
}

/// Test the LLM provider config without persisting anything. Probes
/// `{base_url}/models` with the supplied (or previously stored) key.
#[tauri::command]
pub async fn test_llm_config(input: LlmConfigInput) -> AppResult<LlmConnectivity> {
    let api_key = input.resolve_api_key()?;
    llm::test_connectivity(&input.base_url, &api_key).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::connections::test_utils::EnvSandbox;
    use crate::state::AppState;

    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .manage(AppState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app builds")
    }

    fn fresh_input(api_key: &str) -> LlmConfigInput {
        LlmConfigInput {
            provider: "openai".into(),
            base_url: "https://api.openai.com/v1".into(),
            model: "gpt-4o-mini".into(),
            temperature: 0.0,
            api_key: api_key.into(),
        }
    }

    #[cfg(feature = "mock-keyring")]
    #[test]
    fn get_settings_returns_defaults_on_first_run() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app();
        let view = get_settings(app.handle().clone()).unwrap();
        assert_eq!(view.llm, LlmConfig::default());
        assert!(!view.llm_api_key_configured);
    }

    #[cfg(feature = "mock-keyring")]
    #[test]
    fn save_llm_config_persists_metadata_and_secret() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app();
        let view = save_llm_config(app.handle().clone(), fresh_input("sk-test")).unwrap();
        assert_eq!(view.llm.model, "gpt-4o-mini");
        assert!(view.llm_api_key_configured);

        // Survives a reload.
        let reread = get_settings(app.handle().clone()).unwrap();
        assert_eq!(reread.llm.base_url, "https://api.openai.com/v1");
        assert!(reread.llm_api_key_configured);
    }

    #[cfg(feature = "mock-keyring")]
    #[test]
    fn save_llm_config_keeps_existing_key_when_blank() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app();
        save_llm_config(app.handle().clone(), fresh_input("sk-first")).unwrap();

        let view = save_llm_config(app.handle().clone(), fresh_input("")).unwrap();
        assert!(view.llm_api_key_configured);
        assert_eq!(
            settings::get_secret(LLM_API_KEY_ACCOUNT).unwrap(),
            "sk-first"
        );
    }

    #[cfg(feature = "mock-keyring")]
    #[test]
    fn resolve_api_key_falls_back_to_stored_secret() {
        settings::reset_mock_keyring();
        settings::set_secret(LLM_API_KEY_ACCOUNT, "sk-stored").unwrap();
        let input = fresh_input("");
        assert_eq!(input.resolve_api_key().unwrap(), "sk-stored");
    }

    #[cfg(feature = "mock-keyring")]
    #[test]
    fn resolve_api_key_errors_when_blank_and_no_stored_secret() {
        settings::reset_mock_keyring();
        let input = fresh_input("");
        let err = input.resolve_api_key().unwrap_err();
        assert!(err.to_string().contains("API key is required"));
    }

    #[cfg(feature = "mock-keyring")]
    #[test]
    fn save_safety_config_persists_and_round_trips() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app();

        // Default: confirmations enabled.
        let view = get_settings(app.handle().clone()).unwrap();
        assert!(view.safety.confirm_destructive);

        let updated = save_safety_config(
            app.handle().clone(),
            SafetyConfig {
                confirm_destructive: false,
            },
        )
        .unwrap();
        assert!(!updated.safety.confirm_destructive);

        // Survives a reload.
        let reread = get_settings(app.handle().clone()).unwrap();
        assert!(!reread.safety.confirm_destructive);
    }

    #[cfg(feature = "mock-keyring")]
    #[test]
    fn save_safety_config_leaves_llm_block_untouched() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app();
        save_llm_config(app.handle().clone(), fresh_input("sk-x")).unwrap();
        save_safety_config(
            app.handle().clone(),
            SafetyConfig {
                confirm_destructive: false,
            },
        )
        .unwrap();
        let view = get_settings(app.handle().clone()).unwrap();
        assert_eq!(view.llm.model, "gpt-4o-mini");
        assert!(view.llm_api_key_configured);
    }

    #[cfg(feature = "mock-keyring")]
    #[tokio::test]
    async fn test_llm_config_propagates_resolution_error() {
        settings::reset_mock_keyring();
        let input = fresh_input("");
        let err = test_llm_config(input).await.unwrap_err();
        assert!(err.to_string().contains("API key is required"));
    }

    #[cfg(feature = "mock-keyring")]
    #[test]
    fn clear_llm_api_key_drops_only_the_secret() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app();
        save_llm_config(app.handle().clone(), fresh_input("sk-test")).unwrap();

        clear_llm_api_key().unwrap();
        let view = get_settings(app.handle().clone()).unwrap();
        assert!(!view.llm_api_key_configured);
        // LLM metadata stayed.
        assert_eq!(view.llm.model, "gpt-4o-mini");
    }
}
