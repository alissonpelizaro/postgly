import { invoke } from "@tauri-apps/api/core";

import type {
  AgentOutput,
  CellValue,
  NlHistoryEntry,
  OrderBy,
  QueryResult,
  RowFilter,
  SchemaInfo,
  StatementAnalysis,
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

  /** Update a single table row, addressed by its primary key. */
  updateRow: (
    sessionId: string,
    schema: string,
    table: string,
    primaryKey: CellValue[],
    changes: CellValue[],
  ) =>
    invoke<QueryResult>("update_row", {
      sessionId,
      schema,
      table,
      primaryKey,
      changes,
    }),

  /** Insert a single row from the given column values. */
  insertRow: (
    sessionId: string,
    schema: string,
    table: string,
    values: CellValue[],
  ) =>
    invoke<QueryResult>("insert_row", { sessionId, schema, table, values }),

  /** Delete a single table row, addressed by its primary key. */
  deleteRow: (
    sessionId: string,
    schema: string,
    table: string,
    primaryKey: CellValue[],
  ) =>
    invoke<QueryResult>("delete_row", {
      sessionId,
      schema,
      table,
      primaryKey,
    }),

  /** The statements run this session, oldest first. */
  queryHistory: (sessionId: string) =>
    invoke<string[]>("query_history", { sessionId }),

  /** Turn a natural-language instruction into SQL via the configured LLM.
   *  `overrides` lets the caller pick a different model/temperature for
   *  this single call without touching the saved settings. */
  generateSql: (
    sessionId: string,
    instruction: string,
    overrides?: { model?: string; temperature?: number },
  ) =>
    invoke<AgentOutput>("generate_sql", {
      sessionId,
      instruction,
      modelOverride: overrides?.model ?? null,
      temperatureOverride: overrides?.temperature ?? null,
    }),

  /** Snapshot the session's NL → SQL history, newest first. */
  nlQueryHistory: (sessionId: string) =>
    invoke<NlHistoryEntry[]>("nl_query_history", { sessionId }),

  /** Drop the cached schema for a session — call after DDL. */
  refreshDatabaseSchema: (sessionId: string) =>
    invoke<void>("refresh_database_schema", { sessionId }),

  /** Classify a SQL string and (for destructive DML) ask Postgres for a
   *  row estimate via EXPLAIN. Used by the destructive-SQL guard. */
  analyzeStatement: (sessionId: string, sql: string) =>
    invoke<StatementAnalysis>("analyze_statement", { sessionId, sql }),

  /** Browse a table's rows with an optional quick-filter, sort and pagination. */
  browseTable: (
    sessionId: string,
    schema: string,
    table: string,
    filter: RowFilter | null,
    orderBy: OrderBy | null,
    limit: number,
    offset: number,
  ) =>
    invoke<QueryResult>("browse_table", {
      sessionId,
      schema,
      table,
      filter,
      orderBy,
      limit,
      offset,
    }),
};
