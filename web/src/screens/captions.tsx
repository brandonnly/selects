import type { CaptionTemplates, LimitCheck, Select } from "@selects/server";
import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { useAutosave, useSettled } from "@/lib/autosave";
import { insertToken, parseTags } from "@/lib/captions";
import { cn } from "@/lib/utils";
import { PreviewPicker } from "./frame";
import { Screen } from "./screen";

/** How long a template must stay still before the preview builds and it is saved. */
const SETTLE_MS = 350;

const TOKEN_LABELS: Record<string, string> = {
  coordinates: "Coordinates",
  date: "Date",
  camera: "Camera",
  lens: "Lens",
  focalLength: "Focal length",
  shutter: "Shutter",
  aperture: "Aperture",
  iso: "ISO",
  hashtags: "Hashtags",
};

type SetDraft = { key: number; name: string; tagsText: string };
type Draft = { caption: string; altText: string; sets: SetDraft[] };

type Preview = {
  caption: { caption: string; altText: string; hashtagSet: string | null } | null;
  measure: LimitCheck | null;
  check: { problems: string[]; warnings: string[] };
};

let nextSetKey = 0;

const toTemplates = (draft: Draft): CaptionTemplates => ({
  caption: draft.caption,
  altText: draft.altText,
  hashtagSets: draft.sets.map((set) => ({ name: set.name.trim(), tags: parseTags(set.tagsText) })),
});

export function CaptionsScreen() {
  const [draft, setDraft] = useState<Draft | undefined>();
  const [loaded, setLoaded] = useState<CaptionTemplates | undefined>();
  const [tokens, setTokens] = useState<string[]>([]);
  const [limits, setLimits] = useState<{ characters: number; hashtags: number } | undefined>();
  const [selects, setSelects] = useState<Select[] | undefined>();
  const [previewId, setPreviewId] = useState<string | undefined>();
  const [shownSet, setShownSet] = useState<string | undefined>();
  const [preview, setPreview] = useState<Preview | undefined>();
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([api.captions.get(), api.selects.get()])
      .then(([captions, library]) => {
        if (!live) return;
        if (captions.data) {
          const { templates } = captions.data;
          setDraft({
            caption: templates.caption,
            altText: templates.altText,
            sets: templates.hashtagSets.map((set) => ({
              key: nextSetKey++,
              name: set.name,
              tagsText: set.tags.join(" "),
            })),
          });
          setLoaded(templates);
          setTokens([...captions.data.tokens]);
          setLimits(captions.data.limits);
        }
        if (library.data) {
          setSelects(library.data);
          setPreviewId(library.data[0]?.id);
        }
        setLoadError(captions.error !== null || library.error !== null);
      })
      .catch(() => {
        if (live) setLoadError(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const templates = useMemo(() => (draft === undefined ? undefined : toTemplates(draft)), [draft]);
  const save = useAutosave({
    value: templates,
    loaded,
    save: (next) => api.captions.put(next),
    url: "/api/captions",
    ms: SETTLE_MS,
  });

  const settled = useSettled(templates, SETTLE_MS);
  const setNames = templates?.hashtagSets.map((set) => set.name) ?? [];
  const showing = shownSet !== undefined && setNames.includes(shownSet) ? shownSet : setNames[0];

  // Builds the preview from the settled templates; only the newest answer is shown.
  const previewTurn = useRef(0);
  useEffect(() => {
    if (settled === undefined) return;
    const turn = ++previewTurn.current;
    api.captions.preview
      .post({ selectId: previewId, templates: settled, hashtagSet: showing })
      .then(({ data }) => {
        if (turn === previewTurn.current && data) setPreview(data);
      })
      .catch(() => {});
  }, [settled, previewId, showing]);

  const change = (update: Partial<Draft>) =>
    setDraft((current) => (current === undefined ? current : { ...current, ...update }));
  const changeSet = (key: number, update: Partial<SetDraft>) =>
    setDraft((current) =>
      current === undefined
        ? current
        : { ...current, sets: current.sets.map((set) => (set.key === key ? { ...set, ...update } : set)) },
    );

  return (
    <Screen title="Captions">
      {loadError && <p className="text-sm text-destructive">Can't reach the server.</p>}
      {draft !== undefined && (
        <div className="flex flex-col gap-8 md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-start">
          <form
            aria-label="Caption templates"
            className="flex flex-col gap-6"
            onSubmit={(event) => event.preventDefault()}
          >
            <TemplateField
              id="caption-template"
              label="Caption"
              value={draft.caption}
              tokens={tokens}
              rows={5}
              onChange={(caption) => change({ caption })}
            />
            <TemplateField
              id="alt-text-template"
              label="Alt text"
              value={draft.altText}
              tokens={tokens.filter((token) => token !== "hashtags")}
              rows={2}
              onChange={(altText) => change({ altText })}
            />
            <p className="text-xs text-muted-foreground">
              A token a photo doesn't have is left out, with the separator next to it. A line whose tokens are
              all missing is left out. Text in [square brackets] is left out when a token inside is missing.
            </p>

            <fieldset className="flex flex-col gap-3 text-sm">
              <legend className="mb-1 font-medium">Hashtag sets</legend>
              <p className="text-xs text-muted-foreground">
                Each post uses one set, chosen at random, where the caption has {"{hashtags}"}.
              </p>
              {draft.sets.map((set, index) => (
                <div key={set.key} className="flex flex-col gap-2 rounded-md border bg-card p-3">
                  <div className="flex items-center gap-2">
                    <input
                      aria-label={`Name of hashtag set ${index + 1}`}
                      value={set.name}
                      placeholder="Name"
                      maxLength={60}
                      onChange={(event) => changeSet(set.key, { name: event.currentTarget.value })}
                      className="h-10 min-w-0 flex-1 rounded-md border bg-background px-3 text-base md:text-sm"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove ${set.name.trim() || `hashtag set ${index + 1}`}`}
                      onClick={() => change({ sets: draft.sets.filter((other) => other.key !== set.key) })}
                    >
                      <X aria-hidden className="size-4" />
                    </Button>
                  </div>
                  <textarea
                    aria-label={`Hashtags in ${set.name.trim() || `set ${index + 1}`}`}
                    value={set.tagsText}
                    placeholder="#film #35mm"
                    rows={2}
                    autoCapitalize="none"
                    spellCheck={false}
                    onChange={(event) => changeSet(set.key, { tagsText: event.currentTarget.value })}
                    className="rounded-md border bg-background px-3 py-2 text-base md:text-sm"
                  />
                </div>
              ))}
              <Button
                variant="outline"
                className="self-start"
                onClick={() =>
                  change({ sets: [...draft.sets, { key: nextSetKey++, name: "", tagsText: "" }] })
                }
              >
                <Plus aria-hidden className="size-4" />
                Add hashtag set
              </Button>
            </fieldset>

            <div role="status" className="min-h-5 text-sm text-muted-foreground">
              {save.state === "saving" && "Saving…"}
              {save.state === "saved" && "Saved."}
              {save.state === "failed" && (
                <span className="text-destructive">
                  {save.problems.length > 0
                    ? "Not saved. Fix the problems below."
                    : "Couldn't save. Change something to try again."}
                </span>
              )}
            </div>
            <Notes check={preview?.check} />
          </form>

          <section aria-labelledby="caption-preview" className="flex flex-col gap-3 md:sticky md:top-6">
            <h2 id="caption-preview" className="text-sm font-medium text-muted-foreground">
              Preview
            </h2>
            {selects?.length === 0 && (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                Add a photo in the Library to preview its caption.
              </p>
            )}
            {preview?.caption && (
              <div className="flex flex-col gap-4 rounded-lg border bg-card p-4 text-card-foreground">
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">Caption</span>
                  <p className="whitespace-pre-wrap break-words text-sm">
                    {preview.caption.caption || <Empty>No caption</Empty>}
                  </p>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">Alt text</span>
                  <p className="whitespace-pre-wrap break-words text-sm">
                    {preview.caption.altText || <Empty>No alt text</Empty>}
                  </p>
                </div>
                {preview.measure && limits && (
                  <p className="text-xs tabular-nums text-muted-foreground">
                    {preview.measure.captionCharacters.toLocaleString()} of{" "}
                    {limits.characters.toLocaleString()} characters · {preview.measure.hashtags} of{" "}
                    {limits.hashtags} hashtags
                  </p>
                )}
              </div>
            )}
            {setNames.length > 1 && (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-sm font-medium text-muted-foreground">Hashtag set shown</legend>
                <div className="flex flex-wrap gap-2">
                  {setNames.map((name, index) => (
                    <label
                      // biome-ignore lint/suspicious/noArrayIndexKey: names can repeat while being typed.
                      key={index}
                      className="cursor-pointer rounded-md border bg-card px-3 py-1.5 text-sm text-muted-foreground has-[:checked]:bg-secondary has-[:checked]:text-secondary-foreground has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring"
                    >
                      <input
                        type="radio"
                        name="shown-set"
                        className="sr-only"
                        checked={name === showing}
                        onChange={() => setShownSet(name)}
                      />
                      {name || "Unnamed"}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            {selects !== undefined && selects.length > 1 && (
              <PreviewPicker selects={selects} chosen={previewId} onChoose={setPreviewId} />
            )}
          </section>
        </div>
      )}
    </Screen>
  );
}

function Empty({ children }: { children: string }) {
  return <span className="text-muted-foreground italic">{children}</span>;
}

/** The templates' problems, which stop a save, and warnings near Instagram's limits. */
function Notes({ check }: { check: Preview["check"] | undefined }) {
  if (check === undefined || (check.problems.length === 0 && check.warnings.length === 0)) return null;
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {check.problems.map((problem) => (
        <li key={problem} className="text-destructive">
          {problem}
        </li>
      ))}
      {check.warnings.map((warning) => (
        <li key={warning} className="text-foreground">
          Warning: {warning}
        </li>
      ))}
    </ul>
  );
}

/** A template's text, with a button per token that puts it in at the cursor. */
function TemplateField({
  id,
  label,
  value,
  tokens,
  rows,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  tokens: string[];
  rows: number;
  onChange: (value: string) => void;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  /** Where the cursor goes once the inserted token has rendered. */
  const cursor = useRef<number | undefined>(undefined);

  useEffect(() => {
    const element = field.current;
    if (cursor.current === undefined || element === null) return;
    element.focus();
    element.setSelectionRange(cursor.current, cursor.current);
    cursor.current = undefined;
  });

  const insert = (token: string) => {
    const element = field.current;
    const selection =
      element === null
        ? { start: value.length, end: value.length }
        : { start: element.selectionStart, end: element.selectionEnd };
    const next = insertToken(value, selection, token);
    cursor.current = next.cursor;
    onChange(next.text);
  };

  return (
    <div className="flex flex-col gap-2 text-sm">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      <textarea
        ref={field}
        id={id}
        value={value}
        rows={rows}
        spellCheck={false}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="rounded-md border bg-card px-3 py-2 font-mono text-base text-card-foreground md:text-sm"
      />
      <fieldset className="flex flex-wrap gap-1.5">
        <legend className="sr-only">Insert a token in the {label.toLowerCase()}</legend>
        {tokens.map((token) => (
          <button
            key={token}
            type="button"
            onClick={() => insert(token)}
            className={cn(
              "rounded-sm border bg-background px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              "focus-visible:outline-2 focus-visible:outline-ring",
            )}
          >
            {TOKEN_LABELS[token] ?? token}
          </button>
        ))}
      </fieldset>
    </div>
  );
}
