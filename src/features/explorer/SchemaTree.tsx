import { useEffect, useState } from "react";
import {
  AlertCircle,
  ChevronRight,
  Eye,
  Loader2,
  Table2,
} from "lucide-react";

import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

import { explorerApi } from "./api";
import type { SchemaInfo, TableInfo, TableRef } from "./types";

interface SchemaTreeProps {
  sessionId: string;
  selected: TableRef | null;
  onSelect: (table: TableRef) => void;
}

/** Left-panel tree: schemas that expand to reveal their tables and views. */
export function SchemaTree({ sessionId, selected, onSelect }: SchemaTreeProps) {
  const { t } = useI18n();
  const [schemas, setSchemas] = useState<SchemaInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    explorerApi
      .listSchemas(sessionId)
      .then((s) => {
        setSchemas(s);
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [sessionId]);

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t("explorer.schemas")}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 px-3 py-4 text-xs text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        ) : (
          schemas.map((schema) => (
            <SchemaNode
              key={schema.name}
              sessionId={sessionId}
              schema={schema.name}
              selected={selected}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
    </div>
  );
}

interface SchemaNodeProps {
  sessionId: string;
  schema: string;
  selected: TableRef | null;
  onSelect: (table: TableRef) => void;
}

/** A single schema row that lazily loads its tables on first expand. */
function SchemaNode({ sessionId, schema, selected, onSelect }: SchemaNodeProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && tables === null) {
      setLoading(true);
      try {
        setTables(await explorerApi.listTables(sessionId, schema));
        setError(null);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        className={cn(
          "flex w-full items-center gap-1 px-2 py-1 text-sm",
          "hover:bg-accent/60",
        )}
      >
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
        />
        <span className="truncate font-medium">{schema}</span>
      </button>

      {expanded && (
        <div className="ml-3 border-l border-border pl-1">
          {loading ? (
            <div className="px-2 py-1">
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <p className="px-2 py-1 text-xs text-destructive">{error}</p>
          ) : tables && tables.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              {t("explorer.noTables")}
            </p>
          ) : (
            tables?.map((table) => {
              const active =
                selected?.schema === schema && selected?.name === table.name;
              return (
                <button
                  key={table.name}
                  type="button"
                  onClick={() => onSelect({ schema, name: table.name })}
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-sm",
                    active
                      ? "bg-primary/15 text-primary"
                      : "hover:bg-accent/60",
                  )}
                >
                  {table.is_view ? (
                    <Eye className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <Table2 className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{table.name}</span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
