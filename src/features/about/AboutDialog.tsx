import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Github,
  Heart,
  Loader2,
  Terminal,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import logoUrl from "@/assets/postgly-logo.png";

import type { VersionInfo } from "./use-version-check";

const REPO_URL = "https://github.com/alissonpelizaro/postgly";
const ISSUES_URL = `${REPO_URL}/issues`;
const AUTHOR_URL = "https://github.com/alissonpelizaro";

const INSTALL_SH_URL =
  "https://raw.githubusercontent.com/alissonpelizaro/postgly/main/scripts/install.sh";
const INSTALL_PS1_URL =
  "https://raw.githubusercontent.com/alissonpelizaro/postgly/main/scripts/install.ps1";

type UpdatePlatform = "macos" | "linux" | "windows" | "unknown";

interface UpdateCommand {
  platform: UpdatePlatform;
  shell: string;
  command: string;
}

function detectPlatform(): UpdatePlatform {
  if (typeof navigator === "undefined") return "unknown";
  const ua = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
  if (ua.includes("mac")) return "macos";
  if (ua.includes("win")) return "windows";
  if (ua.includes("linux")) return "linux";
  return "unknown";
}

function updateCommandFor(platform: UpdatePlatform): UpdateCommand {
  switch (platform) {
    case "windows":
      return {
        platform,
        shell: "PowerShell",
        command: `irm ${INSTALL_PS1_URL} | iex`,
      };
    case "macos":
    case "linux":
      return {
        platform,
        shell: platform === "macos" ? "Terminal (bash/zsh)" : "bash/zsh",
        command: `curl -fsSL ${INSTALL_SH_URL} | bash`,
      };
    default:
      return {
        platform,
        shell: "bash/zsh",
        command: `curl -fsSL ${INSTALL_SH_URL} | bash`,
      };
  }
}

interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  version: VersionInfo;
}

/**
 * "About Postgly" modal. Reachable both from the header menu and from the
 * "update available" badge in the top bar. When an update exists it shows
 * the download CTA prominently.
 */
export function AboutDialog({ open, onOpenChange, version }: AboutDialogProps) {
  const open_ = (url: string) => {
    void openUrl(url);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg ">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <img src={logoUrl} alt="Postgly" className="size-12" />
            <div className="flex flex-col">
              <DialogTitle>Postgly</DialogTitle>
              <DialogDescription>
                Cliente PostgreSQL local-first com IA integrada.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          <VersionBlock version={version} />

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Autor</dt>
            <dd>
              <button
                type="button"
                onClick={() => open_(AUTHOR_URL)}
                className="inline-flex items-center gap-1 text-foreground hover:text-primary"
              >
                Alisson Pelizaro
                <ExternalLink className="size-3" />
              </button>
            </dd>

            <dt className="text-muted-foreground">Licença</dt>
            <dd>MIT</dd>

            <dt className="text-muted-foreground">Repositório</dt>
            <dd>
              <button
                type="button"
                onClick={() => open_(REPO_URL)}
                className="inline-flex items-center gap-1 text-foreground hover:text-primary"
              >
                github.com/alissonpelizaro/postgly
                <ExternalLink className="size-3" />
              </button>
            </dd>
          </dl>

          <div className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
            Postgly é um projeto open-source. Contribuições, ideias e
            relatórios de bug são muito bem-vindos.
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => open_(REPO_URL)}>
              <Github className="size-4" />
              GitHub
            </Button>
            <Button variant="outline" size="sm" onClick={() => open_(ISSUES_URL)}>
              <Heart className="size-4" />
              Contribuir
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function VersionBlock({ version }: { version: VersionInfo }) {
  const updateCmd = useMemo(() => updateCommandFor(detectPlatform()), []);
  const [copied, setCopied] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(updateCmd.command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API unavailable — fall through silently; the user can still
      // select the command manually.
    }
  };

  const onAutoUpdate = async () => {
    const ok = window.confirm(
      "O Postgly será fechado e o script de atualização será aberto em uma nova janela de terminal. Continuar?",
    );
    if (!ok) return;
    setUpdating(true);
    setUpdateError(null);
    try {
      await invoke("run_update_and_exit");
      // App is exiting; nothing else to do.
    } catch (err) {
      setUpdating(false);
      setUpdateError(String(err));
    }
  };

  if (version.updateAvailable && version.latest) {
    return (
      <div className="max-w-115 flex flex-col space-y-3 overflow-hidden rounded-md border border-primary/40 bg-primary/10 p-3 text-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-medium text-foreground">
              Nova versão disponível: v{version.latest}
            </p>
            <p className="text-xs text-muted-foreground">
              Você está usando v{version.current}.
            </p>
          </div>
          <Button
            size="sm"
            onClick={onAutoUpdate}
            disabled={updating}
            className="shrink-0"
            title="Fechar o Postgly e executar o script de atualização"
          >
            {updating ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Atualizando…
              </>
            ) : (
              <>
                <Download className="size-3.5" />
                Atualizar agora
              </>
            )}
          </Button>
        </div>
        {updateError && (
          <p className="text-xs text-destructive">
            Falha ao iniciar atualização: {updateError}
          </p>
        )}

        <div className="min-w-0 space-y-2 overflow-hidden rounded-md border border-border bg-background/60 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Terminal className="size-3.5 shrink-0" />
              <span className="truncate">
                Atualize com um comando ({updateCmd.shell})
              </span>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={onCopy}
              className="h-7 shrink-0 px-2 text-xs"
              title="Copiar comando"
            >
              {copied ? (
                <>
                  <Check className="size-3.5" />
                  Copiado
                </>
              ) : (
                <>
                  <Copy className="size-3.5" />
                  Copiar
                </>
              )}
            </Button>
          </div>
          <pre className="max-w-full overflow-x-auto rounded border border-border bg-muted/50 px-2 py-1.5 font-mono text-[11.5px] leading-relaxed text-foreground">
            <code className="whitespace-pre">{updateCmd.command}</code>
          </pre>
          <p className="text-[11px] mt-5 leading-relaxed text-muted-foreground">
            O script baixa o instalador, aplica a atualização e remove os
            arquivos temporários. Feche o Postgly antes de executar.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 p-3 text-sm">
      <span className="text-muted-foreground">Versão instalada</span>
      <span className="font-mono text-foreground">
        {version.loading ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          `v${version.current || "?"}`
        )}
      </span>
    </div>
  );
}
