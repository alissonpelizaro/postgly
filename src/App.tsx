import { useState } from "react";
import { ArrowLeft, Database } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConnectionsScreen } from "@/features/connections/ConnectionsScreen";
import type { ConnectionMeta } from "@/features/connections/types";

/**
 * Root component. Phase 1 has two states: the connection manager and a
 * placeholder for an open connection. Phase 2 replaces the placeholder
 * with the schema/table explorer, and Phase 4 turns it into global tabs.
 */
function App() {
  const [active, setActive] = useState<ConnectionMeta | null>(null);

  if (active) {
    return <ConnectedPlaceholder connection={active} onBack={() => setActive(null)} />;
  }
  return <ConnectionsScreen onConnect={setActive} />;
}

/** Temporary screen shown after connecting — the explorer lands in Phase 2. */
function ConnectedPlaceholder({
  connection,
  onBack,
}: {
  connection: ConnectionMeta;
  onBack: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-4 py-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft />
          Conexões
        </Button>
        <span className="text-sm font-medium">{connection.name}</span>
      </header>
      <main className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Database className="size-7" />
        </div>
        <p className="text-sm font-medium">Conectado a {connection.database}</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          O explorador de schemas e tabelas chega na Fase 2.
        </p>
      </main>
    </div>
  );
}

export default App;
