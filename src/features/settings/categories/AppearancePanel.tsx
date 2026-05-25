import { Check, Monitor, Moon, Palette, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  useTheme,
  type ColorTheme,
  type Theme,
} from "@/components/theme-provider";
import { useI18n, type TKey } from "@/i18n";
import { cn } from "@/lib/utils";

interface ColorOption {
  id: ColorTheme;
  /** Dictionary key for the color label. */
  labelKey: TKey;
  /** Inline gradient preview shown in the swatch. */
  gradient: string;
}

const COLOR_OPTIONS: ColorOption[] = [
  { id: "purple", labelKey: "settings.appearance.colors.purple", gradient: "linear-gradient(135deg, #6c5ce7 0%, #00b8d4 100%)" },
  { id: "blue",   labelKey: "settings.appearance.colors.blue",   gradient: "linear-gradient(135deg, #2563eb 0%, #06b6d4 100%)" },
  { id: "red",    labelKey: "settings.appearance.colors.red",    gradient: "linear-gradient(135deg, #dc2626 0%, #f97316 100%)" },
  { id: "pink",   labelKey: "settings.appearance.colors.pink",   gradient: "linear-gradient(135deg, #db2777 0%, #a855f7 100%)" },
  { id: "green",  labelKey: "settings.appearance.colors.green",  gradient: "linear-gradient(135deg, #16a34a 0%, #14b8a6 100%)" },
  { id: "orange", labelKey: "settings.appearance.colors.orange", gradient: "linear-gradient(135deg, #ea580c 0%, #f59e0b 100%)" },
  { id: "yellow", labelKey: "settings.appearance.colors.yellow", gradient: "linear-gradient(135deg, #eab308 0%, #f59e0b 100%)" },
];

const THEME_OPTIONS: { value: Theme; labelKey: TKey; icon: typeof Sun }[] = [
  { value: "light",  labelKey: "settings.appearance.modes.light",  icon: Sun },
  { value: "dark",   labelKey: "settings.appearance.modes.dark",   icon: Moon },
  { value: "system", labelKey: "settings.appearance.modes.system", icon: Monitor },
];

export function AppearancePanel() {
  const { theme, setTheme, colorTheme, setColorTheme } = useTheme();
  const { t } = useI18n();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-8">
      <header className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <Palette className="size-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold leading-tight">
            {t("settings.appearance.title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("settings.appearance.subtitle")}
          </p>
        </div>
      </header>

      <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5">
        <div>
          <h3 className="text-sm font-medium">{t("settings.appearance.colorScheme")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("settings.appearance.colorSchemeDesc")}
          </p>
        </div>

        <div className="grid grid-cols-4 gap-3 sm:grid-cols-7">
          {COLOR_OPTIONS.map((option) => {
            const active = option.id === colorTheme;
            const label = t(option.labelKey);
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setColorTheme(option.id)}
                aria-pressed={active}
                title={label}
                className={cn(
                  "group flex flex-col items-center gap-1.5 rounded-md p-1.5 transition-colors",
                  active ? "bg-accent" : "hover:bg-accent/60",
                )}
              >
                <span
                  className={cn(
                    "relative flex size-10 items-center justify-center rounded-full ring-offset-2 ring-offset-card transition-shadow",
                    active && "ring-2 ring-foreground/70",
                  )}
                  style={{ background: option.gradient }}
                >
                  {active && (
                    <Check className="size-4 text-white drop-shadow" />
                  )}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5">
        <div>
          <h3 className="text-sm font-medium">{t("settings.appearance.mode")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("settings.appearance.modeDesc")}
          </p>
        </div>

        <div className="inline-flex w-fit items-center gap-0.5 rounded-md border border-border bg-background p-0.5">
          {THEME_OPTIONS.map(({ value, labelKey, icon: Icon }) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant="ghost"
              aria-pressed={theme === value}
              onClick={() => setTheme(value)}
              className={cn(
                "h-8 gap-1.5 rounded-sm px-3 text-xs",
                theme === value &&
                  "bg-accent text-accent-foreground hover:bg-accent",
              )}
            >
              <Icon className="size-3.5" />
              {t(labelKey)}
            </Button>
          ))}
        </div>
      </section>
    </div>
  );
}
