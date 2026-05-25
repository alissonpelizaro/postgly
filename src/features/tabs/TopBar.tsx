import { Database, LayoutGrid, Menu, Settings as SettingsIcon, X } from "lucide-react";

import { ThemeToggle } from "@/components/theme-toggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import type { WorkspaceTab } from "./types";

interface TopBarProps {
  tabs: WorkspaceTab[];
  /** `null` selects the connection manager; `"settings"` selects Settings. */
  activeId: string | null;
  onSelect: (id: string | null) => void;
  onClose: (id: string) => void;
  onOpenSettings: () => void;
}

/**
 * The always-present top chrome: a home button for the connection
 * manager, one chip per open connection, the theme toggle, and an app
 * menu (settings, etc.). Switching tabs never unmounts them, so each
 * keeps its own state.
 */
export function TopBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onOpenSettings,
}: TopBarProps) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-sidebar px-2">
      <HomeButton active={activeId === null} onClick={() => onSelect(null)} />

      {tabs.length > 0 && <div className="mx-1 h-4 w-px bg-border" />}

      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => (
          <ConnectionTab
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            onSelect={() => onSelect(tab.id)}
            onClose={() => onClose(tab.id)}
          />
        ))}
      </div>

      <ThemeToggle />
      <AppMenu onOpenSettings={onOpenSettings} />
    </div>
  );
}

/** The home / connection-manager button. */
function HomeButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors",
        active
          ? "bg-card font-medium text-foreground shadow-sm"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      <LayoutGrid className="size-3.5" />
      Conexões
    </button>
  );
}

interface ConnectionTabProps {
  tab: WorkspaceTab;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}

/** A single open-connection chip. */
function ConnectionTab({ tab, active, onSelect, onClose }: ConnectionTabProps) {
  return (
    <div
      className={cn(
        "group flex h-7 shrink-0 items-center rounded-md pl-2 pr-1 text-sm transition-colors",
        active
          ? "bg-card text-foreground shadow-sm"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 items-center gap-1.5"
        title={tab.connection.name}
      >
        <Database className="size-3.5 shrink-0" />
        <span className="max-w-[140px] truncate">{tab.connection.name}</span>
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label={`Fechar ${tab.connection.name}`}
        className="ml-1 flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

interface AppMenuProps {
  onOpenSettings: () => void;
}

/** Header dropdown with app-wide actions. */
function AppMenu({ onOpenSettings }: AppMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Menu"
        className="ml-1 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Menu className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onOpenSettings}>
          <SettingsIcon className="size-4" />
          Configurações
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
