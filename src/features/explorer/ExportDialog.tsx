import { useState } from "react";
import { AlertCircle, Download, Loader2 } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n";
import { getExportDelimiter } from "@/lib/copy-prefs";
import { cn } from "@/lib/utils";

import { explorerApi } from "./api";

type ExportFormat = "csv" | "jsonlines";

interface ExportDialogProps {
  sessionId: string;
  schema: string;
  table: string;
  onClose: () => void;
}

const EXTENSION: Record<ExportFormat, string> = {
  csv: "csv",
  jsonlines: "jsonl",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function ExportDialog({
  sessionId,
  schema,
  table,
  onClose,
}: ExportDialogProps) {
  const { t } = useI18n();
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ path: string; bytes: number } | null>(
    null,
  );

  const run = async () => {
    setError(null);
    const ext = EXTENSION[format];
    let path: string | null;
    try {
      path = await save({
        defaultPath: `${table}.${ext}`,
        filters: [
          { name: format.toUpperCase(), extensions: [ext] },
          { name: "All", extensions: ["*"] },
        ],
      });
    } catch (e) {
      setError(String(e));
      return;
    }
    if (!path) return;

    setBusy(true);
    try {
      const result = await explorerApi.exportTable(
        sessionId,
        schema,
        table,
        format,
        path,
        // The delimiter only applies to CSV; JSON Lines ignores it.
        format === "csv" ? getExportDelimiter() : null,
      );
      setDone({ path: result.path, bytes: result.bytes_written });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="size-5" />
            {t("explorer.export.title")}
          </DialogTitle>
          <DialogDescription>
            {t("explorer.export.desc", { schema, table })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">
              {t("explorer.export.formatLabel")}
            </Label>
            <div className="flex gap-2">
              {(["csv", "jsonlines"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFormat(f)}
                  disabled={busy}
                  className={cn(
                    "flex-1 rounded-md border px-3 py-2 text-left text-sm",
                    "disabled:cursor-not-allowed disabled:opacity-60",
                    format === f
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border hover:bg-accent/40",
                  )}
                >
                  <div className="font-medium">
                    {t(`explorer.export.formats.${f}.label`)}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {t(`explorer.export.formats.${f}.desc`)}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {done && (
            <div className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
              <Download className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0">
                <p className="font-medium">
                  {t("explorer.export.doneTitle", {
                    size: formatBytes(done.bytes),
                  })}
                </p>
                <p className="truncate text-xs opacity-80" title={done.path}>
                  {done.path}
                </p>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <p className="break-words">{error}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {done ? t("common.close") : t("common.cancel")}
          </Button>
          {!done && (
            <Button onClick={run} disabled={busy}>
              {busy ? (
                <>
                  <Loader2 className="animate-spin" />
                  {t("explorer.export.running")}
                </>
              ) : (
                <>
                  <Download className="size-4" />
                  {t("explorer.export.pickAndRun")}
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
