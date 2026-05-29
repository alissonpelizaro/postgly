/** Map a Postgres `information_schema.data_type` value to the canonical
 *  short name used across the UI (e.g. `character varying` → `varchar`,
 *  `timestamp without time zone` → `timestamp`). Falls back to the raw
 *  value if no alias is known. */
export function normalizePgType(raw: string): string {
  const t = raw.trim().toLowerCase();
  switch (t) {
    case "character varying":
      return "varchar";
    case "character":
      return "char";
    case "timestamp without time zone":
      return "timestamp";
    case "timestamp with time zone":
      return "timestamptz";
    case "time without time zone":
      return "time";
    case "time with time zone":
      return "timetz";
    case "int":
    case "int4":
      return "integer";
    case "int2":
      return "smallint";
    case "int8":
      return "bigint";
    case "float4":
      return "real";
    case "float8":
      return "double precision";
    case "bool":
      return "boolean";
    default:
      return raw;
  }
}
