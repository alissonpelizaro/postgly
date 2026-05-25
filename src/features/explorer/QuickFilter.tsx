import { useEffect, useState } from "react";
import { Filter, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n, type TKey } from "@/i18n";

import type { FilterOp, RowFilter } from "./types";

/** UI operators, each mapping to a backend op plus a value transform. */
const OPERATORS = [
  { key: "eq",       labelKey: "explorer.quickFilter.ops.eq"       as TKey, op: "eq",    wrap: (v: string) => v },
  { key: "neq",      labelKey: "explorer.quickFilter.ops.neq"      as TKey, op: "neq",   wrap: (v: string) => v },
  { key: "contains", labelKey: "explorer.quickFilter.ops.contains" as TKey, op: "ilike", wrap: (v: string) => `%${v}%` },
  { key: "starts",   labelKey: "explorer.quickFilter.ops.starts"   as TKey, op: "ilike", wrap: (v: string) => `${v}%` },
  { key: "gt",       labelKey: "explorer.quickFilter.ops.gt"       as TKey, op: "gt",    wrap: (v: string) => v },
  { key: "lt",       labelKey: "explorer.quickFilter.ops.lt"       as TKey, op: "lt",    wrap: (v: string) => v },
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
  const { t } = useI18n();
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
        aria-label={t("explorer.quickFilter.column")}
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
        aria-label={t("explorer.quickFilter.operator")}
      >
        {OPERATORS.map((o) => (
          <option key={o.key} value={o.key}>
            {t(o.labelKey)}
          </option>
        ))}
      </select>

      <Input
        className="w-48"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && apply()}
        placeholder={t("common.placeholderValue")}
      />

      <Button size="sm" onClick={apply} disabled={!column}>
        <Filter />
        {t("explorer.filter")}
      </Button>

      {active && (
        <Button size="sm" variant="ghost" onClick={clear}>
          <X />
          {t("common.clear")}
        </Button>
      )}
    </div>
  );
}
