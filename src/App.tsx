import { useEffect, useState } from "react";

import { ConnectionsScreen } from "@/features/connections/ConnectionsScreen";
import type { ConnectionMeta } from "@/features/connections/types";
import { ExplorerScreen } from "@/features/explorer/ExplorerScreen";
import { TopBar } from "@/features/tabs/TopBar";
import type { WorkspaceTab } from "@/features/tabs/types";
import { cn } from "@/lib/utils";

/**
 * Root component and tab orchestrator.
 *
 * Every open connection is a tab; the connection manager is the "home"
 * view (`activeId === null`). All tabs stay mounted and are toggled with
 * CSS, so switching tabs never loses a tab's session or state.
 */
function App() {
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const openTab = (connection: ConnectionMeta) => {
    const id = crypto.randomUUID();
    setTabs((prev) => [...prev, { id, connection }]);
    setActiveId(id);
  };

  const closeTab = (id: string) => {
    const index = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);
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
      />

      <div className="min-h-0 flex-1">
        <Pane visible={activeId === null}>
          <ConnectionsScreen onConnect={openTab} />
        </Pane>
        {tabs.map((tab) => (
          <Pane key={tab.id} visible={tab.id === activeId}>
            <ExplorerScreen
              connection={tab.connection}
              onClose={() => closeTab(tab.id)}
            />
          </Pane>
        ))}
      </div>
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
