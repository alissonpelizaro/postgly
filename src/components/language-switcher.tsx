import { Check, Languages } from "lucide-react";

import { LANGUAGES, useI18n, type Language } from "@/i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

interface LanguageSwitcherProps {
  /** Compact = flag-only chip for the top bar. */
  compact?: boolean;
}

export function LanguageSwitcher({ compact = false }: LanguageSwitcherProps) {
  const { lang, setLang, t } = useI18n();
  const current = LANGUAGES.find((l) => l.code === lang) ?? LANGUAGES[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        title={t("topbar.language")}
        aria-label={t("topbar.language")}
        className={cn(
          "flex items-center gap-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
          compact ? "h-7 px-1.5 text-base" : "h-8 border border-border bg-card px-2 text-sm",
        )}
      >
        <span aria-hidden="true">{current.flag}</span>
        {!compact && <span>{current.label}</span>}
        {!compact && <Languages className="size-3.5 opacity-60" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {LANGUAGES.map((option) => (
          <DropdownMenuItem
            key={option.code}
            onClick={() => setLang(option.code as Language)}
            className="gap-2"
          >
            <span aria-hidden="true">{option.flag}</span>
            <span className="flex-1">{option.label}</span>
            {option.code === lang && (
              <Check className="size-3.5 text-primary" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
