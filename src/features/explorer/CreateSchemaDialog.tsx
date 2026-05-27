import { useMemo, useState } from "react";
import { AlertCircle, ChevronRight, Loader2 } from "lucide-react";
import hljs from "highlight.js/lib/core";
import sqlLang from "highlight.js/lib/languages/sql";

hljs.registerLanguage("sql", sqlLang);

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

import { explorerApi } from "./api";

interface CreateSchemaDialogProps {
  sessionId: string;
  onApplied: (schemaName: string) => void;
  onClose: () => void;
}

const quote = (n: string) => `"${n.replace(/"/g, '""')}"`;

const isValidIdentifier = (s: string): boolean => {
  const trimmed = s.trim();
  if (!trimmed) return false;
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(trimmed) || /^".*"$/.test(trimmed);
};

export function CreateSchemaDialog({
  sessionId,
  onApplied,
  onClose,
}: CreateSchemaDialogProps) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("");
  const [ifNotExists, setIfNotExists] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sql = useMemo(() => {
    const trimmedName = name.trim();
    if (!trimmedName) return "";
    const parts = ["CREATE SCHEMA"];
    if (ifNotExists) parts.push("IF NOT EXISTS");
    parts.push(quote(trimmedName));
    if (owner.trim()) parts.push(`AUTHORIZATION ${quote(owner.trim())}`);
    return parts.join(" ") + ";";
  }, [name, owner, ifNotExists]);

  const highlightedSql = useMemo(() => {
    if (!sql) return "";
    try {
      return hljs.highlight(sql, { language: "sql" }).value;
    } catch {
      return "";
    }
  }, [sql]);

  const canApply = isValidIdentifier(name) && !busy;

  const submit = async () => {
    if (!canApply) return;
    setBusy(true);
    setError(null);
    try {
      await explorerApi.runQuery(sessionId, sql);
      await explorerApi.refreshDatabaseSchema(sessionId);
      onApplied(name.trim());
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle>{t("explorer.createSchema.title")}</DialogTitle>
          <DialogDescription>
            {t("explorer.createSchema.desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-5 py-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cs-name" className="text-xs">
              {t("explorer.createSchema.nameLabel")}
            </Label>
            <Input
              id="cs-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("explorer.createSchema.namePlaceholder")}
              disabled={busy}
              autoFocus
            />
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="size-3.5"
              checked={ifNotExists}
              onChange={(e) => setIfNotExists(e.target.checked)}
              disabled={busy}
            />
            <span>{t("explorer.createSchema.ifNotExists")}</span>
          </label>

          <div className="rounded-md border border-border">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent/40"
            >
              <ChevronRight
                className={cn(
                  "size-3.5 shrink-0 transition-transform",
                  advancedOpen && "rotate-90",
                )}
              />
              <span>{t("explorer.createSchema.advanced")}</span>
            </button>
            {advancedOpen && (
              <div className="border-t border-border px-3 py-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cs-owner" className="text-xs">
                    {t("explorer.createSchema.ownerLabel")}
                  </Label>
                  <Input
                    id="cs-owner"
                    value={owner}
                    onChange={(e) => setOwner(e.target.value)}
                    placeholder={t("explorer.createSchema.ownerPlaceholder")}
                    disabled={busy}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">
              {t("explorer.createSchema.previewLabel")}
            </Label>
            <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-foreground">
              {sql ? (
                <code
                  className="hljs whitespace-pre bg-transparent p-0"
                  dangerouslySetInnerHTML={{ __html: highlightedSql }}
                />
              ) : (
                <code className="whitespace-pre">—</code>
              )}
            </pre>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 border-t border-border bg-destructive/10 px-5 py-2.5">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <p className="text-xs text-destructive">{error}</p>
          </div>
        )}

        <DialogFooter className="border-t border-border px-5 py-3">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} disabled={!canApply}>
            {busy && <Loader2 className="animate-spin" />}
            {t("explorer.createSchema.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
