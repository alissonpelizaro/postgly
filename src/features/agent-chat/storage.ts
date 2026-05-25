import type { ChatStore, ChatSession } from "./types";

const STORAGE_KEY = "postgly.agent-chat.v1";
const TTL_MS = 180 * 24 * 60 * 60 * 1000;

function emptyStore(): ChatStore {
  return { version: 1, sessionIds: [], sessions: {}, activeId: null };
}

/** Load + purge sessions older than 180 days. Safe in non-browser envs. */
export function loadStore(): ChatStore {
  if (typeof localStorage === "undefined") return emptyStore();
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return emptyStore();
  let parsed: ChatStore;
  try {
    parsed = JSON.parse(raw) as ChatStore;
  } catch {
    return emptyStore();
  }
  if (!parsed || parsed.version !== 1) return emptyStore();

  const now = Date.now();
  const cutoff = now - TTL_MS;
  const sessions: Record<string, ChatSession> = {};
  const sessionIds: string[] = [];
  for (const id of parsed.sessionIds ?? []) {
    const s = parsed.sessions?.[id];
    if (!s) continue;
    if (s.updatedAt < cutoff) continue;
    sessions[id] = s;
    sessionIds.push(id);
  }
  const activeId =
    parsed.activeId && sessions[parsed.activeId] ? parsed.activeId : null;
  return { version: 1, sessionIds, sessions, activeId };
}

export function saveStore(store: ChatStore): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* quota or serialization error — ignore in phase 1 */
  }
}
