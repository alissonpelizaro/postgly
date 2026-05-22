import { useState } from "react";

import { ConnectionsScreen } from "@/features/connections/ConnectionsScreen";
import type { ConnectionMeta } from "@/features/connections/types";
import { ExplorerScreen } from "@/features/explorer/ExplorerScreen";

/**
 * Root component. Two states: the connection manager and the connected
 * explorer workspace. Phase 4 turns the single active connection into
 * global tabs.
 */
function App() {
  const [active, setActive] = useState<ConnectionMeta | null>(null);

  if (active) {
    return (
      <ExplorerScreen connection={active} onClose={() => setActive(null)} />
    );
  }
  return <ConnectionsScreen onConnect={setActive} />;
}

export default App;
