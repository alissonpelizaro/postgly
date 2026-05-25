import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Check,
  Edit3,
  Gauge,
  HelpCircle,
  History,
  Lightbulb,
  Loader2,
  Pencil,
  RotateCcw,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { explorerApi } from "./api";
import type {
  AgentOutput,
  AgentStatus,
  NlHistoryEntry,
  TokenUsage,
  TraceEvent,
} from "./types";

interface NlQueryBarProps {
  sessionId: string;
  /** Push generated SQL into the editor — caller decides whether to run it. */
  onAcceptSql: (sql: string) => void;
}

type State =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; output: AgentOutput }
  | { kind: "error"; message: string };

/**
 * Natural-language → SQL bar. Sits above the SQL editor in the records
 * tab. Renders the agent's trace inline (collapsible) and exposes an
 * "Usar SQL" action that hands the generated query to the editor
 * without running it.
 */
export function NlQueryBar({ sessionId, onAcceptSql }: NlQueryBarProps) {
  const [instruction, setInstruction] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const [traceOpen, setTraceOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const generate = useCallback(
    async (text: string) => {
      setState({ kind: "running" });
      setTraceOpen(false);
      try {
        const output = await explorerApi.generateSql(sessionId, text);
        setState({ kind: "done", output });
        // Auto-expand trace when the model failed — the user wants to know why.
        if (output.status !== "ok") setTraceOpen(true);
      } catch (err) {
        setState({ kind: "error", message: String(err) });
      }
    },
    [sessionId],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = instruction.trim();
    if (text.length === 0 || state.kind === "running") return;
    await generate(text);
  };

  const reset = () => {
    setState({ kind: "idle" });
    setTraceOpen(false);
  };

  /** Replace the instruction with a refined version and (optionally) re-submit. */
  const useSuggestion = (suggestion: string) => {
    const base = instruction.trim();
    const refined = base.length === 0 ? suggestion : `${base} (${suggestion})`;
    setInstruction(refined);
  };

  const retry = () => {
    const text = instruction.trim();
    if (text.length === 0) return;
    void generate(text);
  };

  /** Seed a follow-up turn that keeps the previous SQL as context. */
  const refine = () => {
    if (state.kind !== "done" || state.output.status !== "ok" || !state.output.sql) return;
    const previous = state.output.sql.replace(/\s+/g, " ").trim();
    const lastInstruction = state.output.reason ? "" : "";
    // Compose a one-shot follow-up: prior SQL + (optional) original
    // intent + an empty refinement slot the user fills in.
    const seed = `Refine a query abaixo conforme a próxima instrução.\nQuery atual: ${previous}\nRefinamento: ${lastInstruction}`;
    setInstruction(seed);
    setState({ kind: "idle" });
    setTraceOpen(false);
    inputRef.current?.focus();
  };

  /** Restore an instruction from the history popover. */
  const restoreFromHistory = (entry: NlHistoryEntry) => {
    setInstruction(entry.instruction);
    setState({ kind: "done", output: entry.output });
    setTraceOpen(false);
    setHistoryOpen(false);
    inputRef.current?.focus();
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-card/50 p-2.5">
      <form onSubmit={submit} className="flex items-center gap-2">
        <Sparkles className="size-4 shrink-0 text-primary" />
        <Input
          ref={inputRef}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Pergunte em linguagem natural — ex.: todos os usuários cadastrados mês passado"
          disabled={state.kind === "running"}
          className="h-8 border-transparent bg-transparent shadow-none focus-visible:ring-0"
        />
        <Button
          type="submit"
          size="sm"
          disabled={instruction.trim().length === 0 || state.kind === "running"}
        >
          {state.kind === "running" ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Sparkles />
          )}
          Gerar
        </Button>
        <HistoryPopover
          sessionId={sessionId}
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          onPick={restoreFromHistory}
        />
        {state.kind !== "idle" && state.kind !== "running" && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Limpar"
            onClick={reset}
            className="size-7"
          >
            <X className="size-4" />
          </Button>
        )}
      </form>

      {state.kind === "done" && (
        <ResultPanel
          output={state.output}
          traceOpen={traceOpen}
          onToggleTrace={() => setTraceOpen((v) => !v)}
          onAcceptSql={onAcceptSql}
          onUseSuggestion={useSuggestion}
          onRetry={retry}
          canRetry={instruction.trim().length > 0}
          onRefine={refine}
        />
      )}

      {state.kind === "error" && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span className="break-words">{state.message}</span>
        </div>
      )}
    </div>
  );
}

interface ResultPanelProps {
  output: AgentOutput;
  traceOpen: boolean;
  onToggleTrace: () => void;
  onAcceptSql: (sql: string) => void;
  onUseSuggestion: (suggestion: string) => void;
  onRetry: () => void;
  canRetry: boolean;
  onRefine: () => void;
}

function ResultPanel({
  output,
  traceOpen,
  onToggleTrace,
  onAcceptSql,
  onUseSuggestion,
  onRetry,
  canRetry,
  onRefine,
}: ResultPanelProps) {
  const isOk = output.status === "ok" && output.sql;
  return (
    <div className="flex flex-col gap-2">
      <StatusBanner status={output.status} reason={output.reason} />

      {!isOk && output.suggestions.length > 0 && (
        <SuggestionList
          suggestions={output.suggestions}
          onUse={onUseSuggestion}
          onRetry={onRetry}
          canRetry={canRetry}
        />
      )}

      {isOk && output.sql && (
        <div className="flex flex-col gap-1.5 rounded-md border border-border bg-background p-2.5">
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
            {output.sql}
          </pre>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onRefine}
              title="Manter contexto e pedir um refinamento"
            >
              <Pencil />
              Refinar
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onAcceptSql(output.sql!)}
            >
              <Edit3 />
              Editar
            </Button>
            <Button type="button" size="sm" onClick={() => onAcceptSql(output.sql!)}>
              <Check />
              Usar SQL
            </Button>
          </div>
        </div>
      )}

      <UsageBadge usage={output.usage} />

      {output.trace.length > 0 && (
        <div>
          <button
            type="button"
            onClick={onToggleTrace}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {traceOpen ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
            Raciocínio do agente ({output.trace.length})
          </button>
          {traceOpen && <TraceList trace={output.trace} />}
        </div>
      )}
    </div>
  );
}

function StatusBanner({
  status,
  reason,
}: {
  status: AgentStatus;
  reason?: string;
}) {
  if (status === "ok") return null;
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border p-2.5 text-sm",
        meta.tone,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <p className="font-medium">{meta.label}</p>
        {reason && <p className="mt-0.5 break-words opacity-90">{reason}</p>}
      </div>
    </div>
  );
}

function UsageBadge({ usage }: { usage: TokenUsage }) {
  if (usage.total_tokens === 0) return null;
  const fmt = new Intl.NumberFormat("pt-BR").format;
  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground">
      <Gauge className="size-3" />
      <span>
        {fmt(usage.total_tokens)} tokens
        <span className="ml-1 opacity-70">
          ({fmt(usage.prompt_tokens)} prompt + {fmt(usage.completion_tokens)} completion)
        </span>
      </span>
    </div>
  );
}

interface HistoryPopoverProps {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (entry: NlHistoryEntry) => void;
}

/** Lightweight history dropdown — fetched on open so it stays fresh. */
function HistoryPopover({
  sessionId,
  open,
  onOpenChange,
  onPick,
}: HistoryPopoverProps) {
  const [entries, setEntries] = useState<NlHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setEntries(null);
    setError(null);
    explorerApi
      .nlQueryHistory(sessionId)
      .then(setEntries)
      .catch((e) => setError(String(e)));
  }, [open, sessionId]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && containerRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [open, onOpenChange]);

  return (
    <div className="relative" ref={containerRef}>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label="Histórico"
        title="Histórico"
        onClick={() => onOpenChange(!open)}
        className="size-7"
      >
        <History className="size-4" />
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-[28rem] max-w-[80vw] rounded-md border border-border bg-popover p-2 text-sm shadow-md">
          <div className="px-1 pb-1 text-xs font-medium text-muted-foreground">
            Histórico desta sessão
          </div>
          {error ? (
            <div className="flex items-start gap-1.5 rounded p-2 text-xs text-destructive">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              {error}
            </div>
          ) : entries === null ? (
            <div className="flex items-center gap-1.5 p-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Carregando…
            </div>
          ) : entries.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">
              Sem consultas anteriores nesta sessão.
            </p>
          ) : (
            <ul className="max-h-72 overflow-y-auto">
              {entries.map((entry, idx) => (
                <li key={`${entry.created_at}-${idx}`}>
                  <button
                    type="button"
                    onClick={() => onPick(entry)}
                    className="flex w-full flex-col gap-0.5 rounded p-2 text-left hover:bg-accent"
                  >
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <StatusDot status={entry.output.status} />
                      <span>{formatTimestamp(entry.created_at)}</span>
                      {entry.output.usage.total_tokens > 0 && (
                        <span className="ml-auto opacity-70">
                          {entry.output.usage.total_tokens} tok
                        </span>
                      )}
                    </span>
                    <span className="break-words text-sm text-foreground">
                      {entry.instruction}
                    </span>
                    {entry.output.sql && (
                      <span className="break-words font-mono text-[11px] text-muted-foreground">
                        {entry.output.sql.length > 120
                          ? `${entry.output.sql.slice(0, 119)}…`
                          : entry.output.sql}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: AgentStatus }) {
  const tone =
    status === "ok"
      ? "bg-primary"
      : status === "need_info"
        ? "bg-amber-500"
        : "bg-destructive";
  return <span className={cn("size-2 rounded-full", tone)} aria-hidden="true" />;
}

function formatTimestamp(seconds: number): string {
  const date = new Date(seconds * 1000);
  return date.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface SuggestionListProps {
  suggestions: string[];
  onUse: (suggestion: string) => void;
  onRetry: () => void;
  canRetry: boolean;
}

/** Friendly "did you mean…" panel rendered under failed runs. */
function SuggestionList({
  suggestions,
  onUse,
  onRetry,
  canRetry,
}: SuggestionListProps) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-background p-2.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Lightbulb className="size-3.5" />
        Sugestões para refinar a instrução
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {suggestions.map((suggestion) => (
          <li key={suggestion}>
            <button
              type="button"
              onClick={() => onUse(suggestion)}
              className="rounded-full border border-border bg-card px-2.5 py-1 text-xs text-foreground transition-colors hover:border-primary/50 hover:bg-accent"
              title="Adicionar à instrução"
            >
              {suggestion}
            </button>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-end">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onRetry}
          disabled={!canRetry}
        >
          <RotateCcw />
          Tentar novamente
        </Button>
      </div>
    </div>
  );
}

const STATUS_META: Record<
  Exclude<AgentStatus, "ok">,
  { label: string; icon: typeof AlertCircle; tone: string }
> = {
  need_info: {
    label: "Mais informações necessárias",
    icon: HelpCircle,
    tone: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300",
  },
  not_found: {
    label: "Não encontrei o que precisa",
    icon: AlertCircle,
    tone: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300",
  },
  error: {
    label: "Não foi possível gerar a query",
    icon: AlertCircle,
    tone: "border-destructive/30 bg-destructive/10 text-destructive",
  },
};

function TraceList({ trace }: { trace: TraceEvent[] }) {
  return (
    <ol className="mt-1.5 flex flex-col gap-1 border-l border-border pl-3">
      {trace.map((event, idx) => (
        <li key={idx} className="text-xs">
          <TraceItem event={event} />
        </li>
      ))}
    </ol>
  );
}

function TraceItem({ event }: { event: TraceEvent }) {
  if (event.kind === "tool_call") {
    return (
      <div className="flex items-start gap-1.5 text-muted-foreground">
        <Wrench className="mt-0.5 size-3 shrink-0" />
        <span>
          <span className="font-medium text-foreground">{event.name}</span>
          <span className="ml-1 font-mono">
            ({summarizeArgs(event.arguments)})
          </span>
        </span>
      </div>
    );
  }
  if (event.kind === "tool_result") {
    return (
      <div
        className={cn(
          "flex items-start gap-1.5",
          event.ok ? "text-muted-foreground" : "text-destructive",
        )}
      >
        {event.ok ? (
          <Check className="mt-0.5 size-3 shrink-0" />
        ) : (
          <X className="mt-0.5 size-3 shrink-0" />
        )}
        <span className="break-words font-mono">{summarizeResult(event.result)}</span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-1.5 text-muted-foreground">
      <Sparkles className="mt-0.5 size-3 shrink-0" />
      <span className="break-words">{truncate(event.content, 240)}</span>
    </div>
  );
}

function summarizeArgs(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args !== "object") return String(args);
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => `${k}=${truncate(JSON.stringify(v), 40)}`)
    .join(", ");
}

function summarizeResult(result: unknown): string {
  if (result === null || result === undefined) return "—";
  const json = typeof result === "string" ? result : JSON.stringify(result);
  return truncate(json, 200);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
