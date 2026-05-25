//! OpenAI-compatible chat completions: request/response types plus a
//! thin client. We hand-roll the wire types so the same code works
//! against any provider that respects the OpenAI shape (OpenAI,
//! groq, Together, Ollama with the `/v1` shim, ...).

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{build_client_with_timeout, endpoint};
use crate::error::{AppError, AppResult};

/// Message roles understood by the chat API.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

/// A function call the assistant wants the host to run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    /// Always `"function"` for the OpenAI shape. Kept opaque so we don't
    /// fail deserialisation on providers that add new kinds.
    #[serde(default = "default_tool_call_kind", rename = "type")]
    pub kind: String,
    pub function: FunctionCall,
}

fn default_tool_call_kind() -> String {
    "function".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionCall {
    pub name: String,
    /// JSON-encoded argument object. Providers can hand back malformed
    /// JSON here, so callers parse defensively.
    pub arguments: String,
}

/// One chat message, on either side of the conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    /// Set on `tool` role messages — the id of the originating call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Set on `tool` role messages — the function name (some providers
    /// require it even though OpenAI itself doesn't).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl ChatMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: Role::System,
            content: Some(content.into()),
            tool_calls: Vec::new(),
            tool_call_id: None,
            name: None,
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            content: Some(content.into()),
            tool_calls: Vec::new(),
            tool_call_id: None,
            name: None,
        }
    }

    pub fn tool(call_id: impl Into<String>, name: impl Into<String>, content: String) -> Self {
        Self {
            role: Role::Tool,
            content: Some(content),
            tool_calls: Vec::new(),
            tool_call_id: Some(call_id.into()),
            name: Some(name.into()),
        }
    }
}

/// JSON schema for a function the assistant may call.
#[derive(Debug, Clone, Serialize)]
pub struct ToolDef {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub function: FunctionDef,
}

impl ToolDef {
    pub fn function(name: impl Into<String>, description: impl Into<String>, parameters: Value) -> Self {
        Self {
            kind: "function",
            function: FunctionDef {
                name: name.into(),
                description: description.into(),
                parameters,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct FunctionDef {
    pub name: String,
    pub description: String,
    /// JSON Schema describing the function's parameters.
    pub parameters: Value,
}

/// A `chat/completions` request body.
#[derive(Debug, Clone, Serialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolDef>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatChoice {
    pub message: ChatMessage,
    #[serde(default)]
    pub finish_reason: Option<String>,
}

/// Token accounting returned alongside a chat completion. All fields
/// are optional because not every OpenAI-compatible provider populates
/// every field (Ollama, for instance, omits prompt counts).
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct TokenUsage {
    #[serde(default)]
    pub prompt_tokens: u64,
    #[serde(default)]
    pub completion_tokens: u64,
    #[serde(default)]
    pub total_tokens: u64,
}

impl TokenUsage {
    /// Add another turn's usage into this running total.
    pub fn accumulate(&mut self, other: &TokenUsage) {
        self.prompt_tokens += other.prompt_tokens;
        self.completion_tokens += other.completion_tokens;
        // Some providers omit `total_tokens`; fall back to the sum so
        // the running total stays consistent.
        let other_total = if other.total_tokens > 0 {
            other.total_tokens
        } else {
            other.prompt_tokens + other.completion_tokens
        };
        self.total_tokens += other_total;
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatResponse {
    pub choices: Vec<ChatChoice>,
    #[serde(default)]
    pub usage: Option<TokenUsage>,
}

/// Minimal client wrapping `chat/completions`. Borrows base URL and key
/// per-request so the caller controls secret lifetime.
pub struct ChatClient<'a> {
    pub base_url: &'a str,
    pub api_key: &'a str,
}

impl<'a> ChatClient<'a> {
    pub fn new(base_url: &'a str, api_key: &'a str) -> Self {
        Self { base_url, api_key }
    }

    /// Send one request and parse the response. Network and HTTP
    /// failures fold into [`AppError::Connection`]; the agent loop
    /// decides whether to surface or retry them.
    pub async fn send(&self, request: &ChatRequest) -> AppResult<ChatResponse> {
        // Chat completions can be slow with tool use; give them more
        // head-room than the connectivity probe.
        let client = build_client_with_timeout(Duration::from_secs(120))?;
        let url = endpoint(self.base_url, "chat/completions");

        let response = client
            .post(&url)
            .bearer_auth(self.api_key)
            .json(request)
            .send()
            .await
            .map_err(|e| AppError::Connection(format!("request failed: {e}")))?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            let snippet = body.chars().take(300).collect::<String>();
            return Err(AppError::Connection(format!(
                "HTTP {}: {}",
                status.as_u16(),
                if snippet.is_empty() { "no body" } else { &snippet }
            )));
        }

        response.json::<ChatResponse>().await.map_err(|e| {
            AppError::Connection(format!("invalid chat completions response: {e}"))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_message_user_omits_empty_optional_fields() {
        let msg = ChatMessage::user("hi");
        let json = serde_json::to_string(&msg).unwrap();
        // No tool_calls / tool_call_id / name keys when unset.
        assert!(!json.contains("tool_calls"));
        assert!(!json.contains("tool_call_id"));
        assert!(!json.contains("\"name\""));
        assert!(json.contains("\"role\":\"user\""));
        assert!(json.contains("\"content\":\"hi\""));
    }

    #[test]
    fn chat_message_tool_carries_call_id_and_name() {
        let msg = ChatMessage::tool("call_1", "list_tables", "[]".into());
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"role\":\"tool\""));
        assert!(json.contains("\"tool_call_id\":\"call_1\""));
        assert!(json.contains("\"name\":\"list_tables\""));
    }

    #[test]
    fn tool_call_round_trips_with_default_type() {
        // Provider returned no `type` field — our default fills it in.
        let raw = r#"{"id":"call_1","function":{"name":"f","arguments":"{}"}}"#;
        let call: ToolCall = serde_json::from_str(raw).unwrap();
        assert_eq!(call.kind, "function");
        assert_eq!(call.function.name, "f");
    }

    #[test]
    fn tool_def_serializes_with_type_function() {
        let def = ToolDef::function(
            "list_tables",
            "List tables",
            serde_json::json!({"type": "object", "properties": {}}),
        );
        let json = serde_json::to_string(&def).unwrap();
        assert!(json.contains("\"type\":\"function\""));
        assert!(json.contains("\"name\":\"list_tables\""));
    }

    #[test]
    fn token_usage_accumulate_sums_each_field() {
        let mut total = TokenUsage::default();
        total.accumulate(&TokenUsage {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
        });
        total.accumulate(&TokenUsage {
            prompt_tokens: 3,
            completion_tokens: 7,
            total_tokens: 10,
        });
        assert_eq!(total.prompt_tokens, 13);
        assert_eq!(total.completion_tokens, 12);
        assert_eq!(total.total_tokens, 25);
    }

    #[test]
    fn token_usage_accumulate_recovers_missing_total() {
        let mut total = TokenUsage::default();
        total.accumulate(&TokenUsage {
            prompt_tokens: 4,
            completion_tokens: 6,
            total_tokens: 0,
        });
        assert_eq!(total.total_tokens, 10);
    }

    #[test]
    fn chat_response_parses_usage_when_present() {
        let raw = r#"{
            "choices": [{
                "message": {"role": "assistant", "content": "x"},
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 11, "completion_tokens": 22, "total_tokens": 33}
        }"#;
        let resp: ChatResponse = serde_json::from_str(raw).unwrap();
        let usage = resp.usage.unwrap();
        assert_eq!(usage.prompt_tokens, 11);
        assert_eq!(usage.total_tokens, 33);
    }

    #[test]
    fn chat_response_parses_assistant_with_tool_call() {
        let raw = r#"{
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "list_tables", "arguments": "{}"}
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        }"#;
        let resp: ChatResponse = serde_json::from_str(raw).unwrap();
        let choice = &resp.choices[0];
        assert_eq!(choice.message.role, Role::Assistant);
        assert_eq!(choice.message.tool_calls.len(), 1);
        assert_eq!(choice.message.tool_calls[0].function.name, "list_tables");
        assert_eq!(choice.finish_reason.as_deref(), Some("tool_calls"));
    }
}
