import { invoke } from "@tauri-apps/api/core";

import type {
  CellValue,
  OrderBy,
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
