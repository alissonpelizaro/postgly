import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const RELEASES_URL =
  "https://api.github.com/repos/alissonpelizaro/postgly/releases/latest";

interface AppInfo {
  name: string;
  version: string;
}

export interface VersionInfo {
  /** Current installed app version (e.g. "0.1.0"). */
  current: string;
  /** Latest release tag from GitHub (without leading "v"), if known. */
  latest: string | null;
  /** URL to the latest release page, if known. */
  releaseUrl: string | null;
  /** True when `latest` is strictly newer than `current`. */
  updateAvailable: boolean;
  loading: boolean;
}

const initialState: VersionInfo = {
  current: "",
  latest: null,
  releaseUrl: null,
  updateAvailable: false,
  loading: true,
};

/** Parses "1.2.3" / "v1.2.3" / "1.2.3-rc.1" into comparable numeric tuple. */
function parseSemver(raw: string): number[] {
  const cleaned = raw.replace(/^v/i, "").split(/[-+]/)[0];
  return cleaned.split(".").map((p) => Number.parseInt(p, 10) || 0);
}

function isNewer(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}

/**
 * Reads the current app version from the backend and asks GitHub for the
 * latest release. Network failures are swallowed silently — a missing
 * update check should never block the UI.
 */
export function useVersionCheck(): VersionInfo {
  const [state, setState] = useState<VersionInfo>(initialState);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      let current = "";
      try {
        const info = await invoke<AppInfo>("app_info");
        current = info.version;
      } catch {
        if (!cancelled) setState((s) => ({ ...s, loading: false }));
        return;
      }

      if (cancelled) return;
      setState((s) => ({ ...s, current, loading: true }));

      try {
        const res = await fetch(RELEASES_URL, {
          headers: { Accept: "application/vnd.github+json" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          tag_name?: string;
          html_url?: string;
        };
        if (cancelled) return;
        const latest = data.tag_name?.replace(/^v/i, "") ?? null;
        const releaseUrl = data.html_url ?? null;
        setState({
          current,
          latest,
          releaseUrl,
          updateAvailable: !!latest && isNewer(latest, current),
          loading: false,
        });
      } catch {
        if (!cancelled) {
          setState({
            current,
            latest: null,
            releaseUrl: null,
            updateAvailable: false,
            loading: false,
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
