import { useEffect, useMemo, useState } from "react";
import { Palette, Settings as SettingsIcon, ShieldAlert, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

import { AppearancePanel } from "./categories/AppearancePanel";
import { GeneralPanel } from "./categories/GeneralPanel";
import { LlmConfigPanel } from "./categories/LlmConfigPanel";
import { SafetyPanel } from "./categories/SafetyPanel";

type CategoryId = "general" | "llm" | "appearance" | "safety";

interface Category {
  id: CategoryId;
  label: string;
  description: string;
  icon: typeof Sparkles;
}

interface SettingsScreenProps {
  /** Closes the settings view (returns to the previous tab or home). */
  onClose: () => void;
}

export function SettingsScreen({ onClose }: SettingsScreenProps) {
  const { t } = useI18n();
  const [active, setActive] = useState<CategoryId>("general");

  const categories = useMemo<Category[]>(
    () => [
      {
        id: "general",
        label: t("settings.categories.general"),
        description: t("settings.categories.generalDesc"),
        icon: SettingsIcon,
      },
      {
        id: "llm",
        label: t("settings.categories.llm"),
        description: t("settings.categories.llmDesc"),
        icon: Sparkles,
      },
      {
        id: "appearance",
        label: t("settings.categories.appearance"),
        description: t("settings.categories.appearanceDesc"),
        icon: Palette,
      },
      {
        id: "safety",
        label: t("settings.categories.safety"),
        description: t("settings.categories.safetyDesc"),
        icon: ShieldAlert,
      },
    ],
    [t],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="flex h-full w-full bg-background">
      <aside className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-sidebar">
        <header className="border-b border-border px-4 py-3">
          <h1 className="text-base font-semibold leading-tight">
            {t("settings.title")}
          </h1>
          <p className="text-xs text-muted-foreground">
            {t("settings.subtitle")}
          </p>
        </header>
        <nav className="flex flex-1 flex-col gap-0.5 p-2">
          {categories.map((category) => (
            <CategoryButton
              key={category.id}
              category={category}
              active={category.id === active}
              onClick={() => setActive(category.id)}
            />
          ))}
        </nav>
        <div className="border-t border-border p-2">
          <Button
            type="button"
            variant="outline"
            className="w-full justify-start"
            onClick={onClose}
            title={t("common.closeEsc")}
          >
            <X />
            {t("common.close")}
          </Button>
        </div>
      </aside>

      <main className="relative min-w-0 flex-1 overflow-y-auto">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-3 top-3 z-10 size-8"
          onClick={onClose}
          aria-label={t("settings.closeAria")}
          title={t("common.closeEsc")}
        >
          <X />
        </Button>
        {active === "general" && <GeneralPanel />}
        {active === "llm" && <LlmConfigPanel />}
        {active === "appearance" && <AppearancePanel />}
        {active === "safety" && <SafetyPanel />}
      </main>
    </div>
  );
}

interface CategoryButtonProps {
  category: Category;
  active: boolean;
  onClick: () => void;
}

function CategoryButton({ category, active, onClick }: CategoryButtonProps) {
  const Icon = category.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-start gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
        active
          ? "bg-card text-foreground shadow-sm"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span className="flex min-w-0 flex-col">
        <span className="font-medium">{category.label}</span>
        <span className="text-xs text-muted-foreground">
          {category.description}
        </span>
      </span>
    </button>
  );
}
