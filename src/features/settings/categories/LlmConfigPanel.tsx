import { useEffect, useState, type FormEvent } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Eraser,
  Loader2,
  Save,
  Sparkles,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { settingsApi } from "../api";
import type { LlmConfigInput, SettingsView } from "../types";

/** Suggested presets so users don't have to remember base URLs. */
const PROVIDER_PRESETS: Array<{
  value: string;
  label: string;
  base_url: string;
  model: string;
}> = [
  {
    value: "openai",
    label: "OpenAI",
    base_url: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  },
  {
    value: "ollama",
    label: "Ollama (local)",
    base_url: "http://localhost:11434/v1",
    model: "llama3.1",
  },
  {
    value: "custom",
    label: "Custom",
    base_url: "",
    model: "",
  },
];

type TestStatus =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; models: string[] }
  | { kind: "error"; message: string };

/** Sentinel placeholder so the user knows a key is already stored. */
const STORED_KEY_PLACEHOLDER = "•••••• (mantém a chave salva)";

/**
 * LLM Config form. Wraps the [`settingsApi`] CRUD plus a "Testar
 * conexão" probe that hits `{base_url}/models` before letting the user
 * save with confidence.
 */
export function LlmConfigPanel() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [form, setForm] = useState<LlmConfigInput>({
    provider: "openai",
    base_url: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    temperature: 0,
    api_key: "",
  });

  const [test, setTest] = useState<TestStatus>({ kind: "idle" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    settingsApi
      .get()
      .then((v) => {
        if (cancelled) return;
        setView(v);
        setForm({
          provider: v.llm.provider || "openai",
          base_url: v.llm.base_url || "https://api.openai.com/v1",
          model: v.llm.model || "gpt-4o-mini",
          temperature: v.llm.temperature ?? 0,
          api_key: "",
        });
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = <K extends keyof LlmConfigInput>(
    key: K,
    value: LlmConfigInput[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setTest({ kind: "idle" });
    setSaved(false);
  };

  const onProviderChange = (value: string) => {
    const preset = PROVIDER_PRESETS.find((p) => p.value === value);
    setForm((prev) => ({
      ...prev,
      provider: value,
      base_url: preset && preset.base_url ? preset.base_url : prev.base_url,
      model: preset && preset.model ? preset.model : prev.model,
    }));
    setTest({ kind: "idle" });
    setSaved(false);
  };

  const handleTest = async () => {
    setTest({ kind: "running" });
    setSaveError(null);
    try {
      const result = await settingsApi.testLlm(form);
      setTest({ kind: "ok", models: result.models });
    } catch (err) {
      setTest({ kind: "error", message: String(err) });
    }
  };

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSaveError(null);
    try {
      const next = await settingsApi.saveLlm(form);
      setView(next);
      setForm((prev) => ({ ...prev, api_key: "" }));
      setSaved(true);
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleClearKey = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await settingsApi.clearLlmApiKey();
      const refreshed = await settingsApi.get();
      setView(refreshed);
      setForm((prev) => ({ ...prev, api_key: "" }));
      setTest({ kind: "idle" });
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const keyConfigured = view?.llm_api_key_configured ?? false;
  const canTest =
    form.base_url.trim().length > 0 &&
    (form.api_key.trim().length > 0 || keyConfigured) &&
    test.kind !== "running";
  const canSave =
    form.base_url.trim().length > 0 &&
    form.model.trim().length > 0 &&
    (form.api_key.trim().length > 0 || keyConfigured) &&
    !saving;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-8">
      <header className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <Sparkles className="size-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold leading-tight">LLM Config</h2>
          <p className="text-sm text-muted-foreground">
            Configure um provedor compatível com OpenAI para gerar queries SQL
            a partir de linguagem natural.
          </p>
        </div>
      </header>

      {loadError && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{loadError}</span>
        </div>
      )}

      <form
        onSubmit={handleSave}
        className="flex flex-col gap-5 rounded-lg border border-border bg-card p-5"
      >
        <div className="grid gap-2">
          <Label htmlFor="llm-provider">Provedor</Label>
          <select
            id="llm-provider"
            value={form.provider}
            onChange={(e) => onProviderChange(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {PROVIDER_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="llm-base-url">Base URL</Label>
          <Input
            id="llm-base-url"
            type="url"
            inputMode="url"
            placeholder="https://api.openai.com/v1"
            value={form.base_url}
            onChange={(e) => update("base_url", e.target.value)}
            required
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="llm-api-key">API key</Label>
          <Input
            id="llm-api-key"
            type="password"
            autoComplete="off"
            placeholder={keyConfigured ? STORED_KEY_PLACEHOLDER : "sk-..."}
            value={form.api_key}
            onChange={(e) => update("api_key", e.target.value)}
          />
          {keyConfigured && (
            <p className="text-xs text-muted-foreground">
              Já existe uma chave salva no keyring. Deixe em branco para mantê-la.
            </p>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
          <div className="grid gap-2">
            <Label htmlFor="llm-model">Modelo</Label>
            <Input
              id="llm-model"
              placeholder="gpt-4o-mini"
              value={form.model}
              onChange={(e) => update("model", e.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="llm-temperature">Temperature</Label>
            <Input
              id="llm-temperature"
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={form.temperature}
              onChange={(e) =>
                update("temperature", Number(e.target.value) || 0)
              }
            />
          </div>
        </div>

        <TestStatusBox status={test} />

        {saveError && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{saveError}</span>
          </div>
        )}

        {saved && test.kind !== "error" && (
          <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/10 p-3 text-sm text-primary">
            <CheckCircle2 className="size-4" />
            Configuração salva.
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          {keyConfigured && (
            <Button
              type="button"
              variant="ghost"
              onClick={handleClearKey}
              disabled={saving}
            >
              <Eraser />
              Remover chave
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={handleTest}
            disabled={!canTest}
          >
            {test.kind === "running" ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Zap />
            )}
            Testar conexão
          </Button>
          <Button type="submit" disabled={!canSave}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            Salvar
          </Button>
        </div>
      </form>
    </div>
  );
}

function TestStatusBox({ status }: { status: TestStatus }) {
  if (status.kind === "idle") return null;
  if (status.kind === "running") {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 p-3 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Testando conexão…
      </div>
    );
  }
  if (status.kind === "ok") {
    const preview = status.models.slice(0, 5).join(", ");
    const more = status.models.length > 5 ? ` (+${status.models.length - 5})` : "";
    return (
      <div className="rounded-md border border-primary/30 bg-primary/10 p-3 text-sm text-primary">
        <div className="flex items-center gap-2 font-medium">
          <CheckCircle2 className="size-4" />
          Conexão OK — {status.models.length} modelo(s) disponíveis.
        </div>
        {preview && (
          <p className="mt-1 truncate font-mono text-xs opacity-80">
            {preview}
            {more}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <span className="break-words">{status.message}</span>
    </div>
  );
}
