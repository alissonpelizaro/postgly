import { useMemo, useState } from "react";
import { AlertCircle, Database, Loader2, Plus, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { logoForColor } from "@/components/logo";
import { useTheme } from "@/components/theme-provider";
import { useI18n } from "@/i18n";

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
  const { t } = useI18n();
  const { connections, loading, error, refresh } = useConnections();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ConnectionMeta | null>(null);
  const [query, setQuery] = useState("");

  const trimmedQuery = query.trim().toLowerCase();
  const filteredConnections = useMemo(() => {
    if (!trimmedQuery) return connections;
    return connections.filter((c) =>
      c.name.toLowerCase().includes(trimmedQuery),
    );
  }, [connections, trimmedQuery]);

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
            <header className="flex flex-col gap-3 border-b border-border px-5 py-3">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-base font-semibold leading-tight">
                    {t("connections.title")}
                  </h1>
                  <p className="text-xs text-muted-foreground">
                    {connections.length === 0
                      ? t("connections.emptyCount")
                      : trimmedQuery
                        ? t("connections.filteredCount", {
                            shown: filteredConnections.length,
                            total: connections.length,
                          })
                        : t("connections.savedCount", { n: connections.length })}
                  </p>
                </div>
                <Button size="sm" variant="gradient" onClick={openCreate}>
                  <Plus />
                  {t("connections.newConnection")}
                </Button>
              </div>
              {connections.length > 0 && (
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t("connections.filterPlaceholder")}
                    className="h-8 pl-8 pr-8 text-sm"
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery("")}
                      aria-label={t("connections.clearFilter")}
                      className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>
              )}
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
              ) : filteredConnections.length === 0 ? (
                <CenteredState>
                  <Search className="size-6 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    {t("connections.noResults", { q: query })}
                  </p>
                </CenteredState>
              ) : (
                <div className="flex flex-col gap-2">
                  {filteredConnections.map((connection) => (
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
 * Left-hand branding panel — hero slab mirroring the marketing site
 * (faded grid, gradient glow blobs, gradient wordmark).
 */
function BrandPanel() {
  const { t } = useI18n();
  const { colorTheme } = useTheme();
  return (
    <aside className="relative flex h-full w-full items-center justify-center overflow-hidden bg-background">
      {/* Faded grid backdrop. */}
      <div className="bg-hero-grid pointer-events-none absolute inset-0 opacity-60" />

      {/* Drifting gradient glow blobs. */}
      <div
        className="animate-drift-a pointer-events-none absolute -left-24 -top-24 size-[22rem] rounded-full opacity-40 blur-3xl"
        style={{ background: "var(--accent-grad)" }}
      />
      <div
        className="animate-drift-b pointer-events-none absolute -bottom-32 -right-20 size-[26rem] rounded-full opacity-30 blur-3xl"
        style={{ background: "var(--accent-grad)" }}
      />
      <div
        className="animate-drift-a pointer-events-none absolute left-1/3 top-1/2 size-[18rem] rounded-full opacity-25 blur-3xl"
        style={{
          background: "var(--accent-grad)",
          animationDelay: "-8s",
          animationDuration: "44s",
        }}
      />

      <div className="relative z-10 flex flex-col items-center justify-center gap-7 px-10 text-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
          <span className="inline-block size-1.5 rounded-full bg-primary shadow-[0_0_0_4px_color-mix(in_srgb,var(--primary)_25%,transparent)]" />
          {t("connections.brandBadge")}
        </span>

        <img
          src={logoForColor(colorTheme)}
          alt="Postgly"
          className="animate-brand-pulse w-48"
        />

        <h2 className="max-w-sm text-2xl font-bold leading-tight tracking-tight">
          <span className="text-grad">{t("connections.brandTitlePrefix")}</span>
          {t("connections.brandTitleSuffix")}
        </h2>

        <p className="max-w-xs text-sm text-muted-foreground">
          {t("connections.brandSubLine1Prefix")}
          <span className="text-grad">{t("connections.brandSubLine1Suffix")}</span>.<br></br>
          <span className="italic">{t("connections.brandSubLine2")}</span>
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
  const { t } = useI18n();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <div className="bg-accent-grad flex size-14 items-center justify-center rounded-2xl text-white shadow-lg shadow-primary/25">
        <Database className="size-7" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("connections.emptyTitle")}</p>
        <p className="max-w-xs text-sm text-muted-foreground">
          {t("connections.emptySubtitle")}
        </p>
      </div>
      <Button variant="gradient" onClick={onCreate}>
        <Plus />
        {t("connections.createFirst")}
      </Button>
    </div>
  );
}
