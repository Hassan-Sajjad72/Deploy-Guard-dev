import { useCallback, useEffect, useRef } from "react";

export function createSerializedRefresh(execute) {
  let disposed = false;
  let inFlight = null;
  let queued = false;
  let requestVersion = 0;

  const refresh = () => {
    if (disposed) return Promise.resolve();
    if (inFlight) {
      queued = true;
      requestVersion += 1;
      return inFlight;
    }

    inFlight = (async () => {
      do {
        queued = false;
        const version = ++requestVersion;
        await execute({ isCurrent: () => !disposed && version === requestVersion });
      } while (queued && !disposed);
    })().finally(() => {
      inFlight = null;
    });

    return inFlight;
  };

  refresh.invalidate = () => {
    requestVersion += 1;
  };
  refresh.dispose = () => {
    disposed = true;
    requestVersion += 1;
    queued = false;
  };

  return refresh;
}

export function useSerializedProjectRefresh(projectId, execute) {
  const projectIdRef = useRef(projectId);
  const executeRef = useRef(execute);
  const refreshRef = useRef(null);
  projectIdRef.current = projectId;
  executeRef.current = execute;

  if (!refreshRef.current) {
    refreshRef.current = createSerializedRefresh(({ isCurrent }) => executeRef.current(projectIdRef.current, isCurrent));
  }

  useEffect(() => {
    refreshRef.current.invalidate();
  }, [projectId]);

  useEffect(() => () => refreshRef.current.dispose(), []);

  return useCallback(() => refreshRef.current(), []);
}
