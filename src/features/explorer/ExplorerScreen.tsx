import { useEffect, useState } from "react";
import { AlertCircle, ArrowLeft, Loader2, Table2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";
import type { ConnectionMeta } from "@/features/connections/types";

import { explorerApi } from "./api";
import { SchemaTree } from "./SchemaTree";
import { TableRecords } from "./TableRecords";
import { TableStructure } from "./TableStructure";
import type { TableRef } from "./types";

interface ExplorerScreenProps {
  connection: ConnectionMeta;
  /** Return to the connection manager. */
  onClose: () => void;
}

type DetailTab = "structure" | "records";

/**
 * The connected workspace: a resizable schema tree on the left and a
 * tabbed detail panel on the right. Owns the connection session — opened
 * on mount, closed on unmount.
 */
export function ExplorerScreen({ connection, onClose }: ExplorerScreenProps) {
  const [session, setSession] = useState<string | null>(null);
  const [opening, setOpening] = useState(true);
  const [openError, setOpenError] = useState<string | null>(null);
  const [selected, setSelected] = useState<TableRef | null>(null);
  const [tab, setTab] = useState<DetailTab>("structure");

  useEffect(() => {
    let active = true;
    let openedId: string | null = null;

    setOpening(true);
    setOpenError(null);
    explorerApi
      .open(connection.id)
      .then((id) => {
        if (active) {
          openedId = id;
          setSession(id);
        } else {
          void explorerApi.close(id);
        }
      })
      .catch((e) => active && setOpenError(String(e)))
      .finally(() => active && setOpening(false));

    return () => {
      active = false;
      if (openedId) void explorerApi.close(openedId);
    };
  }, [connection.id]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-3">
          <Button size="sm" variant="ghost" onClick={onClose}>
            <ArrowLeft />
            Conexões
          </Button>
          <div className="leading-tight">
            <p className="text-sm font-medium">{connection.name}</p>
            <p className="text-xs text-muted-foreground">
              {connection.host}:{connection.port}/{connection.database}
            </p>
          </div>
        </div>
        <ThemeToggle />
      </header>

      {opening ? (
        <CenteredState>
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Conectando…</p>
        </CenteredState>
      ) : openError ? (
        <CenteredState>
          <AlertCircle className="size-6 text-destructive" />
          <p className="max-w-md text-sm text-destructive">{openError}</p>
          <Button size="sm" variant="outline" onClick={onClose}>
            Voltar
          </Button>
        </CenteredState>
      ) : session ? (
        <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
          <ResizablePanel defaultSize={24} minSize={15} maxSize={45}>
            <SchemaTree
              sessionId={session}
              selected={selected}
              onSelect={(table) => {
                setSelected(table);
                setTab("structure");
              }}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={76}>
            {selected ? (
              <DetailPanel
                sessionId={session}
                table={selected}
                tab={tab}
                onTabChange={setTab}
              />
            ) : (
              <NoSelection />
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : null}
    </div>
  );
}

interface DetailPanelProps {
  sessionId: string;
  table: TableRef;
  tab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
}

/** Right panel: tabbed view of the selected table. */
function DetailPanel({ sessionId, table, tab, onTabChange }: DetailPanelProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 pt-2">
        <span className="mr-2 flex items-center gap-1.5 text-sm font-medium">
          <Table2 className="size-4 text-muted-foreground" />
          {table.schema}.{table.name}
        </span>
        <Tab active={tab === "structure"} onClick={() => onTabChange("structure")}>
          Estrutura
        </Tab>
        <Tab active={tab === "records"} onClick={() => onTabChange("records")}>
          Registros
        </Tab>
      </div>

      <div className="min-h-0 flex-1">
        {tab === "structure" ? (
          <TableStructure
            key={`structure:${table.schema}.${table.name}`}
            sessionId={sessionId}
            table={table}
          />
        ) : (
          <TableRecords
            key={`records:${table.schema}.${table.name}`}
            sessionId={sessionId}
            table={table}
          />
        )}
      </div>
    </div>
  );
}

/** A single tab button in the detail panel. */
function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
        active
          ? "border-primary font-medium text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** Empty state shown before a table is selected. */
function NoSelection() {
  return (
    <CenteredState>
      <div className="flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <Table2 className="size-7" />
      </div>
      <p className="text-sm font-medium">Nenhuma tabela selecionada</p>
      <p className="max-w-xs text-center text-sm text-muted-foreground">
        Escolha uma tabela na árvore à esquerda para ver sua estrutura.
      </p>
    </CenteredState>
  );
}

/** Centered column layout for loading / empty / error states. */
function CenteredState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-3">
      {children}
    </div>
  );
}
