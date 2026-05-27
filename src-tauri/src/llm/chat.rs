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
    pub fn function(
        name: impl Into<String>,
        description: impl Into<String>,
        parameters: Value,
    ) -> Self {
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
                if snippet.is_empty() {
                    "no body"
                } else {
                    &snippet
                }
            )));
        }

        response
            .json::<ChatResponse>()
            .await
            .map_err(|e| AppError::Connection(format!("invalid chat completions response: {e}")))
    }

    /// Streaming variant of [`Self::send`]. Reads the SSE response from
    /// an OpenAI-compatible `chat/completions?stream=true` call, invokes
    /// `on_content` for every text delta as it arrives, and returns the
    /// fully assembled assistant message plus token usage when the
    /// stream terminates.
    ///
    /// Tool-call deltas are merged but NOT pushed through `on_content`
    /// (they're not user-visible text). Providers that don't honour
    /// `stream_options.include_usage` just leave usage at `None`.
    pub async fn send_stream<F>(
        &self,
        request: &ChatRequest,
        mut on_content: F,
    ) -> AppResult<(ChatMessage, Option<TokenUsage>)>
    where
        F: FnMut(&str),
    {
        let client = build_client_with_timeout(Duration::from_secs(180))?;
        let url = endpoint(self.base_url, "chat/completions");

        // Serialize and tack on stream + stream_options. We can't add
        // those to ChatRequest itself because non-streaming callers
        // would inherit them.
        let mut body = serde_json::to_value(request)
            .map_err(|e| AppError::Other(format!("serialize chat request: {e}")))?;
        if let Some(obj) = body.as_object_mut() {
            obj.insert("stream".into(), Value::Bool(true));
            obj.insert(
                "stream_options".into(),
                serde_json::json!({ "include_usage": true }),
            );
        }

        let response = client
            .post(&url)
            .bearer_auth(self.api_key)
            .json(&body)
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
                if snippet.is_empty() {
                    "no body"
                } else {
                    &snippet
                }
            )));
        }

        let mut response = response;
        let mut acc = StreamAccumulator::default();
        let mut buffer = String::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| AppError::Connection(format!("stream read failed: {e}")))?
        {
            buffer.push_str(std::str::from_utf8(&chunk).unwrap_or(""));
            // SSE events are separated by a blank line.
            while let Some(idx) = buffer.find("\n\n") {
                let event = buffer[..idx].to_string();
                buffer.drain(..idx + 2);
                for line in event.lines() {
                    let Some(data) = line.strip_prefix("data:") else {
                        continue;
                    };
                    let data = data.trim();
                    if data.is_empty() || data == "[DONE]" {
                        continue;
                    }
                    let Ok(chunk_json) = serde_json::from_str::<StreamChunk>(data) else {
                        continue;
                    };
                    if let Some(usage) = chunk_json.usage {
                        acc.usage = Some(usage);
                    }
                    for choice in chunk_json.choices {
                        if let Some(content) = choice.delta.content {
                            if !content.is_empty() {
                                acc.content.push_str(&content);
                                on_content(&content);
                            }
                        }
                        for tc in choice.delta.tool_calls {
                            acc.merge_tool_call(tc);
                        }
                    }
                }
            }
        }

        Ok(acc.into_message_and_usage())
    }
}

/// Single SSE chunk in an OpenAI-compatible streaming response. We keep
/// everything optional because providers vary widely in what they emit.
#[derive(Debug, Deserialize)]
struct StreamChunk {
    #[serde(default)]
    choices: Vec<StreamChoice>,
    #[serde(default)]
    usage: Option<TokenUsage>,
}

#[derive(Debug, Deserialize)]
struct StreamChoice {
    delta: StreamDelta,
}

#[derive(Debug, Default, Deserialize)]
struct StreamDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ToolCallDelta>,
}

#[derive(Debug, Deserialize)]
struct ToolCallDelta {
    /// Position in the assistant's tool_calls array. Required to
    /// reassemble multiple parallel calls.
    index: usize,
    #[serde(default)]
    id: Option<String>,
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    function: Option<FunctionDelta>,
}

#[derive(Debug, Default, Deserialize)]
struct FunctionDelta {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

/// Buffer that assembles a complete assistant message from streamed
/// deltas. Tool-call slots are extended in place since fragments for the
/// same `index` can arrive across many SSE events.
#[derive(Debug, Default)]
struct StreamAccumulator {
    content: String,
    tool_calls: Vec<ToolCall>,
    usage: Option<TokenUsage>,
}

impl StreamAccumulator {
    fn merge_tool_call(&mut self, delta: ToolCallDelta) {
        while self.tool_calls.len() <= delta.index {
            self.tool_calls.push(ToolCall {
                id: String::new(),
                kind: "function".into(),
                function: FunctionCall {
                    name: String::new(),
                    arguments: String::new(),
                },
            });
        }
        let slot = &mut self.tool_calls[delta.index];
        if let Some(id) = delta.id {
            if !id.is_empty() {
                slot.id = id;
            }
        }
        if let Some(kind) = delta.kind {
            if !kind.is_empty() {
                slot.kind = kind;
            }
        }
        if let Some(func) = delta.function {
            if let Some(name) = func.name {
                if !name.is_empty() {
                    slot.function.name.push_str(&name);
                }
            }
            if let Some(args) = func.arguments {
                slot.function.arguments.push_str(&args);
            }
        }
    }

    fn into_message_and_usage(self) -> (ChatMessage, Option<TokenUsage>) {
        let content = if self.content.is_empty() {
            None
        } else {
            Some(self.content)
        };
        let message = ChatMessage {
            role: Role::Assistant,
            content,
            tool_calls: self.tool_calls,
            tool_call_id: None,
            name: None,
        };
        (message, self.usage)
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

    /// Sanity-check the StreamAccumulator: tool-call fragments arriving
    /// across several SSE events at the same `index` should be merged
    /// into a single ToolCall with concatenated arguments.
    #[test]
    fn stream_accumulator_merges_tool_call_deltas_across_chunks() {
        let mut acc = StreamAccumulator::default();
        acc.merge_tool_call(ToolCallDelta {
            index: 0,
            id: Some("call_1".into()),
            kind: Some("function".into()),
            function: Some(FunctionDelta {
                name: Some("list_".into()),
                arguments: Some("{\"sch".into()),
            }),
        });
        acc.merge_tool_call(ToolCallDelta {
            index: 0,
            id: None,
            kind: None,
            function: Some(FunctionDelta {
                name: Some("tables".into()),
                arguments: Some("ema\":\"public\"}".into()),
            }),
        });
        // A second parallel call at index 1 fills the gap correctly.
        acc.merge_tool_call(ToolCallDelta {
            index: 1,
            id: Some("call_2".into()),
            kind: Some("function".into()),
            function: Some(FunctionDelta {
                name: Some("describe_table".into()),
                arguments: Some("{}".into()),
            }),
        });
        let (msg, usage) = acc.into_message_and_usage();
        assert!(usage.is_none());
        assert!(msg.content.is_none());
        assert_eq!(msg.tool_calls.len(), 2);
        assert_eq!(msg.tool_calls[0].id, "call_1");
        assert_eq!(msg.tool_calls[0].function.name, "list_tables");
        assert_eq!(
            msg.tool_calls[0].function.arguments,
            "{\"schema\":\"public\"}"
        );
        assert_eq!(msg.tool_calls[1].id, "call_2");
        assert_eq!(msg.tool_calls[1].function.name, "describe_table");
    }

    /// Empty-string id/kind/name/arguments deltas should be no-ops so a
    /// later non-empty fragment isn't clobbered or duplicated.
    #[test]
    fn stream_accumulator_ignores_empty_delta_fields() {
        let mut acc = StreamAccumulator::default();
        acc.merge_tool_call(ToolCallDelta {
            index: 0,
            id: Some(String::new()),
            kind: Some(String::new()),
            function: Some(FunctionDelta {
                name: Some(String::new()),
                arguments: None,
            }),
        });
        acc.merge_tool_call(ToolCallDelta {
            index: 0,
            id: Some("real_id".into()),
            kind: Some("function".into()),
            function: Some(FunctionDelta {
                name: Some("tool".into()),
                arguments: Some(String::new()),
            }),
        });
        let (msg, _) = acc.into_message_and_usage();
        assert_eq!(msg.tool_calls.len(), 1);
        assert_eq!(msg.tool_calls[0].id, "real_id");
        assert_eq!(msg.tool_calls[0].kind, "function");
        assert_eq!(msg.tool_calls[0].function.name, "tool");
        assert!(msg.tool_calls[0].function.arguments.is_empty());
    }

    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// End-to-end streaming: hit a wiremock server that returns the
    /// OpenAI SSE format, ensure each content delta is forwarded to the
    /// caller and the final assembled message has the full text + usage.
    #[tokio::test]
    async fn send_stream_forwards_content_deltas_and_assembles_message() {
        let server = MockServer::start().await;
        let body = "data: {\"choices\":[{\"delta\":{\"content\":\"Olá\"}}]}\n\n\
                    data: {\"choices\":[{\"delta\":{\"content\":\", \"}}]}\n\n\
                    data: {\"choices\":[{\"delta\":{\"content\":\"mundo\"}}]}\n\n\
                    data: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\n\
                    data: [DONE]\n\n";
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(body),
            )
            .mount(&server)
            .await;

        let url = format!("{}/v1", server.uri());
        let client = ChatClient::new(&url, "sk");
        let request = ChatRequest {
            model: "m".into(),
            messages: vec![ChatMessage::user("oi")],
            temperature: Some(0.0),
            tools: Vec::new(),
        };
        let mut collected = String::new();
        let (msg, usage) = client
            .send_stream(&request, |d| collected.push_str(d))
            .await
            .unwrap();
        assert_eq!(collected, "Olá, mundo");
        assert_eq!(msg.content.as_deref(), Some("Olá, mundo"));
        assert!(msg.tool_calls.is_empty());
        let usage = usage.unwrap();
        assert_eq!(usage.total_tokens, 5);
    }

    /// Tool-call deltas should NOT be pushed through the content
    /// callback, but should land in the final ChatMessage.tool_calls.
    #[tokio::test]
    async fn send_stream_assembles_tool_calls_without_content_callbacks() {
        let server = MockServer::start().await;
        let body = "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"type\":\"function\",\"function\":{\"name\":\"list_\",\"arguments\":\"{}\"}}]}}]}\n\n\
                    data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"tables\"}}]}}]}\n\n\
                    data: [DONE]\n\n";
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(body),
            )
            .mount(&server)
            .await;

        let url = format!("{}/v1", server.uri());
        let client = ChatClient::new(&url, "sk");
        let request = ChatRequest {
            model: "m".into(),
            messages: vec![ChatMessage::user("x")],
            temperature: Some(0.0),
            tools: Vec::new(),
        };
        let mut deltas = 0usize;
        let (msg, _) = client
            .send_stream(&request, |_d| deltas += 1)
            .await
            .unwrap();
        assert_eq!(deltas, 0, "tool-call deltas must not be forwarded as text");
        assert!(msg.content.is_none());
        assert_eq!(msg.tool_calls.len(), 1);
        assert_eq!(msg.tool_calls[0].id, "c1");
        assert_eq!(msg.tool_calls[0].function.name, "list_tables");
    }

    /// Non-2xx responses to the streaming endpoint bubble up as a
    /// Connection error rather than silently returning an empty
    /// message.
    #[tokio::test]
    async fn send_stream_surfaces_http_errors() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(401).set_body_string("nope"))
            .mount(&server)
            .await;
        let url = format!("{}/v1", server.uri());
        let client = ChatClient::new(&url, "sk");
        let request = ChatRequest {
            model: "m".into(),
            messages: vec![ChatMessage::user("x")],
            temperature: Some(0.0),
            tools: Vec::new(),
        };
        let err = client.send_stream(&request, |_d| {}).await.unwrap_err();
        assert!(err.to_string().contains("401"));
    }
}
