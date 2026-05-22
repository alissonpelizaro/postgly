import { useCallback, useEffect, useState } from "react";
import { AlertCircle, ChevronLeft, ChevronRight, Loader2, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { explorerApi } from "./api";
import { QuickFilter } from "./QuickFilter";
import { ResultGrid } from "./ResultGrid";
import { SqlEditor } from "./SqlEditor";
import type { QueryResult, RowFilter, TableRef } from "./types";

const PAGE_SIZE = 100;

type Mode = "filter" | "sql";

interface TableRecordsProps {
  sessionId: string;
  table: TableRef;
}

/**
 * "Records" tab: browse a table's rows with the quick-filter and
 * pagination, or run free-form SQL against the connection.
 */
export function TableRecords({ sessionId, table }: TableRecordsProps) {
  const [mode, setMode] = useState<Mode>("filter");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<RowFilter | null>(null);
  const [sqlText, setSqlText] = useState(
    `SELECT * FROM "${table.schema}"."${table.name}" LIMIT 100;`,
  );

  const browse = useCallback(
    async (f: RowFilter | null, p: number) => {
      setLoading(true);
      setError(null);
      try {
        const r = await explorerApi.browseTable(
          sessionId,
          table.schema,
          table.name,
          f,
          PAGE_SIZE,
          p * PAGE_SIZE,
        );
        setResult(r);
        if (r.columns.length > 0) setColumns(r.columns);
      } catch (e) {
        setError(String(e));
        setResult(null);
      } finally {
        setLoading(false);
      }
    },
    [sessionId, table.schema, table.name],
  );

  // Initial unfiltered page. The component is remounted per table, so
  // this also covers switching tables.
  useEffect(() => {
    void browse(null, 0);
  }, [browse]);

  const applyFilter = (f: RowFilter | null) => {
    setFilter(f);
    setPage(0);
    void browse(f, 0);
  };

  const goToPage = (p: number) => {
    setPage(p);
    void browse(filter, p);
  };

  const runSql = async () => {
    if (!sqlText.trim()) return;
    setLoading(true);
    setError(null);
    try {
      setResult(await explorerApi.runQuery(sessionId, sqlText));
    } catch (e) {
      setError(String(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const rowCount = result?.rows.length ?? 0;
  const hasNextPage = mode === "filter" && rowCount === PAGE_SIZE;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-2 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <ModeSwitch mode={mode} onChange={setMode} />
        </div>

        {mode === "filter" ? (
          <QuickFilter
            columns={columns}
            active={filter !== null}
            onApply={applyFilter}
          />
        ) : (
          <div className="flex flex-col gap-2">
            <div className="h-40 overflow-hidden rounded-md border border-border">
              <SqlEditor value={sqlText} onChange={setSqlText} onRun={runSql} />
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={runSql} disabled={loading}>
                {loading ? <Loader2 className="animate-spin" /> : <Play />}
                Executar
              </Button>
              <span className="text-xs text-muted-foreground">⌘/Ctrl + ↵</span>
            </div>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {loading ? (
          <Centered>
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </Centered>
        ) : error ? (
          <Centered>
            <AlertCircle className="size-6 text-destructive" />
            <p className="max-w-md text-center text-sm text-destructive">
              {error}
            </p>
          </Centered>
        ) : result ? (
          <ResultGrid result={result} />
        ) : null}
      </div>

      <footer className="flex items-center justify-between border-t border-border px-4 py-1.5 text-xs text-muted-foreground">
        <span>
          {result ? `${rowCount} linha(s)` : "—"}
          {mode === "filter" && ` · página ${page + 1}`}
        </span>
        {mode === "filter" && (
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              disabled={page === 0 || loading}
              onClick={() => goToPage(page - 1)}
              aria-label="Página anterior"
            >
              <ChevronLeft />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              disabled={!hasNextPage || loading}
              onClick={() => goToPage(page + 1)}
              aria-label="Próxima página"
            >
              <ChevronRight />
            </Button>
          </div>
        )}
      </footer>
    </div>
  );
}

/** Segmented control switching between the filter and SQL query modes. */
function ModeSwitch({
  mode,
  onChange,
}: {
  mode: Mode;
  onChange: (mode: Mode) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-border bg-card p-0.5">
      {(["filter", "sql"] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={cn(
            "rounded-sm px-3 py-1 text-xs font-medium transition-colors",
            mode === m
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {m === "filter" ? "Filtro" : "SQL"}
        </button>
      ))}
    </div>
  );
}

/** Centered column layout for loading / error states. */
function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2">
      {children}
    </div>
  );
}
