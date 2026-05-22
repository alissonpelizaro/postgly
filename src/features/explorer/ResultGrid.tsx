import { CheckCircle2 } from "lucide-react";

import type { QueryResult } from "./types";

/** Renders a query result: a data grid, or a confirmation for statements
 * that return no rows (INSERT / UPDATE / DDL). */
export function ResultGrid({ result }: { result: QueryResult }) {
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
              {result.columns.map((col) => (
                <th
                  key={col}
                  className="border-b border-l border-border px-3 py-1.5 font-medium"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, i) => (
              <tr key={i} className="hover:bg-accent/40">
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
    </div>
  );
}
