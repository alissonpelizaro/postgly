import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, CheckCircle2, Trash2 } from "lucide-react";

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
}

/** Renders a query result: a data grid, or a confirmation for statements
 * that return no rows (INSERT / UPDATE / DDL). */
export function ResultGrid({
  result,
  sort,
  onSort,
  onRowOpen,
  onRowDelete,
}: ResultGridProps) {
  // Right-click row menu: viewport coords plus the targeted row index.
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    rowIndex: number;
  } | null>(null);

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

  if (result.columns.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <CheckCircle2 className="size-6 text-emerald-500" />
        <p className="text-sm font-medium">Comando executado</p>
        <p className="text-sm text-muted-foreground">
          {result.rows_affected} linha(s) afetada(s).
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm">
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
                    onClick={() => onSort?.(col)}
                    className={cn(
                      "border-b border-l border-border px-3 py-1.5 font-medium",
                      onSort && "cursor-pointer select-none hover:bg-accent",
                    )}
                  >
                    <span className="flex items-center gap-1">
                      {col}
                      {sorted &&
                        (sort?.descending ? (
                          <ArrowDown className="size-3 text-muted-foreground" />
                        ) : (
                          <ArrowUp className="size-3 text-muted-foreground" />
                        ))}
                    </span>
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
                onContextMenu={(e) => {
                  if (!onRowDelete) return;
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, rowIndex: i });
                }}
                className={cn(
                  "hover:bg-accent/40",
                  (onRowOpen || onRowDelete) && "cursor-pointer",
                  menu?.rowIndex === i && "bg-accent/60",
                )}
              >
                <td className="border-b border-border/60 px-2 py-1 text-right text-xs text-muted-foreground tabular-nums">
                  {i + 1}
                </td>
                {row.map((cell, j) => (
                  <td
                    key={j}
                    title={cell ?? undefined}
                    className="max-w-xs truncate border-b border-l border-border/60 px-3 py-1"
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
            Nenhuma linha retornada.
          </p>
        )}
      </div>

      {menu && onRowDelete && (
        <div
          className="fixed z-50 min-w-44 rounded-md border border-border bg-popover p-1 shadow-md"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            type="button"
            onClick={() => {
              onRowDelete(menu.rowIndex);
              setMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-destructive hover:bg-accent"
          >
            <Trash2 className="size-4" />
            Excluir registro
          </button>
        </div>
      )}
    </div>
  );
}
