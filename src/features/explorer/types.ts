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
