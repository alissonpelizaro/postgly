import { AlertCircle, Bot, Database, Download, PowerOff, RotateCcw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

import type { ChatMessage, ChatSession } from "./types";

import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { SessionList } from "./SessionList";
import type { UseAgentChat } from "./useAgentChat";

interface AgentChatPanelProps {
  chat: UseAgentChat;
  onClose: () => void;
}

/** Right-rail conversational agent. Sends the user's turn to the
 *  configured LLM and renders the assistant's text reply. */
export function AgentChatPanel({ chat, onClose }: AgentChatPanelProps) {
  const { t } = useI18n();

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-border bg-background">
      <header className="flex h-9 shrink-0 items-center justify-between gap-1 border-b border-border bg-sidebar px-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Bot className="size-4 text-primary" />
          <span>{t("agentChat.title")}</span>
        </div>
        <div className="flex items-center">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            onClick={() => exportSession(chat.activeSession, t("agentChat.untitled"))}
            disabled={!chat.activeSession || chat.activeSession.messages.length === 0}
            aria-label={t("agentChat.export")}
            title={t("agentChat.export")}
          >
            <Download className="size-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            onClick={onClose}
            aria-label={t("agentChat.close")}
            title={t("agentChat.close")}
          >
            <X className="size-4" />
          </Button>
        </div>
      </header>

      <SessionList
        sessions={chat.sessions}
        activeId={chat.activeId}
        onSelect={chat.selectSession}
        onCreate={() => chat.createSession()}
        onDelete={chat.deleteSession}
        onRename={chat.renameSession}
      />
      <ConnectionBadge
        dbSessionId={chat.dbSessionId}
        connectionLabel={chat.connectionLabel}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <MessageList
          messages={chat.activeSession?.messages ?? []}
          pending={chat.pending}
          onApproveProposal={
            chat.activeSession
              ? (messageId) => chat.approveProposal(chat.activeSession!.id, messageId)
              : undefined
          }
          onRejectProposal={
            chat.activeSession
              ? (messageId) => chat.rejectProposal(chat.activeSession!.id, messageId)
              : undefined
          }
          onRegenerateLast={chat.pending ? undefined : chat.regenerateLast}
          onEditLastUser={chat.pending ? undefined : chat.editLastUser}
        />
      </div>
      {chat.error && (
        <div className="flex items-start gap-2 border-t border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{chat.error}</span>
          <button
            type="button"
            onClick={() => {
              chat.clearError();
              void chat.retryLast();
            }}
            disabled={chat.pending}
            aria-label={t("common.retry")}
            title={t("common.retry")}
            className="flex items-center gap-1 rounded-sm border border-destructive/40 px-1.5 py-0.5 text-[11px] font-medium hover:bg-destructive/20 disabled:opacity-50"
          >
            <RotateCcw className="size-3" />
            {t("common.retry")}
          </button>
          <button
            type="button"
            onClick={chat.clearError}
            aria-label={t("common.close")}
            className="rounded-sm p-0.5 hover:bg-destructive/20"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <Composer disabled={chat.pending} onSubmit={(text) => chat.sendMessage(text)} />
    </div>
  );
}

/** Serialize a session to a Markdown file and trigger a browser
 *  download. Lives in this file because it's only used by the panel
 *  header. */
function exportSession(session: ChatSession | null, untitledLabel: string) {
  if (!session || session.messages.length === 0) return;
  const title = session.title.trim() || untitledLabel;
  const created = new Date(session.createdAt).toISOString();
  const lines: string[] = [`# ${title}`, "", `_${created}_`, ""];
  for (const m of session.messages) {
    lines.push(formatMessageMarkdown(m));
    lines.push("");
  }
  const md = lines.join("\n");
  triggerDownload(`${slugify(title)}.md`, md);
}

function formatMessageMarkdown(m: ChatMessage): string {
  const tag = m.role === "user" ? "**You**" : m.role === "assistant" ? "**Agent**" : "**System**";
  const stamp = new Date(m.createdAt).toLocaleString();
  let body = `${tag} · ${stamp}\n\n${m.content}`;
  if (m.proposal) {
    const o = m.proposal.outcome;
    const status =
      o.status === "approved"
        ? `executed (${o.kind} affected ${o.rowsAffected} row(s))`
        : o.status === "rejected"
          ? "rejected"
          : o.status === "error"
            ? `failed: ${o.message}`
            : "pending";
    body += `\n\n> Proposed ${m.proposal.kind.toUpperCase()} — ${status}\n\n\`\`\`sql\n${m.proposal.sql}\n\`\`\``;
  }
  return body;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "session";
}

function triggerDownload(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

interface ConnectionBadgeProps {
  dbSessionId: string | null;
  connectionLabel: string | null;
}

/** Strip under the session bar that tells the user whether the chat is
 *  bound to a live DB session (read-only tools available) or floating. */
function ConnectionBadge({ dbSessionId, connectionLabel }: ConnectionBadgeProps) {
  const { t } = useI18n();
  const bound = dbSessionId !== null && connectionLabel !== null;
  const Icon = bound ? Database : PowerOff;
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1 text-[11px]",
        bound
          ? "bg-primary/5 text-primary"
          : "bg-muted/40 text-muted-foreground",
      )}
    >
      <Icon className="size-3" />
      {bound ? (
        <span className="truncate">
          {t("agentChat.boundTo", { name: connectionLabel! })}
        </span>
      ) : (
        <span className="truncate">{t("agentChat.notBound")}</span>
      )}
    </div>
  );
}
