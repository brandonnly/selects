import type { CaptionOverride, LimitCheck } from "@selects/server";
import { useEffect, useRef, useState } from "react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { problemsIn, useSettled } from "@/lib/autosave";

/** How long writing must pause before it is measured against Instagram's limits. */
const SETTLE_MS = 300;

type Built = { caption: string; altText: string; hashtagSet: string | null };
type Loaded = {
  own: CaptionOverride;
  caption: Built;
  /** What the templates make, whether or not something is written for the select. */
  fromTemplate: Built;
  limits: { characters: number; hashtags: number; mentions: number; altTextCharacters: number };
};

type Draft = { caption: string | null; altText: string | null };

/**
 * A select's caption and alt text: the templates' unless one is written for it here. What is
 * written replaces the template for this select only.
 */
export function SelectCaption({
  selectId,
  refresh = 0,
}: {
  selectId: string;
  /** Changes when the select's capture data does, so the template's text is built again. */
  refresh?: number;
}) {
  const [loaded, setLoaded] = useState<Loaded | undefined>();
  const [draft, setDraft] = useState<Draft>({ caption: null, altText: null });
  const [state, setState] = useState<
    { state: "idle" | "saving" | "saved" } | { state: "failed"; problems: string[] }
  >({ state: "idle" });
  const [check, setCheck] = useState<LimitCheck | undefined>();
  /** A save is on its way: the next waits for it, so two never cross. */
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is the signal to load again.
  useEffect(() => {
    let live = true;
    api
      .selects({ id: selectId })
      .caption.get()
      .then(({ data, error }) => {
        if (!live) return;
        if (data) {
          setLoaded(data);
          // What is being written stays when only the capture data changed.
          if (first.current) setDraft(data.own);
          first.current = false;
        }
        setLoadError(error !== null);
      })
      .catch(() => {
        if (live) setLoadError(true);
      });
    return () => {
      live = false;
    };
  }, [selectId, refresh]);

  const latestDraft = useRef(draft);

  // Measures what is being written, so a warning shows before a limit is reached.
  const settled = useSettled(draft, SETTLE_MS);
  const checkTurn = useRef(0);
  useEffect(() => {
    if (loaded === undefined) return;
    const turn = ++checkTurn.current;
    api.captions.check
      .post({
        // Measured as it would be saved.
        caption: normal(settled).caption ?? loaded.fromTemplate.caption,
        altText: normal(settled).altText ?? loaded.fromTemplate.altText,
      })
      .then(({ data }) => {
        if (turn === checkTurn.current && data) setCheck(data);
      })
      .catch(() => {});
  }, [settled, loaded]);

  if (loadError) return <p className="text-sm text-destructive">Couldn't load the caption.</p>;
  if (loaded === undefined) return null;

  const changed = JSON.stringify(normal(draft)) !== JSON.stringify(loaded.own);
  // Only what is written here can stop a save: text from the template is not this editor's to fix.
  const { limits } = loaded;
  const blocked =
    check !== undefined &&
    ((draft.caption !== null &&
      (check.captionCharacters > limits.characters ||
        check.hashtags > limits.hashtags ||
        check.mentions > limits.mentions)) ||
      (draft.altText !== null && check.altTextCharacters > limits.altTextCharacters));

  latestDraft.current = draft;
  const save = async () => {
    setBusy(true);
    setState({ state: "saving" });
    const sent = draft;
    try {
      const { data, error } = await api.selects({ id: selectId }).caption.put(normal(sent));
      if (data) {
        setLoaded(data);
        // Words typed while the save was on its way stay; they are simply not saved yet.
        if (latestDraft.current === sent) {
          setDraft(data.own);
          setState({ state: "saved" });
        } else {
          setState({ state: "idle" });
        }
      } else {
        setState({ state: "failed", problems: problemsIn(error?.value) });
      }
    } catch {
      setState({ state: "failed", problems: [] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={`caption-${selectId}`} className="flex flex-col gap-4 border-t pt-4">
      <h3 id={`caption-${selectId}`} className="text-sm font-medium">
        Caption and alt text
      </h3>
      <OwnText
        label="Caption"
        fromTemplate={loaded.fromTemplate.caption}
        own={draft.caption}
        rows={5}
        note={
          draft.caption === null && loaded.fromTemplate.hashtagSet !== null
            ? "Hashtag set chosen at random per post."
            : undefined
        }
        onChange={(caption) => {
          setDraft((current) => ({ ...current, caption }));
          setState({ state: "idle" });
        }}
      />
      <OwnText
        label="Alt text"
        fromTemplate={loaded.fromTemplate.altText}
        own={draft.altText}
        rows={3}
        onChange={(altText) => {
          setDraft((current) => ({ ...current, altText }));
          setState({ state: "idle" });
        }}
      />
      {check && (check.problems.length > 0 || check.warnings.length > 0) && (
        <ul className="flex flex-col gap-1 text-sm">
          {check.problems.map((problem, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: two problems can read the same.
            <li key={`${index}-${problem}`} className="text-destructive">
              {problem}
            </li>
          ))}
          {check.warnings.map((warning) => (
            <li key={warning}>Warning: {warning}</li>
          ))}
        </ul>
      )}
      {check && (
        <p className="text-xs tabular-nums text-muted-foreground">
          {check.captionCharacters.toLocaleString()} of {loaded.limits.characters.toLocaleString()} characters
          · {check.hashtags} of {loaded.limits.hashtags} hashtags
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={save} disabled={!changed || blocked || busy}>
          {busy ? "Saving…" : "Save caption"}
        </Button>
        <p role="status" className="text-sm text-muted-foreground">
          {state.state === "saved" && "Saved."}
          {state.state === "failed" && (
            <span className="text-destructive">
              {state.problems.length > 0 ? state.problems.join(" ") : "Couldn't save. Try again."}
            </span>
          )}
        </p>
      </div>
    </section>
  );
}

/** Text written for the select, with spaces trimmed; blank text takes the template. */
function normal(draft: Draft): Draft {
  const tidy = (text: string | null) => (text === null || text.trim() === "" ? null : text.trim());
  return { caption: tidy(draft.caption), altText: tidy(draft.altText) };
}

/** The template's text, or the select's own in a box to edit, with a switch between them. */
function OwnText({
  label,
  fromTemplate,
  own,
  rows,
  note,
  onChange,
}: {
  label: string;
  fromTemplate: string;
  own: string | null;
  rows: number;
  note?: string;
  onChange: (own: string | null) => void;
}) {
  const id = `own-${label.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={own === null ? undefined : id} className="font-medium text-muted-foreground">
          {label}
          <span className="font-normal">
            {own === null ? " · from the template" : " · written for this photo"}
          </span>
        </label>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${label}: ${own === null ? "write its own" : "use the template"}`}
          onClick={() => onChange(own === null ? fromTemplate : null)}
        >
          {own === null ? "Write its own" : "Use the template"}
        </Button>
      </div>
      {own === null ? (
        <p className="whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2">
          {fromTemplate || <span className="italic text-muted-foreground">Empty</span>}
        </p>
      ) : (
        <textarea
          id={id}
          value={own}
          rows={rows}
          onChange={(event) => onChange(event.currentTarget.value)}
          className="rounded-md border bg-background px-3 py-2 text-base md:text-sm"
        />
      )}
      {note && own === null && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}
