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
