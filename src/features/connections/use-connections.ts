import { useCallback, useEffect, useState } from "react";

import { connectionsApi } from "./api";
import type { ConnectionMeta } from "./types";

interface UseConnections {
  connections: ConnectionMeta[];
  loading: boolean;
  error: string | null;
  /** Re-fetch the list from the backend. */
  refresh: () => Promise<void>;
}

/**
 * Loads the saved connections and exposes a `refresh` to re-sync after a
 * create / update / delete. Phase 4 may promote this to a global store
 * once multiple connection tabs share the list.
 */
export function useConnections(): UseConnections {
  const [connections, setConnections] = useState<ConnectionMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setConnections(await connectionsApi.list());
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { connections, loading, error, refresh };
}
