import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { debounce } from "./frame";

export type SaveState = { state: "idle" | "saving" | "saved" } | { state: "failed"; problems: string[] };

type Answer = { error: { status: unknown; value: unknown } | null };

/** `value`, once it has stopped changing for `ms`. */
export function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  const update = useMemo(() => debounce(setSettled, ms), [ms]);
  useEffect(() => update(value), [value, update]);
  useEffect(() => update.cancel, [update]);
  return settled;
}

/**
 * Saves `value` once it settles, as the Frame screen does: saves go one after another so an
 * earlier one never lands after a later one, a change not yet settled is still saved when the
 * screen is left, and one still unsaved when the tab closes is sent as the page goes. A save the
 * server refuses with a 422 reports its `problems`.
 */
export function useAutosave<T>({
  value,
  loaded,
  save,
  url,
  ms,
}: {
  /** Undefined until loaded. */
  value: T | undefined;
  /** What the server held when the screen loaded. */
  loaded: T | undefined;
  save: (value: T) => Promise<Answer>;
  /** Where a PUT of the value goes, for the last save as the page closes. */
  url: string;
  ms: number;
}): SaveState {
  const [state, setState] = useState<SaveState>({ state: "idle" });
  /** The value the server holds, as JSON: what was loaded or last sent. */
  const lastSaved = useRef<string | undefined>(undefined);
  const confirmed = useRef<string | undefined>(undefined);
  const unanswered = useRef(0);
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const latest = useRef(value);
  latest.current = value;
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (loaded === undefined || lastSaved.current !== undefined) return;
    lastSaved.current = JSON.stringify(loaded);
    confirmed.current = lastSaved.current;
  }, [loaded]);

  const send = useCallback((next: T) => {
    unanswered.current++;
    const sent = saving.current
      .then(() => saveRef.current(next))
      .then((result) => {
        if (!result.error) confirmed.current = JSON.stringify(next);
        return result;
      })
      .finally(() => {
        unanswered.current--;
      });
    saving.current = sent.catch(() => {});
    return sent;
  }, []);

  const settled = useSettled(value, ms);

  useEffect(() => {
    if (settled === undefined || lastSaved.current === undefined) return;
    const json = JSON.stringify(settled);
    if (json === lastSaved.current) return;
    lastSaved.current = json;
    setState({ state: "saving" });
    send(settled)
      .then(({ error }) => {
        if (lastSaved.current !== json) return;
        setState(error ? { state: "failed", problems: problemsIn(error.value) } : { state: "saved" });
      })
      .catch(() => {
        if (lastSaved.current === json) setState({ state: "failed", problems: [] });
      });
  }, [settled, send]);

  // Leaving the screen before a change has settled still saves it.
  useEffect(
    () => () => {
      const pending = latest.current;
      if (pending === undefined || lastSaved.current === undefined) return;
      if (JSON.stringify(pending) === lastSaved.current) return;
      send(pending).catch(() => {});
    },
    [send],
  );

  // Closing or reloading the tab runs no cleanup, so an unsaved change is sent as the page goes.
  useEffect(() => {
    const flush = () => {
      const pending = latest.current;
      if (pending === undefined || confirmed.current === undefined) return;
      const json = JSON.stringify(pending);
      if (json === confirmed.current && unanswered.current === 0) return;
      fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: json,
        keepalive: true,
      })
        .then((response) => {
          if (!response.ok) return;
          lastSaved.current = json;
          confirmed.current = json;
        })
        .catch(() => {});
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [url]);

  return state;
}

/** The reasons in a 422 answer, or none. */
export function problemsIn(value: unknown): string[] {
  if (typeof value !== "object" || value === null || !("problems" in value)) return [];
  const { problems } = value as { problems: unknown };
  return Array.isArray(problems) ? problems.filter((p): p is string => typeof p === "string") : [];
}
