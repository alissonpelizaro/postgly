import { useCallback, useEffect, useState } from "react";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { AgentChatPanel } from "@/features/agent-chat/AgentChatPanel";
import { useAgentChat } from "@/features/agent-chat/useAgentChat";
import { ConnectionsScreen } from "@/features/connections/ConnectionsScreen";
import type { ConnectionMeta } from "@/features/connections/types";
import { ExplorerScreen } from "@/features/explorer/ExplorerScreen";
import { settingsApi } from "@/features/settings/api";
import { SettingsScreen } from "@/features/settings/SettingsScreen";
import { TopBar } from "@/features/tabs/TopBar";
import type { WorkspaceTab } from "@/features/tabs/types";
import { cn } from "@/lib/utils";

/** Reserved `activeId` value for the Settings pane. */
const SETTINGS_VIEW = "settings";

/**
 * Root component and tab orchestrator.
 *
 * Every open connection is a tab; the connection manager is the "home"
 * view (`activeId === null`) and Settings is a pseudo-tab keyed by
 * [`SETTINGS_VIEW`]. All views stay mounted and are toggled with CSS, so
 * switching never loses state.
 */
function App() {
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Remembers where the user was before opening Settings, so its
  // close button can restore that view.
  const [preSettingsId, setPreSettingsId] = useState<string | null>(null);

  const [llmConfigured, setLlmConfigured] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  // Live Tauri DB session id per tab. Set by `ExplorerScreen` after
  // `open_connection` succeeds, cleared when the tab closes.
  const [sessionByTab, setSessionByTab] = useState<Record<string, string | null>>({});
  const activeDbSession =
    activeId && activeId !== SETTINGS_VIEW ? sessionByTab[activeId] ?? null : null;
  const activeConnection =
    activeId && activeId !== SETTINGS_VIEW
      ? tabs.find((t) => t.id === activeId)?.connection ?? null
      : null;
  const chat = useAgentChat({
    dbSessionId: activeDbSession,
    connectionLabel: activeConnection?.name ?? null,
  });

  const refreshLlmConfigured = useCallback(() => {
    settingsApi
      .get()
      .then((v) => {
        setLlmConfigured(v.llm_api_key_configured && v.llm.base_url.trim() !== "");
      })
      .catch(() => setLlmConfigured(false));
  }, []);

  useEffect(() => {
    refreshLlmConfigured();
  }, [refreshLlmConfigured]);

  // Open the chat panel and hand the user a clean session — unless the
  // active session is still empty (they opened, didn't type, closed and
  // re-opened), in which case we reuse it instead of piling up empties.
  const openChat = useCallback(() => {
    const active = chat.activeSession;
    if (!active || active.messages.length > 0) {
      chat.createSession();
    }
    setChatOpen(true);
  }, [chat]);

  // Close the chat panel and prune the active session if it never
  // received a message — keeps the history list free of empty entries.
  const closeChat = useCallback(() => {
    const active = chat.activeSession;
    if (active && active.messages.length === 0) {
      chat.deleteSession(active.id);
    }
    setChatOpen(false);
  }, [chat]);

  // Close the chat panel automatically if the provider becomes unconfigured.
  useEffect(() => {
    if (!llmConfigured) closeChat();
  }, [llmConfigured, closeChat]);

  const openTab = (connection: ConnectionMeta) => {
    const id = crypto.randomUUID();
    setTabs((prev) => [...prev, { id, connection }]);
    setActiveId(id);
  };

  const closeTab = (id: string) => {
    const index = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);
    setSessionByTab((prev) => {
      if (!(id in prev)) return prev;
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });
    if (activeId === id) {
      // Fall back to the left neighbour, or home when none remain.
      setActiveId(next.length === 0 ? null : next[Math.max(0, index - 1)].id);
    }
  };

  // Cmd/Ctrl+0 jumps home; Cmd/Ctrl+1–9 jump to the Nth tab.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "0") {
        e.preventDefault();
        setActiveId(null);
      } else if (e.key >= "1" && e.key <= "9") {
        const index = Number(e.key) - 1;
        if (index < tabs.length) {
          e.preventDefault();
          setActiveId(tabs[index].id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabs]);

  return (
    <div className="flex h-full flex-col">
      <TopBar
        tabs={tabs}
        activeId={activeId}
        onSelect={setActiveId}
        onClose={closeTab}
        onOpenSettings={() => {
          setPreSettingsId(activeId === SETTINGS_VIEW ? preSettingsId : activeId);
          setActiveId(SETTINGS_VIEW);
        }}
        llmConfigured={llmConfigured}
        chatOpen={chatOpen}
        onToggleChat={chatOpen ? closeChat : openChat}
      />

      <div className="min-h-0 flex-1">
        {/* A single, stable component tree across the chat toggle: the main
         * views always live in the same panel, and only the agent panel is
         * added/removed. Swapping the whole tree (e.g. wrapping in the panel
         * group only when open) would remount MainViews and reset every
         * ExplorerScreen's state — closing the open table. */}
        <ResizablePanelGroup direction="horizontal" className="h-full">
          <ResizablePanel id="main" order={1} defaultSize={70} minSize={40}>
            <MainViews
              activeId={activeId}
              tabs={tabs}
              preSettingsId={preSettingsId}
              openTab={openTab}
              closeTab={closeTab}
              onTabSessionChange={(tabId, sessionId) =>
                setSessionByTab((prev) => ({ ...prev, [tabId]: sessionId }))
              }
              onCloseSettings={() => {
                const target =
                  preSettingsId !== null &&
                  tabs.some((t) => t.id === preSettingsId)
                    ? preSettingsId
                    : null;
                setActiveId(target);
                setPreSettingsId(null);
                refreshLlmConfigured();
              }}
            />
          </ResizablePanel>
          {chatOpen && (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel
                id="agent"
                order={2}
                defaultSize={30}
                minSize={20}
                maxSize={50}
              >
                <AgentChatPanel chat={chat} onClose={closeChat} />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>
    </div>
  );
}

interface MainViewsProps {
  activeId: string | null;
  tabs: WorkspaceTab[];
  preSettingsId: string | null;
  openTab: (c: ConnectionMeta) => void;
  closeTab: (id: string) => void;
  onCloseSettings: () => void;
  onTabSessionChange: (tabId: string, sessionId: string | null) => void;
}

/** The three primary screens (connections / settings / open tabs),
 *  rendered so all stay mounted and only the active one is visible. */
function MainViews({
  activeId,
  tabs,
  openTab,
  closeTab,
  onCloseSettings,
  onTabSessionChange,
}: MainViewsProps) {
  return (
    <div className="h-full">
      <Pane visible={activeId === null}>
        <ConnectionsScreen onConnect={openTab} />
      </Pane>
      <Pane visible={activeId === SETTINGS_VIEW}>
        <SettingsScreen onClose={onCloseSettings} />
      </Pane>
      {tabs.map((tab) => (
        <Pane key={tab.id} visible={tab.id === activeId}>
          <ExplorerScreen
            connection={tab.connection}
            onClose={() => closeTab(tab.id)}
            onSessionChange={(sessionId) => onTabSessionChange(tab.id, sessionId)}
          />
        </Pane>
      ))}
    </div>
  );
}

/** Wraps a screen, hiding it (without unmounting) when another tab is active. */
function Pane({
  visible,
  children,
}: {
  visible: boolean;
  children: React.ReactNode;
}) {
  return <div className={cn("h-full", !visible && "hidden")}>{children}</div>;
}

export default App;
