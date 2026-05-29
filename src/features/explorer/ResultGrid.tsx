import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ClipboardCopy,
  Copy,
  Rows3,
  Trash2,
} from "lucide-react";

import { useI18n } from "@/i18n";
import { getColumnSeparator } from "@/lib/copy-prefs";
import { cn } from "@/lib/utils";

import type { OrderBy, QueryResult } from "./types";

interface ResultGridProps {
  result: QueryResult;
  /** Active sort, shown as an arrow on the column header. */
  sort?: OrderBy | null;
  /** Called when a sortable header is clicked. */
  onSort?: (column: string) => void;
  /** Called when a row is double-clicked; enables row-open affordance. */
  onRowOpen?: (rowIndex: number) => void;
  /** Called from the right-click menu; enables the delete affordance. */
  onRowDelete?: (rowIndex: number) => void;
  /** Called from the right-click menu; enables the duplicate affordance. */
  onRowDuplicate?: (rowIndex: number) => void;
}

const DEFAULT_COL_WIDTH = 200;
const MIN_COL_WIDTH = 60;

/** Renders a query result: a data grid, or a confirmation for statements
 * that return no rows (INSERT / UPDATE / DDL). */
export function ResultGrid({
  result,
  sort,
  onSort,
  onRowOpen,
  onRowDelete,
  onRowDuplicate,
}: ResultGridProps) {
  const { t } = useI18n();
  // Right-click row menu: viewport coords, the targeted row, and the
  // column under the cursor (`null` for the row-number gutter cell).
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    rowIndex: number;
    colIndex: number | null;
  } | null>(null);

  // Per-column widths. Empty until the user drags a resizer.
  const [widths, setWidths] = useState<Record<string, number>>({});
  const resizingRef = useRef(false);

  // Reset widths when the column set changes (new table or different query).
  const colsKey = result.columns.join("|");
  useEffect(() => {
    setWidths({});
  }, [colsKey]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  const startResize = (col: string, e: React.MouseEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    resizingRef.current = true;
    const startX = e.clientX;
    const th = (e.currentTarget.parentElement as HTMLElement) ?? null;
    const startWidth = widths[col] ?? th?.offsetWidth ?? DEFAULT_COL_WIDTH;
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(MIN_COL_WIDTH, startWidth + (ev.clientX - startX));
      setWidths((s) => ({ ...s, [col]: w }));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      // Defer clearing so the bubbled click on the header doesn't toggle sort.
      setTimeout(() => {
        resizingRef.current = false;
      }, 0);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const openMenu = (
    e: React.MouseEvent,
    rowIndex: number,
    colIndex: number | null,
  ) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, rowIndex, colIndex });
  };

  const copyText = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
  };

  // A single cell, or the whole row joined by the user's chosen delimiter.
  // NULL cells copy as an empty string so the column count stays stable.
  const copyCell = (rowIndex: number, colIndex: number) => {
    copyText(result.rows[rowIndex][colIndex] ?? "");
  };
  const copyRow = (rowIndex: number) => {
    copyText(result.rows[rowIndex].map((c) => c ?? "").join(getColumnSeparator()));
  };

  if (result.columns.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <CheckCircle2 className="size-6 text-emerald-500" />
        <p className="text-sm font-medium">{t("explorer.commandExecuted")}</p>
        <p className="text-sm text-muted-foreground">
          {t("common.rowsAffected", { n: result.rows_affected })}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm" style={{ tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: 56 }} />
            {result.columns.map((col) => (
              <col
                key={col}
                style={{ width: widths[col] ?? DEFAULT_COL_WIDTH }}
              />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-muted">
            <tr className="text-left">
              <th className="border-b border-border px-2 py-1.5 text-xs font-medium text-muted-foreground">
                #
              </th>
              {result.columns.map((col) => {
                const sorted = sort?.column === col;
                return (
                  <th
                    key={col}
                    onClick={() => {
                      if (resizingRef.current) return;
                      onSort?.(col);
                    }}
                    className={cn(
                      "relative border-b border-l border-border px-3 py-1.5 font-medium",
                      onSort && "cursor-pointer select-none hover:bg-accent",
                    )}
                  >
                    <span className="flex items-center gap-1 truncate pr-2">
                      <span className="truncate">{col}</span>
                      {sorted &&
                        (sort?.descending ? (
                          <ArrowDown className="size-3 shrink-0 text-muted-foreground" />
                        ) : (
                          <ArrowUp className="size-3 shrink-0 text-muted-foreground" />
                        ))}
                    </span>
                    <span
                      onMouseDown={(e) => startResize(col, e)}
                      onClick={(e) => e.stopPropagation()}
                      className="absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize select-none hover:bg-accent-foreground/30"
                      aria-hidden="true"
                    />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, i) => (
              <tr
                key={i}
                onDoubleClick={() => onRowOpen?.(i)}
                className={cn(
                  "hover:bg-accent/40",
                  (onRowOpen || onRowDelete || onRowDuplicate) && "cursor-pointer",
                  menu?.rowIndex === i && "bg-accent/60",
                )}
              >
                <td
                  onContextMenu={(e) => openMenu(e, i, null)}
                  className="border-b border-border/60 px-2 py-1 text-right text-xs text-muted-foreground tabular-nums"
                >
                  {i + 1}
                </td>
                {row.map((cell, j) => (
                  <td
                    key={j}
                    title={cell ?? undefined}
                    onContextMenu={(e) => openMenu(e, i, j)}
                    className="truncate border-b border-l border-border/60 px-3 py-1"
                  >
                    {cell === null ? (
                      <span className="italic text-muted-foreground">NULL</span>
                    ) : cell === "" ? (
                      <span className="text-muted-foreground">·</span>
                    ) : (
                      cell
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        {result.rows.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {t("explorer.noRows")}
          </p>
        )}
      </div>

      {menu && (
        <div
          className="fixed z-50 min-w-44 rounded-md border border-border bg-popover p-1 shadow-md"
          style={{ left: menu.x, top: menu.y }}
        >
          {menu.colIndex !== null && (
            <button
              type="button"
              onClick={() => {
                copyCell(menu.rowIndex, menu.colIndex!);
                setMenu(null);
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            >
              <ClipboardCopy className="size-4" />
              {t("explorer.copyCell")}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              copyRow(menu.rowIndex);
              setMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
          >
            <Rows3 className="size-4" />
            {t("explorer.copyRow")}
          </button>
          {(onRowDuplicate || onRowDelete) && (
            <div className="my-1 border-t border-border" />
          )}
          {onRowDuplicate && (
            <button
              type="button"
              onClick={() => {
                onRowDuplicate(menu.rowIndex);
                setMenu(null);
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            >
              <Copy className="size-4" />
              {t("explorer.duplicateRecord")}
            </button>
          )}
          {onRowDelete && (
            <button
              type="button"
              onClick={() => {
                onRowDelete(menu.rowIndex);
                setMenu(null);
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-destructive hover:bg-accent"
            >
              <Trash2 className="size-4" />
              {t("explorer.deleteRecord")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
