import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ChevronRight,
  Eraser,
  Eye,
  Filter,
  FolderPlus,
  Loader2,
  Plus,
  RefreshCw,
  Table2,
  Trash2,
  X,
} from "lucide-react";

import { settingsApi } from "@/features/settings/api";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

import { explorerApi } from "./api";
import { CreateSchemaDialog } from "./CreateSchemaDialog";
import { DestructiveConfirmDialog } from "./DestructiveConfirmDialog";
import { TableEditorDialog } from "./TableEditorDialog";
import type {
  SchemaInfo,
  StatementAnalysis,
  TableInfo,
  TableRef,
} from "./types";

type MutationOp = "drop" | "truncate" | "delete" | "drop_schema";

interface SchemaTreeProps {
  sessionId: string;
  selected: TableRef | null;
  onSelect: (table: TableRef) => void;
  /** Called after a successful destructive op so the right pane can refresh
   *  and the selection can be cleared on DROP. */
  onTableMutation?: (op: MutationOp, schema: string, table: string) => void;
}

const SYSTEM_SCHEMA_PREFIXES = ["pg_"];
const SYSTEM_SCHEMA_NAMES = new Set(["information_schema"]);

const isSystemSchema = (name: string): boolean => {
  if (SYSTEM_SCHEMA_NAMES.has(name)) return true;
  return SYSTEM_SCHEMA_PREFIXES.some((p) => name.startsWith(p));
};

interface TableMenu {
  x: number;
  y: number;
  schema: string;
  table: string;
}

interface SchemaMenu {
  x: number;
  y: number;
  schema: string;
}

interface PendingOp {
  sql: string;
  op: MutationOp;
  schema: string;
  table: string | null;
  analysis: StatementAnalysis | null;
}

/** Left-panel tree: schemas that expand to reveal their tables and views. */
export function SchemaTree({
  sessionId,
  selected,
  onSelect,
  onTableMutation,
}: SchemaTreeProps) {
  const { t } = useI18n();
  const [schemas, setSchemas] = useState<SchemaInfo[]>([]);
  const [loadingSchemas, setLoadingSchemas] = useState(true);
  const [schemasError, setSchemasError] = useState<string | null>(null);
  const [showSystem, setShowSystem] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const filterInputRef = useRef<HTMLInputElement | null>(null);

  // Tables cache + expand / load state, keyed by schema. Lifted here so
  // refreshes and DROP can update one schema without remounting the rest.
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set());
  const [tablesBySchema, setTablesBySchema] = useState<
    Record<string, TableInfo[] | null>
  >({});
  const [loadingSchemaTables, setLoadingSchemaTables] = useState<Set<string>>(
    new Set(),
  );
  const [tableErrors, setTableErrors] = useState<Record<string, string>>({});

  const [tableMenu, setTableMenu] = useState<TableMenu | null>(null);
  const [schemaMenu, setSchemaMenu] = useState<SchemaMenu | null>(null);
  const [createForSchema, setCreateForSchema] = useState<string | null>(null);
  const [createSchemaOpen, setCreateSchemaOpen] = useState(false);
  const [pending, setPending] = useState<PendingOp | null>(null);
  const [running, setRunning] = useState(false);

  const loadSchemas = useCallback(async () => {
    setLoadingSchemas(true);
    try {
      setSchemas(await explorerApi.listSchemas(sessionId));
      setSchemasError(null);
    } catch (e) {
      setSchemasError(String(e));
    } finally {
      setLoadingSchemas(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadSchemas();
  }, [loadSchemas]);

  // Dismiss any open right-click menu on outside click / scroll.
  useEffect(() => {
    if (!tableMenu && !schemaMenu) return;
    const close = () => {
      setTableMenu(null);
      setSchemaMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [tableMenu, schemaMenu]);

  const loadTables = useCallback(
    async (schema: string) => {
      setLoadingSchemaTables((s) => new Set(s).add(schema));
      try {
        const tables = await explorerApi.listTables(sessionId, schema);
        setTablesBySchema((m) => ({ ...m, [schema]: tables }));
        setTableErrors((e) => {
          if (!(schema in e)) return e;
          const copy = { ...e };
          delete copy[schema];
          return copy;
        });
      } catch (e) {
        setTableErrors((m) => ({ ...m, [schema]: String(e) }));
      } finally {
        setLoadingSchemaTables((s) => {
          const next = new Set(s);
          next.delete(schema);
          return next;
        });
      }
    },
    [sessionId],
  );

  const toggleSchema = async (schema: string) => {
    const willExpand = !expandedSchemas.has(schema);
    setExpandedSchemas((s) => {
      const next = new Set(s);
      if (willExpand) next.add(schema);
      else next.delete(schema);
      return next;
    });
    if (willExpand && tablesBySchema[schema] === undefined) {
      await loadTables(schema);
    }
  };

  /** Refresh button: re-fetches the schema list + the tables for every
   *  currently-expanded schema. Preserves expanded state. */
  const refresh = async () => {
    await loadSchemas();
    await Promise.all(
      Array.from(expandedSchemas).map((s) => loadTables(s)),
    );
  };

  const visibleSchemas = useMemo(() => {
    const base = showSystem
      ? schemas
      : schemas.filter((s) => !isSystemSchema(s.name));
    const q = filter.trim().toLowerCase();
    if (!q) return base;
    return base.filter((s) => s.name.toLowerCase().includes(q));
  }, [schemas, showSystem, filter]);

  useEffect(() => {
    if (filterOpen) filterInputRef.current?.focus();
  }, [filterOpen]);

  const executeOp = useCallback(
    async (op: PendingOp) => {
      setRunning(true);
      try {
        await explorerApi.runQuery(sessionId, op.sql);
        await explorerApi.refreshDatabaseSchema(sessionId);
        setPending(null);
        // For DROP: refresh that schema's tables (table is gone).
        // For TRUNCATE/DELETE: schema list is unchanged, only rows.
        // For DROP SCHEMA: reload schema list + drop cached tables.
        if (op.op === "drop") {
          await loadTables(op.schema);
        } else if (op.op === "drop_schema") {
          setExpandedSchemas((s) => {
            const next = new Set(s);
            next.delete(op.schema);
            return next;
          });
          setTablesBySchema((m) => {
            if (!(op.schema in m)) return m;
            const copy = { ...m };
            delete copy[op.schema];
            return copy;
          });
          await loadSchemas();
        }
        if (op.table) onTableMutation?.(op.op, op.schema, op.table);
      } catch (e) {
        setSchemasError(String(e));
        setPending(null);
      } finally {
        setRunning(false);
      }
    },
    [sessionId, loadTables, loadSchemas, onTableMutation],
  );

  const runWithGuard = async (op: Omit<PendingOp, "analysis">) => {
    let confirmDestructive = true;
    try {
      confirmDestructive = (await settingsApi.get()).safety.confirm_destructive;
    } catch {
      // Settings unavailable → keep the safe default (confirm).
    }

    if (!confirmDestructive) {
      await executeOp({ ...op, analysis: null });
      return;
    }

    setPending({ ...op, analysis: null });
    try {
      const analysis = await explorerApi.analyzeStatement(sessionId, op.sql);
      if (!analysis.destructive) {
        setPending(null);
        await executeOp({ ...op, analysis: null });
        return;
      }
      setPending({ ...op, analysis });
    } catch (e) {
      setPending(null);
      setSchemasError(String(e));
    }
  };

  const confirmGuard = async () => {
    if (!pending) return;
    await executeOp(pending);
  };

  const cancelGuard = () => {
    if (running) return;
    setPending(null);
  };

  const quote = (n: string) => `"${n.replace(/"/g, '""')}"`;

  const truncateTable = (schema: string, table: string) =>
    runWithGuard({
      sql: `TRUNCATE TABLE ${quote(schema)}.${quote(table)};`,
      op: "truncate",
      schema,
      table,
    });
  const dropTable = (schema: string, table: string) =>
    runWithGuard({
      sql: `DROP TABLE ${quote(schema)}.${quote(table)};`,
      op: "drop",
      schema,
      table,
    });
  const deleteAllRows = (schema: string, table: string) =>
    runWithGuard({
      sql: `DELETE FROM ${quote(schema)}.${quote(table)};`,
      op: "delete",
      schema,
      table,
    });
  const dropSchema = (schema: string) =>
    runWithGuard({
      sql: `DROP SCHEMA ${quote(schema)} CASCADE;`,
      op: "drop_schema",
      schema,
      table: null,
    });

  const afterCreate = async () => {
    if (createForSchema) {
      setExpandedSchemas((s) => new Set(s).add(createForSchema));
      await loadTables(createForSchema);
    }
  };

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="border-b border-border">
        <div className="flex items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <span>{t("explorer.schemas")}</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setCreateSchemaOpen(true)}
              title={t("explorer.newSchema")}
              className="flex size-6 items-center justify-center rounded-sm hover:bg-accent"
            >
              <FolderPlus className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                setFilterOpen((v) => {
                  if (v) setFilter("");
                  return !v;
                });
              }}
              title={t("explorer.filterSchemas")}
              className={cn(
                "flex size-6 items-center justify-center rounded-sm hover:bg-accent",
                (filterOpen || filter) && "text-primary",
              )}
            >
              <Filter className="size-3.5" />
            </button>
          </div>
        </div>
        {filterOpen && (
          <div className="relative px-3 pb-2">
            <input
              ref={filterInputRef}
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setFilter("");
                  setFilterOpen(false);
                }
              }}
              placeholder={t("explorer.filterSchemasPlaceholder")}
              className={cn(
                "w-full rounded-md border border-border bg-background px-2 py-1 pr-7 text-xs",
                "focus:outline-none focus:ring-1 focus:ring-primary",
              )}
            />
            {filter && (
              <button
                type="button"
                onClick={() => {
                  setFilter("");
                  filterInputRef.current?.focus();
                }}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {loadingSchemas && schemas.length === 0 ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : schemasError ? (
          <div className="flex items-start gap-2 px-3 py-4 text-xs text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span className="break-words">{schemasError}</span>
          </div>
        ) : (
          visibleSchemas.map((schema) => (
            <SchemaNode
              key={schema.name}
              schema={schema.name}
              expanded={expandedSchemas.has(schema.name)}
              tables={tablesBySchema[schema.name] ?? null}
              loading={loadingSchemaTables.has(schema.name)}
              error={tableErrors[schema.name] ?? null}
              selected={selected}
              onToggle={() => void toggleSchema(schema.name)}
              onSelect={onSelect}
              onSchemaContext={(x, y) =>
                setSchemaMenu({ x, y, schema: schema.name })
              }
              onTableContext={(x, y, table) =>
                setTableMenu({ x, y, schema: schema.name, table })
              }
            />
          ))
        )}
      </div>

      <SchemaFooter
        showSystem={showSystem}
        onToggleSystem={setShowSystem}
        onRefresh={refresh}
        refreshing={loadingSchemas}
      />

      {schemaMenu && (
        <ContextMenu x={schemaMenu.x} y={schemaMenu.y}>
          <ContextItem
            icon={<Plus className="size-4" />}
            onClick={() => {
              setCreateForSchema(schemaMenu.schema);
              setSchemaMenu(null);
            }}
          >
            {t("explorer.newTable")}
          </ContextItem>
          <ContextItem
            icon={<Trash2 className="size-4" />}
            destructive
            onClick={() => {
              const { schema } = schemaMenu;
              setSchemaMenu(null);
              void dropSchema(schema);
            }}
          >
            {t("explorer.dropSchema")}
          </ContextItem>
        </ContextMenu>
      )}

      {tableMenu && (
        <ContextMenu x={tableMenu.x} y={tableMenu.y}>
          <ContextItem
            icon={<Eraser className="size-4" />}
            onClick={() => {
              const { schema, table } = tableMenu;
              setTableMenu(null);
              void truncateTable(schema, table);
            }}
          >
            {t("explorer.truncateTable")}
          </ContextItem>
          <ContextItem
            icon={<X className="size-4" />}
            onClick={() => {
              const { schema, table } = tableMenu;
              setTableMenu(null);
              void deleteAllRows(schema, table);
            }}
          >
            {t("explorer.deleteAllRows")}
          </ContextItem>
          <ContextItem
            icon={<Trash2 className="size-4" />}
            destructive
            onClick={() => {
              const { schema, table } = tableMenu;
              setTableMenu(null);
              void dropTable(schema, table);
            }}
          >
            {t("explorer.dropTable")}
          </ContextItem>
        </ContextMenu>
      )}

      {createForSchema !== null && (
        <TableEditorDialog
          mode="create"
          sessionId={sessionId}
          schema={createForSchema}
          onApplied={() => void afterCreate()}
          onClose={() => setCreateForSchema(null)}
        />
      )}

      {createSchemaOpen && (
        <CreateSchemaDialog
          sessionId={sessionId}
          onApplied={() => void loadSchemas()}
          onClose={() => setCreateSchemaOpen(false)}
        />
      )}

      <DestructiveConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) cancelGuard();
        }}
        analysis={pending?.analysis ?? null}
        running={running}
        onCancel={cancelGuard}
        onConfirm={confirmGuard}
      />
    </div>
  );
}

interface SchemaFooterProps {
  showSystem: boolean;
  onToggleSystem: (next: boolean) => void;
  onRefresh: () => void;
  refreshing: boolean;
}

function SchemaFooter({
  showSystem,
  onToggleSystem,
  onRefresh,
  refreshing,
}: SchemaFooterProps) {
  const { t } = useI18n();
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-t border-border bg-muted/30 px-3 py-2">
      <label className="flex cursor-pointer items-center gap-2 text-[12px] text-muted-foreground">
        <input
          type="checkbox"
          className="size-3.5"
          checked={showSystem}
          onChange={(e) => onToggleSystem(e.target.checked)}
        />
        <span>{t("explorer.showSystemSchemas")}</span>
      </label>
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        className={cn(
          "flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs",
          "hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60",
        )}
        title={t("explorer.refreshSchemas")}
      >
        {refreshing ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <RefreshCw className="size-3.5" />
        )}
        {t("explorer.refreshSchemas")}
      </button>
    </div>
  );
}

interface SchemaNodeProps {
  schema: string;
  expanded: boolean;
  tables: TableInfo[] | null;
  loading: boolean;
  error: string | null;
  selected: TableRef | null;
  onToggle: () => void;
  onSelect: (table: TableRef) => void;
  onSchemaContext: (x: number, y: number) => void;
  onTableContext: (x: number, y: number, table: string) => void;
}

function SchemaNode({
  schema,
  expanded,
  tables,
  loading,
  error,
  selected,
  onToggle,
  onSelect,
  onSchemaContext,
  onTableContext,
}: SchemaNodeProps) {
  const { t } = useI18n();
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        onContextMenu={(e) => {
          e.preventDefault();
          onSchemaContext(e.clientX, e.clientY);
        }}
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
          {loading && tables === null ? (
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
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onTableContext(e.clientX, e.clientY, table.name);
                  }}
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

function ContextMenu({
  x,
  y,
  children,
}: {
  x: number;
  y: number;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed z-50 min-w-48 rounded-md border border-border bg-popover p-1 shadow-md"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

function ContextItem({
  icon,
  destructive,
  onClick,
  children,
}: {
  icon: React.ReactNode;
  destructive?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent",
        destructive && "text-destructive",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
