import { useCallback, useEffect, useRef, useState } from 'react';

/** Hash route, e.g. "/g/<author>/<id>". */
export function useRoute(): [string, (to: string) => void] {
  const read = () => window.location.hash.slice(1) || '/';
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return [route, (to) => { window.location.hash = to; }];
}

/** Loads on mount and every `ms` milliseconds; keeps the last good value if a refresh fails. */
export function usePoll<T>(load: () => Promise<T>, deps: unknown[], ms = 4000) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const latest = useRef<() => Promise<void>>();
  // Always call the newest `load`, so a poll never reads with an out-of-date view of the world (for example a group's old member list).
  const loader = useRef(load);
  loader.current = load;
  /** Loads again now; resolves once the fresh data is in place, so a button can stay disabled until the screen shows the change. */
  const refresh = useCallback(() => latest.current?.() ?? Promise.resolve(), []);

  useEffect(() => {
    let alive = true;
    const run = () =>
      loader.current().then(
        (value) => { if (alive) { setData(value); setError(undefined); } },
        (e) => { if (alive) setError(String(e?.message ?? e)); },
      );
    latest.current = run;
    run();
    const timer = setInterval(run, ms);
    return () => { alive = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, ms]);

  return { data, error, refresh };
}
