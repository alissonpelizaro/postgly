import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Save, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";

import { settingsApi } from "../api";
import type { SafetyConfig, SettingsView } from "../types";

/**
 * Safety panel — currently a single toggle for the destructive-SQL
 * confirmation modal. New guard-rails (auto-EXPLAIN, dry-run, ...)
 * slot in as additional rows.
 */
export function SafetyPanel() {
  const { t } = useI18n();
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<SafetyConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    settingsApi
      .get()
      .then((v) => {
        if (cancelled) return;
        setView(v);
        setDraft(v.safety);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  const update = <K extends keyof SafetyConfig>(key: K, value: SafetyConfig[K]) => {
    setDraft((prev) => (prev === null ? prev : { ...prev, [key]: value }));
    setSaved(false);
  };

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const next = await settingsApi.saveSafety(draft);
      setView(next);
      setDraft(next.safety);
      setSaved(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const dirty =
    !!view && !!draft && view.safety.confirm_destructive !== draft.confirm_destructive;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-8">
      <header className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-300">
          <ShieldAlert className="size-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold leading-tight">{t("settings.safety.title")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("settings.safety.subtitle")}
          </p>
        </div>
      </header>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {draft === null ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-5 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("common.loading")}
        </div>
      ) : (
        <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5">
          <ToggleRow
            title={t("settings.safety.confirmDestructiveTitle")}
            description={t("settings.safety.confirmDestructiveDesc")}
            checked={draft.confirm_destructive}
            onChange={(v) => update("confirm_destructive", v)}
          />

          {saved && !error && (
            <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/10 p-3 text-sm text-primary">
              <CheckCircle2 className="size-4" />
              {t("settings.safety.saved")}
            </div>
          )}

          <div className="flex items-center justify-end">
            <Button type="button" onClick={handleSave} disabled={!dirty || saving}>
              {saving ? <Loader2 className="animate-spin" /> : <Save />}
              {t("common.save")}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

interface ToggleRowProps {
  title: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}

function ToggleRow({ title, description, checked, onChange }: ToggleRowProps) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 size-4 shrink-0 accent-primary"
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}
