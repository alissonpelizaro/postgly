//! Commands that drive the natural-language → SQL agent.

use std::sync::Arc;

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::db::driver::DatabaseSchema;
use crate::error::{AppError, AppResult};
use crate::llm::agent::{self, AgentOutput, AgentStatus};
use crate::llm::chat::{ChatClient, ChatMessage, ChatRequest, Role, TokenUsage};
use crate::llm::fuzzy;
use crate::llm::tools::SessionTools;
use crate::settings::{self, LLM_API_KEY_ACCOUNT};
use crate::state::{AppState, NlHistoryEntry};

use super::explorer::{get_database_schema, session_for};

/// Turn a natural-language instruction into a SQL query using the
/// configured LLM. Returns a structured outcome that the UI can render
/// directly (the model is asked to emit JSON; the agent recovers it
/// even when wrapped in code fences).
#[tauri::command]
pub async fn generate_sql<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, AppState>,
    session_id: String,
    instruction: String,
    // Optional per-call overrides (model + temperature) that win over
    // the values stored in Settings.
    model_override: Option<String>,
    temperature_override: Option<f32>,
) -> AppResult<AgentOutput> {
    if instruction.trim().is_empty() {
        return Err(AppError::Other("instruction is empty".into()));
    }

    // LLM config + secret.
    let cfg = settings::load(&app)?.llm;
    if cfg.base_url.trim().is_empty() || cfg.model.trim().is_empty() {
        return Err(AppError::Other(
            "LLM is not configured — set base URL and model in Settings.".into(),
        ));
    }
    let api_key = settings::get_secret(&app, LLM_API_KEY_ACCOUNT)?;
    if api_key.trim().is_empty() {
        return Err(AppError::Other(
            "LLM API key is not configured — set it in Settings.".into(),
        ));
    }

    // Resolve effective model + temperature, applying per-call overrides.
    let effective_model = model_override
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(cfg.model.as_str());
    let effective_temperature = temperature_override
        .map(|t| t.clamp(0.0, 2.0))
        .unwrap_or(cfg.temperature);

    // Session + cached schema.
    let session = session_for(&state, &session_id)?;
    let schema = get_database_schema(state.clone(), session_id.clone()).await?;

    let tool_defs = SessionTools::definitions();
    let executor = SessionTools::new(session, Arc::clone(&schema));
    let client = ChatClient::new(&cfg.base_url, &api_key);

    let mut output = agent::run(
        &client,
        tool_defs,
        &executor,
        effective_model,
        effective_temperature,
        agent::default_system_prompt(),
        instruction.clone(),
    )
    .await?;

    // Belt-and-braces: when the model failed to find a table and didn't
    // suggest anything, run a fuzzy match against the cached schema so
    // the UI can still offer "did you mean X?" hints.
    if output.status == AgentStatus::NotFound && output.suggestions.is_empty() {
        output.suggestions = fallback_suggestions(&schema, output.reason.as_deref());
    }

    state.push_nl_history(
        &session_id,
        NlHistoryEntry {
            instruction,
            output: output.clone(),
            created_at: now_seconds(),
        },
    );

    Ok(output)
}

/// One turn passed in from the frontend chat history. We accept a
/// minimal shape so the localStorage payload stays small — system
/// prompt is injected here, tool messages don't exist yet (Phase 2).
#[derive(Debug, Deserialize)]
pub struct ChatTurn {
    pub role: String,
    pub content: String,
}

/// Response shape returned to the frontend chat panel.
#[derive(Debug, Serialize)]
pub struct AgentChatResponse {
    pub content: String,
    pub usage: TokenUsage,
    /// Tool-use trace, present when the chat ran against a connected
    /// database. Empty when the chat had no database session bound.
    #[serde(default)]
    pub trace: Vec<agent::TraceEvent>,
}

/// Conversational system prompt used when the chat has no database
/// session attached. The model can still answer general questions and
/// propose SQL, but it cannot inspect or execute against any database.
fn conversational_system_prompt() -> String {
    "You are the in-app assistant for Postgly, a desktop database client. \
     Reply in the user's language. Be concise — no greetings, no filler, \
     no trailing offers of further help (don't write things like \"posso \
     te ajudar em algo mais?\", \"se precisar de mais alguma coisa é só \
     falar\", \"hope this helps\" or equivalents in any language). End \
     when the answer ends.\n\n\
     ## Scope — strict\n\
     For greetinsgs, always reply with a concise welcome message that \
     invites the user to ask a question or provide instructions.\n\
     Your ONLY job is (1) helping the user manage their database \
     (PostgreSQL: schemas, tables, queries, SQL syntax, performance, data \
     modeling, migrations) and (2) helping them navigate Postgly itself \
     (Connections, Explorer, Settings, About, tabs, keyboard shortcuts, \
     features of the app). Anything outside that scope — general coding \
     help, other tools/frameworks, math, writing, life advice, opinions, \
     translations, jokes, world knowledge — is OFF LIMITS even if the \
     user insists. For those, reply briefly and politely in the user's \
     language, stating that your specialty is helping with the database \
     and with using Postgly, and stop there. Do NOT attempt the task.\n\n\
     ## State\n\
     No database connection is open in this chat, so you can't inspect \
     schemas or run queries. Tell the user to open a connection tab to \
     enable those features. When proposing SQL anyway, render it inside a \
     fenced ```sql block.\n\
     ## About postgly\n\n\
     Postgly is a desktop client for PostgreSQL databases with an Agent \
     (you) built in. In the header, it has 3 buttons: 1. (robot icon) \
     open or close the Agent; 2. (sun, moon, and computer icon) Select \
     dark, light, or system mode; 3. (three bars) Menu.\n\
     In the menu has two options: Settings and About. In Settings, has \
     this configs: General (language select - EN, PT, SP), LLM Config \
     (user can set you own LLM provider an model config), Appearance \
     (change colors and theme) and Safety (manage destructive query \
     guard rails). In About, they see the app version and how to update \
     and links to the docs, and GitHub repo.\n\
     To create a new connection: on the home screen, click + New \
     connection, and enter the connection details.\n\
     The APP is multilingual, so the buttons and texts of the APP will \
     always be in its language. When giving navigation instructions for \
     the APP, use the user's language for the buttons and texts."
        .to_string()
}

/// Conversational system prompt used when a database session is bound.
/// The model has read-only tools for schema lookup, SELECT execution
/// and gated write/DDL execution.
fn conversational_system_prompt_with_tools() -> String {
    "You are the in-app assistant for Postgly, a desktop PostgreSQL \
     client. You have a live connection to the user's database and a set \
     of tools to explore and modify it. Reply in the user's language.\n\n\
     ## Scope — strict\n\
     For greetinsgs, always reply with a concise welcome message that \
     invites the user to ask a question or provide instructions.\n\
     Your ONLY job is (1) helping the user manage their database \
     (schemas, tables, queries, SQL syntax, performance, data modeling, \
     migrations) and (2) helping them navigate Postgly itself \
     (Connections, Explorer, Settings, About, tabs, keyboard shortcuts, \
     features of the app). Anything outside that scope — general coding \
     help in other languages or frameworks, math, writing, life advice, \
     opinions, translations, jokes, world knowledge — is OFF LIMITS even \
     if the user insists. For those, reply briefly and politely in the \
     user's language, stating that your specialty is helping with the \
     database and with using Postgly, and stop there. Do NOT attempt the \
     task and do NOT call any tools.\n\n\
     ## Style\n\
     - Be concise and matter-of-fact. No greetings, no filler, no recap of \
       what you just did unless the user asks.\n\
     - NEVER end a response with offers of further help such as \"posso te \
       ajudar em algo mais?\", \"se precisar de mais alguma coisa é só \
       falar\", \"let me know if you need anything else\", \"hope this \
       helps\", or any equivalent. Stop when the answer is complete.\n\
     - Render SQL inside fenced ```sql blocks when the user benefits from \
       seeing it. Otherwise just state the result.\n\n\
     ## Autonomy — find things yourself before asking\n\
     - Default to acting, not asking. If the user names a table without a \
       schema, call `list_tables` with no schema filter and locate it \
       yourself. Try common variants too: singular/plural, snake_case, \
       and obvious synonyms (e.g. `users` ↔ `usuarios`, `customers` ↔ \
       `clientes`).\n\
     - When a table appears in exactly one schema, just use it — don't ask \
       the user to confirm the schema.\n\
     - When a table appears in MORE than one schema, do NOT guess. List the \
       matching `schema.table` candidates back to the user and ask which \
       one they mean. Wait for the answer before running any query.\n\
     - When the requested table does not exist at all, do a fuzzy scan via \
       `list_tables` and propose the 2–4 closest names you found. Don't \
       invent names.\n\
     - Use `describe_table` and `list_relations` whenever joins, types, or \
       FK paths matter. Don't ask the user for column names that you can \
       look up.\n\
     - Only ask the user when the ambiguity is genuinely irreducible \
       (multiple plausible schemas, conflicting filters, unclear intent). \
       Keep the question to one short sentence with concrete options.\n\n\
     ## Reading data\n\
     - For data questions, run `run_select` and report what you actually \
       saw. Quote real values, never fabricated ones.\n\
     - `run_select` returns at most 100 rows. If `truncated` is true, say \
       so and suggest a narrower filter.\n\
     - Prefer schema-qualified names in generated SQL (`schema.table`).\n\n\
     ## Writing data\n\
     - For mutations, use `run_write` with a single statement and a short \
       `summary` of what it does and why.\n\
     - If `run_write` returns `needs_approval: true`, the host is showing \
       an approval card. STOP - Only one approval card can be active at a \
       time. Explain in plain language what you're proposing. Do NOT call \
       `run_write` again with the same SQL, and do NOT claim it ran.\n\
     - If `run_write` returns `executed: true`, the statement ran. Report \
       `rows_affected`.\n\n\
     ## About postgly\n\
     Postgly is a desktop client for PostgreSQL databases with an Agent \
     (you) built in. In the header, it has 3 buttons: 1. (robot icon) \
     open or close the Agent; 2. (sun, moon, and computer icon) Select \
     dark, light, or system mode; 3. (three bars) Menu.\n\
     In the menu has two options: Settings and About. In Settings, has \
     this configs: General (language select - EN, PT, SP), LLM Config \
     (user can set you own LLM provider an model config), Appearance \
     (change colors and theme) and Safety (manage destructive query \
     guard rails). In About, they see the app version and how to update \
     and links to the docs, and GitHub repo.\n\
     To create a new connection: on the home screen, click + New \
     connection, and enter the connection details.\n\
     The APP is multilingual, so the buttons and texts of the APP will \
     always be in its language. When giving navigation instructions for \
     the APP, use the user's language for the buttons and texts."
        .to_string()
}

/// Send a chat message to the configured LLM and return the assistant's
/// reply. Stateless: the frontend ships the entire conversation history
/// each turn (kept in localStorage with a 180-day TTL). When
/// `connection_session_id` is set, the LLM is given read-only tools to
/// inspect and query that database session.
///
/// When `request_id` is set, the backend streams every text delta as a
/// `agent_chat_delta` Tauri event carrying `{ request_id, delta }`; the
/// final assembled reply is still returned via this command so the
/// frontend gets `trace` and `usage` in one place.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_chat_send<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, AppState>,
    history: Vec<ChatTurn>,
    instruction: String,
    connection_session_id: Option<String>,
    model_override: Option<String>,
    temperature_override: Option<f32>,
    request_id: Option<String>,
) -> AppResult<AgentChatResponse> {
    if instruction.trim().is_empty() {
        return Err(AppError::Other("instruction is empty".into()));
    }

    let cfg = settings::load(&app)?.llm;
    if cfg.base_url.trim().is_empty() || cfg.model.trim().is_empty() {
        return Err(AppError::Other(
            "LLM is not configured — set base URL and model in Settings.".into(),
        ));
    }
    let api_key = settings::get_secret(&app, LLM_API_KEY_ACCOUNT)?;
    if api_key.trim().is_empty() {
        return Err(AppError::Other(
            "LLM API key is not configured — set it in Settings.".into(),
        ));
    }

    let effective_model = model_override
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(cfg.model.as_str());
    let effective_temperature = temperature_override
        .map(|t| t.clamp(0.0, 2.0))
        .unwrap_or(cfg.temperature);

    let bound = connection_session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let system_prompt = if bound.is_some() {
        conversational_system_prompt_with_tools()
    } else {
        conversational_system_prompt()
    };

    let mut messages: Vec<ChatMessage> = Vec::with_capacity(history.len() + 2);
    messages.push(ChatMessage::system(system_prompt));
    for turn in history {
        let role = match turn.role.as_str() {
            "user" => Role::User,
            "assistant" => Role::Assistant,
            // Skip anything unexpected (system, tool, ...) — the chat
            // panel doesn't ship those.
            _ => continue,
        };
        messages.push(ChatMessage {
            role,
            content: Some(turn.content),
            tool_calls: Vec::new(),
            tool_call_id: None,
            name: None,
        });
    }
    messages.push(ChatMessage::user(instruction));

    let client = ChatClient::new(&cfg.base_url, &api_key);
    let request_id = request_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let streaming = request_id.is_some();
    let stream_emitter = StreamEmitter::new(app.clone(), request_id);

    if let Some(session_id) = bound {
        let session = session_for(&state, session_id)?;
        let schema = get_database_schema(state.clone(), session_id.to_string()).await?;
        let safety = settings::load(&app)?.safety;
        let tool_defs = SessionTools::definitions();
        let executor = SessionTools::new(session, Arc::clone(&schema))
            .with_confirm_writes(safety.confirm_destructive);

        let output = if streaming {
            agent::run_chat_stream(
                &client,
                tool_defs,
                &executor,
                effective_model,
                effective_temperature,
                messages,
                |delta| stream_emitter.emit(delta),
            )
            .await?
        } else {
            agent::run_chat(
                &client,
                tool_defs,
                &executor,
                effective_model,
                effective_temperature,
                messages,
            )
            .await?
        };

        if output.content.trim().is_empty() {
            return Err(AppError::Other(
                "LLM returned an empty response. Try rephrasing your message.".into(),
            ));
        }
        return Ok(AgentChatResponse {
            content: output.content,
            usage: output.usage,
            trace: output.trace,
        });
    }

    let request = ChatRequest {
        model: effective_model.to_string(),
        messages,
        temperature: Some(effective_temperature),
        tools: Vec::new(),
    };
    let (content, usage) = if streaming {
        let (assistant, usage) = client
            .send_stream(&request, |delta| stream_emitter.emit(delta))
            .await?;
        (
            assistant.content.unwrap_or_default(),
            usage.unwrap_or_default(),
        )
    } else {
        let response = client.send(&request).await?;
        let usage = response.usage.unwrap_or_default();
        let choice = response
            .choices
            .into_iter()
            .next()
            .ok_or_else(|| AppError::Other("LLM returned no choices".into()))?;
        (choice.message.content.unwrap_or_default(), usage)
    };
    if content.trim().is_empty() {
        return Err(AppError::Other(
            "LLM returned an empty response. Try rephrasing your message.".into(),
        ));
    }
    Ok(AgentChatResponse {
        content,
        usage,
        trace: Vec::new(),
    })
}

/// Helper that turns content deltas into Tauri `agent_chat_delta` events
/// keyed by `request_id`. Emits nothing when no request id was supplied
/// (callers that don't want streaming just pass `None`).
struct StreamEmitter<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
    request_id: Option<String>,
}

impl<R: tauri::Runtime> StreamEmitter<R> {
    fn new(app: tauri::AppHandle<R>, request_id: Option<String>) -> Self {
        Self { app, request_id }
    }

    fn emit(&self, delta: &str) {
        let Some(id) = self.request_id.as_deref() else {
            return;
        };
        // Best-effort: drop failures silently so a busted emit channel
        // doesn't kill the streaming chat.
        let _ = tauri::Emitter::emit(
            &self.app,
            "agent_chat_delta",
            serde_json::json!({ "request_id": id, "delta": delta }),
        );
    }
}

/// Result of approving and executing a pending mutation from the chat
/// approval card. Mirrors the explorer's `QueryResult` but drops the
/// row payload — the chat just needs the affected-row count.
#[derive(Debug, Serialize)]
pub struct ChatMutationResult {
    pub rows_affected: u64,
    pub kind: String,
}

/// Execute a SQL statement that the chat agent previously proposed and
/// the user just approved in the inline confirmation card. Re-runs the
/// safety classifier so a tampered payload still hits the safety net
/// (the executed kind is reported back so the UI can render it).
#[tauri::command]
pub async fn agent_execute_pending_mutation(
    state: tauri::State<'_, AppState>,
    connection_session_id: String,
    sql: String,
) -> AppResult<ChatMutationResult> {
    if sql.trim().is_empty() {
        return Err(AppError::Other("empty SQL".into()));
    }
    let analysis = crate::db::sql_safety::analyze(&sql);
    if analysis.statements.is_empty() {
        return Err(AppError::Other("could not parse SQL".into()));
    }
    if analysis.statements.len() > 1 {
        return Err(AppError::Other(
            "approval covers a single statement; the payload had a `;` batch".into(),
        ));
    }
    let kind = analysis.statements[0].kind;
    if kind == crate::db::sql_safety::StatementKind::Select {
        return Err(AppError::Other(
            "this command is for mutations; SELECTs run inline through the agent".into(),
        ));
    }

    let session = session_for(&state, &connection_session_id)?;
    let result = session.execute(&sql).await?;
    // DDL invalidates the cached schema; do it for any non-SELECT to
    // keep the cache aligned (cheap — next tool call re-introspects).
    if let Ok(mut cache) = state.schema_cache.lock() {
        cache.remove(&connection_session_id);
    }
    Ok(ChatMutationResult {
        rows_affected: result.rows_affected,
        kind: format!("{:?}", kind).to_lowercase(),
    })
}

/// Ask the LLM for a 3-6 word title that summarizes the conversation
/// so far. Uses a tiny, deterministic completion (no tools, low
/// temperature). Failures are surfaced — the frontend can fall back to
/// the heuristic title it already has.
#[tauri::command]
pub async fn agent_generate_title<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    history: Vec<ChatTurn>,
) -> AppResult<String> {
    let user_turns: Vec<&ChatTurn> = history
        .iter()
        .filter(|t| matches!(t.role.as_str(), "user" | "assistant"))
        .collect();
    if user_turns.is_empty() {
        return Err(AppError::Other("history is empty".into()));
    }

    let cfg = settings::load(&app)?.llm;
    if cfg.base_url.trim().is_empty() || cfg.model.trim().is_empty() {
        return Err(AppError::Other("LLM is not configured.".into()));
    }
    let api_key = settings::get_secret(&app, LLM_API_KEY_ACCOUNT)?;
    if api_key.trim().is_empty() {
        return Err(AppError::Other("LLM API key is not configured.".into()));
    }

    let mut messages = vec![ChatMessage::system(
        "You write very short titles (3 to 6 words) summarizing what a user is \
         asking a database assistant about. Respond with the title text only — \
         no quotes, no punctuation at the end, no prefix like 'Title:'. Match the \
         language of the user.",
    )];
    // Cap the history we send: a few turns is plenty for a title and
    // keeps the call cheap.
    for turn in user_turns.iter().take(6) {
        let role = if turn.role == "assistant" {
            Role::Assistant
        } else {
            Role::User
        };
        messages.push(ChatMessage {
            role,
            content: Some(turn.content.clone()),
            tool_calls: Vec::new(),
            tool_call_id: None,
            name: None,
        });
    }
    messages.push(ChatMessage::user("Reply with the title only, 3-6 words."));

    let client = ChatClient::new(&cfg.base_url, &api_key);
    let request = ChatRequest {
        model: cfg.model.clone(),
        messages,
        temperature: Some(0.2),
        tools: Vec::new(),
    };
    let response = client.send(&request).await?;
    let content = response
        .choices
        .into_iter()
        .next()
        .and_then(|c| c.message.content)
        .unwrap_or_default();
    let title = clean_title(&content);
    if title.is_empty() {
        return Err(AppError::Other("LLM returned an empty title".into()));
    }
    Ok(title)
}

/// Trim noise the model often adds around a title: surrounding quotes,
/// trailing punctuation, and stray "Title:" prefixes.
fn clean_title(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    // Strip a "Title:" / "Título:" prefix the model sometimes adds.
    for prefix in [
        "Title:", "title:", "Título:", "título:", "Titulo:", "titulo:",
    ] {
        if let Some(rest) = s.strip_prefix(prefix) {
            s = rest.trim().to_string();
        }
    }
    // Drop wrapping quotes.
    let bytes = s.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0] as char;
        let last = bytes[bytes.len() - 1] as char;
        if matches!(first, '"' | '\'' | '`' | '“' | '‘')
            && matches!(last, '"' | '\'' | '`' | '”' | '’')
        {
            s = s[1..s.len() - 1].trim().to_string();
        }
    }
    // Trim trailing punctuation.
    while let Some(c) = s.chars().last() {
        if matches!(c, '.' | ',' | '!' | '?' | ';' | ':') {
            s.pop();
            s = s.trim_end().to_string();
        } else {
            break;
        }
    }
    // Collapse whitespace + cap length.
    let collapsed: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > 80 {
        collapsed.chars().take(80).collect()
    } else {
        collapsed
    }
}

/// Snapshot the session's natural-language query history, newest first.
#[tauri::command]
pub fn nl_query_history(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> AppResult<Vec<NlHistoryEntry>> {
    Ok(state.nl_history_snapshot(&session_id))
}

/// Current unix timestamp in seconds. Falls back to `0` on the
/// vanishingly rare case where the system clock is before the epoch.
fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Findings returned by [`analyze_query_plan`]. Bundles the raw plans
/// (so the UI can render the visual tree without re-running EXPLAIN) and
/// the LLM's structured optimisation report.
#[derive(Debug, Serialize)]
pub struct QueryAnalysis {
    /// Free-text summary in the user's language.
    pub summary: String,
    pub bottlenecks: Vec<Bottleneck>,
    pub index_suggestions: Vec<IndexSuggestion>,
    /// Rewritten SQL with equivalent semantics. `None` when the model
    /// did not find a worthwhile rewrite.
    pub optimized_sql: Option<String>,
    /// Plain-text bullet points describing the rewrite, when the model
    /// supplied one.
    pub rewrites: Vec<String>,
    /// LLM's claimed speed-up factor (e.g. `5.0` for 5×). Falls back to
    /// the cost ratio when both plans were captured.
    pub estimated_gain_factor: Option<f64>,
    /// Raw `EXPLAIN [ANALYZE] (FORMAT JSON)` for the original SQL.
    pub original_plan: String,
    /// `EXPLAIN (FORMAT JSON)` of the rewritten SQL — `None` when the
    /// LLM did not rewrite or the planner refused.
    pub optimized_plan: Option<String>,
    pub original_total_cost: Option<f64>,
    pub optimized_total_cost: Option<f64>,
    /// `Execution Time` from ANALYZE on the original plan, when present.
    pub original_execution_ms: Option<f64>,
    pub usage: TokenUsage,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Bottleneck {
    pub node: String,
    pub issue: String,
    /// `high` | `medium` | `low`.
    pub severity: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct IndexSuggestion {
    /// Full DDL the user can copy and run.
    pub sql: String,
    pub rationale: String,
    pub table: String,
    pub columns: Vec<String>,
}

/// What the LLM is asked to emit. Mirrors the public [`QueryAnalysis`]
/// fields it controls.
#[derive(Debug, Deserialize)]
struct LlmAnalysis {
    #[serde(default)]
    summary: String,
    #[serde(default)]
    bottlenecks: Vec<Bottleneck>,
    #[serde(default, alias = "indexes")]
    index_suggestions: Vec<IndexSuggestion>,
    #[serde(default)]
    optimized_sql: Option<String>,
    #[serde(default)]
    rewrites: Vec<String>,
    #[serde(default)]
    estimated_gain_factor: Option<f64>,
}

/// Run EXPLAIN (ANALYZE for SELECT, plain otherwise), ask the LLM to
/// audit the plan against the connection's schema, and return structured
/// findings: bottlenecks, suggested indexes, rewritten SQL, estimated
/// gain. The original and rewritten plans are returned verbatim so the
/// UI can render a before/after visual without a round-trip.
#[tauri::command]
pub async fn analyze_query_plan<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, AppState>,
    session_id: String,
    sql: String,
) -> AppResult<QueryAnalysis> {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    if trimmed.is_empty() {
        return Err(AppError::Other("empty SQL".into()));
    }

    // LLM gate — fail fast with a clear message rather than running
    // EXPLAIN ANALYZE first and then discovering we can't analyse it.
    let cfg = settings::load(&app)?.llm;
    if cfg.base_url.trim().is_empty() || cfg.model.trim().is_empty() {
        return Err(AppError::Other(
            "LLM is not configured — set base URL and model in Settings.".into(),
        ));
    }
    let api_key = settings::get_secret(&app, LLM_API_KEY_ACCOUNT)?;
    if api_key.trim().is_empty() {
        return Err(AppError::Other(
            "LLM API key is not configured — set it in Settings.".into(),
        ));
    }

    let session = session_for(&state, &session_id)?;
    let schema = get_database_schema(state.clone(), session_id.clone()).await?;

    let stmt_analysis = crate::db::sql_safety::analyze(trimmed);
    let is_select = stmt_analysis
        .statements
        .first()
        .map(|s| matches!(s.kind, crate::db::sql_safety::StatementKind::Select))
        .unwrap_or(false);
    let analyze_opts = if is_select {
        "ANALYZE true, VERBOSE false, COSTS true, BUFFERS true, FORMAT JSON"
    } else {
        "ANALYZE false, VERBOSE false, COSTS true, FORMAT JSON"
    };
    let explain_sql = format!("EXPLAIN ({analyze_opts}) {trimmed}");
    let plan_result = session.execute(&explain_sql).await?;
    let original_plan = plan_result
        .rows
        .first()
        .and_then(|r| r.first())
        .and_then(|c| c.as_ref())
        .ok_or_else(|| AppError::Other("EXPLAIN returned no rows".into()))?
        .clone();

    let (original_total_cost, original_execution_ms) = plan_summary(&original_plan);

    // Slice the schema down to the tables this plan actually touches so
    // the LLM context stays small. Falls back to "all user tables" only
    // when the plan referenced nothing recognisable (very unusual).
    let referenced = collect_referenced_relations(&original_plan);
    let schema_snippet = format_schema_for_tables(&schema, &referenced);

    let user_prompt = build_analysis_prompt(
        trimmed,
        &original_plan,
        &schema_snippet,
        original_execution_ms,
        original_total_cost,
        is_select,
    );

    let client = ChatClient::new(&cfg.base_url, &api_key);
    let request = ChatRequest {
        model: cfg.model.clone(),
        messages: vec![
            ChatMessage::system(analysis_system_prompt()),
            ChatMessage::user(user_prompt),
        ],
        temperature: Some(0.1),
        tools: Vec::new(),
    };
    let response = client.send(&request).await?;
    let usage = response.usage.clone().unwrap_or_default();
    let raw_content = response
        .choices
        .into_iter()
        .next()
        .and_then(|c| c.message.content)
        .unwrap_or_default();
    let llm: LlmAnalysis = parse_analysis_json(&raw_content)
        .ok_or_else(|| AppError::Other("LLM did not return parseable JSON".into()))?;

    // EXPLAIN the rewritten SQL to back the comparison with hard numbers
    // — never with ANALYZE, since the user may not want to run the
    // rewrite against live data yet.
    let (optimized_plan, optimized_total_cost) = match llm.optimized_sql.as_ref() {
        Some(opt) if !opt.trim().is_empty() => {
            let opt_trim = opt.trim().trim_end_matches(';').trim();
            let opt_sql = format!("EXPLAIN (FORMAT JSON) {opt_trim}");
            match session.execute(&opt_sql).await {
                Ok(r) => {
                    let plan = r
                        .rows
                        .first()
                        .and_then(|row| row.first())
                        .and_then(|c| c.as_ref())
                        .cloned();
                    let cost = plan.as_deref().and_then(|p| plan_summary(p).0);
                    (plan, cost)
                }
                Err(_) => (None, None),
            }
        }
        _ => (None, None),
    };

    let estimated_gain_factor =
        llm.estimated_gain_factor
            .or_else(|| match (original_total_cost, optimized_total_cost) {
                (Some(o), Some(n)) if n > 0.0 => Some(o / n),
                _ => None,
            });

    Ok(QueryAnalysis {
        summary: llm.summary,
        bottlenecks: llm.bottlenecks,
        index_suggestions: llm.index_suggestions,
        optimized_sql: llm.optimized_sql,
        rewrites: llm.rewrites,
        estimated_gain_factor,
        original_plan,
        optimized_plan,
        original_total_cost,
        optimized_total_cost,
        original_execution_ms,
        usage,
    })
}

fn analysis_system_prompt() -> &'static str {
    "You are a senior PostgreSQL query optimiser. Given the EXPLAIN (often \
     EXPLAIN ANALYZE) of a query plus the relevant schema, you return a \
     STRICT JSON object — no prose, no markdown, no code fences — with the \
     following shape and field names exactly:\n\
     {\n  \
       \"summary\": \"short paragraph explaining what the plan does and where it hurts\",\n  \
       \"bottlenecks\": [ { \"node\": \"Seq Scan on public.orders\", \"issue\": \"why it's slow\", \"severity\": \"high|medium|low\" } ],\n  \
       \"index_suggestions\": [ { \"sql\": \"CREATE INDEX CONCURRENTLY ...\", \"rationale\": \"...\", \"table\": \"public.orders\", \"columns\": [\"customer_id\",\"created_at\"] } ],\n  \
       \"optimized_sql\": \"SELECT ... ; or null if no rewrite helps\",\n  \
       \"rewrites\": [\"bullet describing each rewrite step\"],\n  \
       \"estimated_gain_factor\": 5.0\n\
     }\n\n\
     Rules:\n\
     - Only propose indexes that the schema permits — never invent columns.\n\
     - Prefer composite indexes in the right column order, and `CREATE INDEX CONCURRENTLY` for tables.\n\
     - Skip suggesting indexes that already exist according to the schema.\n\
     - Rewrites must preserve query semantics. If you can't safely rewrite, set optimized_sql to null and rewrites to [].\n\
     - estimated_gain_factor is a multiplier (2.0 == 2× faster). Use null when uncertain.\n\
     - Match the user's language in summary, issue and rationale fields.\n\
     - Output JSON only."
}

fn build_analysis_prompt(
    sql: &str,
    plan: &str,
    schema: &str,
    exec_ms: Option<f64>,
    total_cost: Option<f64>,
    analyze_ran: bool,
) -> String {
    let mut out = String::new();
    out.push_str("Original SQL:\n```sql\n");
    out.push_str(sql);
    out.push_str("\n```\n\n");
    if analyze_ran {
        out.push_str("Plan was produced with EXPLAIN ANALYZE — `Actual Time` and `Actual Rows` reflect a real run.\n");
    } else {
        out.push_str(
            "Plan was produced with EXPLAIN (no ANALYZE) — only planner estimates are available.\n",
        );
    }
    if let Some(c) = total_cost {
        out.push_str(&format!("Planner total cost: {c:.2}\n"));
    }
    if let Some(t) = exec_ms {
        out.push_str(&format!("Measured execution time: {t:.2} ms\n"));
    }
    out.push_str("\nPlan (EXPLAIN FORMAT JSON):\n```json\n");
    out.push_str(plan);
    out.push_str("\n```\n\nRelevant schema:\n");
    out.push_str(schema);
    out.push_str("\n\nReturn the JSON analysis now.");
    out
}

/// Walk an EXPLAIN JSON tree and collect every `(schema?, relation)`
/// pair it references. Skips nodes that don't touch a base relation
/// (hash, sort, aggregate, ...).
fn collect_referenced_relations(plan_json: &str) -> Vec<(Option<String>, String)> {
    let mut out: Vec<(Option<String>, String)> = Vec::new();
    let Ok(value) = serde_json::from_str::<serde_json::Value>(plan_json) else {
        return out;
    };
    let root_plan = value
        .as_array()
        .and_then(|a| a.first())
        .and_then(|o| o.get("Plan"));
    if let Some(p) = root_plan {
        walk_plan(p, &mut out);
    }
    out.sort();
    out.dedup();
    out
}

fn walk_plan(node: &serde_json::Value, out: &mut Vec<(Option<String>, String)>) {
    if let Some(name) = node.get("Relation Name").and_then(|v| v.as_str()) {
        let schema = node
            .get("Schema")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        out.push((schema, name.to_string()));
    }
    if let Some(children) = node.get("Plans").and_then(|v| v.as_array()) {
        for c in children {
            walk_plan(c, out);
        }
    }
    if let Some(sub) = node.get("Subplan Name") {
        if let Some(plans) = sub.get("Plans").and_then(|v| v.as_array()) {
            for c in plans {
                walk_plan(c, out);
            }
        }
    }
}

/// Compact, model-friendly view of the tables that appear in the plan:
/// names, types, primary keys, foreign keys and existing indexes (the
/// latter so the model doesn't suggest indexes that are already there).
fn format_schema_for_tables(
    schema: &DatabaseSchema,
    referenced: &[(Option<String>, String)],
) -> String {
    let mut out = String::new();
    let mut wrote = false;
    for table in &schema.tables {
        let matches = referenced.iter().any(|(s, n)| {
            n == &table.name && s.as_deref().map(|x| x == table.schema).unwrap_or(true)
        });
        if !matches && !referenced.is_empty() {
            continue;
        }
        wrote = true;
        out.push_str(&format!("- {}.{}", table.schema, table.name));
        if !table.primary_key.is_empty() {
            out.push_str(&format!("  PK({})", table.primary_key.join(", ")));
        }
        out.push('\n');
        for col in &table.columns {
            out.push_str(&format!("    {} {}", col.name, col.data_type));
            if !col.nullable {
                out.push_str(" NOT NULL");
            }
            if let Some(c) = col.comment.as_deref() {
                out.push_str(&format!("  -- {c}"));
            }
            out.push('\n');
        }
        for fk in &table.foreign_keys {
            out.push_str(&format!(
                "    FK({}) -> {}.{}({})\n",
                fk.columns.join(", "),
                fk.ref_schema,
                fk.ref_table,
                fk.ref_columns.join(", ")
            ));
        }
    }
    if !wrote {
        out.push_str("(no matching tables in cached schema)\n");
    }
    out
}

fn plan_summary(plan_json: &str) -> (Option<f64>, Option<f64>) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(plan_json) else {
        return (None, None);
    };
    let root = value.as_array().and_then(|a| a.first());
    let total_cost = root
        .and_then(|o| o.get("Plan"))
        .and_then(|p| p.get("Total Cost"))
        .and_then(|v| v.as_f64());
    let exec_ms = root
        .and_then(|o| o.get("Execution Time"))
        .and_then(|v| v.as_f64());
    (total_cost, exec_ms)
}

/// Parse the LLM's response, recovering from code fences and from a
/// preamble of explanation text the model sometimes adds despite the
/// instructions.
fn parse_analysis_json(raw: &str) -> Option<LlmAnalysis> {
    let stripped = strip_fence(raw.trim());
    if let Ok(parsed) = serde_json::from_str::<LlmAnalysis>(stripped.trim()) {
        return Some(parsed);
    }
    let inner = extract_first_json_object(&stripped)?;
    serde_json::from_str::<LlmAnalysis>(&inner).ok()
}

fn strip_fence(s: &str) -> String {
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

/// Best-effort fallback when the LLM reports `not_found` without
/// proposing alternatives. Pulls candidate tokens from the reason and
/// matches them against table names in the cached schema.
fn fallback_suggestions(schema: &DatabaseSchema, reason: Option<&str>) -> Vec<String> {
    let reason = match reason {
        Some(r) if !r.is_empty() => r,
        _ => return Vec::new(),
    };
    let tokens = fuzzy::extract_tokens(reason);
    fuzzy::nearest_table_names(schema, &tokens, 3)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::connections::test_utils::EnvSandbox;
    use crate::commands::settings::{save_llm_config, LlmConfigInput};
    use crate::db::driver::{
        CellValue, ConnectionConfig, DatabaseKind, DatabaseSchema, OrderBy, QueryResult,
        RelationKind, RowFilter, SchemaInfo, TableDetails, TableInfo, TableSchema,
    };
    use crate::settings;
    use async_trait::async_trait;
    use std::sync::Mutex;
    use tauri::Manager;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Fake driver — only `execute` and `introspect_schema` are
    /// exercised. All other trait methods delegate to a one-line "empty"
    /// result to keep test code small and the file's coverage healthy.
    #[derive(Default)]
    struct FakeDriver {
        executed: Mutex<Vec<String>>,
    }

    fn empty_result() -> QueryResult {
        QueryResult {
            columns: vec![],
            rows: vec![],
            rows_affected: 0,
        }
    }

    #[async_trait]
    impl crate::db::DatabaseDriver for FakeDriver {
        fn kind(&self) -> DatabaseKind {
            DatabaseKind::Postgres
        }
        async fn connect(&mut self, _: &ConnectionConfig) -> AppResult<()> {
            Ok(())
        }
        async fn ping(&self) -> AppResult<()> {
            Ok(())
        }
        async fn list_schemas(&self) -> AppResult<Vec<SchemaInfo>> {
            Ok(vec![])
        }
        async fn list_tables(&self, _: &str) -> AppResult<Vec<TableInfo>> {
            Ok(vec![])
        }
        async fn describe_table(&self, _: &str, _: &str) -> AppResult<TableDetails> {
            Ok(TableDetails {
                columns: vec![],
                indexes: vec![],
            })
        }
        async fn introspect_schema(&self) -> AppResult<DatabaseSchema> {
            Ok(DatabaseSchema {
                tables: vec![TableSchema {
                    schema: "public".into(),
                    name: "users".into(),
                    kind: RelationKind::Table,
                    comment: None,
                    columns: vec![ColumnSchema {
                        name: "id".into(),
                        data_type: "int4".into(),
                        nullable: false,
                        default: None,
                        is_primary_key: true,
                        comment: None,
                    }],
                    primary_key: vec!["id".into()],
                    foreign_keys: vec![],
                }],
            })
        }
        async fn execute(&self, sql: &str) -> AppResult<QueryResult> {
            self.executed.lock().unwrap().push(sql.to_string());
            Ok(QueryResult {
                columns: vec!["id".into()],
                rows: vec![vec![Some("1".into())]],
                rows_affected: 1,
            })
        }
        async fn browse_table(
            &self,
            _: &str,
            _: &str,
            _: Option<&RowFilter>,
            _: Option<&OrderBy>,
            _: i64,
            _: i64,
        ) -> AppResult<QueryResult> {
            Ok(empty_result())
        }
        async fn update_row(
            &self,
            _: &str,
            _: &str,
            _: &[CellValue],
            _: &[CellValue],
        ) -> AppResult<QueryResult> {
            Ok(empty_result())
        }
        async fn insert_row(&self, _: &str, _: &str, _: &[CellValue]) -> AppResult<QueryResult> {
            Ok(empty_result())
        }
        async fn delete_row(&self, _: &str, _: &str, _: &[CellValue]) -> AppResult<QueryResult> {
            Ok(empty_result())
        }
        fn query_history(&self) -> Vec<String> {
            vec![]
        }
        async fn disconnect(&mut self) -> AppResult<()> {
            Ok(())
        }
        async fn copy_table_to_file(
            &self,
            _schema: &str,
            _table: &str,
            _format: crate::db::driver::ExportFormat,
            _path: &std::path::Path,
        ) -> AppResult<u64> {
            Ok(0)
        }
    }

    use crate::db::driver::ColumnSchema;

    fn mock_app_with_session(id: &str) -> tauri::App<tauri::test::MockRuntime> {
        let state = AppState::default();
        state
            .sessions
            .lock()
            .unwrap()
            .insert(id.into(), Arc::new(FakeDriver::default()));
        tauri::test::mock_builder()
            .manage(state)
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app")
    }

    fn mock_app_without_session() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .manage(AppState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app")
    }

    async fn write_llm_config<R: tauri::Runtime>(
        app: &tauri::AppHandle<R>,
        base_url: &str,
        api_key: &str,
    ) {
        save_llm_config(
            app.clone(),
            LlmConfigInput {
                provider: "openai".into(),
                base_url: base_url.into(),
                model: "gpt-test".into(),
                temperature: 0.0,
                api_key: api_key.into(),
            },
        )
        .unwrap();
    }

    #[cfg(feature = "mock-keyring")]
    #[tokio::test]
    async fn generate_sql_rejects_empty_instruction() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app_with_session("s");
        let err = generate_sql(
            app.handle().clone(),
            app.state::<AppState>(),
            "s".into(),
            "   ".into(),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("instruction is empty"));
    }

    #[cfg(feature = "mock-keyring")]
    #[tokio::test]
    async fn generate_sql_errors_when_llm_not_configured() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app_with_session("s");
        let err = generate_sql(
            app.handle().clone(),
            app.state::<AppState>(),
            "s".into(),
            "list users".into(),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("LLM is not configured"));
    }

    #[cfg(feature = "mock-keyring")]
    #[tokio::test]
    async fn generate_sql_errors_when_api_key_missing() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app_with_session("s");
        // Save config but with an empty API key.
        let server = MockServer::start().await; // unused but ensures base url is well-formed
        write_llm_config(app.handle(), &format!("{}/v1", server.uri()), "key").await;
        // Wipe the key after saving (simulates the user clearing it).
        settings::set_secret(app.handle(), LLM_API_KEY_ACCOUNT, "").unwrap();

        let err = generate_sql(
            app.handle().clone(),
            app.state::<AppState>(),
            "s".into(),
            "list users".into(),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("API key is not configured"));
    }

    #[cfg(feature = "mock-keyring")]
    #[tokio::test]
    async fn generate_sql_errors_when_session_unknown() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app_with_session("s");
        let server = MockServer::start().await;
        write_llm_config(app.handle(), &format!("{}/v1", server.uri()), "sk").await;

        let err = generate_sql(
            app.handle().clone(),
            app.state::<AppState>(),
            "ghost".into(),
            "anything".into(),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("session not found"));
    }

    #[cfg(feature = "mock-keyring")]
    #[tokio::test]
    async fn generate_sql_returns_final_answer_on_single_turn() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app_with_session("s");

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": "{\"status\":\"need_info\",\"reason\":\"specify date range\"}"
                    },
                    "finish_reason": "stop"
                }]
            })))
            .mount(&server)
            .await;

        write_llm_config(app.handle(), &format!("{}/v1", server.uri()), "sk").await;

        let out = generate_sql(
            app.handle().clone(),
            app.state::<AppState>(),
            "s".into(),
            "users".into(),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(out.status, agent::AgentStatus::NeedInfo);
        assert_eq!(out.reason.as_deref(), Some("specify date range"));
        assert!(out.sql.is_none());
    }

    #[cfg(feature = "mock-keyring")]
    #[tokio::test]
    async fn generate_sql_records_history_and_nl_query_history_returns_it() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app_with_session("s");

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": "{\"status\":\"ok\",\"sql\":\"SELECT 1\"}"
                    },
                    "finish_reason": "stop"
                }],
                "usage": {"prompt_tokens": 12, "completion_tokens": 4, "total_tokens": 16}
            })))
            .mount(&server)
            .await;

        write_llm_config(app.handle(), &format!("{}/v1", server.uri()), "sk").await;

        // Two requests → two history entries, newest first.
        for q in ["primeira", "segunda"] {
            generate_sql(
                app.handle().clone(),
                app.state::<AppState>(),
                "s".into(),
                q.into(),
                None,
                None,
            )
            .await
            .unwrap();
        }

        let history = nl_query_history(app.state::<AppState>(), "s".into()).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].instruction, "segunda");
        assert_eq!(history[1].instruction, "primeira");
        // Token usage propagates into the history entry.
        assert_eq!(history[0].output.usage.total_tokens, 16);
        assert_eq!(history[0].output.sql.as_deref(), Some("SELECT 1"));
    }

    #[test]
    fn nl_query_history_empty_for_unknown_session() {
        let app = tauri::test::mock_builder()
            .manage(AppState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let out = nl_query_history(app.state::<AppState>(), "missing".into()).unwrap();
        assert!(out.is_empty());
    }

    #[cfg(feature = "mock-keyring")]
    #[tokio::test]
    async fn generate_sql_falls_back_to_fuzzy_suggestions_on_not_found() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app_with_session("s");

        let server = MockServer::start().await;
        // Single-turn: model emits not_found WITHOUT suggestions.
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": "{\"status\":\"not_found\",\"reason\":\"tabela usuarios não encontrada\"}"
                    },
                    "finish_reason": "stop"
                }]
            })))
            .mount(&server)
            .await;

        write_llm_config(app.handle(), &format!("{}/v1", server.uri()), "sk").await;

        let out = generate_sql(
            app.handle().clone(),
            app.state::<AppState>(),
            "s".into(),
            "usuarios cadastrados".into(),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(out.status, agent::AgentStatus::NotFound);
        // Schema has a `users` table; fuzzy fallback proposed it.
        assert!(out.suggestions.iter().any(|s| s == "public.users"));
    }

    #[test]
    fn fallback_suggestions_returns_empty_without_reason() {
        let schema = DatabaseSchema {
            tables: vec![TableSchema {
                schema: "public".into(),
                name: "users".into(),
                kind: RelationKind::Table,
                comment: None,
                columns: vec![],
                primary_key: vec![],
                foreign_keys: vec![],
            }],
        };
        assert!(super::fallback_suggestions(&schema, None).is_empty());
        assert!(super::fallback_suggestions(&schema, Some("")).is_empty());
    }

    #[cfg(feature = "mock-keyring")]
    #[tokio::test]
    async fn generate_sql_runs_tool_then_returns_final_sql() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app_with_session("s");

        let server = MockServer::start().await;

        // First model turn: ask the host to call `list_tables`.
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "tool_calls": [{
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "list_tables",
                                "arguments": "{}"
                            }
                        }]
                    },
                    "finish_reason": "tool_calls"
                }]
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;

        // Second model turn: emit the final JSON answer.
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": "{\"status\":\"ok\",\"sql\":\"SELECT * FROM public.users\"}"
                    },
                    "finish_reason": "stop"
                }]
            })))
            .mount(&server)
            .await;

        write_llm_config(app.handle(), &format!("{}/v1", server.uri()), "sk").await;

        let out = generate_sql(
            app.handle().clone(),
            app.state::<AppState>(),
            "s".into(),
            "list every user".into(),
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(out.status, agent::AgentStatus::Ok);
        assert_eq!(out.sql.as_deref(), Some("SELECT * FROM public.users"));
        // Trace records: tool call → tool result → final assistant msg.
        assert!(out.trace.iter().any(|e| matches!(
            e,
            agent::TraceEvent::ToolCall { name, .. } if name == "list_tables"
        )));
        assert!(out.trace.iter().any(|e| matches!(
            e,
            agent::TraceEvent::ToolResult { name, ok: true, .. } if name == "list_tables"
        )));
        assert!(out
            .trace
            .iter()
            .any(|e| matches!(e, agent::TraceEvent::AssistantMessage { .. })));
    }

    #[test]
    fn clean_title_strips_prefix_quotes_and_punctuation() {
        let cleaned = clean_title("Title: \"Relatorio de vendas.\"");
        assert_eq!(cleaned, "Relatorio de vendas");
    }

    #[test]
    fn clean_title_truncates_very_long_outputs() {
        let long = "a".repeat(120);
        let cleaned = clean_title(&long);
        assert_eq!(cleaned.len(), 80);
    }

    #[test]
    fn now_seconds_is_never_negative() {
        assert!(now_seconds() >= 0);
    }

    #[test]
    fn conversational_prompts_include_expected_guidance() {
        let unbound = conversational_system_prompt();
        assert!(unbound.contains("open a connection tab"));
        let bound = conversational_system_prompt_with_tools();
        assert!(bound.contains("run_write"));
        assert!(bound.contains("needs_approval"));
    }

    #[cfg(feature = "mock-keyring")]
    #[tokio::test]
    async fn agent_chat_send_unbound_rejects_empty_instruction() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app_without_session();
        let err = agent_chat_send(
            app.handle().clone(),
            app.state::<AppState>(),
            vec![],
            "   ".into(),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("instruction is empty"));
    }

    #[cfg(feature = "mock-keyring")]
    #[tokio::test]
    async fn agent_chat_send_unbound_returns_content_and_no_trace() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app_without_session();
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{
                    "message": {"role":"assistant", "content":"Resposta final"},
                    "finish_reason": "stop"
                }],
                "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}
            })))
            .mount(&server)
            .await;

        write_llm_config(app.handle(), &format!("{}/v1", server.uri()), "sk").await;

        let out = agent_chat_send(
            app.handle().clone(),
            app.state::<AppState>(),
            vec![
                ChatTurn {
                    role: "tool".into(),
                    content: "skip".into(),
                },
                ChatTurn {
                    role: "user".into(),
                    content: "oi".into(),
                },
            ],
            "resuma".into(),
            None,
            Some("  ".into()),
            Some(5.0),
            None,
        )
        .await
        .unwrap();

        assert_eq!(out.content, "Resposta final");
        assert!(out.trace.is_empty());
        assert_eq!(out.usage.total_tokens, 5);
    }

    #[cfg(feature = "mock-keyring")]
    #[tokio::test]
    async fn agent_chat_send_unbound_errors_when_provider_returns_no_choices_or_empty_content() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app_without_session();
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": []
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{
                    "message": {"role":"assistant", "content":"   "},
                    "finish_reason":"stop"
                }]
            })))
            .mount(&server)
            .await;

        write_llm_config(app.handle(), &format!("{}/v1", server.uri()), "sk").await;

        let err = agent_chat_send(
            app.handle().clone(),
            app.state::<AppState>(),
            vec![],
            "q1".into(),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("no choices"));

        let err = agent_chat_send(
            app.handle().clone(),
            app.state::<AppState>(),
            vec![],
            "q2".into(),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("empty response"));
    }

    #[cfg(feature = "mock-keyring")]
    #[tokio::test]
    async fn agent_chat_send_bound_uses_tools_loop_and_returns_trace() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app_with_session("s");
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{
                    "message": {
                        "role":"assistant",
                        "tool_calls": [{
                            "id":"call_1",
                            "type":"function",
                            "function":{"name":"list_tables","arguments":"{}"}
                        }]
                    },
                    "finish_reason":"tool_calls"
                }]
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{
                    "message": {"role":"assistant", "content":"Use a tabela users"},
                    "finish_reason":"stop"
                }]
            })))
            .mount(&server)
            .await;

        write_llm_config(app.handle(), &format!("{}/v1", server.uri()), "sk").await;

        let out = agent_chat_send(
            app.handle().clone(),
            app.state::<AppState>(),
            vec![],
            "listar usuarios".into(),
            Some("s".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert!(out.content.contains("users"));
        assert!(out.trace.iter().any(
            |e| matches!(e, agent::TraceEvent::ToolCall { name, .. } if name == "list_tables")
        ));
    }

    #[cfg(feature = "mock-keyring")]
    #[tokio::test]
    async fn agent_chat_send_bound_errors_for_unknown_session_and_empty_answer() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app_with_session("s");
        let server = MockServer::start().await;

        write_llm_config(app.handle(), &format!("{}/v1", server.uri()), "sk").await;

        let err = agent_chat_send(
            app.handle().clone(),
            app.state::<AppState>(),
            vec![],
            "x".into(),
            Some("ghost".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("session not found"));

        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{
                    "message": {"role":"assistant", "content":" "},
                    "finish_reason":"stop"
                }]
            })))
            .mount(&server)
            .await;

        let err = agent_chat_send(
            app.handle().clone(),
            app.state::<AppState>(),
            vec![],
            "x".into(),
            Some("s".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("empty response"));
    }

    #[cfg(feature = "mock-keyring")]
    #[tokio::test]
    async fn agent_execute_pending_mutation_validates_and_executes_single_mutation() {
        let app = mock_app_with_session("s");
        let app_state = app.state::<AppState>();
        {
            let mut cache = app_state.schema_cache.lock().unwrap();
            cache.insert(
                "s".into(),
                Arc::new(DatabaseSchema {
                    tables: vec![TableSchema {
                        schema: "public".into(),
                        name: "x".into(),
                        kind: RelationKind::Table,
                        comment: None,
                        columns: vec![],
                        primary_key: vec![],
                        foreign_keys: vec![],
                    }],
                }),
            );
        }

        let err = agent_execute_pending_mutation(app_state.clone(), "s".into(), "".into())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("empty SQL"));

        let err = agent_execute_pending_mutation(app_state.clone(), "s".into(), "SELECT 1".into())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("for mutations"));

        let err = agent_execute_pending_mutation(
            app_state.clone(),
            "s".into(),
            "UPDATE t SET x=1; UPDATE t SET x=2".into(),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("single statement"));

        let out = agent_execute_pending_mutation(
            app_state.clone(),
            "s".into(),
            "UPDATE public.users SET id = 2 WHERE id = 1".into(),
        )
        .await
        .unwrap();
        assert_eq!(out.rows_affected, 1);
        assert_eq!(out.kind, "update");
        assert!(app_state.schema_cache.lock().unwrap().get("s").is_none());
    }

    #[cfg(feature = "mock-keyring")]
    #[tokio::test]
    async fn agent_generate_title_handles_success_and_errors() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app_without_session();

        let err = agent_generate_title(app.handle().clone(), vec![])
            .await
            .unwrap_err();
        assert!(err.to_string().contains("history is empty"));

        let server = MockServer::start().await;
        write_llm_config(app.handle(), &format!("{}/v1", server.uri()), "sk").await;

        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{
                    "message": {"role":"assistant", "content":"Title: \"Analise de vendas.\""},
                    "finish_reason":"stop"
                }]
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{
                    "message": {"role":"assistant", "content":"   "},
                    "finish_reason":"stop"
                }]
            })))
            .mount(&server)
            .await;

        let ok = agent_generate_title(
            app.handle().clone(),
            vec![ChatTurn {
                role: "user".into(),
                content: "me mostre vendas por mes".into(),
            }],
        )
        .await
        .unwrap();
        assert_eq!(ok, "Analise de vendas");

        let err = agent_generate_title(
            app.handle().clone(),
            vec![ChatTurn {
                role: "assistant".into(),
                content: "ok".into(),
            }],
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("empty title"));
    }
}
