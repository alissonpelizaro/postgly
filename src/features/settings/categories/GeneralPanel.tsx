import { Check, Settings as SettingsIcon } from "lucide-react";

import { LANGUAGES, useI18n, type Language } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * General preferences — language today, app-wide options later.
 */
export function GeneralPanel() {
  const { lang, setLang, t } = useI18n();

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
    </div>
  );
}
