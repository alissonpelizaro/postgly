import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  MessageSquare,
  MessageSquarePlus,
  Pencil,
  Trash2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

import type { ChatSession } from "./types";

interface SessionListProps {
  sessions: ChatSession[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
}

/** ~10 rows tall — anything beyond that scrolls. Row is `py-1.5` + text
 *  + a thin border, ~32px. */
const ROW_HEIGHT_PX = 32;
const VISIBLE_ROWS = 10;

/** Collapsible session picker. Header shows the active session; clicking
 *  it expands a scrollable list with inline rename/delete. Selecting a
 *  session collapses the list automatically. */
export function SessionList({
  sessions,
  activeId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
}: SessionListProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Click outside closes the panel (but not when actively renaming —
  // the click might just be in the input itself).
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && containerRef.current?.contains(target)) return;
      setOpen(false);
      setEditingId(null);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const active = activeId ? sessions.find((s) => s.id === activeId) ?? null : null;
  const headerLabel = active
    ? active.title.trim() === ""
      ? t("agentChat.untitled")
      : active.title
    : t("agentChat.pickerEmpty");

  const handleSelect = (id: string) => {
    onSelect(id);
    setOpen(false);
    setEditingId(null);
  };

  const handleCreate = () => {
    onCreate();
    setOpen(false);
    setEditingId(null);
  };

  return (
    <div ref={containerRef} className="relative shrink-0 border-b border-border bg-sidebar/50">
      <div className="flex h-8 items-center gap-1 px-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          aria-expanded={open}
          aria-label={t("agentChat.openSessionList")}
        >
          <MessageSquare className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">{headerLabel}</span>
          <span className="shrink-0 text-[10px] tabular-nums opacity-70">
            {sessions.length}
          </span>
          <ChevronDown
            className={cn(
              "size-3.5 shrink-0 transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-6 shrink-0"
          onClick={handleCreate}
          title={t("agentChat.newSession")}
          aria-label={t("agentChat.newSession")}
        >
          <MessageSquarePlus className="size-3.5" />
        </Button>
      </div>

      {open && (
        <div
          className="absolute left-0 right-0 top-full z-30 border-b border-border bg-popover shadow-md"
          style={{ maxHeight: ROW_HEIGHT_PX * VISIBLE_ROWS }}
        >
          <div
            className="overflow-y-auto"
            style={{ maxHeight: ROW_HEIGHT_PX * VISIBLE_ROWS }}
          >
            {sessions.length === 0 ? (
              <p className="p-3 text-center text-xs text-muted-foreground">
                {t("agentChat.sessionsEmpty")}
              </p>
            ) : (
              <ul className="flex flex-col">
                {sessions.map((s) => (
                  <li key={s.id}>
                    <SessionRow
                      session={s}
                      active={s.id === activeId}
                      editing={editingId === s.id}
                      onSelect={() => handleSelect(s.id)}
                      onStartEdit={() => setEditingId(s.id)}
                      onCancelEdit={() => setEditingId(null)}
                      onCommitEdit={(title) => {
                        onRename(s.id, title);
                        setEditingId(null);
                      }}
                      onDelete={() => {
                        onDelete(s.id);
                        if (editingId === s.id) setEditingId(null);
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface SessionRowProps {
  session: ChatSession;
  active: boolean;
  editing: boolean;
  onSelect: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onCommitEdit: (title: string) => void;
  onDelete: () => void;
}

function SessionRow({
  session,
  active,
  editing,
  onSelect,
  onStartEdit,
  onCancelEdit,
  onCommitEdit,
  onDelete,
}: SessionRowProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(session.title);

  if (editing) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const title = draft.trim();
          if (title.length === 0) {
            onCancelEdit();
            return;
          }
          onCommitEdit(title);
        }}
        className="flex items-center gap-1 border-b border-border bg-accent/30 px-2 py-1"
        style={{ height: ROW_HEIGHT_PX }}
      >
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancelEdit();
          }}
          className="h-6 flex-1 px-1.5 text-xs"
        />
        <button
          type="submit"
          className="flex size-6 items-center justify-center rounded-sm hover:bg-accent"
          aria-label={t("common.save")}
        >
          <Check className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onCancelEdit}
          className="flex size-6 items-center justify-center rounded-sm hover:bg-accent"
          aria-label={t("common.cancel")}
        >
          <X className="size-3.5" />
        </button>
      </form>
    );
  }

  const displayTitle =
    session.title.trim() === "" ? t("agentChat.untitled") : session.title;

  return (
    <div
      className={cn(
        "group flex items-center border-b border-border/60 transition-colors",
        active ? "bg-primary/10" : "hover:bg-accent/40",
      )}
      style={{ height: ROW_HEIGHT_PX }}
    >
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left text-xs",
          active ? "text-foreground" : "text-muted-foreground",
        )}
        title={displayTitle}
      >
        <MessageSquare
          className={cn(
            "size-3 shrink-0",
            active ? "text-primary" : "text-muted-foreground/60",
          )}
        />
        <span className="truncate">{displayTitle}</span>
      </button>
      <div className="flex shrink-0 pr-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setDraft(session.title);
            onStartEdit();
          }}
          aria-label={t("agentChat.renameSession")}
          title={t("agentChat.renameSession")}
          className="flex size-6 items-center justify-center rounded-sm hover:bg-accent hover:text-foreground"
        >
          <Pencil className="size-3" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label={t("agentChat.deleteSession")}
          title={t("agentChat.deleteSession")}
          className="flex size-6 items-center justify-center rounded-sm hover:bg-destructive/20 hover:text-destructive"
        >
          <Trash2 className="size-3" />
        </button>
      </div>
    </div>
  );
}
