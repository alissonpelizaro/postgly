import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ChevronRight,
  Copy,
  Gauge,
  Loader2,
  Sparkles,
  TrendingUp,
} from "lucide-react";

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
import type {
  Bottleneck,
  IndexSuggestion,
  QueryAnalysis,
} from "./types";

interface ExplainDialogProps {
  sessionId: string;
  sql: string;
  onClose: () => void;
  /** Called when the user picks the LLM-suggested optimized SQL — the
   *  parent updates the editor and (typically) closes the dialog. */
  onUseSql?: (sql: string) => void;
  /** Called when the user wants to run a suggested CREATE INDEX. The
   *  parent should slot it into the editor or kick off a confirmation. */
  onRunIndex?: (sql: string) => void;
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
export function ExplainDialog({
  sessionId,
  sql,
  onClose,
  onUseSql,
  onRunIndex,
}: ExplainDialogProps) {
  const { t } = useI18n();
  const [analyze, setAnalyze] = useState(false);
  const [raw, setRaw] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"plan" | "ai">("plan");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<QueryAnalysis | null>(null);
  const [showOptimizedPlan, setShowOptimizedPlan] = useState(false);

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

  const envelope = useMemo<ExplainEnvelope | null>(
    () => parseEnvelope(raw),
    [raw],
  );
  const optimizedEnvelope = useMemo<ExplainEnvelope | null>(
    () => parseEnvelope(analysis?.optimized_plan ?? null),
    [analysis?.optimized_plan],
  );

  const runAi = async () => {
    setAiLoading(true);
    setAiError(null);
    try {
      const r = await explorerApi.analyzeQueryPlan(sessionId, sql);
      setAnalysis(r);
      setView("ai");
    } catch (e) {
      setAiError(String(e));
    } finally {
      setAiLoading(false);
    }
  };

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
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant={analyze ? "default" : "outline"}
              disabled={loading}
              onClick={() => setAnalyze((a) => !a)}
              title={t("explorer.explainAnalyzeHint")}
            >
              {t("explorer.explainAnalyze")}
            </Button>
            <Button
              size="sm"
              variant={analysis ? "outline" : "default"}
              disabled={
                loading || aiLoading || !sql.trim() || !envelope
              }
              onClick={runAi}
            >
              {aiLoading ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Sparkles />
              )}
              {aiLoading ? t("explorer.aiAnalyzing") : t("explorer.aiAnalyze")}
            </Button>
          </div>
        </div>

        {(analysis || aiError) && (
          <div className="flex shrink-0 gap-1 border-b border-border bg-card px-3 pt-2">
            <TabButton active={view === "plan"} onClick={() => setView("plan")}>
              {t("explorer.explainTitle")}
            </TabButton>
            <TabButton active={view === "ai"} onClick={() => setView("ai")}>
              <Sparkles className="size-3.5" />
              {t("explorer.aiAnalyze")}
            </TabButton>
          </div>
        )}

        <div className="max-h-[65vh] overflow-auto px-5 py-4">
          {view === "ai" ? (
            <AiAnalysisView
              loading={aiLoading}
              error={aiError}
              analysis={analysis}
              optimizedEnvelope={optimizedEnvelope}
              showOptimizedPlan={showOptimizedPlan}
              onToggleOptimizedPlan={() => setShowOptimizedPlan((v) => !v)}
              onUseSql={onUseSql}
              onRunIndex={onRunIndex}
            />
          ) : !sql.trim() ? (
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

function parseEnvelope(raw: string | null): ExplainEnvelope | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const root = Array.isArray(parsed) ? parsed[0] : parsed;
    return root && root.Plan ? (root as ExplainEnvelope) : null;
  } catch {
    return null;
  }
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

interface AiAnalysisViewProps {
  loading: boolean;
  error: string | null;
  analysis: QueryAnalysis | null;
  optimizedEnvelope: ExplainEnvelope | null;
  showOptimizedPlan: boolean;
  onToggleOptimizedPlan: () => void;
  onUseSql?: (sql: string) => void;
  onRunIndex?: (sql: string) => void;
}

function AiAnalysisView({
  loading,
  error,
  analysis,
  optimizedEnvelope,
  showOptimizedPlan,
  onToggleOptimizedPlan,
  onUseSql,
  onRunIndex,
}: AiAnalysisViewProps) {
  const { t } = useI18n();

  if (loading) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        {t("explorer.aiAnalyzing")}
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-start gap-2 text-sm text-destructive">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        <span className="break-words">{error || t("explorer.aiFailed")}</span>
      </div>
    );
  }
  if (!analysis) return null;

  return (
    <div className="space-y-5">
      {analysis.summary && (
        <Section title={t("explorer.aiSummary")}>
          <p className="whitespace-pre-wrap text-sm leading-relaxed">
            {analysis.summary}
          </p>
        </Section>
      )}

      <Section title={t("explorer.aiComparison")}>
        <ComparisonCards
          originalCost={analysis.original_total_cost}
          optimizedCost={analysis.optimized_total_cost}
          originalExecMs={analysis.original_execution_ms}
          gain={analysis.estimated_gain_factor}
        />
        {optimizedEnvelope && (
          <div className="mt-3">
            <button
              type="button"
              onClick={onToggleOptimizedPlan}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ChevronRight
                className={cn(
                  "size-3.5 transition-transform",
                  showOptimizedPlan && "rotate-90",
                )}
              />
              {showOptimizedPlan ? "Hide" : "Show"} optimized plan
            </button>
            {showOptimizedPlan && (
              <div className="mt-2 rounded-md border border-border bg-muted/30 p-3">
                <PlanTreeNode
                  node={optimizedEnvelope.Plan}
                  analyze={false}
                  depth={0}
                />
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title={t("explorer.aiBottlenecks")}>
        {analysis.bottlenecks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("explorer.aiNoBottlenecks")}
          </p>
        ) : (
          <ul className="space-y-2">
            {analysis.bottlenecks.map((b, i) => (
              <BottleneckItem key={i} bottleneck={b} />
            ))}
          </ul>
        )}
      </Section>

      <Section title={t("explorer.aiIndexes")}>
        {analysis.index_suggestions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("explorer.aiNoIndexes")}
          </p>
        ) : (
          <ul className="space-y-3">
            {analysis.index_suggestions.map((idx, i) => (
              <IndexItem
                key={i}
                suggestion={idx}
                onRun={onRunIndex}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section title={t("explorer.aiOptimized")}>
        {!analysis.optimized_sql ? (
          <p className="text-sm text-muted-foreground">
            {t("explorer.aiNoRewrite")}
          </p>
        ) : (
          <div className="space-y-2">
            <SqlBlock value={analysis.optimized_sql} />
            <div className="flex items-center gap-2">
              {onUseSql && (
                <Button
                  size="sm"
                  onClick={() => onUseSql(analysis.optimized_sql!)}
                >
                  {t("explorer.aiUseOptimized")}
                </Button>
              )}
              <CopyButton value={analysis.optimized_sql} />
            </div>
            {analysis.rewrites.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                {analysis.rewrites.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

function ComparisonCards({
  originalCost,
  optimizedCost,
  originalExecMs,
  gain,
}: {
  originalCost: number | null;
  optimizedCost: number | null;
  originalExecMs: number | null;
  gain: number | null;
}) {
  const { t } = useI18n();
  const reduction =
    originalCost !== null && optimizedCost !== null && originalCost > 0
      ? 1 - optimizedCost / originalCost
      : null;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <ComparisonCard
        label={t("explorer.aiOriginal")}
        cost={originalCost}
        execMs={originalExecMs}
        tone="muted"
      />
      <ComparisonCard
        label={t("explorer.aiOptimizedShort")}
        cost={optimizedCost}
        execMs={null}
        tone={
          reduction !== null && reduction > 0 ? "positive" : "muted"
        }
      />
      <div
        className={cn(
          "flex flex-col justify-center rounded-md border px-3 py-3",
          gain !== null && gain > 1.2
            ? "border-emerald-500/40 bg-emerald-500/10"
            : "border-border bg-card",
        )}
      >
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {t("explorer.aiGain")}
        </span>
        <div className="mt-1 flex items-baseline gap-2">
          <TrendingUp className="size-4 text-emerald-500" />
          <span className="text-lg font-semibold">
            {gain !== null ? `${gain.toFixed(2)}×` : "—"}
          </span>
          {reduction !== null && reduction > 0 && (
            <span className="text-xs text-muted-foreground">
              -{(reduction * 100).toFixed(0)}% cost
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function ComparisonCard({
  label,
  cost,
  execMs,
  tone,
}: {
  label: string;
  cost: number | null;
  execMs: number | null;
  tone: "muted" | "positive";
}) {
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-3",
        tone === "positive"
          ? "border-emerald-500/40 bg-emerald-500/10"
          : "border-border bg-card",
      )}
    >
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="mt-1 font-mono text-sm">
        cost: {cost !== null ? cost.toFixed(2) : "—"}
      </div>
      {execMs !== null && (
        <div className="font-mono text-xs text-muted-foreground">
          time: {execMs.toFixed(2)} ms
        </div>
      )}
    </div>
  );
}

function BottleneckItem({ bottleneck }: { bottleneck: Bottleneck }) {
  const accent =
    bottleneck.severity === "high"
      ? "border-red-500/50 bg-red-500/10"
      : bottleneck.severity === "medium"
        ? "border-amber-500/40 bg-amber-500/10"
        : "border-border bg-card";
  const dotColor =
    bottleneck.severity === "high"
      ? "bg-red-500"
      : bottleneck.severity === "medium"
        ? "bg-amber-500"
        : "bg-muted-foreground/60";
  return (
    <li className={cn("rounded-md border px-3 py-2 text-sm", accent)}>
      <div className="flex items-center gap-2">
        <span className={cn("size-2 rounded-full", dotColor)} />
        <span className="font-mono text-xs">{bottleneck.node}</span>
        <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
          {bottleneck.severity}
        </span>
      </div>
      <p className="mt-1 text-sm text-foreground">{bottleneck.issue}</p>
    </li>
  );
}

function IndexItem({
  suggestion,
  onRun,
}: {
  suggestion: IndexSuggestion;
  onRun?: (sql: string) => void;
}) {
  const { t } = useI18n();
  return (
    <li className="rounded-md border border-border bg-card p-3">
      <div className="text-xs text-muted-foreground">
        {suggestion.table}
        {suggestion.columns.length > 0 && ` · (${suggestion.columns.join(", ")})`}
      </div>
      <p className="mt-1 text-sm">{suggestion.rationale}</p>
      <div className="mt-2">
        <SqlBlock value={suggestion.sql} />
      </div>
      <div className="mt-2 flex items-center gap-2">
        {onRun && (
          <Button size="sm" variant="outline" onClick={() => onRun(suggestion.sql)}>
            {t("explorer.aiRunIndex")}
          </Button>
        )}
        <CopyButton value={suggestion.sql} />
      </div>
    </li>
  );
}

function SqlBlock({ value }: { value: string }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-muted/50 px-3 py-2 font-mono text-xs leading-relaxed">
      <code>{value}</code>
    </pre>
  );
}

function CopyButton({ value }: { value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      <Copy />
      {copied ? t("explorer.aiCopied") : t("explorer.aiCopy")}
    </Button>
  );
}
