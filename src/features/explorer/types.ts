/** A schema (namespace) within the connected database. */
export interface SchemaInfo {
  name: string;
}

/** A table or view inside a schema. */
export interface TableInfo {
  schema: string;
  name: string;
  is_view: boolean;
}

/** A single column of a table. */
export interface ColumnInfo {
  name: string;
  data_type: string;
  nullable: boolean;
  default: string | null;
  is_primary_key: boolean;
}

/** An index defined on a table. */
export interface IndexInfo {
  name: string;
  columns: string[];
  is_unique: boolean;
  is_primary: boolean;
}

/** The full structural description of a table. */
export interface TableDetails {
  columns: ColumnInfo[];
  indexes: IndexInfo[];
}

/** Identifies a selected table within the explorer. */
export interface TableRef {
  schema: string;
  name: string;
}

/** The result of running a query: column names plus stringified rows. */
export interface QueryResult {
  columns: string[];
  rows: (string | null)[][];
  /** Rows returned (SELECT) or affected (INSERT/UPDATE/DELETE). */
  rows_affected: number;
  /** `true` when `run_query` wrapped a free-form `SELECT` to enforce
   *  the safety cap. Drives the pager and header-sort affordances in
   *  SQL mode. */
  paginated?: boolean;
  /** `true` when there is at least one more row on the server beyond
   *  the current page — drives the "next page" button. */
  has_more?: boolean;
  /** Offset that produced this page (0 for the first page). */
  offset?: number;
  /** Effective page size that was applied (e.g. 1000). */
  row_cap?: number | null;
}

/** A single column value: used to address a row (primary key) or to
 * carry an edited value. `value` is `null` for SQL `NULL`. */
export interface CellValue {
  column: string;
  value: string | null;
}

/** Comparison operator for the records quick-filter. */
export type FilterOp =
  | "eq"
  | "neq"
  | "lt"
  | "gt"
  | "lte"
  | "gte"
  | "like"
  | "ilike";

/** A single quick-filter clause: `column <op> value`. */
export interface RowFilter {
  column: string;
  operator: FilterOp;
  value: string;
}

/** A sort clause: `ORDER BY column [ASC|DESC]`. */
export interface OrderBy {
  column: string;
  descending: boolean;
}

/** Outcome status emitted by the natural-language SQL agent. */
export type AgentStatus = "ok" | "need_info" | "not_found" | "error";

/** One observable step in the agent's reasoning trace. */
export type TraceEvent =
  | { kind: "tool_call"; name: string; arguments: unknown }
  | { kind: "tool_result"; name: string; ok: boolean; result: unknown }
  | { kind: "assistant_message"; content: string };

/** Token accounting for an LLM exchange. Zeroed when the provider
 *  didn't return usage data. */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** What `generate_sql` returns to the UI. */
export interface AgentOutput {
  status: AgentStatus;
  sql?: string;
  reason?: string;
  /** Actionable hints surfaced when the model could not finish the
   *  task: candidate table names, clarifying questions, etc. */
  suggestions: string[];
  trace: TraceEvent[];
  usage: TokenUsage;
}

/** One past natural-language → SQL exchange for the session. */
export interface NlHistoryEntry {
  instruction: string;
  output: AgentOutput;
  /** Unix timestamp (seconds). */
  created_at: number;
}

/** Kind of a single SQL statement, mirrored from the Rust classifier. */
export type StatementKind =
  | "select"
  | "insert"
  | "update"
  | "delete"
  | "drop"
  | "truncate"
  | "alter"
  | "create"
  | "other";

export interface StatementInfo {
  kind: StatementKind;
  /** `true` when an UPDATE/DELETE carries a WHERE clause. */
  has_where: boolean;
  /** First ~140 chars of the statement, whitespace-collapsed. */
  preview: string;
}

/** A single column within a [TableSchema] from the introspection cache. */
export interface ColumnSchema {
  name: string;
  data_type: string;
  nullable: boolean;
  default: string | null;
  is_primary_key: boolean;
  comment: string | null;
}

/** A foreign-key constraint on a [TableSchema]. */
export interface ForeignKeySchema {
  name: string;
  columns: string[];
  ref_schema: string;
  ref_table: string;
  ref_columns: string[];
}

/** A single table/view from the full schema introspection. */
export interface TableSchema {
  schema: string;
  name: string;
  kind: "table" | "view" | "materializedview";
  comment: string | null;
  columns: ColumnSchema[];
  primary_key: string[];
  foreign_keys: ForeignKeySchema[];
}

/** Full introspected schema for an open connection (user schemas only). */
export interface DatabaseSchema {
  tables: TableSchema[];
}

/** One slow node flagged by the LLM analyser. */
export interface Bottleneck {
  node: string;
  issue: string;
  severity: "high" | "medium" | "low" | string;
}

/** A proposed index along with the DDL to create it. */
export interface IndexSuggestion {
  sql: string;
  rationale: string;
  table: string;
  columns: string[];
}

/** Token accounting for an LLM exchange (shared with [AgentOutput]). */
export interface AnalyzeUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** Structured output of `analyze_query_plan`. The raw plan JSON strings
 *  are returned verbatim so the UI can render the visual tree without
 *  re-running EXPLAIN. */
export interface QueryAnalysis {
  summary: string;
  bottlenecks: Bottleneck[];
  index_suggestions: IndexSuggestion[];
  optimized_sql: string | null;
  rewrites: string[];
  estimated_gain_factor: number | null;
  original_plan: string;
  optimized_plan: string | null;
  original_total_cost: number | null;
  optimized_total_cost: number | null;
  original_execution_ms: number | null;
  usage: AnalyzeUsage;
}

/** Result of `analyze_statement` — used by the destructive-SQL guard. */
export interface StatementAnalysis {
  statements: StatementInfo[];
  destructive: boolean;
  unbounded_dml: boolean;
  /** Planner row estimate for the destructive DML, when available. */
  estimated_rows: number | null;
  /** Reason EXPLAIN failed, when it did. */
  explain_error: string | null;
}
