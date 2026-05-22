import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Database } from "lucide-react";

import { ThemeToggle } from "@/components/theme-toggle";

/** Shape returned by the Rust `app_info` command. */
type AppInfo = {
  name: string;
  version: string;
};

/**
 * Phase 0 placeholder screen.
 *
 * It exists to prove the foundation is wired up end to end: Tailwind tokens
 * render, the theme toggle switches palettes, and the IPC bridge reaches
 * Rust (`app_info`). Phase 1 replaces this with the connection manager.
 */
function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    invoke<AppInfo>("app_info").then(setInfo).catch(console.error);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-4 py-2">
        <span className="text-sm font-medium text-muted-foreground">
          {info ? `${info.name} v${info.version}` : "Postgly"}
        </span>
        <ThemeToggle />
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="flex size-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Database className="size-8" />
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Postgly</h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            Foundation ready. The connection manager arrives in Phase 1.
          </p>
        </div>
      </main>
    </div>
  );
}

export default App;
