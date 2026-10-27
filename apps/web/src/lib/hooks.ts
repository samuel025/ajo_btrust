import { useCallback, useEffect, useState } from 'react';

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
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let alive = true;
    const run = () =>
      load().then(
        (value) => { if (alive) { setData(value); setError(undefined); } },
        (e) => { if (alive) setError(String(e?.message ?? e)); },
      );
    run();
    const timer = setInterval(run, ms);
    return () => { alive = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version, ms]);

  return { data, error, refresh };
}
