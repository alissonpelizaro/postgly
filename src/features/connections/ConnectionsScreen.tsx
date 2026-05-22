import { useState } from "react";
import { AlertCircle, Database, Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";

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
    <div className="flex h-full">
      <BrandPanel />

      <section className="flex h-full flex-1 flex-col bg-background">
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <div>
            <h1 className="text-base font-semibold leading-tight">Conexões</h1>
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

      <ConnectionForm
        open={formOpen}
        onOpenChange={setFormOpen}
        editing={editing}
        onSaved={refresh}
      />
    </div>
  );
}

/** Left-hand branding panel — pure decoration. */
function BrandPanel() {
  return (
    <aside className="relative hidden w-[42%] shrink-0 overflow-hidden bg-sidebar sm:flex">
      {/* Soft gradient wash. */}
      <div className="absolute inset-0 bg-gradient-to-br from-primary/15 via-transparent to-primary/5" />
      <div className="absolute -left-16 -top-16 size-72 rounded-full bg-primary/10 blur-3xl" />
      <div className="absolute -bottom-20 -right-10 size-72 rounded-full bg-primary/10 blur-3xl" />

      <div className="relative z-10 flex flex-col items-center justify-center gap-5 px-10 text-center">
        <div className="flex size-20 items-center justify-center rounded-3xl bg-primary text-primary-foreground shadow-lg shadow-primary/30">
          <Database className="size-10" />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-3xl font-semibold tracking-tight">Postgly</h2>
          <p className="max-w-xs text-sm text-muted-foreground">
            Gerencie seus bancos PostgreSQL em um só lugar — rápido, local e
            multiplataforma.
          </p>
        </div>
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
