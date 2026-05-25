import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Loader2,
  ShieldAlert,
  X,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

import type { ChatProposal } from "./types";

interface ApprovalCardProps {
  proposal: ChatProposal;
  disabled?: boolean;
  onApprove: () => void;
  onReject: () => void;
}

/** Inline confirmation surface attached to an assistant message that
 *  carries a `run_write` proposal. Collapses to a status badge once the
 *  user decides. */
export function ApprovalCard({
  proposal,
  disabled,
  onApprove,
  onReject,
}: ApprovalCardProps) {
  const { t } = useI18n();
  const { outcome } = proposal;

  if (outcome.status === "approved") {
    return (
      <StatusStrip
        tone="success"
        Icon={CheckCircle2}
        text={t("agentChat.approval.executed", {
          n: outcome.rowsAffected,
          kind: outcome.kind.toUpperCase(),
        })}
      />
    );
  }
  if (outcome.status === "rejected") {
    return <StatusStrip tone="muted" Icon={XCircle} text={t("agentChat.approval.rejected")} />;
  }
  if (outcome.status === "error") {
    return (
      <StatusStrip
        tone="error"
        Icon={AlertTriangle}
        text={t("agentChat.approval.error", { msg: outcome.message })}
      />
    );
  }

  const running = outcome.status === "running";
  const blocking = proposal.destructive || proposal.unboundedDml;
  const kindLabel = proposal.kind.toUpperCase();

  return (
    <div
      className={cn(
        "flex w-full flex-col gap-2 rounded-md border p-2.5 text-xs",
        blocking
          ? "border-destructive/40 bg-destructive/5"
          : "border-amber-500/40 bg-amber-500/5",
      )}
    >
      <div className="flex items-center gap-1.5">
        {blocking ? (
          <ShieldAlert className="size-3.5 text-destructive" />
        ) : (
          <AlertTriangle className="size-3.5 text-amber-600" />
        )}
        <span
          className={cn(
            "font-medium",
            blocking ? "text-destructive" : "text-amber-700 dark:text-amber-300",
          )}
        >
          {t("agentChat.approval.title")}
        </span>
        <span
          className={cn(
            "rounded-sm border px-1 font-mono text-[10px] uppercase",
            blocking
              ? "border-destructive/40 text-destructive"
              : "border-amber-500/40 text-amber-700 dark:text-amber-300",
          )}
        >
          {kindLabel}
        </span>
        {proposal.unboundedDml && (
          <span className="rounded-sm bg-destructive/15 px-1 text-[10px] font-medium text-destructive">
            {t("agentChat.approval.unboundedDml")}
          </span>
        )}
      </div>

      {proposal.summary.trim().length > 0 && (
        <p className="text-foreground">{proposal.summary}</p>
      )}

      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-background/60 p-2 font-mono text-[11px] leading-relaxed text-foreground">
        {proposal.sql}
      </pre>

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={running || disabled}
          onClick={onReject}
        >
          <X />
          {t("agentChat.approval.reject")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={blocking ? "destructive" : "default"}
          disabled={running || disabled}
          onClick={onApprove}
        >
          {running ? <Loader2 className="animate-spin" /> : <Check />}
          {running ? t("agentChat.approval.running") : t("agentChat.approval.approve")}
        </Button>
      </div>
    </div>
  );
}

function StatusStrip({
  tone,
  Icon,
  text,
}: {
  tone: "success" | "error" | "muted";
  Icon: typeof CheckCircle2;
  text: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]",
        tone === "success" && "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        tone === "error" && "border-destructive/40 bg-destructive/10 text-destructive",
        tone === "muted" && "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="break-words">{text}</span>
    </div>
  );
}
