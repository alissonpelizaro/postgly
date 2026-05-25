import { useEffect, useRef, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Pencil,
  RotateCcw,
  Sparkles,
  User,
  Wrench,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

import { ApprovalCard } from "./ApprovalCard";
import { Markdown } from "./Markdown";
import type { ChatMessage, ChatTraceEvent } from "./types";

interface MessageListProps {
  messages: ChatMessage[];
  pending?: boolean;
  onApproveProposal?: (messageId: string) => void;
  onRejectProposal?: (messageId: string) => void;
  /** Drop the last assistant message and re-request a reply. */
  onRegenerateLast?: () => void;
  /** Replace the last user message with `text` and re-run the agent. */
  onEditLastUser?: (text: string) => void;
}

export function MessageList({
  messages,
  pending,
  onApproveProposal,
  onRejectProposal,
  onRegenerateLast,
  onEditLastUser,
}: MessageListProps) {
  const { t } = useI18n();
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, pending]);

  if (messages.length === 0 && !pending) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {t("agentChat.empty")}
      </div>
    );
  }

  // Compute which message gets "regenerate" / "edit" affordances — only
  // the trailing assistant and the trailing user, respectively.
  const lastAssistantIdx = findLastIndex(messages, (m) => m.role === "assistant");
  const lastUserIdx = findLastIndex(messages, (m) => m.role === "user");

  return (
    <div className="flex flex-col gap-3 p-3">
      {messages.map((m, idx) => (
        <MessageBubble
          key={m.id}
          message={m}
          onApprove={onApproveProposal ? () => onApproveProposal(m.id) : undefined}
          onReject={onRejectProposal ? () => onRejectProposal(m.id) : undefined}
          onRegenerate={
            !pending && idx === lastAssistantIdx && onRegenerateLast
              ? onRegenerateLast
              : undefined
          }
          onEdit={
            !pending && idx === lastUserIdx && onEditLastUser
              ? onEditLastUser
              : undefined
          }
        />
      ))}
      {pending && <TypingBubble />}
      <div ref={endRef} />
    </div>
  );
}

function findLastIndex<T>(arr: T[], pred: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return i;
  }
  return -1;
}

interface MessageBubbleProps {
  message: ChatMessage;
  onApprove?: () => void;
  onReject?: () => void;
  onRegenerate?: () => void;
  onEdit?: (text: string) => void;
}

function MessageBubble({
  message,
  onApprove,
  onReject,
  onRegenerate,
  onEdit,
}: MessageBubbleProps) {
  const { t } = useI18n();
  const isUser = message.role === "user";
  const Icon = isUser ? User : Bot;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);

  // Sync the draft back to the message content when entering edit mode
  // (the content may have changed since the last edit attempt).
  const enterEdit = () => {
    setDraft(message.content);
    setEditing(true);
  };

  if (editing && onEdit) {
    return (
      <div className={cn("flex gap-2", isUser ? "flex-row-reverse" : "flex-row")}>
        <div
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-full",
            isUser ? "bg-primary/15 text-primary" : "bg-accent text-foreground",
          )}
        >
          <Icon className="size-3.5" />
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const text = draft.trim();
            if (text.length === 0) {
              setEditing(false);
              return;
            }
            setEditing(false);
            onEdit(text);
          }}
          className="flex max-w-[85%] min-w-0 flex-1 flex-col gap-1.5"
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            autoFocus
            rows={3}
            className="resize-none rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex justify-end gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setEditing(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" size="sm">
              {t("agentChat.editSend")}
            </Button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className={cn("group flex gap-2", isUser ? "flex-row-reverse" : "flex-row")}>
      <div
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full",
          isUser ? "bg-primary/15 text-primary" : "bg-accent text-foreground",
        )}
      >
        <Icon className="size-3.5" />
      </div>
      <div className={cn("flex max-w-[85%] min-w-0 flex-col gap-1.5", isUser && "items-end")}>
        <div
          className={cn(
            "rounded-lg px-3 py-2 text-sm",
            isUser
              ? "bg-primary text-primary-foreground"
              : "bg-card text-foreground border border-border",
          )}
        >
          <Markdown content={message.content} inverted={isUser} />
        </div>
        {!isUser && message.proposal && onApprove && onReject && (
          <ApprovalCard
            proposal={message.proposal}
            onApprove={onApprove}
            onReject={onReject}
          />
        )}
        {!isUser && message.trace && message.trace.length > 0 && (
          <TraceDisclosure trace={message.trace} />
        )}
        {(onRegenerate || onEdit) && (
          <div
            className={cn(
              "flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100",
              isUser && "justify-end",
            )}
          >
            {onRegenerate && (
              <button
                type="button"
                onClick={onRegenerate}
                title={t("agentChat.regenerate")}
                aria-label={t("agentChat.regenerate")}
                className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <RotateCcw className="size-3" />
                {t("agentChat.regenerate")}
              </button>
            )}
            {onEdit && (
              <button
                type="button"
                onClick={enterEdit}
                title={t("agentChat.editMessage")}
                aria-label={t("agentChat.editMessage")}
                className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Pencil className="size-3" />
                {t("agentChat.editMessage")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TraceDisclosure({ trace }: { trace: ChatTraceEvent[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // Tool calls + results, but skip the final assistant_message echo —
  // it duplicates the visible bubble.
  const steps = trace.filter((e) => e.kind !== "assistant_message");
  if (steps.length === 0) return null;
  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {t("agentChat.reasoning", { n: steps.length })}
      </button>
      {open && (
        <ol className="mt-1 flex flex-col gap-1 border-l border-border pl-3">
          {steps.map((event, idx) => (
            <li key={idx} className="text-xs">
              <TraceItem event={event} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function TraceItem({ event }: { event: ChatTraceEvent }) {
  if (event.kind === "tool_call") {
    return (
      <div className="flex items-start gap-1.5 text-muted-foreground">
        <Wrench className="mt-0.5 size-3 shrink-0" />
        <span>
          <span className="font-medium text-foreground">{event.name}</span>
          <span className="ml-1 font-mono">({summarizeArgs(event.arguments)})</span>
        </span>
      </div>
    );
  }
  if (event.kind === "tool_result") {
    return (
      <div
        className={cn(
          "flex items-start gap-1.5",
          event.ok ? "text-muted-foreground" : "text-destructive",
        )}
      >
        {event.ok ? (
          <Check className="mt-0.5 size-3 shrink-0" />
        ) : (
          <X className="mt-0.5 size-3 shrink-0" />
        )}
        <span className="break-words font-mono">{summarizeResult(event.result)}</span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-1.5 text-muted-foreground">
      <Sparkles className="mt-0.5 size-3 shrink-0" />
      <span className="break-words">{truncate(event.content, 240)}</span>
    </div>
  );
}

function summarizeArgs(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args !== "object") return String(args);
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => `${k}=${truncate(JSON.stringify(v), 40)}`)
    .join(", ");
}

function summarizeResult(result: unknown): string {
  if (result === null || result === undefined) return "—";
  const json = typeof result === "string" ? result : JSON.stringify(result);
  return truncate(json, 200);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function TypingBubble() {
  return (
    <div className="flex gap-2">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-foreground">
        <Bot className="size-3.5" />
      </div>
      <div className="flex items-center gap-1 rounded-lg border border-border bg-card px-3 py-2.5">
        <Dot delay={0} />
        <Dot delay={150} />
        <Dot delay={300} />
      </div>
    </div>
  );
}

function Dot({ delay }: { delay: number }) {
  return (
    <span
      className="inline-block size-1.5 animate-bounce rounded-full bg-muted-foreground/60"
      style={{ animationDelay: `${delay}ms` }}
    />
  );
}
