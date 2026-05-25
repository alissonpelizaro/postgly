import { useState } from "react";
import { Database, Loader2, Pencil, Plug, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

import type { ConnectionMeta } from "./types";

interface ConnectionRowProps {
  connection: ConnectionMeta;
  onEdit: (connection: ConnectionMeta) => void;
  onDelete: (connection: ConnectionMeta) => Promise<void>;
  onConnect: (connection: ConnectionMeta) => void;
}

/**
 * A single connection in the list. Action buttons (connect, edit, delete)
 * slide in on hover; deletion asks for inline confirmation first.
 */
export function ConnectionRow({
  connection,
  onEdit,
  onDelete,
  onConnect,
}: ConnectionRowProps) {
  const { t } = useI18n();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await onDelete(connection);
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5",
        "transition-colors hover:border-primary/40 hover:bg-accent/40",
      )}
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        <Database className="size-4.5" />
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{connection.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {connection.user}@{connection.host}:{connection.port}/
          {connection.database}
        </p>
      </div>

      {confirmingDelete ? (
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">{t("connections.deleteConfirm")}</span>
          <Button
            size="sm"
            variant="destructive"
            className="h-7"
            onClick={handleDelete}
            disabled={deleting}
          >
            {deleting && <Loader2 className="animate-spin" />}
            {t("common.yes")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            onClick={() => setConfirmingDelete(false)}
            disabled={deleting}
          >
            {t("common.no")}
          </Button>
        </div>
      ) : (
        <div
          className={cn(
            // Collapsed to zero width while hidden so the row text keeps
            // the full width; expands on hover / focus.
            "flex items-center gap-1 overflow-hidden",
            "max-w-0 opacity-0 transition-all duration-150",
            "group-hover:max-w-[220px] group-hover:opacity-100",
            "focus-within:max-w-[220px] focus-within:opacity-100",
          )}
        >
          <Button
            size="icon"
            variant="ghost"
            className="size-8 shrink-0"
            title={t("common.edit")}
            aria-label={t("connections.editAria")}
            onClick={() => onEdit(connection)}
          >
            <Pencil />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-8 shrink-0 text-destructive hover:text-destructive"
            title={t("common.delete")}
            aria-label={t("connections.deleteAria")}
            onClick={() => setConfirmingDelete(true)}
          >
            <Trash2 />
          </Button>
          <Button
            size="sm"
            className="h-8 shrink-0"
            title={t("connections.connect")}
            onClick={() => onConnect(connection)}
          >
            <Plug />
            {t("connections.connect")}
          </Button>
        </div>
      )}
    </div>
  );
}
