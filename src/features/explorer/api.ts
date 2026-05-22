import { invoke } from "@tauri-apps/api/core";

import type {
  QueryResult,
  RowFilter,
  SchemaInfo,
  TableDetails,
  TableInfo,
} from "./types";

/** Typed wrappers around the Rust database-explorer commands. */
export const explorerApi = {
  /** Open a live connection; resolves to a session id. */
  open: (connectionId: string) =>
    invoke<string>("open_connection", { connectionId }),

  /** Close an open connection and drop its pool. */
  close: (sessionId: string) =>
    invoke<void>("close_connection", { sessionId }),

  /** List the schemas visible to the connected user. */
  listSchemas: (sessionId: string) =>
    invoke<SchemaInfo[]>("list_schemas", { sessionId }),

  /** List the tables and views inside a schema. */
  listTables: (sessionId: string, schema: string) =>
    invoke<TableInfo[]>("list_tables", { sessionId, schema }),

  /** Describe a table's columns and indexes. */
  describeTable: (sessionId: string, schema: string, table: string) =>
    invoke<TableDetails>("describe_table", { sessionId, schema, table }),

  /** Run an arbitrary SQL statement from the editor. */
  runQuery: (sessionId: string, sql: string) =>
    invoke<QueryResult>("run_query", { sessionId, sql }),

  /** Browse a table's rows with an optional quick-filter and pagination. */
  browseTable: (
    sessionId: string,
    schema: string,
    table: string,
    filter: RowFilter | null,
    limit: number,
    offset: number,
  ) =>
    invoke<QueryResult>("browse_table", {
      sessionId,
      schema,
      table,
      filter,
      limit,
      offset,
    }),
};
