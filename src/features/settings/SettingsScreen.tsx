import { useState } from "react";
import { ShieldAlert, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";

import { LlmConfigPanel } from "./categories/LlmConfigPanel";
import { SafetyPanel } from "./categories/SafetyPanel";

type CategoryId = "llm" | "safety";

interface Category {
  id: CategoryId;
  label: string;
  description: string;
  icon: typeof Sparkles;
}

const CATEGORIES: Category[] = [
  {
    id: "llm",
    label: "LLM Config",
    description: "Provedor compatível com OpenAI para queries em linguagem natural",
    icon: Sparkles,
  },
  {
    id: "safety",
    label: "Segurança",
    description: "Confirmações antes de operações destrutivas",
    icon: ShieldAlert,
  },
];

/**
 * Settings shell — a left sidebar of categories and a right pane that
 * renders the selected category. New sections (themes, shortcuts, etc.)
 * plug in by appending to [`CATEGORIES`] and adding a panel.
 */
export function SettingsScreen() {
  const [active, setActive] = useState<CategoryId>("llm");

  return (
    <div className="flex h-full w-full bg-background">
      <aside className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-sidebar">
        <header className="border-b border-border px-4 py-3">
          <h1 className="text-base font-semibold leading-tight">
            Configurações
          </h1>
          <p className="text-xs text-muted-foreground">
            Preferências do aplicativo
          </p>
        </header>
        <nav className="flex flex-1 flex-col gap-0.5 p-2">
          {CATEGORIES.map((category) => (
            <CategoryButton
              key={category.id}
              category={category}
              active={category.id === active}
              onClick={() => setActive(category.id)}
            />
          ))}
        </nav>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        {active === "llm" && <LlmConfigPanel />}
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
