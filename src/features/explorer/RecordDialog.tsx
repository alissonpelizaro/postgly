import { useMemo, useState } from "react";
import { AlertCircle, Braces, KeyRound, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

import type { CellValue } from "./types";

type Mode = "edit" | "insert";

interface RecordDialogProps {
  mode: Mode;
  /** Column names, in display order. */
  columns: string[];
  /** Maps a column name to its SQL data type (lowercased). */
  types: Record<string, string>;
  /** Names of the primary-key columns. */
  pkColumns: string[];
  /** The row's cell values, aligned with `columns` (edit mode only). */
  row?: (string | null)[];
  /** Persist the row; rejects with an error string on failure. */
  onSave: (values: CellValue[]) => Promise<void>;
  onClose: () => void;
}

/** `true` for Postgres JSON column types. */
const isJsonType = (type: string | undefined) =>
  type === "json" || type === "jsonb";

/** Pretty-print a JSON string; returns the input unchanged if invalid. */
function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/**
 * View, edit or create a single table row.
 *
 * In edit mode the primary-key columns are locked and only changed cells
 * are sent; in insert mode every column is editable and untouched columns
 * are omitted so database defaults apply. JSON / JSONB cells are shown
 * pretty-printed in a monospace editor.
 */
export function RecordDialog({
  mode,
  columns,
  types,
  pkColumns,
  row,
  onSave,
  onClose,
}: RecordDialogProps) {
  const { t } = useI18n();
  // The value shown at open: edit seeds from the row (JSON pretty-printed),
  // insert leaves every field `undefined` (untouched).
  const initial = useMemo<Record<string, string | null | undefined>>(() => {
    if (mode === "insert") {
      return Object.fromEntries(columns.map((c) => [c, undefined]));
    }
    return Object.fromEntries(
      columns.map((c, i) => {
        const raw = row?.[i] ?? null;
        return [c, raw !== null && isJsonType(types[c]) ? prettyJson(raw) : raw];
      }),
    );
  }, [mode, columns, row, types]);

  // Edited values. `null` is SQL NULL; `undefined` means untouched.
  const [draft, setDraft] =
    useState<Record<string, string | null | undefined>>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editable = mode === "insert" || pkColumns.length > 0;

  // What gets sent on save: edited non-key cells (edit) or every touched
  // column (insert).
  const values = useMemo<CellValue[]>(() => {
    if (mode === "insert") {
      return columns
        .filter((c) => draft[c] !== undefined)
        .map((c) => ({ column: c, value: draft[c] ?? null }));
    }
    return columns
      .filter((c) => !pkColumns.includes(c) && draft[c] !== initial[c])
      .map((c) => ({ column: c, value: draft[c] ?? null }));
  }, [mode, columns, draft, initial, pkColumns]);

  const setValue = (column: string, value: string | null) =>
    setDraft((d) => ({ ...d, [column]: value }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(values);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="max-h-[85vh] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle>
            {mode === "insert" ? t("explorer.record.newTitle") : t("explorer.record.editTitle")}
          </DialogTitle>
          <DialogDescription>
            {mode === "insert"
              ? t("explorer.record.newDesc")
              : editable
                ? t("explorer.record.editDesc")
                : t("explorer.record.readOnlyDesc")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto px-5 py-4">
          {columns.map((column) => {
            const isPk = pkColumns.includes(column);
            const locked = (mode === "edit" && isPk) || !editable;
            const json = isJsonType(types[column]);
            const value = draft[column];
            const isNull = value === null;
            return (
              <div key={column} className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <Label className="flex items-center gap-1.5 text-xs">
                    {isPk && <KeyRound className="size-3 text-amber-500" />}
                    {json && <Braces className="size-3 text-sky-500" />}
                    {column}
                    <span className="text-muted-foreground">
                      {types[column]}
                    </span>
                  </Label>
                  <button
                    type="button"
                    disabled={locked || saving}
                    onClick={() => setValue(column, isNull ? "" : null)}
                    className={cn(
                      "text-[10px] uppercase tracking-wide transition-colors",
                      isNull
                        ? "font-medium text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                      (locked || saving) && "pointer-events-none opacity-40",
                    )}
                  >
                    NULL
                  </button>
                </div>
                <textarea
                  value={value ?? ""}
                  disabled={locked || saving || isNull}
                  placeholder={
                    isNull
                      ? "NULL"
                      : mode === "insert"
                        ? t("explorer.record.defaultPlaceholder")
                        : ""
                  }
                  onChange={(e) => setValue(column, e.target.value)}
                  rows={json ? 6 : 1}
                  className={cn(
                    "resize-y rounded-md border border-border bg-transparent px-3 py-1.5 text-sm",
                    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    "disabled:cursor-not-allowed disabled:opacity-60",
                    json ? "min-h-24 font-mono text-xs" : "min-h-9",
                    isNull && "italic placeholder:text-muted-foreground",
                  )}
                />
              </div>
            );
          })}
        </div>

        {error && (
          <div className="flex items-start gap-2 border-t border-border bg-destructive/10 px-5 py-2.5">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <p className="text-xs text-destructive">{error}</p>
          </div>
        )}

        <DialogFooter className="border-t border-border px-5 py-3">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={save}
            disabled={!editable || saving || values.length === 0}
          >
            {saving && <Loader2 className="animate-spin" />}
            {mode === "insert" ? t("common.insert") : t("common.save")}
            {values.length > 0 && ` (${values.length})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
