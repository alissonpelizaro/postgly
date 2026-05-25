import { useState } from "react";
import { AlertCircle, Database, Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import logoUrl from "@/assets/postgly-logo.png";

import { connectionsApi } from "./api";
import { ConnectionForm } from "./ConnectionForm";
import { ConnectionRow } from "./ConnectionRow";
import { useConnections } from "./use-connections";
import type { ConnectionMeta } from "./types";

interface ConnectionsScreenProps {
  /** Invoked when the user connects — opens the connection in a new tab. */
  onConnect: (connection: ConnectionMeta) => void;
}

/**
 * The app's landing screen: a branding panel on the left and the saved
 * connection list with its management controls on the right.
 */
export function ConnectionsScreen({ onConnect }: ConnectionsScreenProps) {
  const { connections, loading, error, refresh } = useConnections();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ConnectionMeta | null>(null);

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (connection: ConnectionMeta) => {
    setEditing(connection);
    setFormOpen(true);
  };

  const handleDelete = async (connection: ConnectionMeta) => {
    await connectionsApi.remove(connection.id);
    await refresh();
  };

  return (
    <>
      <ResizablePanelGroup direction="horizontal" className="h-full">
        <ResizablePanel defaultSize={58} minSize={30}>
          <BrandPanel />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={42} minSize={30}>
          <section className="flex h-full w-full flex-col bg-background">
            <header className="flex items-center justify-between border-b border-border px-5 py-3">
              <div>
                <h1 className="text-base font-semibold leading-tight">
                  Conexões
                </h1>
                <p className="text-xs text-muted-foreground">
                  {connections.length === 0
                    ? "Nenhuma conexão salva"
                    : `${connections.length} conexão(ões) salva(s)`}
                </p>
              </div>
              <Button size="sm" onClick={openCreate}>
                <Plus />
                Nova conexão
              </Button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {loading ? (
                <CenteredState>
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </CenteredState>
              ) : error ? (
                <CenteredState>
                  <AlertCircle className="size-6 text-destructive" />
                  <p className="text-sm text-destructive">{error}</p>
                </CenteredState>
              ) : connections.length === 0 ? (
                <EmptyState onCreate={openCreate} />
              ) : (
                <div className="flex flex-col gap-2">
                  {connections.map((connection) => (
                    <ConnectionRow
                      key={connection.id}
                      connection={connection}
                      onEdit={openEdit}
                      onDelete={handleDelete}
                      onConnect={onConnect}
                    />
                  ))}
                </div>
              )}
            </div>
          </section>
        </ResizablePanel>
      </ResizablePanelGroup>

      <ConnectionForm
        open={formOpen}
        onOpenChange={setFormOpen}
        editing={editing}
        onSaved={refresh}
      />
    </>
  );
}

/**
 * Left-hand branding panel — a hero slab that follows the active theme.
 */
function BrandPanel() {
  return (
    <aside className="relative flex h-full w-full items-center justify-center overflow-hidden bg-muted">
      {/* Green glow accents. */}
      <div className="absolute -left-16 -top-16 size-72 rounded-full bg-primary/20 blur-3xl" />
      <div className="absolute -bottom-20 -right-10 size-80 rounded-full bg-primary/15 blur-3xl" />

      <div className="relative z-10 flex flex-col items-center justify-center gap-6 px-10 text-center">
        <img
          src={logoUrl}
          alt="Postgly"
          className="w-48 drop-shadow-[0_0_30px_rgba(74,144,229,0.3)]"
        />
        <p className="max-w-xs text-sm text-muted-foreground">
          Gerencie seus bancos PostgreSQL em um só lugar — rápido, local e
          multiplataforma.
        </p>
      </div>
    </aside>
  );
}

/** Centered container for loading / error states. */
function CenteredState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2">
      {children}
    </div>
  );
}

/** Shown when there are no saved connections yet. */
function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <Database className="size-7" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">Nenhuma conexão ainda</p>
        <p className="max-w-xs text-sm text-muted-foreground">
          Crie sua primeira conexão para começar a explorar um banco.
        </p>
      </div>
      <Button onClick={onCreate}>
        <Plus />
        Criar primeira conexão
      </Button>
    </div>
  );
}
