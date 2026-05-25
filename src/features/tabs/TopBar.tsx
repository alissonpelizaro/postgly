import { useState } from "react";
import { ArrowUpCircle, Brain, Database, Info, LayoutGrid, Menu, Settings as SettingsIcon, X } from "lucide-react";

// import { LanguageSwitcher } from "@/components/language-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AboutDialog } from "@/features/about/AboutDialog";
import { useVersionCheck } from "@/features/about/use-version-check";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

import type { WorkspaceTab } from "./types";

interface TopBarProps {
  tabs: WorkspaceTab[];
  /** `null` selects the connection manager; `"settings"` selects Settings. */
  activeId: string | null;
  onSelect: (id: string | null) => void;
  onClose: (id: string) => void;
  onOpenSettings: () => void;
  /** Show the agent-chat brain button in its enabled (colored) state. */
  llmConfigured: boolean;
  /** Whether the right-side chat panel is currently open. */
  chatOpen: boolean;
  onToggleChat: () => void;
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
  llmConfigured,
  chatOpen,
  onToggleChat,
}: TopBarProps) {
  const version = useVersionCheck();
  const { t } = useI18n();
  const [aboutOpen, setAboutOpen] = useState(false);

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-sidebar px-2">
      <HomeButton
        active={activeId === null}
        label={t("topbar.connections")}
        onClick={() => onSelect(null)}
      />

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

      {version.updateAvailable && (
        <UpdateBadge
          latest={version.latest!}
          label={t("topbar.updateAvailable")}
          titleText={t("topbar.updateTitle", { v: version.latest! })}
          onClick={() => setAboutOpen(true)}
        />
      )}
      {/* <LanguageSwitcher compact /> */}
      <AgentChatButton
        enabled={llmConfigured}
        active={chatOpen}
        onClick={onToggleChat}
        enabledTitle={t("topbar.agentChat")}
        disabledTitle={t("topbar.agentChatDisabled")}
      />
      <ThemeToggle />
      <AppMenu
        onOpenSettings={onOpenSettings}
        onOpenAbout={() => setAboutOpen(true)}
        settingsLabel={t("topbar.settings")}
        aboutLabel={t("topbar.about")}
        menuLabel={t("topbar.menu")}
      />

      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} version={version} />
    </div>
  );
}

/** Brain button that opens the right-side agent chat. Muted until the
 *  LLM provider is configured. */
function AgentChatButton({
  enabled,
  active,
  onClick,
  enabledTitle,
  disabledTitle,
}: {
  enabled: boolean;
  active: boolean;
  onClick: () => void;
  enabledTitle: string;
  disabledTitle: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!enabled}
      aria-label={enabled ? enabledTitle : disabledTitle}
      title={enabled ? enabledTitle : disabledTitle}
      className={cn(
        "ml-1 flex size-7 items-center justify-center rounded-md transition-colors",
        !enabled && "text-muted-foreground/50 cursor-not-allowed",
        enabled && !active && "text-primary hover:bg-accent",
        enabled && active && "bg-primary/15 text-primary",
      )}
    >
      <Brain className="size-4" />
    </button>
  );
}

/** "New version available" pill — only rendered when an update exists. */
function UpdateBadge({
  label,
  titleText,
  onClick,
}: {
  latest: string;
  label: string;
  titleText: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={titleText}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors",
        "border border-primary/40 bg-primary/10 text-primary hover:bg-primary/15",
      )}
    >
      <ArrowUpCircle className="size-3.5" />
      {label}
    </button>
  );
}

/** The home / connection-manager button. */
function HomeButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
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
      {label}
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
  onOpenAbout: () => void;
  settingsLabel: string;
  aboutLabel: string;
  menuLabel: string;
}

/** Header dropdown with app-wide actions. */
function AppMenu({
  onOpenSettings,
  onOpenAbout,
  settingsLabel,
  aboutLabel,
  menuLabel,
}: AppMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={menuLabel}
        className="ml-1 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Menu className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onOpenSettings}>
          <SettingsIcon className="size-4" />
          {settingsLabel}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onOpenAbout}>
          <Info className="size-4" />
          {aboutLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
