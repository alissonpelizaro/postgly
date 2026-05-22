import { useEffect, useState } from "react";
import { AlertCircle, KeyRound, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

import { explorerApi } from "./api";
import type { TableDetails, TableRef } from "./types";

interface TableStructureProps {
  sessionId: string;
  table: TableRef;
}

/** "Structure" tab: the columns and indexes of the selected table. */
export function TableStructure({ sessionId, table }: TableStructureProps) {
  const [details, setDetails] = useState<TableDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    explorerApi
      .describeTable(sessionId, table.schema, table.name)
      .then((d) => setDetails(d))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [sessionId, table.schema, table.name]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <AlertCircle className="size-6 text-destructive" />
        <p className="max-w-md text-sm text-destructive">{error}</p>
      </div>
    );
  }

  if (!details) return null;

  return (
    <div className="flex flex-col gap-6 overflow-y-auto p-5">
      <Section title="Colunas" count={details.columns.length}>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-4 font-medium">Coluna</th>
              <th className="py-2 pr-4 font-medium">Tipo</th>
              <th className="py-2 pr-4 font-medium">Nulo</th>
              <th className="py-2 font-medium">Padrão</th>
            </tr>
          </thead>
          <tbody>
            {details.columns.map((col) => (
              <tr
                key={col.name}
                className="border-b border-border/60 last:border-0"
              >
                <td className="py-2 pr-4">
                  <span className="flex items-center gap-1.5 font-medium">
                    {col.is_primary_key && (
                      <KeyRound
                        className="size-3.5 text-amber-500"
                        aria-label="Chave primária"
                      />
                    )}
                    {col.name}
                  </span>
                </td>
                <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">
                  {col.data_type}
                </td>
                <td className="py-2 pr-4 text-muted-foreground">
                  {col.nullable ? "NULL" : "NOT NULL"}
                </td>
                <td className="py-2 font-mono text-xs text-muted-foreground">
                  {col.default ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Índices" count={details.indexes.length}>
        {details.indexes.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum índice.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {details.indexes.map((idx) => (
              <li
                key={idx.name}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2"
              >
                <span className="font-mono text-sm">{idx.name}</span>
                <span className="text-xs text-muted-foreground">
                  ({idx.columns.join(", ")})
                </span>
                {idx.is_primary && <Badge tone="amber">PRIMARY</Badge>}
                {idx.is_unique && !idx.is_primary && (
                  <Badge tone="blue">UNIQUE</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

/** A titled block with a count chip. */
function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        {title}
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
          {count}
        </span>
      </h3>
      {children}
    </section>
  );
}

/** A small coloured label. */
function Badge({
  tone,
  children,
}: {
  tone: "amber" | "blue";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        tone === "amber"
          ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
          : "bg-blue-500/15 text-blue-600 dark:text-blue-400",
      )}
    >
      {children}
    </span>
  );
}
