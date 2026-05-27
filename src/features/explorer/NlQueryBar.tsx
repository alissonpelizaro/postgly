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
  SlidersHorizontal,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { localeFor, useI18n, type TKey } from "@/i18n";
import { cn } from "@/lib/utils";
import { settingsApi } from "@/features/settings/api";
import type { SettingsView } from "@/features/settings/types";

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
  const { t } = useI18n();
  const [instruction, setInstruction] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const [traceOpen, setTraceOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  // Per-call overrides for model / temperature. `undefined` = use the
  // saved default from Settings. Persists across submissions until the
  // user explicitly clears it.
  const [override, setOverride] = useState<{
    model?: string;
    temperature?: number;
  }>({});
  const inputRef = useRef<HTMLInputElement>(null);

  const generate = useCallback(
    async (text: string) => {
      setState({ kind: "running" });
      setTraceOpen(false);
      try {
        const output = await explorerApi.generateSql(sessionId, text, override);
        setState({ kind: "done", output });
        // Auto-expand trace when the model failed — the user wants to know why.
        if (output.status !== "ok") setTraceOpen(true);
      } catch (err) {
        setState({ kind: "error", message: String(err) });
      }
    },
    [sessionId, override],
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
    const seed = t("explorer.nl.refineSeed", { sql: previous });
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
          placeholder={t("explorer.nl.placeholder")}
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
          {t("explorer.nl.generate")}
        </Button>
        <OverridePopover
          open={overrideOpen}
          onOpenChange={setOverrideOpen}
          override={override}
          onChange={setOverride}
        />
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
            aria-label={t("explorer.nl.cleanAria")}
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
  const { t } = useI18n();
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
              title={t("explorer.nl.refineTitle")}
            >
              <Pencil />
              {t("common.refine")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onAcceptSql(output.sql!)}
            >
              <Edit3 />
              {t("explorer.nl.editSql")}
            </Button>
            <Button type="button" size="sm" onClick={() => onAcceptSql(output.sql!)}>
              <Check />
              {t("explorer.nl.useSql")}
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
            {t("explorer.nl.reasoning", { n: output.trace.length })}
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
  const { t } = useI18n();
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
        <p className="font-medium">{t(meta.labelKey)}</p>
        {reason && <p className="mt-0.5 break-words opacity-90">{reason}</p>}
      </div>
    </div>
  );
}

function UsageBadge({ usage }: { usage: TokenUsage }) {
  const { lang, t } = useI18n();
  if (usage.total_tokens === 0) return null;
  const fmt = new Intl.NumberFormat(localeFor(lang)).format;
  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground">
      <Gauge className="size-3" />
      <span>
        {t("explorer.nl.tokens", { n: fmt(usage.total_tokens) })}
        <span className="ml-1 opacity-70">
          {" "}
          {t("explorer.nl.promptCompletion", {
            prompt: fmt(usage.prompt_tokens),
            completion: fmt(usage.completion_tokens),
          })}
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
  const { t, lang } = useI18n();
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
        aria-label={t("explorer.nl.historyTitle")}
        title={t("explorer.nl.historyTitle")}
        onClick={() => onOpenChange(!open)}
        className="size-7"
      >
        <History className="size-4" />
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-[28rem] max-w-[80vw] rounded-md border border-border bg-popover p-2 text-sm shadow-md">
          <div className="px-1 pb-1 text-xs font-medium text-muted-foreground">
            {t("explorer.nl.historySession")}
          </div>
          {error ? (
            <div className="flex items-start gap-1.5 rounded p-2 text-xs text-destructive">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              {error}
            </div>
          ) : entries === null ? (
            <div className="flex items-center gap-1.5 p-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> {t("common.loading")}
            </div>
          ) : entries.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">
              {t("explorer.nl.historyEmpty")}
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
                      <span>{formatTimestamp(entry.created_at, lang)}</span>
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

function formatTimestamp(seconds: number, lang: string): string {
  const date = new Date(seconds * 1000);
  return date.toLocaleString(localeFor(lang as never), {
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
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-background p-2.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Lightbulb className="size-3.5" />
        {t("explorer.nl.suggestions")}
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {suggestions.map((suggestion) => (
          <li key={suggestion}>
            <button
              type="button"
              onClick={() => onUse(suggestion)}
              className="rounded-full border border-border bg-card px-2.5 py-1 text-xs text-foreground transition-colors hover:border-primary/50 hover:bg-accent"
              title={t("explorer.nl.addToInstruction")}
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
          {t("common.retry")}
        </Button>
      </div>
    </div>
  );
}

const STATUS_META: Record<
  Exclude<AgentStatus, "ok">,
  { labelKey: TKey; icon: typeof AlertCircle; tone: string }
> = {
  need_info: {
    labelKey: "explorer.nl.status.needInfo",
    icon: HelpCircle,
    tone: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300",
  },
  not_found: {
    labelKey: "explorer.nl.status.notFound",
    icon: AlertCircle,
    tone: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300",
  },
  error: {
    labelKey: "explorer.nl.status.error",
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

interface OverridePopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  override: { model?: string; temperature?: number };
  onChange: (next: { model?: string; temperature?: number }) => void;
}

/**
 * Per-instruction overrides for model and temperature. Loads the saved
 * defaults from Settings, then probes `{base_url}/models` so the user
 * picks from a real list. Overrides persist across submissions until
 * cleared.
 */
function OverridePopover({
  open,
  onOpenChange,
  override,
  onChange,
}: OverridePopoverProps) {
  const { t } = useI18n();
  const [view, setView] = useState<SettingsView | null>(null);
  const [models, setModels] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ok"; list: string[] }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [customModel, setCustomModel] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const active =
    override.model !== undefined || override.temperature !== undefined;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setModels({ kind: "loading" });
    settingsApi
      .get()
      .then((v) => {
        setView(v);
        // Try to fetch the models list, but degrade gracefully — the
        // user can still type a custom model name.
        if (!v.llm.base_url.trim() || !v.llm_api_key_configured) {
          setModels({ kind: "error", message: t("explorer.nl.override.configureLlmFirst") });
          return;
        }
        settingsApi
          .testLlm({ ...v.llm, api_key: "" })
          .then((res) => setModels({ kind: "ok", list: res.models }))
          .catch((e) => setModels({ kind: "error", message: String(e) }));
      })
      .catch((e) => setError(String(e)));
  }, [open]);

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

  const defaultModel = view?.llm.model ?? "";
  const defaultTemperature = view?.llm.temperature ?? 0;
  const effectiveModel = override.model ?? defaultModel;
  const effectiveTemperature = override.temperature ?? defaultTemperature;
  const list = (models.kind === "ok" ? models.list : [])
    .slice()
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const modelInList = effectiveModel !== "" && list.includes(effectiveModel);

  const setModel = (value: string | undefined) => {
    onChange({ ...override, model: value });
  };
  const setTemperature = (value: number | undefined) => {
    onChange({ ...override, temperature: value });
  };

  return (
    <div className="relative" ref={containerRef}>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={t("explorer.nl.override.ariaLabel")}
        title={
          active
            ? t("explorer.nl.override.activeTitle")
            : t("explorer.nl.override.inactiveTitle")
        }
        onClick={() => onOpenChange(!open)}
        className={cn(
          "relative size-7",
          active && "text-primary hover:text-primary",
        )}
      >
        <SlidersHorizontal className="size-4" />
        {active && (
          <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary" />
        )}
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-[22rem] max-w-[90vw] rounded-md border border-border bg-popover p-3 text-sm shadow-md">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {t("explorer.nl.override.title")}
            </span>
            {active && (
              <button
                type="button"
                onClick={() => {
                  onChange({});
                  setCustomModel(false);
                }}
                className="text-xs text-primary hover:underline"
              >
                {t("common.useDefault")}
              </button>
            )}
          </div>

          {error && (
            <div className="mb-2 flex items-start gap-1.5 rounded p-2 text-xs text-destructive">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              {error}
            </div>
          )}

          <div className="mb-3 flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium">{t("settings.llm.model")}</span>
              <span className="text-muted-foreground">
                {t("explorer.nl.override.modelDefault", { model: defaultModel || "—" })}
              </span>
            </div>
            {models.kind === "loading" ? (
              <div className="flex h-9 items-center gap-2 rounded-md border border-input bg-transparent px-3 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {t("settings.llm.loadingModels")}
              </div>
            ) : customModel || list.length === 0 ? (
              <div className="flex flex-col gap-1">
                <Input
                  value={override.model ?? ""}
                  placeholder={defaultModel || t("explorer.nl.override.customPlaceholder")}
                  onChange={(e) =>
                    setModel(e.target.value === "" ? undefined : e.target.value)
                  }
                  className="h-8 text-sm"
                />
                {list.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setCustomModel(false)}
                    className="self-start text-xs text-muted-foreground hover:text-foreground"
                  >
                    {t("explorer.nl.override.backToList")}
                  </button>
                )}
                {models.kind === "error" && (
                  <p className="text-[11px] text-muted-foreground">
                    {t("settings.llm.modelsListUnavailable")}
                  </p>
                )}
              </div>
            ) : (
              <select
                value={override.model ?? "__default__"}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "__default__") return setModel(undefined);
                  if (v === "__custom__") {
                    setCustomModel(true);
                    return;
                  }
                  setModel(v);
                }}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="__default__">
                  {t("explorer.nl.override.defaultOption", {
                    model: defaultModel || t("explorer.nl.override.notDefined"),
                  })}
                </option>
                {override.model !== undefined && !modelInList && (
                  <option value={override.model}>
                    {override.model}{t("settings.llm.notListed")}
                  </option>
                )}
                {list.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value="__custom__">{t("explorer.nl.override.customOption")}</option>
              </select>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium">{t("settings.llm.temperature")}</span>
              <span className="text-muted-foreground">
                {t("explorer.nl.override.temperatureDefault")}{" "}
                <span className="font-mono">
                  {defaultTemperature.toFixed(1)}
                </span>
                {override.temperature !== undefined && (
                  <>
                    {" · "}
                    <span className="font-mono text-primary">
                      {override.temperature.toFixed(1)}
                    </span>
                  </>
                )}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={effectiveTemperature}
              onChange={(e) => setTemperature(Number(e.target.value))}
              className="range-slider h-9 w-full"
            />
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
              <span>{t("settings.llm.precise")}</span>
              {override.temperature !== undefined && (
                <button
                  type="button"
                  onClick={() => setTemperature(undefined)}
                  className="normal-case tracking-normal text-primary hover:underline"
                >
                  {t("common.useDefault")}
                </button>
              )}
              <span>{t("settings.llm.creative")}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
