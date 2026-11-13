import type { CaptionOverride, LimitCheck } from "@selects/server";
import { useEffect, useRef, useState } from "react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { problemsIn, useSettled } from "@/lib/autosave";

/** How long writing must pause before it is measured against Instagram's limits. */
const SETTLE_MS = 300;

type Loaded = {
  own: CaptionOverride;
  caption: { caption: string; altText: string; hashtagSet: string | null };
};

type Draft = { caption: string | null; altText: string | null };

/**
 * A select's caption and alt text: the templates' unless one is written for it here. What is
 * written replaces the template for this select only.
 */
export function SelectCaption({ selectId }: { selectId: string }) {
  const [loaded, setLoaded] = useState<Loaded | undefined>();
  const [draft, setDraft] = useState<Draft>({ caption: null, altText: null });
  const [state, setState] = useState<
    { state: "idle" | "saving" | "saved" } | { state: "failed"; problems: string[] }
  >({ state: "idle" });
  const [check, setCheck] = useState<LimitCheck | undefined>();
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .selects({ id: selectId })
      .caption.get()
      .then(({ data, error }) => {
        if (!live) return;
        if (data) {
          setLoaded(data);
          setDraft(data.own);
        }
        setLoadError(error !== null);
      })
      .catch(() => {
        if (live) setLoadError(true);
      });
    return () => {
      live = false;
    };
  }, [selectId]);

  // Measures what is being written, so a warning shows before a limit is reached.
  const settled = useSettled(draft, SETTLE_MS);
  const checkTurn = useRef(0);
  useEffect(() => {
    if (loaded === undefined) return;
    const turn = ++checkTurn.current;
    api.captions.check
      .post({
        caption: settled.caption ?? loaded.caption.caption,
        altText: settled.altText ?? loaded.caption.altText,
      })
      .then(({ data }) => {
        if (turn === checkTurn.current && data) setCheck(data);
      })
      .catch(() => {});
  }, [settled, loaded]);

  if (loadError) return <p className="text-sm text-destructive">Couldn't load the caption.</p>;
  if (loaded === undefined) return null;

  const changed = JSON.stringify(normal(draft)) !== JSON.stringify(loaded.own);
  const blocked = (check?.problems.length ?? 0) > 0;

  const save = async () => {
    setState({ state: "saving" });
    try {
      const { data, error } = await api.selects({ id: selectId }).caption.put(normal(draft));
      if (data) {
        setLoaded(data);
        setDraft(data.own);
        setState({ state: "saved" });
      } else {
        setState({ state: "failed", problems: problemsIn(error?.value) });
      }
    } catch {
      setState({ state: "failed", problems: [] });
    }
  };

  return (
    <section aria-labelledby={`caption-${selectId}`} className="flex flex-col gap-4 border-t pt-4">
      <h3 id={`caption-${selectId}`} className="text-sm font-medium">
        Caption and alt text
      </h3>
      <OwnText
        label="Caption"
        fromTemplate={loaded.caption.caption}
        own={draft.caption}
        rows={5}
        note={
          loaded.own.caption === null && loaded.caption.hashtagSet !== null
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
        fromTemplate={loaded.caption.altText}
        own={draft.altText}
        rows={3}
        onChange={(altText) => {
          setDraft((current) => ({ ...current, altText }));
          setState({ state: "idle" });
        }}
      />
      {check && (check.problems.length > 0 || check.warnings.length > 0) && (
        <ul className="flex flex-col gap-1 text-sm">
          {check.problems.map((problem) => (
            <li key={problem} className="text-destructive">
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
          {check.captionCharacters.toLocaleString()} of 2,200 characters · {check.hashtags} of 30 hashtags
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={save} disabled={!changed || blocked || state.state === "saving"}>
          {state.state === "saving" ? "Saving…" : "Save caption"}
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
        <Button variant="ghost" size="sm" onClick={() => onChange(own === null ? fromTemplate : null)}>
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
