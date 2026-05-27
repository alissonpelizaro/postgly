import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { settingsApi } from "@/features/settings/api";

import { agentChatApi, type AgentChatTurn } from "./api";
import { loadStore, saveStore } from "./storage";
import type {
  ChatMessage,
  ChatProposal,
  ChatRole,
  ChatSession,
  ChatStore,
  ChatTraceEvent,
  ProposalKind,
  ProposalStatus,
} from "./types";

function newId(): string {
  return crypto.randomUUID();
}

/** Scan the trace for a `run_write` tool call whose result requested
 *  approval. Returns the most recent unresolved proposal, if any. */
function proposalFromTrace(trace: ChatTraceEvent[]): ChatProposal | undefined {
  for (let i = trace.length - 1; i >= 0; i--) {
    const result = trace[i];
    if (result.kind !== "tool_result") continue;
    if (result.name !== "run_write") continue;
    if (!result.ok) continue;
    const body = result.result as Record<string, unknown> | null;
    if (!body || body.needs_approval !== true) continue;
    const sql = typeof body.sql === "string" ? body.sql : "";
    if (sql.length === 0) continue;
    return {
      sql,
      summary: typeof body.summary === "string" ? body.summary : "",
      kind: (body.kind as ProposalKind) ?? "other",
      preview: typeof body.preview === "string" ? body.preview : sql,
      destructive: body.destructive === true,
      unboundedDml: body.unbounded_dml === true,
      hasWhere: body.has_where === true,
      outcome: { status: "pending" },
    };
  }
  return undefined;
}

function deriveTitle(content: string): string {
  const trimmed = content.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return "";
  return trimmed.length > 60 ? `${trimmed.slice(0, 59)}…` : trimmed;
}

function buildMessage(
  role: ChatRole,
  content: string,
  trace?: ChatTraceEvent[],
): ChatMessage {
  const proposal = role === "assistant" && trace ? proposalFromTrace(trace) : undefined;
  return {
    id: newId(),
    role,
    content,
    createdAt: Date.now(),
    ...(trace && trace.length > 0 ? { trace } : {}),
    ...(proposal ? { proposal } : {}),
  };
}

export interface UseAgentChatOptions {
  dbSessionId: string | null;
  connectionLabel: string | null;
}

const MODEL_OVERRIDE_KEY = "postgly-chat-model";

/** Session + message state machine for the agent chat. */
export function useAgentChat(options: UseAgentChatOptions) {
  const { dbSessionId, connectionLabel } = options;
  const [store, setStore] = useState<ChatStore>(() => loadStore());
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Chat-scoped model override. Null = follow the global setting saved
  // in `llm.model`. Persisted across launches.
  const [modelOverride, setModelOverrideState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(MODEL_OVERRIDE_KEY);
    } catch {
      return null;
    }
  });
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  // Track the latest in-flight model probe so a slow earlier response
  // doesn't clobber a fresher one.
  const modelsReqId = useRef(0);

  // Load the default model + available list. The probe hits
  // {base_url}/models so it only runs when the provider is set. Also
  // re-runs whenever the global LLM config is saved (via the
  // `postgly:llm-config-changed` window event) so the chat picker
  // doesn't keep showing a stale default.
  useEffect(() => {
    let cancelled = false;
    const refreshFromSettings = async () => {
      try {
        const view = await settingsApi.get();
        if (cancelled) return;
        setDefaultModel(view.llm.model ?? "");
        if (!view.llm.base_url || !view.llm_api_key_configured) {
          setAvailableModels([]);
          return;
        }
        const id = ++modelsReqId.current;
        setModelsLoading(true);
        try {
          const res = await settingsApi.testLlm({
            provider: view.llm.provider,
            base_url: view.llm.base_url,
            model: view.llm.model,
            temperature: view.llm.temperature,
            api_key: "",
          });
          if (cancelled || id !== modelsReqId.current) return;
          setAvailableModels(res.models);
        } catch {
          // Probe failed — leave the list empty. The UI falls back to
          // showing only the default model.
        } finally {
          if (!cancelled) setModelsLoading(false);
        }
      } catch {
        // Settings store unavailable; nothing to do.
      }
    };

    void refreshFromSettings();
    const onChanged = () => {
      void refreshFromSettings();
    };
    window.addEventListener("postgly:llm-config-changed", onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("postgly:llm-config-changed", onChanged);
    };
  }, []);

  const setModel = useCallback((model: string | null) => {
    try {
      if (model && model.length > 0) {
        localStorage.setItem(MODEL_OVERRIDE_KEY, model);
      } else {
        localStorage.removeItem(MODEL_OVERRIDE_KEY);
      }
    } catch {
      // localStorage unavailable in some webview contexts — best effort.
    }
    setModelOverrideState(model && model.length > 0 ? model : null);
  }, []);
  // The hook's mutators read fresh state via this ref so they don't
  // need `store` in their deps (which would force unnecessary
  // re-renders of every consumer).
  const storeRef = useRef(store);
  useEffect(() => {
    storeRef.current = store;
  }, [store]);

  useEffect(() => {
    saveStore(store);
  }, [store]);

  const activeSession: ChatSession | null = useMemo(() => {
    if (!store.activeId) return null;
    return store.sessions[store.activeId] ?? null;
  }, [store]);

  const sessions: ChatSession[] = useMemo(
    () => store.sessionIds.map((id) => store.sessions[id]).filter(Boolean),
    [store],
  );

  const createSession = useCallback(
    (opts?: { connectionId?: string | null; title?: string }): string => {
      const id = newId();
      const now = Date.now();
      const session: ChatSession = {
        id,
        title: opts?.title ?? "",
        connectionId: opts?.connectionId ?? null,
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      setStore((prev) => ({
        ...prev,
        sessionIds: [id, ...prev.sessionIds],
        sessions: { ...prev.sessions, [id]: session },
        activeId: id,
      }));
      return id;
    },
    [],
  );

  const selectSession = useCallback((id: string | null) => {
    setStore((prev) => {
      if (id !== null && !prev.sessions[id]) return prev;
      return { ...prev, activeId: id };
    });
  }, []);

  const deleteSession = useCallback((id: string) => {
    setStore((prev) => {
      if (!prev.sessions[id]) return prev;
      const sessions = { ...prev.sessions };
      delete sessions[id];
      const sessionIds = prev.sessionIds.filter((x) => x !== id);
      const activeId =
        prev.activeId === id ? (sessionIds[0] ?? null) : prev.activeId;
      return { ...prev, sessions, sessionIds, activeId };
    });
  }, []);

  const renameSession = useCallback((id: string, title: string) => {
    setStore((prev) => {
      const s = prev.sessions[id];
      if (!s) return prev;
      return {
        ...prev,
        // A manual rename locks the title so the auto-summary won't overwrite it.
        sessions: {
          ...prev.sessions,
          [id]: { ...s, title, titleGenerated: true },
        },
      };
    });
  }, []);

  /** Ask the LLM for a 3-6 word title and apply it. No-op when the
   *  title is already finalized or the LLM call fails. Takes the
   *  history snapshot explicitly to avoid races against the state
   *  update that just appended the assistant reply. */
  const autoGenerateTitle = useCallback(
    async (sessionId: string, history: AgentChatTurn[]) => {
      const session = storeRef.current.sessions[sessionId];
      if (!session || session.titleGenerated) return;
      if (history.length === 0) return;
      try {
        const title = await agentChatApi.generateTitle(history);
        if (!title || title.trim().length === 0) return;
        setStore((prev) => {
          const s = prev.sessions[sessionId];
          if (!s || s.titleGenerated) return prev;
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [sessionId]: { ...s, title: title.trim(), titleGenerated: true },
            },
          };
        });
      } catch {
        // Best-effort — the heuristic title (first user message) stays.
      }
    },
    [],
  );

  /** Low-level: replace the messages array of a session (used by edit,
   *  regenerate and retry to drop entries before a re-request). */
  const replaceMessages = useCallback(
    (sessionId: string, next: ChatMessage[]) => {
      setStore((prev) => {
        const s = prev.sessions[sessionId];
        if (!s) return prev;
        return {
          ...prev,
          sessions: {
            ...prev.sessions,
            [sessionId]: { ...s, messages: next, updatedAt: Date.now() },
          },
        };
      });
    },
    [],
  );

  const appendMessage = useCallback(
    (
      sessionId: string,
      role: ChatRole,
      content: string,
      trace?: ChatTraceEvent[],
    ): ChatMessage => {
      const msg = buildMessage(role, content, trace);
      setStore((prev) => {
        const s = prev.sessions[sessionId];
        if (!s) return prev;
        const titleNeeded = s.title.trim() === "" && role === "user";
        const next: ChatSession = {
          ...s,
          title: titleNeeded ? deriveTitle(content) : s.title,
          updatedAt: msg.createdAt,
          messages: [...s.messages, msg],
        };
        const sessionIds = [
          sessionId,
          ...prev.sessionIds.filter((x) => x !== sessionId),
        ];
        return {
          ...prev,
          sessions: { ...prev.sessions, [sessionId]: next },
          sessionIds,
        };
      });
      return msg;
    },
    [],
  );

  /** Apply a streamed text delta to the in-progress assistant message
   *  of a session. One bubble per turn — reasoning paragraphs from the
   *  model are separated by a Markdown horizontal rule (`---`) so the
   *  user can still see each step distinctly without bubble spam. The
   *  raw buffer is kept in a ref so we can re-derive the rendered text
   *  cheaply on each chunk. */
  const streamingBuffers = useRef<
    Map<string, { id: string; raw: string }>
  >(new Map());

  /** Convert a streamed plain-text buffer into the bubble's rendered
   *  Markdown by inserting `---` separators between paragraph breaks. */
  const renderStreamed = (raw: string): string =>
    raw.replace(/\n{2,}/g, "\n\n---\n\n");

  const appendStreamingDelta = useCallback(
    (sessionId: string, delta: string) => {
      if (delta.length === 0) return;
      let state = streamingBuffers.current.get(sessionId);
      if (!state) {
        const id = newId();
        state = { id, raw: delta };
        streamingBuffers.current.set(sessionId, state);
        const placeholder: ChatMessage = {
          id,
          role: "assistant",
          content: renderStreamed(delta),
          createdAt: Date.now(),
        };
        setStore((prev) => {
          const s = prev.sessions[sessionId];
          if (!s) return prev;
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [sessionId]: {
                ...s,
                messages: [...s.messages, placeholder],
                updatedAt: placeholder.createdAt,
              },
            },
          };
        });
        return;
      }
      state.raw += delta;
      const rendered = renderStreamed(state.raw);
      const id = state.id;
      setStore((prev) => {
        const s = prev.sessions[sessionId];
        if (!s) return prev;
        const messages = s.messages.map((m) =>
          m.id === id ? { ...m, content: rendered } : m,
        );
        return {
          ...prev,
          sessions: { ...prev.sessions, [sessionId]: { ...s, messages } },
        };
      });
    },
    [],
  );

  /** Run the agent with an explicit history snapshot (no implicit reads
   *  from state) and append the reply on success. Centralises the
   *  pending/error wiring so every entry point shares the same flow. */
  const requestReply = useCallback(
    async (
      sessionId: string,
      instruction: string,
      historyMessages: ChatMessage[],
    ) => {
      setError(null);
      setPendingSessionId(sessionId);
      const history: AgentChatTurn[] = historyMessages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
      const requestId = newId();
      // Subscribe BEFORE invoking so we don't miss the opening chunks of
      // fast streams. listen() resolves to an unlisten fn.
      const unlistenPromise = listen<{ request_id: string; delta: string }>(
        "agent_chat_delta",
        (event) => {
          if (event.payload.request_id !== requestId) return;
          appendStreamingDelta(sessionId, event.payload.delta);
        },
      );
      try {
        const reply = await agentChatApi.send(history, instruction, {
          connectionSessionId: dbSessionId,
          requestId,
          model: modelOverride ?? undefined,
        });
        // Finalize: keep the streamed reasoning text intact and only
        // attach the trace + proposal to the same bubble. If no stream
        // arrived (rare — backend usually emits deltas) fall back to a
        // plain append with the canonical reply.content.
        const state = streamingBuffers.current.get(sessionId);
        streamingBuffers.current.delete(sessionId);
        if (state) {
          const id = state.id;
          const traceMsg = buildMessage("assistant", "", reply.trace);
          // If reply.content extends past what the stream delivered,
          // splice the missing tail onto the buffer (and let renderStreamed
          // add a separator between reasoning and final answer).
          let raw = state.raw;
          if (
            reply.content.length > raw.length &&
            reply.content.startsWith(raw)
          ) {
            raw = reply.content;
          } else if (
            reply.content.length > 0 &&
            !raw.includes(reply.content.trim())
          ) {
            raw = `${raw.replace(/\s+$/, "")}\n\n${reply.content}`;
          }
          const rendered = renderStreamed(raw);
          setStore((prev) => {
            const s = prev.sessions[sessionId];
            if (!s) return prev;
            const messages = s.messages.map((m) =>
              m.id === id
                ? {
                    ...m,
                    content: rendered,
                    ...(traceMsg.trace ? { trace: traceMsg.trace } : {}),
                    ...(traceMsg.proposal
                      ? { proposal: traceMsg.proposal }
                      : {}),
                  }
                : m,
            );
            return {
              ...prev,
              sessions: {
                ...prev.sessions,
                [sessionId]: { ...s, messages, updatedAt: Date.now() },
              },
            };
          });
        } else {
          appendMessage(sessionId, "assistant", reply.content, reply.trace);
        }
        // Fire-and-forget: ask the LLM for a real title once the first
        // assistant reply has landed. Build the history inline (state
        // hasn't flushed yet) and let `autoGenerateTitle` gate via
        // `titleGenerated` so subsequent turns are no-ops.
        const titleHistory: AgentChatTurn[] = [
          ...history
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({
              role: m.role as "user" | "assistant",
              content: m.content,
            })),
          { role: "user", content: instruction },
          { role: "assistant", content: reply.content },
        ];
        void autoGenerateTitle(sessionId, titleHistory);
      } catch (err) {
        // Streaming may have left a partial assistant bubble — drop it
        // so the user sees the error against a clean trailing user turn,
        // which is what `retryLast` expects.
        const state = streamingBuffers.current.get(sessionId);
        if (state) {
          streamingBuffers.current.delete(sessionId);
          const placeholderId = state.id;
          setStore((prev) => {
            const s = prev.sessions[sessionId];
            if (!s) return prev;
            return {
              ...prev,
              sessions: {
                ...prev.sessions,
                [sessionId]: {
                  ...s,
                  messages: s.messages.filter((m) => m.id !== placeholderId),
                },
              },
            };
          });
        }
        setError(String(err));
      } finally {
        try {
          const unlisten = await unlistenPromise;
          unlisten();
        } catch {
          // If the listener never registered (unlikely), nothing to do.
        }
        setPendingSessionId((current) =>
          current === sessionId ? null : current,
        );
      }
    },
    [
      appendMessage,
      appendStreamingDelta,
      dbSessionId,
      autoGenerateTitle,
      modelOverride,
    ],
  );

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;

      let sessionId = storeRef.current.activeId;
      if (!sessionId) sessionId = createSession();

      // Capture the history BEFORE appending the new user turn so the
      // backend doesn't see it twice (it adds `instruction` as the
      // final user turn on top of `history`).
      const history = storeRef.current.sessions[sessionId]?.messages ?? [];
      appendMessage(sessionId, "user", trimmed);
      await requestReply(sessionId, trimmed, history);
    },
    [appendMessage, createSession, requestReply],
  );

  /** Drop the trailing assistant message and re-request a fresh reply
   *  using the same prior user turn. */
  const regenerateLast = useCallback(async () => {
    const sessionId = storeRef.current.activeId;
    if (!sessionId) return;
    const messages = storeRef.current.sessions[sessionId]?.messages ?? [];
    if (messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (last.role !== "assistant") return;
    const prior = messages.slice(0, -1);
    const lastUser = [...prior].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    // History for the re-request excludes the user we're going to re-send.
    const lastUserIdx = prior.lastIndexOf(lastUser);
    const history = prior.slice(0, lastUserIdx);
    replaceMessages(sessionId, prior);
    await requestReply(sessionId, lastUser.content, history);
  }, [replaceMessages, requestReply]);

  /** Re-send the most recent user message after an error left the chat
   *  without an assistant reply. Falls back to `regenerateLast` when an
   *  assistant message did land. */
  const retryLast = useCallback(async () => {
    const sessionId = storeRef.current.activeId;
    if (!sessionId) return;
    const messages = storeRef.current.sessions[sessionId]?.messages ?? [];
    if (messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (last.role === "assistant") {
      await regenerateLast();
      return;
    }
    if (last.role !== "user") return;
    const history = messages.slice(0, -1);
    await requestReply(sessionId, last.content, history);
  }, [regenerateLast, requestReply]);

  /** Replace the most recent user message with `newText` and re-run the
   *  agent. Drops any assistant reply that came after the original user
   *  message — the new prompt deserves a fresh answer. */
  const editLastUser = useCallback(
    async (newText: string) => {
      const trimmed = newText.trim();
      if (trimmed.length === 0) return;
      const sessionId = storeRef.current.activeId;
      if (!sessionId) return;
      const messages = storeRef.current.sessions[sessionId]?.messages ?? [];
      if (messages.length === 0) return;
      let cutoff = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          cutoff = i;
          break;
        }
      }
      if (cutoff < 0) return;
      const history = messages.slice(0, cutoff);
      const next = [...history, buildMessage("user", trimmed)];
      replaceMessages(sessionId, next);
      await requestReply(sessionId, trimmed, history);
    },
    [replaceMessages, requestReply],
  );

  const setProposalOutcome = useCallback(
    (sessionId: string, messageId: string, outcome: ProposalStatus) => {
      setStore((prev) => {
        const s = prev.sessions[sessionId];
        if (!s) return prev;
        const messages = s.messages.map((m) => {
          if (m.id !== messageId || !m.proposal) return m;
          return { ...m, proposal: { ...m.proposal, outcome } };
        });
        return {
          ...prev,
          sessions: {
            ...prev.sessions,
            [sessionId]: { ...s, messages, updatedAt: Date.now() },
          },
        };
      });
    },
    [],
  );

  const approveProposal = useCallback(
    async (sessionId: string, messageId: string) => {
      const session = storeRef.current.sessions[sessionId];
      const message = session?.messages.find((m) => m.id === messageId);
      const proposal = message?.proposal;
      if (!session || !proposal) return;
      if (proposal.outcome.status !== "pending") return;
      if (!dbSessionId) {
        setProposalOutcome(sessionId, messageId, {
          status: "error",
          message:
            "Connection is no longer active — reopen the database tab to retry.",
        });
        return;
      }
      setProposalOutcome(sessionId, messageId, { status: "running" });
      try {
        const res = await agentChatApi.executePending(dbSessionId, proposal.sql);
        setProposalOutcome(sessionId, messageId, {
          status: "approved",
          rowsAffected: res.rows_affected,
          kind: res.kind,
        });
        // The agent stops after each approval card — it can't tell that
        // the user clicked "approve" until we ping it again. Re-invoke
        // the model with a synthetic continuation so multi-step plans
        // (e.g. "create schema X then create table Y") actually run all
        // the way through instead of stalling after step 1.
        const history = storeRef.current.sessions[sessionId]?.messages ?? [];
        const kindNote = res.kind ? ` (${res.kind})` : "";
        const continuation =
          `The previous statement${kindNote} was approved and executed ` +
          `successfully — ${res.rows_affected} row(s) affected. If the ` +
          `task required further steps, run the next one now; otherwise ` +
          `summarize the outcome for the user.`;
        void requestReply(sessionId, continuation, history);
      } catch (err) {
        const errMessage = String(err);
        setProposalOutcome(sessionId, messageId, {
          status: "error",
          message: errMessage,
        });
        // Same problem on the error path: without a continuation ping
        // the agent never sees the failure and the conversation stalls.
        // Tell it what went wrong so it can adapt (e.g. switch to
        // CREATE TABLE IF NOT EXISTS, drop the duplicate, etc.) or
        // surface the error to the user.
        const history = storeRef.current.sessions[sessionId]?.messages ?? [];
        const continuation =
          `The previous statement was approved but failed to execute. ` +
          `Database error: ${errMessage}. Decide how to proceed — adjust ` +
          `the plan, propose a corrected statement, or stop and explain ` +
          `the failure to the user.`;
        void requestReply(sessionId, continuation, history);
      }
    },
    [dbSessionId, setProposalOutcome, requestReply],
  );

  const rejectProposal = useCallback(
    (sessionId: string, messageId: string) => {
      setProposalOutcome(sessionId, messageId, { status: "rejected" });
    },
    [setProposalOutcome],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    sessions,
    activeId: store.activeId,
    activeSession,
    createSession,
    selectSession,
    deleteSession,
    renameSession,
    appendMessage,
    sendMessage,
    regenerateLast,
    retryLast,
    editLastUser,
    approveProposal,
    rejectProposal,
    pending: pendingSessionId !== null && pendingSessionId === store.activeId,
    error,
    clearError,
    dbSessionId,
    connectionLabel,
    // Model selector state.
    modelOverride,
    setModel,
    defaultModel,
    availableModels,
    modelsLoading,
  };
}

export type UseAgentChat = ReturnType<typeof useAgentChat>;
