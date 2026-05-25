import { AlertTriangle, Loader2, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { localeFor, useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

import type { StatementAnalysis, StatementInfo, StatementKind } from "./types";

interface DestructiveConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  analysis: StatementAnalysis | null;
  /** Spinner state for the parent's run-after-confirm callback. */
  running: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

const KIND_LABEL: Record<StatementKind, string> = {
  select: "SELECT",
  insert: "INSERT",
  update: "UPDATE",
  delete: "DELETE",
  drop: "DROP",
  truncate: "TRUNCATE",
  alter: "ALTER",
  create: "CREATE",
  other: "OTHER",
};

/**
 * Confirmation modal shown before any destructive SQL runs. Renders the
 * statement classification, the planner's row estimate (when available)
 * and a loud warning when an UPDATE/DELETE has no WHERE clause.
 */
export function DestructiveConfirmDialog({
  open,
  onOpenChange,
  analysis,
  running,
  onCancel,
  onConfirm,
}: DestructiveConfirmDialogProps) {
  const { t, lang } = useI18n();
  const destructive = analysis?.statements.filter((s) =>
    isDestructiveKind(s.kind),
  ) ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-5 text-amber-600 dark:text-amber-400" />
            {t("explorer.destructive.title")}
          </DialogTitle>
          <DialogDescription>
            {t("explorer.destructive.desc")}
          </DialogDescription>
        </DialogHeader>

        {analysis === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("explorer.destructive.analyzing")}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {analysis.unbounded_dml && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <div>
                  <p className="font-medium">{t("explorer.destructive.unboundedTitle")}</p>
                  <p className="opacity-90">{t("explorer.destructive.unboundedDesc")}</p>
                </div>
              </div>
            )}

            {analysis.estimated_rows !== null && (
              <RowEstimate rows={analysis.estimated_rows} locale={localeFor(lang)} byPlanner={t("explorer.destructive.rowsByPlanner")} />
            )}

            {analysis.explain_error && (
              <p className="text-xs text-muted-foreground">
                {t("explorer.destructive.estimateMissing", { error: analysis.explain_error })}
              </p>
            )}

            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium uppercase text-muted-foreground">
                {t("explorer.destructive.affectedStatements")}
              </p>
              <ul className="flex flex-col gap-1.5">
                {destructive.map((stmt, idx) => (
                  <StatementRow
                    key={idx}
                    stmt={stmt}
                    withWhereLabel={t("explorer.destructive.withWhere")}
                    withoutWhereLabel={t("explorer.destructive.withoutWhere")}
                  />
                ))}
              </ul>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={running}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={onConfirm}
            disabled={running || analysis === null}
          >
            {running ? <Loader2 className="animate-spin" /> : null}
            {t("explorer.destructive.runAnyway")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatementRow({
  stmt,
  withWhereLabel,
  withoutWhereLabel,
}: {
  stmt: StatementInfo;
  withWhereLabel: string;
  withoutWhereLabel: string;
}) {
  const danger = (stmt.kind === "update" || stmt.kind === "delete") && !stmt.has_where;
  return (
    <li
      className={cn(
        "rounded-md border border-border bg-muted/40 p-2 text-xs",
        danger && "border-destructive/40 bg-destructive/10",
      )}
    >
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide">
        <span
          className={cn(
            "rounded px-1.5 py-0.5",
            danger
              ? "bg-destructive/20 text-destructive"
              : "bg-primary/20 text-primary",
          )}
        >
          {KIND_LABEL[stmt.kind] ?? stmt.kind}
        </span>
        {(stmt.kind === "update" || stmt.kind === "delete") && (
          <span
            className={cn(
              "text-[10px] font-medium",
              danger ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {stmt.has_where ? withWhereLabel : withoutWhereLabel}
          </span>
        )}
      </div>
      <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs leading-snug text-foreground">
        {stmt.preview}
      </pre>
    </li>
  );
}

function RowEstimate({ rows, locale, byPlanner }: { rows: number; locale: string; byPlanner: string }) {
  const rounded = Math.round(rows);
  const formatted = new Intl.NumberFormat(locale).format(rounded);
  return (
    <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
      <span className="font-medium">~{formatted}</span>
      <span>{byPlanner}</span>
    </div>
  );
}

function isDestructiveKind(kind: StatementKind): boolean {
  return (
    kind === "insert" ||
    kind === "update" ||
    kind === "delete" ||
    kind === "drop" ||
    kind === "truncate" ||
    kind === "alter" ||
    kind === "create"
  );
}
