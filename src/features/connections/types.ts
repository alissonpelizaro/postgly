/** Supported database engines. Only Postgres ships today. */
export type DatabaseKind = "postgres";

/** Non-secret metadata for a saved connection, as returned by the backend. */
export interface ConnectionMeta {
  id: string;
  name: string;
  kind: DatabaseKind;
  host: string;
  port: number;
  database: string;
  user: string;
}

/**
 * Form payload sent to `save_connection` / `test_connection`.
 * `id` is absent when creating; `password` is empty when editing and the
 * user keeps the stored secret.
 */
export interface ConnectionInput {
  id?: string;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/** Blank form values for a brand-new Postgres connection. */
export const emptyConnectionInput = (): ConnectionInput => ({
  name: "",
  host: "localhost",
  port: 5432,
  database: "",
  user: "postgres",
  password: "",
});
