import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

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

/** Session + message state machine for the agent chat. */
export function useAgentChat(options: UseAgentChatOptions) {
  const { dbSessionId, connectionLabel } = options;
  const [store, setStore] = useState<ChatStore>(() => loadStore());
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  /** Apply a streamed text delta to the in-progress assistant message of
   *  a session. Creates the placeholder message on the first delta and
   *  appends to its content thereafter. The id of the placeholder is
   *  tracked per-session so concurrent requests don't cross-contaminate. */
  const streamingMsgIds = useRef<Map<string, string>>(new Map());
  const appendStreamingDelta = useCallback(
    (sessionId: string, delta: string) => {
      if (delta.length === 0) return;
      const existingId = streamingMsgIds.current.get(sessionId);
      if (!existingId) {
        const placeholder = buildMessage("assistant", delta);
        streamingMsgIds.current.set(sessionId, placeholder.id);
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
      setStore((prev) => {
        const s = prev.sessions[sessionId];
        if (!s) return prev;
        const messages = s.messages.map((m) =>
          m.id === existingId ? { ...m, content: m.content + delta } : m,
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
        });
        // Replace the streaming placeholder (if any) with the canonical
        // reply — same content but with the final trace + proposal
        // attached. If no placeholder exists (no deltas arrived) fall
        // back to a plain append.
        const placeholderId = streamingMsgIds.current.get(sessionId);
        if (placeholderId) {
          streamingMsgIds.current.delete(sessionId);
          const finalMsg = buildMessage("assistant", reply.content, reply.trace);
          setStore((prev) => {
            const s = prev.sessions[sessionId];
            if (!s) return prev;
            const messages = s.messages.map((m) =>
              m.id === placeholderId ? { ...finalMsg, id: m.id } : m,
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
        const placeholderId = streamingMsgIds.current.get(sessionId);
        if (placeholderId) {
          streamingMsgIds.current.delete(sessionId);
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
    [appendMessage, appendStreamingDelta, dbSessionId, autoGenerateTitle],
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
      } catch (err) {
        setProposalOutcome(sessionId, messageId, {
          status: "error",
          message: String(err),
        });
      }
    },
    [dbSessionId, setProposalOutcome],
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
  };
}

export type UseAgentChat = ReturnType<typeof useAgentChat>;
