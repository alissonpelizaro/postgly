import { useState } from "react";
import { Check, Settings as SettingsIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { LANGUAGES, useI18n, type Language } from "@/i18n";
import {
  DEFAULT_COLUMN_SEPARATOR,
  DEFAULT_EXPORT_DELIMITER,
  getColumnSeparator,
  getExportDelimiter,
  setColumnSeparator,
  setExportDelimiter,
} from "@/lib/copy-prefs";
import { cn } from "@/lib/utils";

/**
 * General preferences — language today, app-wide options later.
 */
export function GeneralPanel() {
  const { lang, setLang, t } = useI18n();
  const [separator, setSeparator] = useState(getColumnSeparator);
  const [delimiter, setDelimiter] = useState(getExportDelimiter);

  // Both apply instantly (like language) — no Save button. Each falls back
  // to its default when cleared so copy/export always have a delimiter.
  const updateSeparator = (value: string) => {
    setSeparator(value);
    setColumnSeparator(value === "" ? DEFAULT_COLUMN_SEPARATOR : value);
  };
  const updateDelimiter = (value: string) => {
    setDelimiter(value);
    setExportDelimiter(value === "" ? DEFAULT_EXPORT_DELIMITER : value);
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-8">
      <header className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <SettingsIcon className="size-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold leading-tight">
            {t("settings.general.title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("settings.general.subtitle")}
          </p>
        </div>
      </header>

      <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5">
        <div>
          <h3 className="text-sm font-medium">{t("settings.general.language")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("settings.general.languageDesc")}
          </p>
        </div>

        <div className="grid grid-cols-3 gap-2">
          {LANGUAGES.map((option) => {
            const active = option.code === lang;
            return (
              <button
                key={option.code}
                type="button"
                onClick={() => setLang(option.code as Language)}
                aria-pressed={active}
                className={cn(
                  "flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                  active
                    ? "border-primary/50 bg-primary/10 text-foreground"
                    : "border-border bg-background hover:bg-accent/60",
                )}
              >
                <span className="text-lg" aria-hidden="true">
                  {option.flag}
                </span>
                <span className="flex-1 text-left">{option.label}</span>
                {active && <Check className="size-4 text-primary" />}
              </button>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-1 rounded-lg border border-border bg-card p-5">
        <h3 className="text-sm font-semibold">
          {t("settings.general.exportTitle")}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t("settings.general.exportSubtitle")}
        </p>

        <div className="mt-3 flex flex-col divide-y divide-border">
          <FieldRow
            label={t("settings.general.copySeparator")}
            description={t("settings.general.copySeparatorDesc")}
            value={separator}
            placeholder={DEFAULT_COLUMN_SEPARATOR}
            onChange={updateSeparator}
          />
          <FieldRow
            label={t("settings.general.exportDelimiter")}
            description={t("settings.general.exportDelimiterDesc")}
            value={delimiter}
            placeholder={DEFAULT_EXPORT_DELIMITER}
            onChange={updateDelimiter}
          />
        </div>
      </section>
    </div>
  );
}

/** A label + description on the left, with a small inline input on the
 *  right — used by the export settings rows. */
function FieldRow({
  label,
  description,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  description: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="text-sm font-normal text-foreground/90">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="w-16 shrink-0 text-center font-mono"
      />
    </div>
  );
}
