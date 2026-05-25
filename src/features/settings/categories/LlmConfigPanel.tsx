import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Eraser,
  Loader2,
  RefreshCw,
  Save,
  Sparkles,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

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

type ModelsStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; list: string[] }
  | { kind: "error"; message: string };

/**
 * LLM Config form. Wraps the [`settingsApi`] CRUD plus a "Test
 * connection" probe that hits `{base_url}/models` before letting the
 * user save with confidence.
 */
export function LlmConfigPanel() {
  const { t } = useI18n();
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
  const [models, setModels] = useState<ModelsStatus>({ kind: "idle" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Latest-request guard for the model autoload — prevents stale responses
  // from a slow request from overwriting a newer one.
  const modelsReqId = useRef(0);

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

  const refreshModels = async () => {
    const id = ++modelsReqId.current;
    setModels({ kind: "loading" });
    try {
      const result = await settingsApi.testLlm(form);
      if (id !== modelsReqId.current) return;
      setModels({ kind: "ok", list: result.models });
    } catch (err) {
      if (id !== modelsReqId.current) return;
      setModels({ kind: "error", message: String(err) });
    }
  };

  // Auto-fetch the model list whenever the endpoint/credentials change.
  // Debounced so typing the API key or URL doesn't fire a request per keystroke.
  useEffect(() => {
    if (!view) return;
    const baseUrl = form.base_url.trim();
    const hasKey = form.api_key.trim().length > 0 || (view.llm_api_key_configured ?? false);
    if (!baseUrl || !hasKey) {
      setModels({ kind: "idle" });
      return;
    }
    const id = ++modelsReqId.current;
    const timer = setTimeout(async () => {
      setModels({ kind: "loading" });
      try {
        const result = await settingsApi.testLlm(form);
        if (id !== modelsReqId.current) return;
        setModels({ kind: "ok", list: result.models });
      } catch (err) {
        if (id !== modelsReqId.current) return;
        setModels({ kind: "error", message: String(err) });
      }
    }, 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, form.base_url, form.api_key, form.provider]);

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
          <h2 className="text-lg font-semibold leading-tight">{t("settings.llm.title")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("settings.llm.subtitle")}
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
          <Label htmlFor="llm-provider">{t("settings.llm.provider")}</Label>
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
          <Label htmlFor="llm-base-url">{t("settings.llm.baseUrl")}</Label>
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
          <Label htmlFor="llm-api-key">{t("settings.llm.apiKey")}</Label>
          <Input
            id="llm-api-key"
            type="password"
            autoComplete="off"
            placeholder={keyConfigured ? t("settings.llm.apiKeyStoredPlaceholder") : "sk-..."}
            value={form.api_key}
            onChange={(e) => update("api_key", e.target.value)}
          />
          {keyConfigured && (
            <p className="text-xs text-muted-foreground">
              {t("settings.llm.apiKeyStored")}
            </p>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="llm-model">{t("settings.llm.model")}</Label>
              <button
                type="button"
                onClick={refreshModels}
                disabled={models.kind === "loading"}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                title={t("settings.llm.reloadTitle")}
              >
                <RefreshCw
                  className={cn(
                    "size-3",
                    models.kind === "loading" && "animate-spin",
                  )}
                />
                {t("settings.llm.reload")}
              </button>
            </div>
            <ModelField
              status={models}
              value={form.model}
              onChange={(v) => update("model", v)}
            />
          </div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="llm-temperature">{t("settings.llm.temperature")}</Label>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {form.temperature.toFixed(1)}
              </span>
            </div>
            <input
              id="llm-temperature"
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={form.temperature}
              onChange={(e) => update("temperature", Number(e.target.value))}
              className="range-slider h-9 w-full accent-primary"
            />
            <div className="flex justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
              <span>{t("settings.llm.precise")}</span>
              <span>{t("settings.llm.creative")}</span>
            </div>
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
            {t("settings.llm.saved")}
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
              {t("settings.llm.removeKey")}
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
            {t("settings.llm.test")}
          </Button>
          <Button type="submit" disabled={!canSave}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            {t("common.save")}
          </Button>
        </div>
      </form>
    </div>
  );
}

interface ModelFieldProps {
  status: ModelsStatus;
  value: string;
  onChange: (value: string) => void;
}

/**
 * Model picker. Renders a dropdown populated from `/models` when the
 * endpoint replied, with a "Custom…" option that falls back to a free-text
 * input for unlisted models. While the list is loading or unreachable, the
 * user keeps a plain text input so configuration is never blocked.
 */
function ModelField({ status, value, onChange }: ModelFieldProps) {
  const { t } = useI18n();
  const [customMode, setCustomMode] = useState(false);

  const list = status.kind === "ok" ? status.list : [];
  const valueInList = value !== "" && list.includes(value);
  // When the saved value isn't in the fetched list, show it as a separate
  // option (and surface a hint) so the user understands why.
  const showSavedOption = !customMode && value !== "" && list.length > 0 && !valueInList;

  if (status.kind === "loading" && list.length === 0) {
    return (
      <div className="flex h-9 items-center gap-2 rounded-md border border-input bg-transparent px-3 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Carregando modelos…
      </div>
    );
  }

  if (list.length === 0 || customMode) {
    return (
      <div className="flex flex-col gap-1">
        <Input
          id="llm-model"
          placeholder="gpt-4o-mini"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
        />
        {status.kind === "error" && !customMode && (
          <p className="text-xs text-destructive">
            Não foi possível carregar a lista — informe o modelo manualmente.
          </p>
        )}
        {list.length > 0 && customMode && (
          <button
            type="button"
            onClick={() => setCustomMode(false)}
            className="self-start text-xs text-muted-foreground hover:text-foreground"
          >
            ← Voltar para a lista
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <select
        id="llm-model"
        value={valueInList ? value : ""}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "__custom__") {
            setCustomMode(true);
            return;
          }
          onChange(v);
        }}
        className={cn(
          "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
        required
      >
        {!valueInList && (
          <option value="" disabled>
            {value ? `${value} (não listado)` : "Selecione um modelo…"}
          </option>
        )}
        {showSavedOption && (
          <option value={value}>{value} (atual)</option>
        )}
        {list.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
        <option value="__custom__">Outro… (digitar manualmente)</option>
      </select>
      <p className="text-xs text-muted-foreground">
        {list.length} modelo(s) disponíveis
        {showSavedOption && " · valor salvo não está na lista atual"}
      </p>
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
