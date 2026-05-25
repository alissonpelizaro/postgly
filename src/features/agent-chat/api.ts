import { invoke } from "@tauri-apps/api/core";

import type { ChatTraceEvent } from "./types";

export interface AgentChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AgentTokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface AgentChatResponse {
  content: string;
  usage: AgentTokenUsage;
  trace: ChatTraceEvent[];
}

export interface AgentChatSendOptions {
  /** Live Tauri DB session id — enables read-only tool use. */
  connectionSessionId?: string | null;
  model?: string;
  temperature?: number;
}

export interface ChatMutationResult {
  rows_affected: number;
  kind: string;
}

export const agentChatApi = {
  /** Send the user's turn plus the prior history; receive the assistant
   *  reply. Stateless on the backend — history lives in localStorage. */
  send: (
    history: AgentChatTurn[],
    instruction: string,
    options?: AgentChatSendOptions,
  ) =>
    invoke<AgentChatResponse>("agent_chat_send", {
      history,
      instruction,
      connectionSessionId: options?.connectionSessionId ?? null,
      modelOverride: options?.model ?? null,
      temperatureOverride: options?.temperature ?? null,
    }),

  /** Execute a mutation the user approved via the inline confirmation card. */
  executePending: (connectionSessionId: string, sql: string) =>
    invoke<ChatMutationResult>("agent_execute_pending_mutation", {
      connectionSessionId,
      sql,
    }),

  /** Ask the LLM for a short title summarizing the conversation. */
  generateTitle: (history: AgentChatTurn[]) =>
    invoke<string>("agent_generate_title", { history }),
};
