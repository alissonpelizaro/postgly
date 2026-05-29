import { useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import {
  PostgreSQL,
  sql,
  type SQLNamespace,
} from "@codemirror/lang-sql";
import type { Completion } from "@codemirror/autocomplete";

import { useTheme } from "@/components/theme-provider";

import { normalizePgType } from "./pgTypes";
import type { DatabaseSchema } from "./types";

interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Triggered by Cmd/Ctrl+Enter. */
  onRun: () => void;
  /** Reports the currently selected text (empty string when none). */
  onSelectionChange?: (selected: string) => void;
  /** Full live schema. Drives table / column autocompletion. */
  schema?: DatabaseSchema | null;
  /** Schema whose tables are reachable without a `<schema>.` prefix. */
  defaultSchema?: string;
}

/** Convert the introspected schema into the nested namespace that
 *  `@codemirror/lang-sql` consumes for table / column completion.
 *  Columns carry their PG type as the `detail` chip and the column
 *  COMMENT as the popover info. */
function buildNamespace(schema: DatabaseSchema): SQLNamespace {
  const ns: Record<string, Record<string, Completion[]>> = {};
  for (const t of schema.tables) {
    const cols: Completion[] = t.columns.map((c) => ({
      label: c.name,
      type: c.is_primary_key ? "constant" : "property",
      detail: normalizePgType(c.data_type),
      info: c.comment ?? undefined,
      boost: c.is_primary_key ? 1 : 0,
    }));
    (ns[t.schema] ??= {})[t.name] = cols;
  }
  return ns as SQLNamespace;
}

/** Tables-as-completions list (flat). Lets typing a bare table name
 *  surface every reachable table across every schema, not only the
 *  default one. */
function buildTablesList(schema: DatabaseSchema): Completion[] {
  return schema.tables.map((t) => ({
    label: t.name,
    type: t.kind === "view" || t.kind === "materializedview" ? "class" : "type",
    detail: t.schema,
    info: t.comment ?? undefined,
  }));
}

/** Schemas-as-completions list. Used to autocomplete the leading
 *  `<schema>.` qualifier. */
function buildSchemasList(schema: DatabaseSchema): Completion[] {
  const seen = new Set<string>();
  const out: Completion[] = [];
  for (const t of schema.tables) {
    if (seen.has(t.schema)) continue;
    seen.add(t.schema);
    out.push({ label: t.schema, type: "namespace" });
  }
  return out;
}

/** A syntax-highlighted SQL editor (CodeMirror) for free-form queries. */
export function SqlEditor({
  value,
  onChange,
  onRun,
  onSelectionChange,
  schema,
  defaultSchema,
}: SqlEditorProps) {
  const { resolvedTheme } = useTheme();

  const extensions = useMemo(() => {
    const cfg = {
      dialect: PostgreSQL,
      upperCaseKeywords: true,
      ...(schema
        ? {
            schema: buildNamespace(schema),
            tables: buildTablesList(schema),
            schemas: buildSchemasList(schema),
            defaultSchema,
          }
        : {}),
    };
    return [sql(cfg)];
  }, [schema, defaultSchema]);

  return (
    <div
      className="h-full overflow-hidden text-sm"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          onRun();
        }
      }}
    >
      <CodeMirror
        value={value}
        onChange={onChange}
        onUpdate={(u) => {
          if (!onSelectionChange || !u.selectionSet) return;
          const { from, to } = u.state.selection.main;
          onSelectionChange(u.state.sliceDoc(from, to));
        }}
        theme={resolvedTheme}
        height="100%"
        style={{ height: "100%" }}
        extensions={extensions}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLine: true,
          autocompletion: true,
          foldGutter: false,
        }}
        placeholder="SELECT * FROM ..."
      />
    </div>
  );
}
