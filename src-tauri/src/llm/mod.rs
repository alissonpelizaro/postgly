//! OpenAI-compatible LLM client.
//!
//! - [`test_connectivity`] — the Settings "Testar conexão" probe.
//! - [`chat`] — `chat/completions` types and the agent's HTTP client.
//! - [`tools`] — schemas + executor for the functions the LLM may call.
//! - [`agent`] — tool-use loop that turns a natural-language instruction
//!   into a SQL query.

use std::time::Duration;

use serde::Deserialize;

use crate::error::{AppError, AppResult};

pub mod agent;
pub mod chat;
pub mod fuzzy;
pub mod tools;

/// Shape of the `/models` response we care about. We don't deserialise
/// the whole envelope — only enough to confirm the endpoint answered.
#[derive(Debug, Deserialize)]
struct ModelsResponse {
    #[serde(default)]
    data: Vec<ModelEntry>,
}

#[derive(Debug, Deserialize)]
struct ModelEntry {
    #[serde(default)]
    id: String,
}

/// Outcome of `test_llm_config`. `models` is the list of model ids the
/// provider advertised, useful as a hint in the UI.
#[derive(Debug, serde::Serialize)]
pub struct LlmConnectivity {
    pub models: Vec<String>,
}

/// Strip the trailing slash so `{base}/models` always joins cleanly.
fn normalize_base_url(base: &str) -> &str {
    base.trim_end_matches('/')
}

/// Build the URL for an arbitrary path on the configured base.
pub fn endpoint(base_url: &str, path: &str) -> String {
    let base = normalize_base_url(base_url);
    let suffix = path.trim_start_matches('/');
    format!("{base}/{suffix}")
}

/// Default HTTP client with a sane timeout. Created per-call: the
/// surface here is tiny and a global pool isn't worth the plumbing yet.
fn build_client() -> AppResult<reqwest::Client> {
    build_client_with_timeout(Duration::from_secs(15))
}

/// Same as [`build_client`] but the caller picks the timeout. Used by
/// the chat client where tool-use loops can take a while.
pub(crate) fn build_client_with_timeout(timeout: Duration) -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| AppError::Other(format!("http client: {e}")))
}

/// Hit `{base_url}/models` with the supplied bearer token. Returns the
/// list of model ids on success. Distinguishes auth, transport and
/// protocol errors so the UI can surface actionable messages.
pub async fn test_connectivity(base_url: &str, api_key: &str) -> AppResult<LlmConnectivity> {
    if base_url.trim().is_empty() {
        return Err(AppError::Connection("base URL is required".into()));
    }
    if api_key.trim().is_empty() {
        return Err(AppError::Connection("API key is required".into()));
    }

    let url = endpoint(base_url, "models");
    let client = build_client()?;

    let response = client
        .get(&url)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| AppError::Connection(format!("request failed: {e}")))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let snippet = body.chars().take(200).collect::<String>();
        return Err(AppError::Connection(format!(
            "HTTP {}: {}",
            status.as_u16(),
            if snippet.is_empty() {
                "no body"
            } else {
                &snippet
            }
        )));
    }

    let parsed: ModelsResponse = response.json().await.map_err(|e| {
        AppError::Connection(format!(
            "endpoint did not return an OpenAI-compatible response: {e}"
        ))
    })?;

    Ok(LlmConnectivity {
        models: parsed.data.into_iter().map(|m| m.id).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_handles_trailing_slashes() {
        assert_eq!(
            endpoint("https://api.openai.com/v1", "models"),
            "https://api.openai.com/v1/models"
        );
        assert_eq!(
            endpoint("https://api.openai.com/v1/", "/models"),
            "https://api.openai.com/v1/models"
        );
    }

    #[tokio::test]
    async fn test_connectivity_rejects_empty_base_url() {
        let err = test_connectivity("", "sk-test").await.unwrap_err();
        assert!(err.to_string().contains("base URL is required"));
    }

    #[tokio::test]
    async fn test_connectivity_rejects_empty_api_key() {
        let err = test_connectivity("https://x", "  ").await.unwrap_err();
        assert!(err.to_string().contains("API key is required"));
    }

    mod with_mock_server {
        use super::*;
        use wiremock::matchers::{bearer_token, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        #[tokio::test]
        async fn returns_model_ids_on_success() {
            let server = MockServer::start().await;
            Mock::given(method("GET"))
                .and(path("/v1/models"))
                .and(bearer_token("sk-test"))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "data": [
                        {"id": "gpt-4o-mini"},
                        {"id": "gpt-4o"}
                    ]
                })))
                .mount(&server)
                .await;

            let url = format!("{}/v1", server.uri());
            let result = test_connectivity(&url, "sk-test").await.unwrap();
            assert_eq!(result.models, vec!["gpt-4o-mini", "gpt-4o"]);
        }

        #[tokio::test]
        async fn maps_unauthorized_status_to_connection_error() {
            let server = MockServer::start().await;
            Mock::given(method("GET"))
                .and(path("/v1/models"))
                .respond_with(ResponseTemplate::new(401).set_body_string("invalid api key"))
                .mount(&server)
                .await;

            let url = format!("{}/v1", server.uri());
            let err = test_connectivity(&url, "wrong").await.unwrap_err();
            let msg = err.to_string();
            assert!(msg.contains("401"));
            assert!(msg.contains("invalid api key"));
        }

        #[tokio::test]
        async fn flags_non_openai_compatible_response() {
            let server = MockServer::start().await;
            Mock::given(method("GET"))
                .and(path("/v1/models"))
                .respond_with(ResponseTemplate::new(200).set_body_string("<html>not json</html>"))
                .mount(&server)
                .await;

            let url = format!("{}/v1", server.uri());
            let err = test_connectivity(&url, "sk-test").await.unwrap_err();
            assert!(err
                .to_string()
                .contains("did not return an OpenAI-compatible response"));
        }

        #[tokio::test]
        async fn surfaces_transport_failure_when_host_unreachable() {
            // Reserved port 1 — guaranteed connection refused.
            let err = test_connectivity("http://127.0.0.1:1/v1", "sk-test")
                .await
                .unwrap_err();
            assert!(err.to_string().contains("request failed"));
        }
    }
}
