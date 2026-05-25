import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

import { connectionsApi } from "./api";
import { emptyConnectionInput, type ConnectionInput, type ConnectionMeta } from "./types";

interface ConnectionFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The connection being edited, or `null` to create a new one. */
  editing: ConnectionMeta | null;
  /** Called after a successful save so the caller can refresh its list. */
  onSaved: () => void;
}

type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok" }
  | { status: "error"; message: string };

/** Modal form for creating and editing a database connection. */
export function ConnectionForm({
  open,
  onOpenChange,
  editing,
  onSaved,
}: ConnectionFormProps) {
  const { t } = useI18n();
  const [form, setForm] = useState<ConnectionInput>(emptyConnectionInput);
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form whenever the dialog opens (for create or edit).
  useEffect(() => {
    if (!open) return;
    setTest({ status: "idle" });
    setError(null);
    setForm(
      editing
        ? { ...editing, password: "" }
        : emptyConnectionInput(),
    );
  }, [open, editing]);

  const isEditing = editing !== null;
  const update = <K extends keyof ConnectionInput>(
    key: K,
    value: ConnectionInput[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setTest({ status: "idle" });
  };

  const handleTest = async () => {
    setTest({ status: "testing" });
    try {
      await connectionsApi.test(form);
      setTest({ status: "ok" });
    } catch (e) {
      setTest({ status: "error", message: String(e) });
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await connectionsApi.save(form);
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? t("connections.form.editTitle") : t("connections.form.newTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("connections.form.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <Field label={t("connections.form.name")}>
            <Input
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              placeholder={t("connections.form.namePlaceholder")}
              autoFocus
            />
          </Field>

          <div className="grid grid-cols-[1fr_120px] gap-3">
            <Field label={t("connections.form.host")}>
              <Input
                value={form.host}
                onChange={(e) => update("host", e.target.value)}
                placeholder="localhost"
              />
            </Field>
            <Field label={t("connections.form.port")}>
              <Input
                type="number"
                value={form.port}
                onChange={(e) => update("port", Number(e.target.value))}
              />
            </Field>
          </div>

          <Field label={t("connections.form.database")}>
            <Input
              value={form.database}
              onChange={(e) => update("database", e.target.value)}
              placeholder="postgres"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label={t("connections.form.user")}>
              <Input
                value={form.user}
                onChange={(e) => update("user", e.target.value)}
              />
            </Field>
            <Field label={t("connections.form.password")}>
              <Input
                type="password"
                value={form.password}
                onChange={(e) => update("password", e.target.value)}
                placeholder={isEditing ? t("connections.form.passwordPlaceholder") : ""}
              />
            </Field>
          </div>
        </div>

        <TestResult state={test} okLabel={t("connections.form.testOk")} />
        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={handleTest}
            disabled={test.status === "testing" || saving}
          >
            {test.status === "testing" && (
              <Loader2 className="animate-spin" />
            )}
            {t("connections.form.test")}
          </Button>
          <Button type="button" onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            {isEditing ? t("common.saveChanges") : t("common.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A labelled form row. */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

/** Inline feedback for the "Test connection" button. */
function TestResult({ state, okLabel }: { state: TestState; okLabel: string }) {
  if (state.status === "idle" || state.status === "testing") return null;

  const ok = state.status === "ok";
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
        ok
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      {ok ? (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
      ) : (
        <XCircle className="mt-0.5 size-4 shrink-0" />
      )}
      <span className="break-words">
        {ok ? okLabel : state.message}
      </span>
    </div>
  );
}
