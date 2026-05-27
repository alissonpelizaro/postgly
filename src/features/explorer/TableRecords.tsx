import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  History,
  Loader2,
  Play,
  Plus,
  RefreshCw,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

import { settingsApi } from "@/features/settings/api";

import { explorerApi } from "./api";
import { CommandHistory } from "./CommandHistory";
import { DestructiveConfirmDialog } from "./DestructiveConfirmDialog";
import { NlQueryBar } from "./NlQueryBar";
import { QuickFilter } from "./QuickFilter";
import { RecordDialog } from "./RecordDialog";
import { ResultGrid } from "./ResultGrid";
import { SqlEditor } from "./SqlEditor";
import type {
  CellValue,
  ColumnInfo,
  OrderBy,
  QueryResult,
  RowFilter,
  StatementAnalysis,
  TableRef,
} from "./types";

const PAGE_SIZE = 100;

const qIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;
const qLit = (value: string | null): string =>
  value === null ? "NULL" : `'${value.replace(/'/g, "''")}'`;

/** Build a human-readable UPDATE statement for the row-edit confirmation
 *  modal. The actual mutation still goes through the parameterized
 *  `update_row` command — this string is only used for the analyzer
 *  preview shown to the user. */
function buildUpdatePreviewSql(
  schema: string,
  table: string,
  pk: CellValue[],
  changes: CellValue[],
): string {
  const setClause = changes
    .map((c) => `${qIdent(c.column)} = ${qLit(c.value)}`)
    .join(", ");
  const whereClause = pk
    .map((c) => `${qIdent(c.column)} = ${qLit(c.value)}`)
    .join(" AND ");
  return `UPDATE ${qIdent(schema)}.${qIdent(table)} SET ${setClause} WHERE ${whereClause};`;
}

type Mode = "filter" | "sql";

interface TableRecordsProps {
  sessionId: string;
  table: TableRef;
}

/**
 * "Records" tab: browse a table's rows with the quick-filter, sorting and
 * pagination, edit / insert / delete rows, or run free-form SQL.
 */
export function TableRecords({ sessionId, table }: TableRecordsProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>("filter");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<RowFilter | null>(null);
  const [sort, setSort] = useState<OrderBy | null>(null);
  const [tableColumns, setTableColumns] = useState<ColumnInfo[]>([]);
  const [openRow, setOpenRow] = useState<number | null>(null);
  const [deleteIdx, setDeleteIdx] = useState<number | null>(null);
  const [showInsert, setShowInsert] = useState(false);
  const [duplicateRow, setDuplicateRow] = useState<number | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [selectedSql, setSelectedSql] = useState("");
  const [sqlText, setSqlText] = useState(
    `SELECT * FROM "${table.schema}"."${table.name}" LIMIT 100;`,
  );
  const [pendingGuard, setPendingGuard] = useState<{
    sql: string;
    analysis: StatementAnalysis | null;
  } | null>(null);
  const [pendingRowUpdate, setPendingRowUpdate] = useState<{
    rowIndex: number;
    changes: CellValue[];
    sql: string;
    analysis: StatementAnalysis | null;
  } | null>(null);
  const [rowUpdateRunning, setRowUpdateRunning] = useState(false);
  const rowUpdateResolverRef = useRef<{
    resolve: () => void;
    reject: (e: unknown) => void;
  } | null>(null);

  const pkColumns = useMemo(
    () => tableColumns.filter((c) => c.is_primary_key).map((c) => c.name),
    [tableColumns],
  );
  const columnTypes = useMemo(
    () =>
      Object.fromEntries(
        tableColumns.map((c) => [c.name, c.data_type.toLowerCase()]),
      ),
    [tableColumns],
  );

  const browse = useCallback(
    async (f: RowFilter | null, o: OrderBy | null, p: number) => {
      setLoading(true);
      setError(null);
      try {
        const r = await explorerApi.browseTable(
          sessionId,
          table.schema,
          table.name,
          f,
          o,
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
    void browse(null, null, 0);
  }, [browse]);

  // Column metadata drives the primary key, JSON detection and insert form.
  useEffect(() => {
    explorerApi
      .describeTable(sessionId, table.schema, table.name)
      .then((d) => setTableColumns(d.columns))
      .catch(() => setTableColumns([]));
  }, [sessionId, table.schema, table.name]);

  const applyFilter = (f: RowFilter | null) => {
    setFilter(f);
    setPage(0);
    void browse(f, sort, 0);
  };

  const goToPage = (p: number) => {
    setPage(p);
    void browse(filter, sort, p);
  };

  // Cycle a column's sort: none → ascending → descending → none.
  const cycleSort = (column: string) => {
    const next: OrderBy | null =
      !sort || sort.column !== column
        ? { column, descending: false }
        : !sort.descending
          ? { column, descending: true }
          : null;
    setSort(next);
    setPage(0);
    void browse(filter, next, 0);
  };

  const executeSql = useCallback(
    async (sql: string) => {
      setLoading(true);
      setError(null);
      try {
        setResult(await explorerApi.runQuery(sessionId, sql));
      } catch (e) {
        setError(String(e));
        setResult(null);
      } finally {
        setLoading(false);
      }
    },
    [sessionId],
  );

  const runSql = async () => {
    const sql = selectedSql.trim() || sqlText;
    if (!sql.trim()) return;

    // Check the guard setting + analyse the statement. If the user has
    // opted out of confirmations we go straight to execute.
    let confirmDestructive = true;
    try {
      confirmDestructive = (await settingsApi.get()).safety.confirm_destructive;
    } catch {
      // Settings unavailable → fall back to the safe default (confirm).
    }

    if (!confirmDestructive) {
      await executeSql(sql);
      return;
    }

    // Open the modal optimistically; populate analysis when it returns.
    setPendingGuard({ sql, analysis: null });
    try {
      const analysis = await explorerApi.analyzeStatement(sessionId, sql);
      if (!analysis.destructive) {
        setPendingGuard(null);
        await executeSql(sql);
        return;
      }
      setPendingGuard({ sql, analysis });
    } catch (e) {
      // Analysis itself failed — surface as a regular error and skip
      // execution. Better than silently running an unanalysed mutation.
      setPendingGuard(null);
      setError(String(e));
    }
  };

  const confirmDestructiveRun = async () => {
    if (!pendingGuard) return;
    const sql = pendingGuard.sql;
    setPendingGuard(null);
    await executeSql(sql);
  };

  const cancelDestructiveRun = () => {
    setPendingGuard(null);
  };

  // The primary key of a result row, for addressing it on update / delete.
  const rowKey = (rowIndex: number): CellValue[] => {
    const row = result!.rows[rowIndex];
    return pkColumns.map((column) => ({
      column,
      value: row[result!.columns.indexOf(column)],
    }));
  };

  const saveRow = async (changes: CellValue[]) => {
    if (openRow === null || !result) return;

    let confirmDestructive = true;
    try {
      confirmDestructive = (await settingsApi.get()).safety.confirm_destructive;
    } catch {
      // Settings unavailable → keep the safe default (confirm).
    }
    if (!confirmDestructive) {
      await explorerApi.updateRow(
        sessionId,
        table.schema,
        table.name,
        rowKey(openRow),
        changes,
      );
      await browse(filter, sort, page);
      return;
    }

    const pk = rowKey(openRow);
    const sql = buildUpdatePreviewSql(table.schema, table.name, pk, changes);
    setPendingRowUpdate({ rowIndex: openRow, changes, sql, analysis: null });
    void explorerApi
      .analyzeStatement(sessionId, sql)
      .then((analysis) =>
        setPendingRowUpdate((p) => (p ? { ...p, analysis } : p)),
      )
      .catch(() => {
        // Analysis failed — surface a minimal synthetic analysis so the
        // dialog still shows what's about to run instead of hanging on
        // the loader.
        setPendingRowUpdate((p) =>
          p
            ? {
                ...p,
                analysis: {
                  statements: [
                    { kind: "update", has_where: true, preview: sql },
                  ],
                  destructive: true,
                  unbounded_dml: false,
                  estimated_rows: 1,
                  explain_error: null,
                },
              }
            : p,
        );
      });

    return new Promise<void>((resolve, reject) => {
      rowUpdateResolverRef.current = { resolve, reject };
    });
  };

  const confirmRowUpdate = async () => {
    const pending = pendingRowUpdate;
    if (!pending) return;
    setRowUpdateRunning(true);
    try {
      await explorerApi.updateRow(
        sessionId,
        table.schema,
        table.name,
        rowKey(pending.rowIndex),
        pending.changes,
      );
      await browse(filter, sort, page);
      rowUpdateResolverRef.current?.resolve();
    } catch (e) {
      rowUpdateResolverRef.current?.reject(e);
    } finally {
      rowUpdateResolverRef.current = null;
      setPendingRowUpdate(null);
      setRowUpdateRunning(false);
    }
  };

  const cancelRowUpdate = () => {
    if (rowUpdateRunning) return;
    rowUpdateResolverRef.current?.reject(
      new Error(t("explorer.destructive.cancelled")),
    );
    rowUpdateResolverRef.current = null;
    setPendingRowUpdate(null);
  };

  const saveInsert = async (values: CellValue[]) => {
    await explorerApi.insertRow(sessionId, table.schema, table.name, values);
    await browse(filter, sort, page);
  };

  const confirmDelete = async () => {
    if (deleteIdx === null || !result) return;
    await explorerApi.deleteRow(
      sessionId,
      table.schema,
      table.name,
      rowKey(deleteIdx),
    );
    setDeleteIdx(null);
    await browse(filter, sort, page);
  };

  const rowCount = result?.rows.length ?? 0;
  const hasNextPage = mode === "filter" && rowCount === PAGE_SIZE;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-2 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <ModeSwitch mode={mode} onChange={setMode} />
          {mode === "filter" && (
            <Button
              size="sm"
              variant="outline"
              disabled={tableColumns.length === 0}
              onClick={() => setShowInsert(true)}
            >
              <Plus />
              {t("explorer.newRecord")}
            </Button>
          )}
          {mode === "filter" && (
            <Button
              size="sm"
              variant="ghost"
              disabled={loading}
              onClick={() => void browse(filter, sort, page)}
              title={t("explorer.refresh")}
            >
              <RefreshCw className={loading ? "animate-spin" : undefined} />
              {t("explorer.refresh")}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => setShowHistory(true)}
          >
            <History />
            {t("explorer.history")}
          </Button>
        </div>

        {mode === "filter" ? (
          <QuickFilter
            columns={columns}
            active={filter !== null}
            onApply={applyFilter}
          />
        ) : (
          <div className="flex flex-col gap-2">
            <NlQueryBar sessionId={sessionId} onAcceptSql={setSqlText} />
            <div className="h-40 overflow-hidden rounded-md border border-border">
              <SqlEditor
                value={sqlText}
                onChange={setSqlText}
                onRun={runSql}
                onSelectionChange={setSelectedSql}
              />
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={runSql} disabled={loading}>
                {loading ? <Loader2 className="animate-spin" /> : <Play />}
                {selectedSql.trim() ? t("explorer.runSelection") : t("explorer.run")}
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
          <ResultGrid
            result={result}
            sort={mode === "filter" ? sort : null}
            onSort={mode === "filter" ? cycleSort : undefined}
            onRowOpen={mode === "filter" ? setOpenRow : undefined}
            onRowDelete={
              mode === "filter" && pkColumns.length > 0
                ? setDeleteIdx
                : undefined
            }
            onRowDuplicate={
              mode === "filter" && tableColumns.length > 0
                ? setDuplicateRow
                : undefined
            }
          />
        ) : null}
      </div>

      <footer className="flex items-center justify-between border-t border-border px-4 py-1.5 text-xs text-muted-foreground">
        <span>
          {result ? t("common.rowsCount", { n: rowCount }) : "—"}
          {mode === "filter" && ` · ${t("common.page", { n: page + 1 })}`}
        </span>
        {mode === "filter" && (
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              disabled={page === 0 || loading}
              onClick={() => goToPage(page - 1)}
              aria-label={t("common.previousPage")}
            >
              <ChevronLeft />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              disabled={!hasNextPage || loading}
              onClick={() => goToPage(page + 1)}
              aria-label={t("common.nextPage")}
            >
              <ChevronRight />
            </Button>
          </div>
        )}
      </footer>

      {openRow !== null && result && (
        <RecordDialog
          mode="edit"
          columns={result.columns}
          types={columnTypes}
          pkColumns={pkColumns}
          row={result.rows[openRow]}
          onSave={saveRow}
          onClose={() => setOpenRow(null)}
        />
      )}

      {showInsert && (
        <RecordDialog
          mode="insert"
          columns={tableColumns.map((c) => c.name)}
          types={columnTypes}
          pkColumns={pkColumns}
          onSave={saveInsert}
          onClose={() => setShowInsert(false)}
        />
      )}

      {duplicateRow !== null && result && (
        <RecordDialog
          mode="insert"
          columns={tableColumns.map((c) => c.name)}
          types={columnTypes}
          pkColumns={pkColumns}
          initialValues={Object.fromEntries(
            result.columns
              .map((col, j) => [col, result.rows[duplicateRow][j]] as const)
              .filter(([col]) => !pkColumns.includes(col)),
          )}
          onSave={saveInsert}
          onClose={() => setDuplicateRow(null)}
        />
      )}

      {deleteIdx !== null && (
        <ConfirmDialog
          title={t("explorer.deleteRecord")}
          description={t("explorer.deleteRecordDesc")}
          confirmLabel={t("common.delete")}
          destructive
          onConfirm={confirmDelete}
          onCancel={() => setDeleteIdx(null)}
        />
      )}

      {showHistory && (
        <CommandHistory
          sessionId={sessionId}
          onPick={(sql) => {
            setMode("sql");
            setSqlText(sql);
          }}
          onClose={() => setShowHistory(false)}
        />
      )}

      <DestructiveConfirmDialog
        open={pendingGuard !== null}
        onOpenChange={(open) => {
          if (!open) cancelDestructiveRun();
        }}
        analysis={pendingGuard?.analysis ?? null}
        running={loading}
        onCancel={cancelDestructiveRun}
        onConfirm={confirmDestructiveRun}
      />

      <DestructiveConfirmDialog
        open={pendingRowUpdate !== null}
        onOpenChange={(open) => {
          if (!open) cancelRowUpdate();
        }}
        analysis={pendingRowUpdate?.analysis ?? null}
        running={rowUpdateRunning}
        onCancel={cancelRowUpdate}
        onConfirm={confirmRowUpdate}
      />
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
  const { t } = useI18n();
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
          {m === "filter" ? t("explorer.filterMode") : t("explorer.sql")}
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
