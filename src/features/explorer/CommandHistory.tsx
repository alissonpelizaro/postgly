import { useEffect, useState } from "react";
import { History, Loader2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/i18n";

import { explorerApi } from "./api";

interface CommandHistoryProps {
  sessionId: string;
  /** Load the picked statement into the SQL editor. */
  onPick: (sql: string) => void;
  onClose: () => void;
}

/**
 * Lists the SQL statements run in the current session (newest first).
 * Picking one loads it into the SQL editor.
 */
export function CommandHistory({
  sessionId,
  onPick,
  onClose,
}: CommandHistoryProps) {
  const { t } = useI18n();
  const [history, setHistory] = useState<string[] | null>(null);

  useEffect(() => {
    explorerApi
      .queryHistory(sessionId)
      .then((h) => setHistory([...h].reverse()))
      .catch(() => setHistory([]));
  }, [sessionId]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[80vh] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <History className="size-4" />
            {t("explorer.sessionHistory")}
          </DialogTitle>
          <DialogDescription>
            {t("explorer.sessionHistoryDesc")}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto">
          {history === null ? (
            <div className="flex justify-center py-10">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : history.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t("explorer.noCommandsYet")}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {history.map((sql, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => {
                      onPick(sql);
                      onClose();
                    }}
                    className="block w-full px-5 py-2.5 text-left font-mono text-xs hover:bg-accent"
                  >
                    {sql}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
