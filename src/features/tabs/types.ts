import type { ConnectionMeta } from "@/features/connections/types";

/** One open connection in the global tab bar. */
export interface WorkspaceTab {
  /** Unique per tab — the same connection may be opened more than once. */
  id: string;
  connection: ConnectionMeta;
}
