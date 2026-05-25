import { openUrl } from "@tauri-apps/plugin-opener";
import { Download, ExternalLink, Github, Heart, Loader2 } from "lucide-react";

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
      <DialogContent className="max-w-lg">
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
          <VersionBlock version={version} onDownload={() => version.releaseUrl && open_(version.releaseUrl)} />

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

function VersionBlock({
  version,
  onDownload,
}: {
  version: VersionInfo;
  onDownload: () => void;
}) {
  if (version.updateAvailable && version.latest) {
    return (
      <div className="rounded-md border border-primary/40 bg-primary/10 p-3 text-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-medium text-foreground">
              Nova versão disponível: v{version.latest}
            </p>
            <p className="text-xs text-muted-foreground">
              Você está usando v{version.current}.
            </p>
          </div>
          <Button size="sm" variant="gradient" onClick={onDownload}>
            <Download className="size-4" />
            Baixar
          </Button>
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
