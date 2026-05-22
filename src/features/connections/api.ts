import { invoke } from "@tauri-apps/api/core";

import type { ConnectionInput, ConnectionMeta } from "./types";

/** Typed wrappers around the Rust connection commands. */
export const connectionsApi = {
  /** List every saved connection (metadata only). */
  list: () => invoke<ConnectionMeta[]>("list_connections"),

  /** Create or update a connection; returns the persisted metadata. */
  save: (input: ConnectionInput) =>
    invoke<ConnectionMeta>("save_connection", { input }),

  /** Delete a connection and its keyring password. */
  remove: (id: string) => invoke<void>("delete_connection", { id }),

  /** Open, ping and close a transient connection. Rejects on failure. */
  test: (input: ConnectionInput) => invoke<void>("test_connection", { input }),
};
