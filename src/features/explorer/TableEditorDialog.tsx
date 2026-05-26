import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  KeyRound,
  Link2,
  Loader2,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n, type TKey } from "@/i18n";
import { cn } from "@/lib/utils";

import { explorerApi } from "./api";
import type { ColumnInfo, IndexInfo, SchemaInfo, TableInfo } from "./types";

type FkAction = "no_action" | "restrict" | "cascade" | "set_null" | "set_default";

interface ForeignKey {
  schema: string;
  table: string;
  column: string;
  onDelete: FkAction;
  onUpdate: FkAction;
}

interface OriginalColumn {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  isPrimaryKey: boolean;
}

interface ColumnDraft {
  id: string;
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  unique: boolean;
  defaultValue: string;
  fk: ForeignKey | null;
  fkOpen: boolean;
  /** Snapshot of the column's state at load time (edit mode only). */
  original?: OriginalColumn;
  /** Marked for DROP COLUMN on apply. */
  dropped?: boolean;
}

interface OriginalIndex {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

interface IndexDraft {
  id: string;
  name: string;
  /** Comma-separated free-form when the user types it. */
  columnsText: string;
  unique: boolean;
  original?: OriginalIndex;
  dropped?: boolean;
}

export type TableEditorMode = "create" | "edit";

interface TableEditorDialogProps {
  mode: TableEditorMode;
  sessionId: string;
  schema: string;
  /** Required in edit mode. */
  table?: string;
  onApplied: () => void;
  onClose: () => void;
}

/** Postgres types grouped into optgroups. */
const TYPE_GROUPS: { groupKey: string; types: string[] }[] = [
  {
    groupKey: "numbers",
    types: [
      "bigserial",
      "serial",
      "smallserial",
      "integer",
      "bigint",
      "smallint",
      "numeric",
      "real",
      "double precision",
    ],
  },
  { groupKey: "text", types: ["text", "varchar(255)", "char(1)"] },
  { groupKey: "boolean", types: ["boolean"] },
  {
    groupKey: "date",
    types: ["date", "timestamp", "timestamptz", "time", "interval"],
  },
  { groupKey: "json", types: ["json", "jsonb"] },
  { groupKey: "uuid", types: ["uuid"] },
  { groupKey: "binary", types: ["bytea"] },
];

const FK_ACTIONS: FkAction[] = [
  "no_action",
  "restrict",
  "cascade",
  "set_null",
  "set_default",
];

const FK_SQL: Record<FkAction, string> = {
  no_action: "NO ACTION",
  restrict: "RESTRICT",
  cascade: "CASCADE",
  set_null: "SET NULL",
  set_default: "SET DEFAULT",
};

function newId(): string {
  return crypto.randomUUID();
}

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function emptyColumn(): ColumnDraft {
  return {
    id: newId(),
    name: "",
    type: "text",
    nullable: true,
    primaryKey: false,
    unique: false,
    defaultValue: "",
    fk: null,
    fkOpen: false,
  };
}

function columnFromInfo(c: ColumnInfo): ColumnDraft {
  const original: OriginalColumn = {
    name: c.name,
    type: c.data_type,
    nullable: c.nullable,
    default: c.default,
    isPrimaryKey: c.is_primary_key,
  };
  return {
    id: newId(),
    name: c.name,
    type: c.data_type,
    nullable: c.nullable,
    primaryKey: c.is_primary_key,
    unique: false,
    defaultValue: c.default ?? "",
    fk: null,
    fkOpen: false,
    original,
  };
}

function emptyIndex(): IndexDraft {
  return { id: newId(), name: "", columnsText: "", unique: false };
}

function indexFromInfo(i: IndexInfo): IndexDraft {
  return {
    id: newId(),
    name: i.name,
    columnsText: i.columns.join(", "),
    unique: i.is_unique,
    original: {
      name: i.name,
      columns: i.columns,
      unique: i.is_unique,
      primary: i.is_primary,
    },
  };
}

function parseColumnList(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function columnDefinitionSql(col: ColumnDraft): string {
  const parts = [quote(col.name.trim()), col.type.trim() || "text"];
  if (!col.nullable) parts.push("NOT NULL");
  if (col.unique) parts.push("UNIQUE");
  if (col.defaultValue.trim().length > 0) {
    parts.push(`DEFAULT ${col.defaultValue.trim()}`);
  }
  return parts.join(" ");
}

function fkConstraintSql(
  schema: string,
  tableName: string,
  col: ColumnDraft,
): string | null {
  if (!col.fk) return null;
  const constraintName = `fk_${tableName}_${col.name.trim()}`;
  return [
    `ALTER TABLE ${quote(schema)}.${quote(tableName)}`,
    `  ADD CONSTRAINT ${quote(constraintName)}`,
    `  FOREIGN KEY (${quote(col.name.trim())})`,
    `  REFERENCES ${quote(col.fk.schema)}.${quote(col.fk.table)} (${quote(col.fk.column)})`,
    `  ON DELETE ${FK_SQL[col.fk.onDelete]} ON UPDATE ${FK_SQL[col.fk.onUpdate]};`,
  ].join("\n");
}

export function TableEditorDialog({
  mode,
  sessionId,
  schema,
  table,
  onApplied,
  onClose,
}: TableEditorDialogProps) {
  const { t } = useI18n();

  const [name, setName] = useState(table ?? "");
  const [columns, setColumns] = useState<ColumnDraft[]>(() =>
    mode === "create"
      ? [
          {
            ...emptyColumn(),
            name: "id",
            type: "bigserial",
            nullable: false,
            primaryKey: true,
          },
        ]
      : [],
  );
  const [indexes, setIndexes] = useState<IndexDraft[]>([]);
  const [loading, setLoading] = useState(mode === "edit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // FK picker data — schemas, tables-per-schema, columns-per-table.
  const [allSchemas, setAllSchemas] = useState<SchemaInfo[]>([]);
  const [tablesCache, setTablesCache] = useState<Record<string, TableInfo[]>>({});
  const [colsCache, setColsCache] = useState<Record<string, ColumnInfo[]>>({});

  // Load existing structure for edit mode.
  useEffect(() => {
    if (mode !== "edit" || !table) return;
    let cancelled = false;
    setLoading(true);
    explorerApi
      .describeTable(sessionId, schema, table)
      .then((d) => {
        if (cancelled) return;
        setColumns(d.columns.map(columnFromInfo));
        setIndexes(d.indexes.map(indexFromInfo));
        setError(null);
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [mode, sessionId, schema, table]);

  // Load schemas once for the FK picker.
  useEffect(() => {
    explorerApi
      .listSchemas(sessionId)
      .then(setAllSchemas)
      .catch(() => setAllSchemas([]));
  }, [sessionId]);

  const ensureTables = useCallback(
    async (s: string) => {
      if (tablesCache[s]) return tablesCache[s];
      const list = await explorerApi.listTables(sessionId, s);
      setTablesCache((c) => ({ ...c, [s]: list }));
      return list;
    },
    [sessionId, tablesCache],
  );

  const ensureCols = useCallback(
    async (s: string, tname: string) => {
      const key = `${s}.${tname}`;
      if (colsCache[key]) return colsCache[key];
      const d = await explorerApi.describeTable(sessionId, s, tname);
      setColsCache((c) => ({ ...c, [key]: d.columns }));
      return d.columns;
    },
    [sessionId, colsCache],
  );

  const updateColumn = (id: string, patch: Partial<ColumnDraft>) =>
    setColumns((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const addColumn = () => setColumns((cs) => [...cs, emptyColumn()]);
  const toggleDropColumn = (id: string) =>
    setColumns((cs) =>
      cs.map((c) => {
        if (c.id !== id) return c;
        if (c.original) return { ...c, dropped: !c.dropped };
        return c; // brand-new: removeColumn used instead
      }),
    );
  const removeNewColumn = (id: string) =>
    setColumns((cs) => cs.filter((c) => c.id !== id));

  const updateIndex = (id: string, patch: Partial<IndexDraft>) =>
    setIndexes((idxs) => idxs.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  const addIndex = () => setIndexes((idxs) => [...idxs, emptyIndex()]);
  const toggleDropIndex = (id: string) =>
    setIndexes((idxs) =>
      idxs.map((i) => {
        if (i.id !== id) return i;
        if (i.original) return { ...i, dropped: !i.dropped };
        return i;
      }),
    );
  const removeNewIndex = (id: string) =>
    setIndexes((idxs) => idxs.filter((i) => i.id !== id));

  /** Generate the SQL to apply: a single CREATE TABLE statement in create
   *  mode, or an ordered list of ALTER / DROP / CREATE statements in edit
   *  mode. */
  const sql = useMemo(() => {
    const tname = name.trim();
    if (mode === "create") {
      if (tname.length === 0) return "";
      const liveCols = columns.filter((c) => c.name.trim().length > 0);
      if (liveCols.length === 0) return "";
      const colSql = liveCols.map(columnDefinitionSql);
      const pkCols = liveCols
        .filter((c) => c.primaryKey)
        .map((c) => quote(c.name.trim()));
      if (pkCols.length > 0) {
        colSql.push(`PRIMARY KEY (${pkCols.join(", ")})`);
      }
      const stmts: string[] = [];
      stmts.push(
        `CREATE TABLE ${quote(schema)}.${quote(tname)} (\n  ${colSql.join(",\n  ")}\n);`,
      );
      for (const c of liveCols) {
        const fk = fkConstraintSql(schema, tname, c);
        if (fk) stmts.push(fk);
      }
      for (const idx of indexes) {
        if (idx.name.trim().length === 0) continue;
        const cols = parseColumnList(idx.columnsText);
        if (cols.length === 0) continue;
        const unique = idx.unique ? "UNIQUE " : "";
        stmts.push(
          `CREATE ${unique}INDEX ${quote(idx.name.trim())} ON ${quote(schema)}.${quote(tname)} (${cols.map(quote).join(", ")});`,
        );
      }
      return stmts.join("\n\n");
    }

    // edit mode
    if (!table) return "";
    const stmts: string[] = [];
    const qt = `${quote(schema)}.${quote(table)}`;

    // 1. Drop indexes first (before drop columns referencing them).
    for (const idx of indexes) {
      if (idx.original && idx.dropped && !idx.original.primary) {
        stmts.push(`DROP INDEX ${quote(schema)}.${quote(idx.original.name)};`);
      }
    }

    // 2. Drop columns.
    for (const c of columns) {
      if (c.original && c.dropped) {
        stmts.push(`ALTER TABLE ${qt} DROP COLUMN ${quote(c.original.name)};`);
      }
    }

    // 3. Rename columns.
    for (const c of columns) {
      if (!c.original || c.dropped) continue;
      if (c.name.trim() !== c.original.name) {
        stmts.push(
          `ALTER TABLE ${qt} RENAME COLUMN ${quote(c.original.name)} TO ${quote(c.name.trim())};`,
        );
      }
    }

    // 4. Alter type / null / default on remaining existing columns.
    for (const c of columns) {
      if (!c.original || c.dropped) continue;
      const colRef = quote(c.name.trim());
      if (c.type.trim() !== c.original.type) {
        stmts.push(
          `ALTER TABLE ${qt} ALTER COLUMN ${colRef} TYPE ${c.type.trim()} USING ${colRef}::${c.type.trim()};`,
        );
      }
      if (c.nullable !== c.original.nullable) {
        stmts.push(
          `ALTER TABLE ${qt} ALTER COLUMN ${colRef} ${c.nullable ? "DROP" : "SET"} NOT NULL;`,
        );
      }
      const origDefault = c.original.default ?? "";
      if (c.defaultValue.trim() !== origDefault.trim()) {
        if (c.defaultValue.trim().length === 0) {
          stmts.push(`ALTER TABLE ${qt} ALTER COLUMN ${colRef} DROP DEFAULT;`);
        } else {
          stmts.push(
            `ALTER TABLE ${qt} ALTER COLUMN ${colRef} SET DEFAULT ${c.defaultValue.trim()};`,
          );
        }
      }
    }

    // 5. Add new columns.
    for (const c of columns) {
      if (c.original) continue;
      if (c.name.trim().length === 0) continue;
      stmts.push(
        `ALTER TABLE ${qt} ADD COLUMN ${columnDefinitionSql(c)};`,
      );
    }

    // 6. Add foreign keys (only for FK objects set in this session).
    for (const c of columns) {
      if (c.dropped || !c.fk || c.name.trim().length === 0) continue;
      const fkSql = fkConstraintSql(schema, table, c);
      if (fkSql) stmts.push(fkSql);
    }

    // 7. Create new indexes.
    for (const idx of indexes) {
      if (idx.original) continue;
      if (idx.name.trim().length === 0) continue;
      const cols = parseColumnList(idx.columnsText);
      if (cols.length === 0) continue;
      const unique = idx.unique ? "UNIQUE " : "";
      stmts.push(
        `CREATE ${unique}INDEX ${quote(idx.name.trim())} ON ${qt} (${cols.map(quote).join(", ")});`,
      );
    }

    return stmts.join("\n\n");
  }, [mode, schema, table, name, columns, indexes]);

  const canApply = sql.trim().length > 0 && !busy && !loading;

  const submit = async () => {
    if (!sql.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await explorerApi.runQuery(sessionId, sql);
      await explorerApi.refreshDatabaseSchema(sessionId);
      onApplied();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const title =
    mode === "create"
      ? t("explorer.createTable.title")
      : t("explorer.createTable.editTitle");
  const desc =
    mode === "create"
      ? t("explorer.createTable.desc", { schema })
      : t("explorer.createTable.editDesc", { schema, table: table ?? "" });

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{desc}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex h-48 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="flex max-h-[65vh] flex-col gap-5 overflow-y-auto px-5 py-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="te-name" className="text-xs">
                {t("explorer.createTable.nameLabel")}
              </Label>
              <Input
                id="te-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("explorer.createTable.namePlaceholder")}
                disabled={busy || mode === "edit"}
              />
            </div>

            <ColumnsSection
              columns={columns}
              mode={mode}
              busy={busy}
              schema={schema}
              allSchemas={allSchemas}
              tablesCache={tablesCache}
              colsCache={colsCache}
              ensureTables={ensureTables}
              ensureCols={ensureCols}
              onUpdate={updateColumn}
              onAdd={addColumn}
              onDropExisting={toggleDropColumn}
              onRemoveNew={removeNewColumn}
            />

            <IndexesSection
              indexes={indexes}
              busy={busy}
              onUpdate={updateIndex}
              onAdd={addIndex}
              onDropExisting={toggleDropIndex}
              onRemoveNew={removeNewIndex}
            />

            <div>
              <Label className="mb-1.5 block text-xs">
                {t("explorer.createTable.previewLabel")}
              </Label>
              <pre className="max-h-48 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs text-muted-foreground">
                {sql || "—"}
              </pre>
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 border-t border-border bg-destructive/10 px-5 py-2.5">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <p className="text-xs text-destructive">{error}</p>
          </div>
        )}

        <DialogFooter className="border-t border-border px-5 py-3">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} disabled={!canApply}>
            {busy && <Loader2 className="animate-spin" />}
            {mode === "create"
              ? t("explorer.createTable.create")
              : sql.trim().length === 0
                ? t("explorer.createTable.nothingToApply")
                : t("explorer.createTable.apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ColumnsSectionProps {
  columns: ColumnDraft[];
  mode: TableEditorMode;
  busy: boolean;
  schema: string;
  allSchemas: SchemaInfo[];
  tablesCache: Record<string, TableInfo[]>;
  colsCache: Record<string, ColumnInfo[]>;
  ensureTables: (s: string) => Promise<TableInfo[]>;
  ensureCols: (s: string, t: string) => Promise<ColumnInfo[]>;
  onUpdate: (id: string, patch: Partial<ColumnDraft>) => void;
  onAdd: () => void;
  onDropExisting: (id: string) => void;
  onRemoveNew: (id: string) => void;
}

function ColumnsSection(props: ColumnsSectionProps) {
  const { t } = useI18n();
  const {
    columns,
    mode,
    busy,
    schema,
    allSchemas,
    tablesCache,
    colsCache,
    ensureTables,
    ensureCols,
    onUpdate,
    onAdd,
    onDropExisting,
    onRemoveNew,
  } = props;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{t("explorer.createTable.columnsLabel")}</Label>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onAdd}
          disabled={busy}
        >
          <Plus />
          {t("explorer.createTable.addColumn")}
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        {columns.map((col) => (
          <ColumnRow
            key={col.id}
            col={col}
            mode={mode}
            busy={busy}
            schema={schema}
            allSchemas={allSchemas}
            tablesCache={tablesCache}
            colsCache={colsCache}
            ensureTables={ensureTables}
            ensureCols={ensureCols}
            onUpdate={onUpdate}
            onDropExisting={onDropExisting}
            onRemoveNew={onRemoveNew}
          />
        ))}
        {columns.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {t("explorer.createTable.noColumns")}
          </p>
        )}
      </div>
    </div>
  );
}

interface ColumnRowProps {
  col: ColumnDraft;
  mode: TableEditorMode;
  busy: boolean;
  schema: string;
  allSchemas: SchemaInfo[];
  tablesCache: Record<string, TableInfo[]>;
  colsCache: Record<string, ColumnInfo[]>;
  ensureTables: (s: string) => Promise<TableInfo[]>;
  ensureCols: (s: string, t: string) => Promise<ColumnInfo[]>;
  onUpdate: (id: string, patch: Partial<ColumnDraft>) => void;
  onDropExisting: (id: string) => void;
  onRemoveNew: (id: string) => void;
}

function ColumnRow({
  col,
  mode,
  busy,
  schema,
  allSchemas,
  tablesCache,
  colsCache,
  ensureTables,
  ensureCols,
  onUpdate,
  onDropExisting,
  onRemoveNew,
}: ColumnRowProps) {
  const { t } = useI18n();
  const disabled = busy || !!col.dropped;
  const pkDisabled = mode === "edit" || disabled;

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border border-border bg-card p-3",
        col.dropped && "opacity-60",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={col.name}
          onChange={(e) => onUpdate(col.id, { name: e.target.value })}
          placeholder="column_name"
          disabled={disabled}
          className="min-w-32 flex-1"
        />
        <TypeSelect
          value={col.type}
          onChange={(type) => onUpdate(col.id, { type })}
          disabled={disabled}
        />
        <ToggleButton
          active={col.primaryKey}
          disabled={pkDisabled}
          title={t("explorer.createTable.togglePk")}
          onClick={() =>
            onUpdate(col.id, {
              primaryKey: !col.primaryKey,
              nullable: !col.primaryKey ? false : col.nullable,
            })
          }
        >
          <KeyRound className="size-3.5" />
          PK
        </ToggleButton>
        <ToggleButton
          active={!col.nullable}
          disabled={disabled || col.primaryKey}
          title={t("explorer.createTable.toggleNotNull")}
          onClick={() => onUpdate(col.id, { nullable: !col.nullable })}
        >
          NOT NULL
        </ToggleButton>
        <ToggleButton
          active={col.unique}
          disabled={disabled}
          title={t("explorer.createTable.toggleUnique")}
          onClick={() => onUpdate(col.id, { unique: !col.unique })}
        >
          {t("explorer.createTable.colUnique")}
        </ToggleButton>
        <ToggleButton
          active={col.fk !== null || col.fkOpen}
          disabled={disabled}
          title={t("explorer.createTable.fkButton")}
          onClick={() => onUpdate(col.id, { fkOpen: !col.fkOpen })}
        >
          <Link2 className="size-3.5" />
          FK
        </ToggleButton>
        <Input
          value={col.defaultValue}
          onChange={(e) => onUpdate(col.id, { defaultValue: e.target.value })}
          placeholder={t("explorer.createTable.colDefault")}
          disabled={disabled}
          className="w-40"
        />
        {col.original ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8"
            disabled={busy}
            onClick={() => onDropExisting(col.id)}
            title={
              col.dropped
                ? t("explorer.createTable.restoreColumn")
                : t("explorer.createTable.dropColumn")
            }
          >
            {col.dropped ? (
              <RotateCcw className="size-4" />
            ) : (
              <Trash2 className="size-4 text-destructive" />
            )}
          </Button>
        ) : (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8"
            disabled={busy}
            onClick={() => onRemoveNew(col.id)}
            title={t("explorer.createTable.dropColumn")}
          >
            <Trash2 className="size-4" />
          </Button>
        )}
        {col.original && !col.dropped && isColumnModified(col) && (
          <span
            className="ml-1 inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-600 dark:text-amber-400"
            title="modified"
          >
            <Sparkles className="size-3" />
            mod
          </span>
        )}
      </div>

      {col.fkOpen && !col.dropped && (
        <FkRow
          col={col}
          allSchemas={allSchemas}
          tablesCache={tablesCache}
          colsCache={colsCache}
          ensureTables={ensureTables}
          ensureCols={ensureCols}
          onUpdate={onUpdate}
          defaultSchema={schema}
          disabled={busy}
        />
      )}
    </div>
  );
}

function isColumnModified(col: ColumnDraft): boolean {
  if (!col.original) return false;
  if (col.name.trim() !== col.original.name) return true;
  if (col.type.trim() !== col.original.type) return true;
  if (col.nullable !== col.original.nullable) return true;
  const origDefault = col.original.default ?? "";
  if (col.defaultValue.trim() !== origDefault.trim()) return true;
  if (col.fk !== null) return true;
  return false;
}

interface FkRowProps {
  col: ColumnDraft;
  allSchemas: SchemaInfo[];
  tablesCache: Record<string, TableInfo[]>;
  colsCache: Record<string, ColumnInfo[]>;
  ensureTables: (s: string) => Promise<TableInfo[]>;
  ensureCols: (s: string, t: string) => Promise<ColumnInfo[]>;
  onUpdate: (id: string, patch: Partial<ColumnDraft>) => void;
  defaultSchema: string;
  disabled: boolean;
}

function FkRow({
  col,
  allSchemas,
  tablesCache,
  colsCache,
  ensureTables,
  ensureCols,
  onUpdate,
  defaultSchema,
  disabled,
}: FkRowProps) {
  const { t } = useI18n();
  const fk: ForeignKey = col.fk ?? {
    schema: defaultSchema,
    table: "",
    column: "",
    onDelete: "no_action",
    onUpdate: "no_action",
  };

  useEffect(() => {
    void ensureTables(fk.schema);
  }, [fk.schema, ensureTables]);

  useEffect(() => {
    if (fk.table.length > 0) {
      void ensureCols(fk.schema, fk.table);
    }
  }, [fk.schema, fk.table, ensureCols]);

  const tables = tablesCache[fk.schema] ?? [];
  const cols = fk.table ? colsCache[`${fk.schema}.${fk.table}`] ?? [] : [];

  const set = (patch: Partial<ForeignKey>) =>
    onUpdate(col.id, { fk: { ...fk, ...patch } });

  return (
    <div className="grid grid-cols-1 gap-2 rounded-md border border-dashed border-border bg-muted/30 p-3 text-xs sm:grid-cols-[1fr_1fr_1fr_auto]">
      <SelectField
        label={t("explorer.createTable.fkRefSchema")}
        value={fk.schema}
        onChange={(v) => set({ schema: v, table: "", column: "" })}
        disabled={disabled}
      >
        {allSchemas.map((s) => (
          <option key={s.name} value={s.name}>
            {s.name}
          </option>
        ))}
      </SelectField>
      <SelectField
        label={t("explorer.createTable.fkRefTable")}
        value={fk.table}
        onChange={(v) => set({ table: v, column: "" })}
        disabled={disabled || tables.length === 0}
      >
        <option value="">—</option>
        {tables.map((tbl) => (
          <option key={tbl.name} value={tbl.name}>
            {tbl.name}
          </option>
        ))}
      </SelectField>
      <SelectField
        label={t("explorer.createTable.fkRefColumn")}
        value={fk.column}
        onChange={(v) => set({ column: v })}
        disabled={disabled || cols.length === 0}
      >
        <option value="">—</option>
        {cols.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
      </SelectField>
      <div className="flex items-end">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => onUpdate(col.id, { fk: null, fkOpen: false })}
          disabled={disabled}
        >
          {t("explorer.createTable.fkClear")}
        </Button>
      </div>
      <SelectField
        label={t("explorer.createTable.fkOnDelete")}
        value={fk.onDelete}
        onChange={(v) => set({ onDelete: v as FkAction })}
        disabled={disabled}
      >
        {FK_ACTIONS.map((a) => (
          <option key={a} value={a}>
            {fkActionLabel(t, a)}
          </option>
        ))}
      </SelectField>
      <SelectField
        label={t("explorer.createTable.fkOnUpdate")}
        value={fk.onUpdate}
        onChange={(v) => set({ onUpdate: v as FkAction })}
        disabled={disabled}
      >
        {FK_ACTIONS.map((a) => (
          <option key={a} value={a}>
            {fkActionLabel(t, a)}
          </option>
        ))}
      </SelectField>
      <div />
      <div />
    </div>
  );
}

type Translator = (path: TKey, params?: Record<string, string | number>) => string;

function fkActionLabel(t: Translator, action: FkAction): string {
  switch (action) {
    case "no_action":
      return t("explorer.createTable.fkActions.noAction");
    case "restrict":
      return t("explorer.createTable.fkActions.restrict");
    case "cascade":
      return t("explorer.createTable.fkActions.cascade");
    case "set_null":
      return t("explorer.createTable.fkActions.setNull");
    case "set_default":
      return t("explorer.createTable.fkActions.setDefault");
  }
}

function typeGroupLabel(t: Translator, key: string): string {
  switch (key) {
    case "numbers":
      return t("explorer.createTable.types.numbers");
    case "text":
      return t("explorer.createTable.types.text");
    case "boolean":
      return t("explorer.createTable.types.boolean");
    case "date":
      return t("explorer.createTable.types.date");
    case "json":
      return t("explorer.createTable.types.json");
    case "uuid":
      return t("explorer.createTable.types.uuid");
    case "binary":
      return t("explorer.createTable.types.binary");
    default:
      return key;
  }
}

interface IndexesSectionProps {
  indexes: IndexDraft[];
  busy: boolean;
  onUpdate: (id: string, patch: Partial<IndexDraft>) => void;
  onAdd: () => void;
  onDropExisting: (id: string) => void;
  onRemoveNew: (id: string) => void;
}

function IndexesSection({
  indexes,
  busy,
  onUpdate,
  onAdd,
  onDropExisting,
  onRemoveNew,
}: IndexesSectionProps) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{t("explorer.createTable.indexesLabel")}</Label>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onAdd}
          disabled={busy}
        >
          <Plus />
          {t("explorer.createTable.addIndex")}
        </Button>
      </div>

      {indexes.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("explorer.createTable.noIndexes")}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {indexes.map((idx) => (
            <div
              key={idx.id}
              className={cn(
                "flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-3",
                idx.dropped && "opacity-60",
              )}
            >
              <Input
                value={idx.name}
                onChange={(e) => onUpdate(idx.id, { name: e.target.value })}
                placeholder={t("explorer.createTable.indexName")}
                disabled={busy || !!idx.dropped || !!idx.original?.primary}
                className="w-48"
              />
              <Input
                value={idx.columnsText}
                onChange={(e) =>
                  onUpdate(idx.id, { columnsText: e.target.value })
                }
                placeholder={`${t("explorer.createTable.indexColumns")} (a, b)`}
                disabled={busy || !!idx.dropped || !!idx.original}
                className="min-w-48 flex-1"
              />
              <ToggleButton
                active={idx.unique}
                disabled={busy || !!idx.dropped || !!idx.original}
                title={t("explorer.createTable.indexUnique")}
                onClick={() => onUpdate(idx.id, { unique: !idx.unique })}
              >
                {t("explorer.createTable.indexUnique")}
              </ToggleButton>
              {idx.original?.primary && (
                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-600 dark:text-amber-400">
                  PRIMARY
                </span>
              )}
              {idx.original ? (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  disabled={busy || !!idx.original.primary}
                  onClick={() => onDropExisting(idx.id)}
                  title={
                    idx.dropped
                      ? t("explorer.createTable.restoreColumn")
                      : t("explorer.createTable.dropIndex")
                  }
                >
                  {idx.dropped ? (
                    <RotateCcw className="size-4" />
                  ) : (
                    <Trash2 className="size-4 text-destructive" />
                  )}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  disabled={busy}
                  onClick={() => onRemoveNew(idx.id)}
                  title={t("explorer.createTable.dropIndex")}
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface ToggleButtonProps {
  active: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}

function ToggleButton({
  active,
  disabled,
  title,
  onClick,
  children,
}: ToggleButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "inline-flex h-9 items-center gap-1 rounded-md border px-2.5 text-xs font-semibold transition-colors",
        active
          ? "border-primary bg-primary/15 text-primary"
          : "border-border bg-transparent text-muted-foreground hover:bg-accent",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      {children}
    </button>
  );
}

interface TypeSelectProps {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}

function TypeSelect({ value, onChange, disabled }: TypeSelectProps) {
  const { t } = useI18n();
  // The value may not be one of the known types (existing tables, custom
  // types). Include it as a leading option so the select reflects the
  // current value instead of silently snapping to the first listed type.
  const known = new Set(TYPE_GROUPS.flatMap((g) => g.types));
  const showCustom = value.length > 0 && !known.has(value);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={cn(
        "h-9 min-w-40 rounded-md border border-input bg-transparent px-2 text-sm",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-60",
      )}
    >
      {showCustom && <option value={value}>{value}</option>}
      {TYPE_GROUPS.map((g) => (
        <optgroup key={g.groupKey} label={typeGroupLabel(t, g.groupKey)}>
          {g.types.map((tp) => (
            <option key={tp} value={tp}>
              {tp}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

interface SelectFieldProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  children: React.ReactNode;
}

function SelectField({
  label,
  value,
  onChange,
  disabled,
  children,
}: SelectFieldProps) {
  return (
    <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
      <span>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={cn(
          "h-8 rounded-md border border-input bg-transparent px-2 text-sm text-foreground",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}
      >
        {children}
      </select>
    </label>
  );
}
