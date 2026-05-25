/** Conversational agent chat (Phase 1: UI + persistence only). */

export type ChatRole = "user" | "assistant" | "system";

/** One step the agent took while answering a message — surfaced in the
 *  UI as a collapsible "reasoning" trace. Shape mirrors the backend. */
export type ChatTraceEvent =
  | { kind: "tool_call"; name: string; arguments: unknown }
  | { kind: "tool_result"; name: string; ok: boolean; result: unknown }
  | { kind: "assistant_message"; content: string };

/** Statement kind (mirrors backend `StatementKind`). */
export type ProposalKind =
  | "select"
  | "insert"
  | "update"
  | "delete"
  | "drop"
  | "truncate"
  | "alter"
  | "create"
  | "other";

/** Outcome of an inline approval card. `null` = still pending. */
export type ProposalStatus =
  | { status: "pending" }
  | { status: "running" }
  | { status: "approved"; rowsAffected: number; kind: string }
  | { status: "rejected" }
  | { status: "error"; message: string };

/** A mutation the agent wants to run that needs human approval. */
export interface ChatProposal {
  sql: string;
  summary: string;
  kind: ProposalKind;
  preview: string;
  destructive: boolean;
  unboundedDml: boolean;
  hasWhere: boolean;
  outcome: ProposalStatus;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** Unix ms. */
  createdAt: number;
  /** Only set on assistant messages produced via tool-enabled chats. */
  trace?: ChatTraceEvent[];
  /** Pending or resolved mutation proposal attached to this message. */
  proposal?: ChatProposal;
}

export interface ChatSession {
  id: string;
  title: string;
  /** `true` once the title has been finalized — either by the LLM
   *  auto-summary or by the user renaming the session. Suppresses
   *  subsequent auto-generation. Older sessions (pre-feature) lack the
   *  field and are treated as already-finalized. */
  titleGenerated?: boolean;
  /** Optional connection the session is bound to. `null` = unbound. */
  connectionId: string | null;
  /** Unix ms. */
  createdAt: number;
  /** Unix ms — refreshed whenever a message lands. Drives 180-day TTL. */
  updatedAt: number;
  messages: ChatMessage[];
}

/** Shape persisted in localStorage. */
export interface ChatStore {
  version: 1;
  /** Most-recent first. */
  sessionIds: string[];
  sessions: Record<string, ChatSession>;
  activeId: string | null;
}
