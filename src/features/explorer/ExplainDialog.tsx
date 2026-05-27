import { useEffect, useMemo, useState } from "react";
import { AlertCircle, ChevronRight, Gauge, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

import { explorerApi } from "./api";

interface ExplainDialogProps {
  sessionId: string;
  sql: string;
  onClose: () => void;
}

/** A parsed `EXPLAIN (FORMAT JSON)` plan node — Postgres uses string
 *  keys with spaces, so we keep the raw shape and read with bracket
 *  notation. */
interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  Schema?: string;
  Alias?: string;
  "Startup Cost"?: number;
  "Total Cost"?: number;
  "Plan Rows"?: number;
  "Plan Width"?: number;
  "Actual Startup Time"?: number;
  "Actual Total Time"?: number;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Index Name"?: string;
  "Index Cond"?: string;
  "Hash Cond"?: string;
  "Join Type"?: string;
  "Sort Key"?: string[];
  "Group Key"?: string[];
  "Sort Method"?: string;
  Filter?: string;
  "Rows Removed by Filter"?: number;
  "Parallel Aware"?: boolean;
  Strategy?: string;
  Plans?: PlanNode[];
}

interface ExplainEnvelope {
  Plan: PlanNode;
  "Planning Time"?: number;
  "Execution Time"?: number;
  "Total Cost"?: number;
}

/** Modal showing the visual EXPLAIN plan for the editor's current SQL.
 *  Plain `EXPLAIN` runs by default; an "Analyze" button re-runs with
 *  `ANALYZE true` so the user can see real timings on demand. */
export function ExplainDialog({ sessionId, sql, onClose }: ExplainDialogProps) {
  const { t } = useI18n();
  const [analyze, setAnalyze] = useState(false);
  const [raw, setRaw] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sql.trim()) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    explorerApi
      .explainQuery(sessionId, sql, analyze)
      .then((json) => {
        if (!cancelled) setRaw(json);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, sql, analyze]);

  const envelope = useMemo<ExplainEnvelope | null>(() => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      const root = Array.isArray(parsed) ? parsed[0] : parsed;
      return root && root.Plan ? (root as ExplainEnvelope) : null;
    } catch {
      return null;
    }
  }, [raw]);

  const totalCost = envelope?.Plan?.["Total Cost"];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <Gauge className="size-4" />
            {t("explorer.explainTitle")}
          </DialogTitle>
          <DialogDescription>{t("explorer.explainDesc")}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/30 px-5 py-2 text-xs">
          <div className="flex items-center gap-4 text-muted-foreground">
            {envelope?.["Planning Time"] !== undefined && (
              <span>
                planning: {envelope["Planning Time"].toFixed(2)} ms
              </span>
            )}
            {envelope?.["Execution Time"] !== undefined && (
              <span>
                execution: {envelope["Execution Time"].toFixed(2)} ms
              </span>
            )}
            {totalCost !== undefined && (
              <span>total cost: {totalCost.toFixed(2)}</span>
            )}
          </div>
          <Button
            size="sm"
            variant={analyze ? "default" : "outline"}
            disabled={loading}
            onClick={() => setAnalyze((a) => !a)}
            title={t("explorer.explainAnalyzeHint")}
          >
            {t("explorer.explainAnalyze")}
          </Button>
        </div>

        <div className="max-h-[65vh] overflow-auto px-5 py-4">
          {!sql.trim() ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("explorer.explainEmpty")}
            </p>
          ) : loading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                {error}
              </pre>
            </div>
          ) : envelope?.Plan ? (
            <PlanTreeNode node={envelope.Plan} analyze={analyze} depth={0} />
          ) : (
            <p className="py-8 text-center text-sm text-destructive">
              {t("explorer.explainFailed")}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface PlanTreeNodeProps {
  node: PlanNode;
  analyze: boolean;
  depth: number;
}

/** Recursive plan node card. The vertical bar on the left visually
 *  threads parents to children — the higher the relative cost of a node
 *  the more saturated its accent. */
function PlanTreeNode({ node, analyze, depth }: PlanTreeNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const children = node.Plans ?? [];
  const relation = node["Relation Name"]
    ? node.Schema
      ? `${node.Schema}.${node["Relation Name"]}`
      : node["Relation Name"]
    : null;

  const startup = node["Startup Cost"];
  const total = node["Total Cost"];
  const planRows = node["Plan Rows"];
  const actualRows = node["Actual Rows"];
  const actualTotal = node["Actual Total Time"];
  const actualLoops = node["Actual Loops"];

  const accent = costAccent(total);

  return (
    <div className={cn("relative", depth > 0 && "mt-2 pl-5")}>
      {depth > 0 && (
        <div className="absolute left-0 top-0 h-full w-px bg-border" />
      )}
      <div
        className={cn(
          "rounded-md border bg-card px-3 py-2 shadow-sm",
          accent.border,
        )}
      >
        <div className="flex items-center gap-2">
          {children.length > 0 ? (
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              className="flex size-4 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent"
              aria-label={expanded ? "collapse" : "expand"}
            >
              <ChevronRight
                className={cn(
                  "size-3.5 transition-transform",
                  expanded && "rotate-90",
                )}
              />
            </button>
          ) : (
            <span className="inline-block size-4" />
          )}
          <span
            className={cn(
              "rounded-sm px-1.5 py-0.5 font-mono text-xs font-semibold",
              accent.badge,
            )}
          >
            {node["Node Type"]}
          </span>
          {node["Join Type"] && (
            <span className="text-xs text-muted-foreground">
              {node["Join Type"]}
            </span>
          )}
          {relation && (
            <span className="font-mono text-xs text-foreground">
              {relation}
              {node.Alias && node.Alias !== node["Relation Name"]
                ? ` (${node.Alias})`
                : ""}
            </span>
          )}
          {node["Index Name"] && (
            <span className="font-mono text-xs text-muted-foreground">
              · idx {node["Index Name"]}
            </span>
          )}
        </div>

        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 pl-6 font-mono text-[11px] text-muted-foreground sm:grid-cols-3">
          {total !== undefined && (
            <Metric
              label="cost"
              value={`${startup?.toFixed(2) ?? "?"}..${total.toFixed(2)}`}
            />
          )}
          {planRows !== undefined && (
            <Metric label="rows" value={String(Math.round(planRows))} />
          )}
          {node["Plan Width"] !== undefined && (
            <Metric label="width" value={String(node["Plan Width"])} />
          )}
          {analyze && actualTotal !== undefined && (
            <Metric
              label="time"
              value={`${actualTotal.toFixed(2)} ms`}
              emphasis
            />
          )}
          {analyze && actualRows !== undefined && (
            <Metric
              label="actual"
              value={String(actualRows)}
              emphasis={
                planRows !== undefined && estimateMisleading(planRows, actualRows)
              }
            />
          )}
          {analyze && actualLoops !== undefined && actualLoops > 1 && (
            <Metric label="loops" value={String(actualLoops)} />
          )}
          {node.Strategy && <Metric label="strategy" value={node.Strategy} />}
          {node["Sort Method"] && (
            <Metric label="sort" value={node["Sort Method"]} />
          )}
        </div>

        {(node["Index Cond"] ||
          node["Hash Cond"] ||
          node.Filter ||
          node["Sort Key"] ||
          node["Group Key"]) && (
          <div className="mt-2 space-y-0.5 pl-6 font-mono text-[11px] text-muted-foreground">
            {node["Index Cond"] && (
              <Predicate label="index cond" value={node["Index Cond"]} />
            )}
            {node["Hash Cond"] && (
              <Predicate label="hash cond" value={node["Hash Cond"]} />
            )}
            {node.Filter && (
              <Predicate
                label="filter"
                value={node.Filter}
                warn={
                  analyze &&
                  (node["Rows Removed by Filter"] ?? 0) > 1000
                }
              />
            )}
            {node["Sort Key"] && (
              <Predicate
                label="sort key"
                value={node["Sort Key"].join(", ")}
              />
            )}
            {node["Group Key"] && (
              <Predicate
                label="group key"
                value={node["Group Key"].join(", ")}
              />
            )}
          </div>
        )}
      </div>

      {expanded &&
        children.map((child, i) => (
          <PlanTreeNode
            key={i}
            node={child}
            analyze={analyze}
            depth={depth + 1}
          />
        ))}
    </div>
  );
}

function Metric({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-1">
      <span>{label}</span>
      <span
        className={cn(
          "text-foreground",
          emphasis && "font-semibold text-amber-600 dark:text-amber-400",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function Predicate({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="flex gap-2">
      <span className="shrink-0">{label}:</span>
      <span
        className={cn(
          "break-all text-foreground",
          warn && "text-amber-600 dark:text-amber-400",
        )}
      >
        {value}
      </span>
    </div>
  );
}

/** Pick a colour band for the node by total cost. Thresholds are rough
 *  but enough to make hot nodes pop visually in the tree. */
function costAccent(total: number | undefined): {
  border: string;
  badge: string;
} {
  if (total === undefined) {
    return {
      border: "border-border",
      badge: "bg-muted text-foreground",
    };
  }
  if (total < 100) {
    return {
      border: "border-emerald-500/40",
      badge: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    };
  }
  if (total < 10000) {
    return {
      border: "border-amber-500/40",
      badge: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    };
  }
  return {
    border: "border-red-500/50",
    badge: "bg-red-500/15 text-red-700 dark:text-red-400",
  };
}

/** Estimate is misleading when the planner is off by more than 10x. */
function estimateMisleading(planRows: number, actualRows: number): boolean {
  if (planRows === 0 && actualRows === 0) return false;
  const ratio =
    planRows === 0 ? actualRows : Math.max(planRows, actualRows) / Math.max(1, Math.min(planRows, actualRows));
  return ratio >= 10;
}
