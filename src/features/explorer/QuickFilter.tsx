import { useEffect, useState } from "react";
import { Filter, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import type { FilterOp, RowFilter } from "./types";

/** UI operators, each mapping to a backend op plus a value transform. */
const OPERATORS = [
  { key: "eq", label: "igual a", op: "eq", wrap: (v: string) => v },
  { key: "neq", label: "diferente de", op: "neq", wrap: (v: string) => v },
  { key: "contains", label: "contém", op: "ilike", wrap: (v: string) => `%${v}%` },
  { key: "starts", label: "começa com", op: "ilike", wrap: (v: string) => `${v}%` },
  { key: "gt", label: "maior que", op: "gt", wrap: (v: string) => v },
  { key: "lt", label: "menor que", op: "lt", wrap: (v: string) => v },
] as const;

interface QuickFilterProps {
  /** Column names available to filter on. */
  columns: string[];
  /** Whether a filter is currently applied. */
  active: boolean;
  /** Apply a filter, or clear it when `null`. */
  onApply: (filter: RowFilter | null) => void;
}

const selectClass =
  "h-9 rounded-md border border-input bg-transparent px-2 text-sm " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The records quick-filter bar: column + operator + value. */
export function QuickFilter({ columns, active, onApply }: QuickFilterProps) {
  const [column, setColumn] = useState("");
  const [opKey, setOpKey] = useState<(typeof OPERATORS)[number]["key"]>("eq");
  const [value, setValue] = useState("");

  // Default to the first column once the list is known.
  useEffect(() => {
    if (!column && columns.length > 0) setColumn(columns[0]);
  }, [columns, column]);

  const apply = () => {
    if (!column) return;
    const op = OPERATORS.find((o) => o.key === opKey)!;
    onApply({
      column,
      operator: op.op as FilterOp,
      value: op.wrap(value),
    });
  };

  const clear = () => {
    setValue("");
    onApply(null);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className={selectClass}
        value={column}
        onChange={(e) => setColumn(e.target.value)}
        aria-label="Coluna"
      >
        {columns.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>

      <select
        className={selectClass}
        value={opKey}
        onChange={(e) => setOpKey(e.target.value as typeof opKey)}
        aria-label="Operador"
      >
        {OPERATORS.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>

      <Input
        className="w-48"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && apply()}
        placeholder="valor"
      />

      <Button size="sm" onClick={apply} disabled={!column}>
        <Filter />
        Filtrar
      </Button>

      {active && (
        <Button size="sm" variant="ghost" onClick={clear}>
          <X />
          Limpar
        </Button>
      )}
    </div>
  );
}
