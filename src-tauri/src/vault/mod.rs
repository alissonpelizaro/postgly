//! Encrypted secret vault persisted in the app config directory.
//!
//! This replaces OS keyring usage with a single encrypted `vault.json`.
//! The encryption key is derived from a host/user fingerprint plus a
//! per-write random salt so plaintext secrets never hit disk.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use aes_gcm_siv::aead::{Aead, KeyInit};
use aes_gcm_siv::{Aes256GcmSiv, Nonce};
use base64::Engine as _;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::error::{AppError, AppResult};

#[cfg_attr(feature = "mock-keyring", allow(dead_code))]
const VAULT_FILE: &str = "vault.json";
#[cfg_attr(feature = "mock-keyring", allow(dead_code))]
const VAULT_VERSION: u32 = 1;

// Static pepper so an attacker needs machine context, not just the file.
#[cfg_attr(feature = "mock-keyring", allow(dead_code))]
const KEY_PEPPER: &[u8] = b"postgly.vault.v1";

#[cfg_attr(feature = "mock-keyring", allow(dead_code))]
#[derive(Debug, Default, Serialize, Deserialize)]
struct VaultPlain {
    #[serde(default)]
    connections: HashMap<String, String>,
    #[serde(default)]
    settings: HashMap<String, String>,
}

#[cfg_attr(feature = "mock-keyring", allow(dead_code))]
#[derive(Debug, Serialize, Deserialize)]
struct VaultEnvelope {
    version: u32,
    salt_b64: String,
    nonce_b64: String,
    ciphertext_b64: String,
}

#[cfg_attr(feature = "mock-keyring", allow(dead_code))]
fn vault_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Other(format!("cannot resolve config dir: {e}")))?;
    fs::create_dir_all(&dir).map_err(|e| AppError::Other(e.to_string()))?;
    Ok(dir.join(VAULT_FILE))
}

#[cfg_attr(feature = "mock-keyring", allow(dead_code))]
fn host_fingerprint() -> String {
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default();
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    format!("{user}|{home}|{os}|{arch}")
}

#[cfg_attr(feature = "mock-keyring", allow(dead_code))]
fn derive_key(salt: &[u8; 16]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(KEY_PEPPER);
    hasher.update(host_fingerprint().as_bytes());
    hasher.update(salt);
    hasher.finalize().into()
}

#[cfg_attr(feature = "mock-keyring", allow(dead_code))]
fn load_plain_from(path: &Path) -> AppResult<VaultPlain> {
    if !path.exists() {
        return Ok(VaultPlain::default());
    }

    let raw = fs::read_to_string(path).map_err(|e| AppError::Other(e.to_string()))?;
    let envelope: VaultEnvelope =
        serde_json::from_str(&raw).map_err(|e| AppError::Other(format!("corrupt vault: {e}")))?;

    if envelope.version != VAULT_VERSION {
        return Err(AppError::Other("unsupported vault version".into()));
    }

    let salt: [u8; 16] = base64::engine::general_purpose::STANDARD
        .decode(envelope.salt_b64)
        .map_err(|e| AppError::Other(format!("corrupt vault salt: {e}")))?
        .try_into()
        .map_err(|_| AppError::Other("corrupt vault salt length".into()))?;

    let nonce: [u8; 12] = base64::engine::general_purpose::STANDARD
        .decode(envelope.nonce_b64)
        .map_err(|e| AppError::Other(format!("corrupt vault nonce: {e}")))?
        .try_into()
        .map_err(|_| AppError::Other("corrupt vault nonce length".into()))?;

    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(envelope.ciphertext_b64)
        .map_err(|e| AppError::Other(format!("corrupt vault payload: {e}")))?;

    let key = derive_key(&salt);
    let cipher = Aes256GcmSiv::new_from_slice(&key)
        .map_err(|e| AppError::Other(format!("vault key init failed: {e}")))?;
    let decrypted = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| AppError::Other("cannot decrypt vault (host/user changed?)".into()))?;

    serde_json::from_slice::<VaultPlain>(&decrypted)
        .map_err(|e| AppError::Other(format!("corrupt decrypted vault: {e}")))
}

#[cfg_attr(feature = "mock-keyring", allow(dead_code))]
fn save_plain_to(path: &Path, plain: &VaultPlain) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| AppError::Other(e.to_string()))?;
    }

    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce);

    let key = derive_key(&salt);
    let cipher = Aes256GcmSiv::new_from_slice(&key)
        .map_err(|e| AppError::Other(format!("vault key init failed: {e}")))?;

    let plaintext = serde_json::to_vec(plain).map_err(|e| AppError::Other(e.to_string()))?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext.as_ref())
        .map_err(|e| AppError::Other(format!("vault encryption failed: {e}")))?;

    let envelope = VaultEnvelope {
        version: VAULT_VERSION,
        salt_b64: base64::engine::general_purpose::STANDARD.encode(salt),
        nonce_b64: base64::engine::general_purpose::STANDARD.encode(nonce),
        ciphertext_b64: base64::engine::general_purpose::STANDARD.encode(ciphertext),
    };
    let raw =
        serde_json::to_string_pretty(&envelope).map_err(|e| AppError::Other(e.to_string()))?;
    fs::write(path, raw).map_err(|e| AppError::Other(e.to_string()))
}

#[cfg(not(feature = "mock-keyring"))]
pub fn set_connection_password<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
    password: &str,
) -> AppResult<()> {
    let path = vault_path(app)?;
    let mut plain = load_plain_from(&path)?;
    plain
        .connections
        .insert(id.to_string(), password.to_string());
    save_plain_to(&path, &plain)
}

#[cfg(not(feature = "mock-keyring"))]
pub fn get_connection_password<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
) -> AppResult<String> {
    let path = vault_path(app)?;
    let plain = load_plain_from(&path)?;
    plain
        .connections
        .get(id)
        .cloned()
        .ok_or_else(|| AppError::Other("vault: no entry".into()))
}

#[cfg(not(feature = "mock-keyring"))]
pub fn delete_connection_password<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
) -> AppResult<()> {
    let path = vault_path(app)?;
    let mut plain = load_plain_from(&path)?;
    plain.connections.remove(id);
    save_plain_to(&path, &plain)
}

#[cfg(not(feature = "mock-keyring"))]
pub fn set_setting_secret<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    account: &str,
    value: &str,
) -> AppResult<()> {
    let path = vault_path(app)?;
    let mut plain = load_plain_from(&path)?;
    plain
        .settings
        .insert(account.to_string(), value.to_string());
    save_plain_to(&path, &plain)
}

#[cfg(not(feature = "mock-keyring"))]
pub fn get_setting_secret<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    account: &str,
) -> AppResult<String> {
    let path = vault_path(app)?;
    let plain = load_plain_from(&path)?;
    Ok(plain.settings.get(account).cloned().unwrap_or_default())
}

#[cfg(not(feature = "mock-keyring"))]
#[allow(dead_code)]
pub fn delete_setting_secret<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    account: &str,
) -> AppResult<()> {
    let path = vault_path(app)?;
    let mut plain = load_plain_from(&path)?;
    plain.settings.remove(account);
    save_plain_to(&path, &plain)
}

#[cfg(feature = "mock-keyring")]
mod mock_vault {
    use super::{AppResult, HashMap};
    use std::sync::Mutex;

    #[derive(Default)]
    struct MockVault {
        connections: HashMap<String, String>,
        settings: HashMap<String, String>,
    }

    static STORE: Mutex<Option<HashMap<String, MockVault>>> = Mutex::new(None);

    fn scope_key() -> String {
        format!(
            "{}|{}|{}",
            std::env::var("HOME").unwrap_or_default(),
            std::env::var("XDG_CONFIG_HOME").unwrap_or_default(),
            std::env::var("APPDATA").unwrap_or_default()
        )
    }

    fn with_store<R>(f: impl FnOnce(&mut MockVault) -> R) -> R {
        let mut guard = STORE.lock().expect("mock vault poisoned");
        let map = guard.get_or_insert_with(HashMap::new);
        let vault = map.entry(scope_key()).or_insert_with(MockVault::default);
        f(vault)
    }

    pub fn set_connection(id: &str, password: &str) -> AppResult<()> {
        with_store(|v| {
            v.connections.insert(id.to_string(), password.to_string());
        });
        Ok(())
    }

    pub fn get_connection(id: &str) -> AppResult<String> {
        with_store(|v| {
            v.connections
                .get(id)
                .cloned()
                .ok_or_else(|| crate::error::AppError::Other("vault: no entry".into()))
        })
    }

    pub fn delete_connection(id: &str) -> AppResult<()> {
        with_store(|v| {
            v.connections.remove(id);
        });
        Ok(())
    }

    pub fn set_setting(account: &str, value: &str) -> AppResult<()> {
        with_store(|v| {
            v.settings.insert(account.to_string(), value.to_string());
        });
        Ok(())
    }

    pub fn get_setting(account: &str) -> AppResult<String> {
        with_store(|v| Ok(v.settings.get(account).cloned().unwrap_or_default()))
    }

    pub fn delete_setting(account: &str) -> AppResult<()> {
        with_store(|v| {
            v.settings.remove(account);
        });
        Ok(())
    }

    pub fn reset_connections() {
        with_store(|v| {
            v.connections.clear();
        });
    }

    pub fn reset_settings() {
        with_store(|v| {
            v.settings.clear();
        });
    }
}

#[cfg(feature = "mock-keyring")]
pub fn set_connection_password<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    id: &str,
    password: &str,
) -> AppResult<()> {
    mock_vault::set_connection(id, password)
}

#[cfg(feature = "mock-keyring")]
pub fn get_connection_password<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    id: &str,
) -> AppResult<String> {
    mock_vault::get_connection(id)
}

#[cfg(feature = "mock-keyring")]
pub fn delete_connection_password<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    id: &str,
) -> AppResult<()> {
    mock_vault::delete_connection(id)
}

#[cfg(feature = "mock-keyring")]
pub fn set_setting_secret<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    account: &str,
    value: &str,
) -> AppResult<()> {
    mock_vault::set_setting(account, value)
}

#[cfg(feature = "mock-keyring")]
pub fn get_setting_secret<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    account: &str,
) -> AppResult<String> {
    mock_vault::get_setting(account)
}

#[cfg(feature = "mock-keyring")]
#[allow(dead_code)]
pub fn delete_setting_secret<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    account: &str,
) -> AppResult<()> {
    mock_vault::delete_setting(account)
}

#[cfg(feature = "mock-keyring")]
pub fn reset_mock_connection_store() {
    mock_vault::reset_connections();
}

#[cfg(feature = "mock-keyring")]
pub fn reset_mock_setting_store() {
    mock_vault::reset_settings();
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn save_then_load_round_trip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("vault.json");

        let mut plain = VaultPlain::default();
        plain.connections.insert("a".into(), "pw".into());
        plain.settings.insert("llm.api_key".into(), "sk-x".into());
        save_plain_to(&path, &plain).unwrap();

        let loaded = load_plain_from(&path).unwrap();
        assert_eq!(loaded.connections.get("a").unwrap(), "pw");
        assert_eq!(loaded.settings.get("llm.api_key").unwrap(), "sk-x");
    }

    #[test]
    fn missing_file_returns_default_plain() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("vault.json");
        let loaded = load_plain_from(&path).unwrap();
        assert!(loaded.connections.is_empty());
        assert!(loaded.settings.is_empty());
    }
}
