//! Tool-use loop that drives the LLM through schema exploration and
//! into a final SQL query.
//!
//! Contract with the model: the system prompt asks it to either keep
//! calling tools or to respond with a single JSON object describing the
//! outcome:
//!
//! ```json
//! { "status": "ok",        "sql": "SELECT ..." }
//! { "status": "need_info", "reason": "instrução ambígua: ..." }
//! { "status": "not_found", "reason": "tabela X não encontrada" }
//! { "status": "error",     "reason": "..." }
//! ```
//!
//! The loop bails out after [`MAX_STEPS`] iterations so a misbehaving
//! model can't loop forever burning tokens.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::chat::{ChatClient, ChatMessage, ChatRequest, TokenUsage, ToolDef};
use super::tools::ToolExecutor;
use crate::error::{AppError, AppResult};

/// Hard cap on the number of `chat/completions` calls we'll make per
/// natural-language request. Each iteration is one model turn (possibly
/// with multiple tool calls handled together before the next call).
pub const MAX_STEPS: usize = 8;

/// One observable event in the agent trace — surfaced back to the UI so
/// users can see what the model did.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TraceEvent {
    ToolCall {
        name: String,
        arguments: Value,
    },
    ToolResult {
        name: String,
        ok: bool,
        result: Value,
    },
    AssistantMessage {
        content: String,
    },
}

/// Outcome status the model is asked to emit in its final message.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Ok,
    NeedInfo,
    NotFound,
    Error,
}

/// What `generate_sql` returns to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentOutput {
    pub status: AgentStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Short, actionable hints surfaced when `status != "ok"` — e.g.
    /// table names the user might have meant, or clarifying questions.
    /// Always present (possibly empty) so the frontend can iterate
    /// without null-checks.
    #[serde(default)]
    pub suggestions: Vec<String>,
    pub trace: Vec<TraceEvent>,
    /// Aggregate token usage across every chat turn made for this
    /// request. Zeroed when the provider didn't return usage data.
    #[serde(default)]
    pub usage: TokenUsage,
}

/// Internal: the schema we expect the model to emit in its final message.
#[derive(Debug, Deserialize)]
struct FinalAnswer {
    status: AgentStatus,
    #[serde(default)]
    sql: Option<String>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    suggestions: Vec<String>,
}

/// Default system prompt — explains the contract and the available tools.
pub fn default_system_prompt() -> String {
    format!(
        "You are a SQL assistant embedded in a PostgreSQL client. \
         Your job: turn a user's natural-language request into a single SQL query.\n\n\
         Rules:\n\
         - Always inspect the database before answering. Use `list_tables`, \
         `describe_table` and `list_relations` to confirm tables, columns and joins.\n\
         - Use `sample_rows` only when you really need to inspect data formats \
         (it issues a real SELECT against the user's database).\n\
         - Generate ANSI-compatible PostgreSQL. Prefer schema-qualified names.\n\
         - You may use JOINs when the user's request requires data from related tables.\n\
         - If the request is ambiguous, missing context, or a table cannot be found, \
         say so — do NOT invent column or table names.\n\
         - When ready, reply with ONE JSON object and nothing else. \
         No code fences, no commentary. The schema is:\n\
         {{\"status\":\"ok|need_info|not_found|error\",\"sql\":\"<query>\",\"reason\":\"<why>\",\"suggestions\":[\"...\"]}}\n\
         - `sql` is required when status is `ok` and omitted otherwise.\n\
         - `reason` is required when status is not `ok`. Be specific — name the table or term that confused you.\n\
         - `suggestions` is an array of up to 5 short, actionable hints to help the user retry. Examples:\n\
           * status `not_found`: candidate table/column names you saw in the schema that look similar (e.g. [\"public.users\", \"public.customers\"]).\n\
           * status `need_info`: concrete clarifying examples (e.g. [\"filtrar por created_at >= '2025-01-01'\", \"informar o tenant_id desejado\"]).\n\
           Omit or use [] when nothing useful applies.\n\
         You have at most {MAX_STEPS} model turns to complete the task."
    )
}

/// Run the agent loop. Returns the structured outcome plus a trace of
/// what happened (used by the UI to show "the model called X, got Y").
pub async fn run(
    client: &ChatClient<'_>,
    tool_defs: Vec<ToolDef>,
    executor: &dyn ToolExecutor,
    model: &str,
    temperature: f32,
    system_prompt: String,
    instruction: String,
) -> AppResult<AgentOutput> {
    let mut messages = vec![
        ChatMessage::system(system_prompt),
        ChatMessage::user(instruction),
    ];
    let mut trace = Vec::new();
    let mut usage = TokenUsage::default();

    for _ in 0..MAX_STEPS {
        let request = ChatRequest {
            model: model.to_string(),
            messages: messages.clone(),
            temperature: Some(temperature),
            tools: tool_defs.clone(),
        };
        let response = client.send(&request).await?;
        if let Some(turn_usage) = response.usage.as_ref() {
            usage.accumulate(turn_usage);
        }
        let choice = response
            .choices
            .into_iter()
            .next()
            .ok_or_else(|| AppError::Other("LLM returned no choices".into()))?;

        let assistant = choice.message;
        messages.push(assistant.clone());

        // Tool calls take priority: any tool calls trigger execution
        // and a follow-up turn, even if `content` is also set.
        if !assistant.tool_calls.is_empty() {
            for call in &assistant.tool_calls {
                let args: Value = if call.function.arguments.trim().is_empty() {
                    Value::Object(serde_json::Map::new())
                } else {
                    serde_json::from_str(&call.function.arguments)
                        .unwrap_or_else(|_| Value::Object(serde_json::Map::new()))
                };
                trace.push(TraceEvent::ToolCall {
                    name: call.function.name.clone(),
                    arguments: args.clone(),
                });

                let (ok, body) = match executor.execute(&call.function.name, args).await {
                    Ok(v) => (true, v),
                    Err(e) => (false, serde_json::json!({ "error": e.to_string() })),
                };
                trace.push(TraceEvent::ToolResult {
                    name: call.function.name.clone(),
                    ok,
                    result: body.clone(),
                });

                messages.push(ChatMessage::tool(
                    call.id.clone(),
                    call.function.name.clone(),
                    serde_json::to_string(&body).unwrap_or_else(|_| "{}".into()),
                ));
            }
            continue;
        }

        // No tool calls — this is the model's final answer.
        let content = assistant.content.unwrap_or_default();
        trace.push(TraceEvent::AssistantMessage {
            content: content.clone(),
        });
        return Ok(finalize(content, trace, usage));
    }

    Ok(AgentOutput {
        status: AgentStatus::Error,
        sql: None,
        reason: Some(format!(
            "LLM exceeded the {MAX_STEPS}-turn budget without producing a final answer"
        )),
        suggestions: Vec::new(),
        trace,
        usage,
    })
}

/// Outcome of the conversational chat agent (free-form text answer with
/// an optional tool-use trace).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatOutput {
    pub content: String,
    pub trace: Vec<TraceEvent>,
    #[serde(default)]
    pub usage: TokenUsage,
}

/// Drive the LLM through the same tool-use loop as [`run`], but accept
/// any free-form text as the final answer — no JSON schema is enforced.
/// Used by the conversational chat panel.
pub async fn run_chat(
    client: &ChatClient<'_>,
    tool_defs: Vec<ToolDef>,
    executor: &dyn ToolExecutor,
    model: &str,
    temperature: f32,
    messages: Vec<ChatMessage>,
) -> AppResult<ChatOutput> {
    let mut messages = messages;
    let mut trace = Vec::new();
    let mut usage = TokenUsage::default();

    for _ in 0..MAX_STEPS {
        let request = ChatRequest {
            model: model.to_string(),
            messages: messages.clone(),
            temperature: Some(temperature),
            tools: tool_defs.clone(),
        };
        let response = client.send(&request).await?;
        if let Some(turn_usage) = response.usage.as_ref() {
            usage.accumulate(turn_usage);
        }
        let choice = response
            .choices
            .into_iter()
            .next()
            .ok_or_else(|| AppError::Other("LLM returned no choices".into()))?;
        let assistant = choice.message;
        messages.push(assistant.clone());

        if !assistant.tool_calls.is_empty() {
            for call in &assistant.tool_calls {
                let args: Value = if call.function.arguments.trim().is_empty() {
                    Value::Object(serde_json::Map::new())
                } else {
                    serde_json::from_str(&call.function.arguments)
                        .unwrap_or_else(|_| Value::Object(serde_json::Map::new()))
                };
                trace.push(TraceEvent::ToolCall {
                    name: call.function.name.clone(),
                    arguments: args.clone(),
                });

                let (ok, body) = match executor.execute(&call.function.name, args).await {
                    Ok(v) => (true, v),
                    Err(e) => (false, serde_json::json!({ "error": e.to_string() })),
                };
                trace.push(TraceEvent::ToolResult {
                    name: call.function.name.clone(),
                    ok,
                    result: body.clone(),
                });

                messages.push(ChatMessage::tool(
                    call.id.clone(),
                    call.function.name.clone(),
                    serde_json::to_string(&body).unwrap_or_else(|_| "{}".into()),
                ));
            }
            continue;
        }

        let content = assistant.content.unwrap_or_default();
        trace.push(TraceEvent::AssistantMessage {
            content: content.clone(),
        });
        return Ok(ChatOutput {
            content,
            trace,
            usage,
        });
    }

    Ok(ChatOutput {
        content: format!(
            "Stopped after {MAX_STEPS} reasoning steps without a final answer. \
             Try narrowing your request."
        ),
        trace,
        usage,
    })
}

/// Streaming variant of [`run_chat`]. Identical tool-use loop, but each
/// model turn goes through [`ChatClient::send_stream`] so the caller
/// receives text deltas in real time via `on_content`. Tool-call turns
/// don't emit content, so `on_content` simply isn't invoked for them.
pub async fn run_chat_stream<F>(
    client: &ChatClient<'_>,
    tool_defs: Vec<ToolDef>,
    executor: &dyn ToolExecutor,
    model: &str,
    temperature: f32,
    messages: Vec<ChatMessage>,
    mut on_content: F,
) -> AppResult<ChatOutput>
where
    F: FnMut(&str),
{
    let mut messages = messages;
    let mut trace = Vec::new();
    let mut usage = TokenUsage::default();

    // True after we've streamed at least one non-empty reasoning chunk.
    // Used to inject a paragraph break between consecutive reasoning
    // turns so the UI can render each step as its own block instead of
    // gluing them all into one wall of text.
    let mut emitted_any_content = false;
    for _ in 0..MAX_STEPS {
        let request = ChatRequest {
            model: model.to_string(),
            messages: messages.clone(),
            temperature: Some(temperature),
            tools: tool_defs.clone(),
        };
        if emitted_any_content {
            // Separator between agent turns. Two newlines = Markdown
            // paragraph break; the host adds an <hr> on top of that.
            on_content("\n\n");
        }
        let (assistant, turn_usage) = client
            .send_stream(&request, |delta| on_content(delta))
            .await?;
        if let Some(u) = turn_usage.as_ref() {
            usage.accumulate(u);
        }
        if assistant
            .content
            .as_ref()
            .map(|c| !c.trim().is_empty())
            .unwrap_or(false)
        {
            emitted_any_content = true;
        }
        messages.push(assistant.clone());

        if !assistant.tool_calls.is_empty() {
            for call in &assistant.tool_calls {
                let args: Value = if call.function.arguments.trim().is_empty() {
                    Value::Object(serde_json::Map::new())
                } else {
                    serde_json::from_str(&call.function.arguments)
                        .unwrap_or_else(|_| Value::Object(serde_json::Map::new()))
                };
                trace.push(TraceEvent::ToolCall {
                    name: call.function.name.clone(),
                    arguments: args.clone(),
                });

                let (ok, body) = match executor.execute(&call.function.name, args).await {
                    Ok(v) => (true, v),
                    Err(e) => (false, serde_json::json!({ "error": e.to_string() })),
                };
                trace.push(TraceEvent::ToolResult {
                    name: call.function.name.clone(),
                    ok,
                    result: body.clone(),
                });

                messages.push(ChatMessage::tool(
                    call.id.clone(),
                    call.function.name.clone(),
                    serde_json::to_string(&body).unwrap_or_else(|_| "{}".into()),
                ));
            }
            continue;
        }

        let content = assistant.content.unwrap_or_default();
        trace.push(TraceEvent::AssistantMessage {
            content: content.clone(),
        });
        return Ok(ChatOutput {
            content,
            trace,
            usage,
        });
    }

    Ok(ChatOutput {
        content: format!(
            "Stopped after {MAX_STEPS} reasoning steps without a final answer. \
             Try narrowing your request."
        ),
        trace,
        usage,
    })
}

/// Coerce the assistant's final message into an [`AgentOutput`]. JSON is
/// parsed leniently — the model occasionally wraps it in a code fence
/// or trails extra commentary, so we try a few recoveries before giving
/// up.
fn finalize(content: String, trace: Vec<TraceEvent>, usage: TokenUsage) -> AgentOutput {
    let trimmed = content.trim();
    let candidates = [
        trimmed.to_string(),
        strip_code_fence(trimmed),
        extract_first_json_object(trimmed).unwrap_or_default(),
    ];
    for candidate in candidates.iter().filter(|s| !s.is_empty()) {
        if let Ok(parsed) = serde_json::from_str::<FinalAnswer>(candidate) {
            let suggestions = parsed
                .suggestions
                .into_iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .take(5)
                .collect();
            return AgentOutput {
                status: parsed.status,
                sql: parsed.sql.filter(|s| !s.is_empty()),
                reason: parsed.reason.filter(|s| !s.is_empty()),
                suggestions,
                trace,
                usage,
            };
        }
    }
    AgentOutput {
        status: AgentStatus::Error,
        sql: None,
        reason: Some(format!(
            "LLM did not return JSON. Raw answer: {}",
            content.chars().take(400).collect::<String>()
        )),
        suggestions: Vec::new(),
        trace,
        usage,
    }
}

fn strip_code_fence(s: &str) -> String {
    let s = s.trim();
    if !s.starts_with("```") {
        return s.to_string();
    }
    let after_open = s
        .trim_start_matches("```")
        .trim_start_matches("json")
        .trim_start();
    after_open.trim_end_matches("```").trim().to_string()
}

fn extract_first_json_object(s: &str) -> Option<String> {
    let start = s.find('{')?;
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escape = false;
    for (i, ch) in s[start..].char_indices() {
        if escape {
            escape = false;
            continue;
        }
        match ch {
            '\\' if in_string => escape = true,
            '"' => in_string = !in_string,
            '{' if !in_string => depth += 1,
            '}' if !in_string => {
                depth -= 1;
                if depth == 0 {
                    return Some(s[start..start + i + 1].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finalize_parses_clean_json() {
        let out = finalize(
            r#"{"status":"ok","sql":"SELECT 1"}"#.into(),
            vec![],
            TokenUsage::default(),
        );
        assert_eq!(out.status, AgentStatus::Ok);
        assert_eq!(out.sql.as_deref(), Some("SELECT 1"));
    }

    #[test]
    fn finalize_unwraps_code_fence() {
        let out = finalize(
            "```json\n{\"status\":\"ok\",\"sql\":\"SELECT 1\"}\n```".into(),
            vec![],
            TokenUsage::default(),
        );
        assert_eq!(out.sql.as_deref(), Some("SELECT 1"));
    }

    #[test]
    fn finalize_extracts_first_object_amid_chatter() {
        let out = finalize(
            "Sure! Here is the JSON: {\"status\":\"need_info\",\"reason\":\"why?\"} thanks.".into(),
            vec![],
            TokenUsage::default(),
        );
        assert_eq!(out.status, AgentStatus::NeedInfo);
        assert_eq!(out.reason.as_deref(), Some("why?"));
    }

    #[test]
    fn finalize_parses_suggestions_array_and_trims_blank_entries() {
        let raw = r#"{
            "status": "not_found",
            "reason": "tabela usuarios não encontrada",
            "suggestions": ["public.users", "  ", "public.customers", "public.user_logs", "public.x", "extra"]
        }"#;
        let out = finalize(raw.into(), vec![], TokenUsage::default());
        assert_eq!(out.status, AgentStatus::NotFound);
        // Blank entry filtered, capped at 5.
        assert_eq!(out.suggestions.len(), 5);
        assert_eq!(out.suggestions[0], "public.users");
        assert!(!out.suggestions.iter().any(|s| s.trim().is_empty()));
    }

    #[test]
    fn finalize_defaults_suggestions_to_empty_when_omitted() {
        let out = finalize(
            r#"{"status":"ok","sql":"SELECT 1"}"#.into(),
            vec![],
            TokenUsage::default(),
        );
        assert!(out.suggestions.is_empty());
    }

    #[test]
    fn finalize_falls_back_to_error_for_garbage() {
        let out = finalize("totally not json".into(), vec![], TokenUsage::default());
        assert_eq!(out.status, AgentStatus::Error);
        assert!(out.reason.unwrap().contains("did not return JSON"));
    }

    #[test]
    fn finalize_drops_empty_sql_and_reason_strings() {
        let out = finalize(
            r#"{"status":"ok","sql":"","reason":""}"#.into(),
            vec![],
            TokenUsage::default(),
        );
        assert!(out.sql.is_none());
        assert!(out.reason.is_none());
    }

    #[test]
    fn extract_first_json_object_skips_braces_inside_strings() {
        let extracted = extract_first_json_object("noise {\"a\":\"}\",\"b\":1} trailing").unwrap();
        assert_eq!(extracted, "{\"a\":\"}\",\"b\":1}");
    }

    #[test]
    fn default_system_prompt_mentions_tools_and_budget() {
        let prompt = default_system_prompt();
        assert!(prompt.contains("list_tables"));
        assert!(prompt.contains("describe_table"));
        assert!(prompt.contains("list_relations"));
        assert!(prompt.contains("sample_rows"));
        assert!(prompt.contains(&MAX_STEPS.to_string()));
    }

    use crate::error::AppResult;
    use async_trait::async_trait;
    use serde_json::json;
    use std::sync::Mutex;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    struct ScriptedExecutor {
        responses: Mutex<Vec<AppResult<Value>>>,
    }

    impl ScriptedExecutor {
        fn new(responses: Vec<AppResult<Value>>) -> Self {
            Self {
                responses: Mutex::new(responses),
            }
        }
    }

    #[async_trait]
    impl crate::llm::tools::ToolExecutor for ScriptedExecutor {
        async fn execute(&self, _name: &str, _args: Value) -> AppResult<Value> {
            self.responses.lock().unwrap().remove(0)
        }
    }

    #[tokio::test]
    async fn agent_records_tool_failure_in_trace_and_continues() {
        let server = MockServer::start().await;

        // Turn 1: ask for a tool call.
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "tool_calls": [{
                            "id": "call_1",
                            "type": "function",
                            "function": {"name": "describe_table", "arguments": "{}"}
                        }]
                    },
                    "finish_reason": "tool_calls"
                }]
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;

        // Turn 2: produce final answer.
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": "{\"status\":\"not_found\",\"reason\":\"table missing\"}"
                    },
                    "finish_reason": "stop"
                }]
            })))
            .mount(&server)
            .await;

        let executor = ScriptedExecutor::new(vec![Err(crate::error::AppError::Other(
            "table not found".into(),
        ))]);
        let url = format!("{}/v1", server.uri());
        let client = ChatClient::new(&url, "sk");

        let out = run(
            &client,
            vec![ToolDef::function(
                "describe_table",
                "desc",
                json!({"type": "object"}),
            )],
            &executor,
            "m",
            0.0,
            "sys".into(),
            "do thing".into(),
        )
        .await
        .unwrap();

        assert_eq!(out.status, AgentStatus::NotFound);
        // The failed tool result is on the trace with ok=false.
        assert!(out
            .trace
            .iter()
            .any(|e| matches!(e, TraceEvent::ToolResult { ok: false, .. })));
    }

    #[tokio::test]
    async fn agent_gives_up_after_max_steps() {
        let server = MockServer::start().await;

        // Every call returns another tool request — the agent should
        // stop after MAX_STEPS and report an error.
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "tool_calls": [{
                            "id": "call_x",
                            "type": "function",
                            "function": {"name": "list_tables", "arguments": ""}
                        }]
                    },
                    "finish_reason": "tool_calls"
                }]
            })))
            .mount(&server)
            .await;

        let executor =
            ScriptedExecutor::new((0..MAX_STEPS).map(|_| Ok(json!({"tables": []}))).collect());
        let url = format!("{}/v1", server.uri());
        let client = ChatClient::new(&url, "sk");

        let out = run(
            &client,
            vec![ToolDef::function(
                "list_tables",
                "",
                json!({"type": "object"}),
            )],
            &executor,
            "m",
            0.0,
            "sys".into(),
            "go".into(),
        )
        .await
        .unwrap();

        assert_eq!(out.status, AgentStatus::Error);
        assert!(out.reason.as_deref().unwrap_or("").contains("exceeded"));
    }

    #[tokio::test]
    async fn agent_sums_usage_across_turns() {
        let server = MockServer::start().await;

        // Turn 1: tool call + 10/5 tokens.
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "tool_calls": [{
                            "id": "c",
                            "type": "function",
                            "function": {"name": "list_tables", "arguments": "{}"}
                        }]
                    },
                    "finish_reason": "tool_calls"
                }],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;

        // Turn 2: final + 20/8 tokens.
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": "{\"status\":\"ok\",\"sql\":\"SELECT 1\"}"
                    },
                    "finish_reason": "stop"
                }],
                "usage": {"prompt_tokens": 20, "completion_tokens": 8, "total_tokens": 28}
            })))
            .mount(&server)
            .await;

        let executor = ScriptedExecutor::new(vec![Ok(json!({"tables": []}))]);
        let url = format!("{}/v1", server.uri());
        let client = ChatClient::new(&url, "sk");

        let out = run(
            &client,
            vec![ToolDef::function(
                "list_tables",
                "",
                json!({"type":"object"}),
            )],
            &executor,
            "m",
            0.0,
            "sys".into(),
            "go".into(),
        )
        .await
        .unwrap();

        assert_eq!(out.usage.prompt_tokens, 30);
        assert_eq!(out.usage.completion_tokens, 13);
        assert_eq!(out.usage.total_tokens, 43);
    }

    #[tokio::test]
    async fn agent_errors_when_provider_returns_no_choices() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"choices": []})))
            .mount(&server)
            .await;

        let executor = ScriptedExecutor::new(vec![]);
        let url = format!("{}/v1", server.uri());
        let client = ChatClient::new(&url, "sk");
        let err = run(
            &client,
            vec![],
            &executor,
            "m",
            0.0,
            "sys".into(),
            "x".into(),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("no choices"));
    }

    /// `run_chat_stream` should drive the same tool-call loop as
    /// `run_chat` while forwarding text deltas from the final streamed
    /// turn to the caller. Wiremock returns SSE for both turns:
    /// turn 1 = tool_calls only (no content -> no callbacks);
    /// turn 2 = streamed text fragments (callback fires per fragment).
    #[tokio::test]
    async fn run_chat_stream_streams_final_turn_after_tool_loop() {
        let server = MockServer::start().await;

        // Turn 1: tool_call delta, no content.
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(
                        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"type\":\"function\",\"function\":{\"name\":\"list_tables\",\"arguments\":\"{}\"}}]}}]}\n\n\
                         data: [DONE]\n\n",
                    ),
            )
            .up_to_n_times(1)
            .mount(&server)
            .await;

        // Turn 2: streamed text reply, three fragments.
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(
                        "data: {\"choices\":[{\"delta\":{\"content\":\"hello \"}}]}\n\n\
                         data: {\"choices\":[{\"delta\":{\"content\":\"world\"}}]}\n\n\
                         data: {\"choices\":[],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":6,\"total_tokens\":10}}\n\n\
                         data: [DONE]\n\n",
                    ),
            )
            .mount(&server)
            .await;

        let executor = ScriptedExecutor::new(vec![Ok(json!({"tables": ["users"]}))]);
        let url = format!("{}/v1", server.uri());
        let client = ChatClient::new(&url, "sk");
        let mut deltas: Vec<String> = Vec::new();
        let out = run_chat_stream(
            &client,
            vec![ToolDef::function(
                "list_tables",
                "",
                json!({"type": "object"}),
            )],
            &executor,
            "m",
            0.0,
            vec![ChatMessage::system("s"), ChatMessage::user("oi")],
            |d| deltas.push(d.to_string()),
        )
        .await
        .unwrap();

        assert_eq!(out.content, "hello world");
        assert_eq!(deltas, vec!["hello ", "world"]);
        // Trace should hold the tool call + tool result + final
        // assistant_message echo.
        assert!(out
            .trace
            .iter()
            .any(|e| matches!(e, TraceEvent::ToolCall { name, .. } if name == "list_tables")));
        assert!(out
            .trace
            .iter()
            .any(|e| matches!(e, TraceEvent::ToolResult { ok: true, .. })));
        // Usage from the streamed turn.
        assert_eq!(out.usage.total_tokens, 10);
    }
}
