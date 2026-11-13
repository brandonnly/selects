import type { CaptureEdits, CaptureView, Withheld } from "@selects/server";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { type Draft, draftOf, type EditField, editsFrom } from "@/lib/capture-edits";
import { cn } from "@/lib/utils";

/** How long the form must stay still before it is saved, as on the Frame screen. */
const SETTLE_MS = 350;

type Input = {
  field: keyof Draft;
  label: string;
  /** Which edit's error shows under this input. */
  edit: EditField;
  inputMode?: "text" | "decimal" | "numeric";
  type?: "text" | "datetime-local";
  placeholder?: string;
};

const INPUTS: Input[] = [
  { field: "camera", edit: "camera", label: "Camera" },
  { field: "lens", edit: "lens", label: "Lens" },
  {
    field: "focalLength",
    edit: "focalLength",
    label: "Focal length, mm",
    inputMode: "decimal",
    placeholder: "35",
  },
  { field: "exposureTime", edit: "exposureTime", label: "Shutter, s", placeholder: "1/250" },
  { field: "fNumber", edit: "fNumber", label: "Aperture, ƒ/", inputMode: "decimal", placeholder: "2.8" },
  { field: "iso", edit: "iso", label: "ISO", inputMode: "numeric", placeholder: "400" },
  { field: "capturedAt", edit: "capturedAt", label: "Taken", type: "datetime-local" },
  { field: "latitude", edit: "coordinates", label: "Latitude", inputMode: "decimal", placeholder: "10.5" },
  {
    field: "longitude",
    edit: "coordinates",
    label: "Longitude",
    inputMode: "decimal",
    placeholder: "-40.25",
  },
];

const WITHHELD: Record<Withheld | "published", string> = {
  published: "Its coordinates print on the frame and in the caption.",
  "no-coordinates": "It has no coordinates, so none are published.",
  hidden: "Its location is hidden: coordinates are never published.",
  "privacy-zone": "It was taken inside a privacy zone: coordinates are never published.",
};

type Payload = { edits: CaptureEdits; locationHidden: boolean };
type SaveState = "idle" | "saving" | "saved" | "failed";

/**
 * A select's capture data, editable field by field, and whether its location is published.
 * Changes save themselves once typing stops. Edits live in the database; the original file is
 * never changed.
 */
export function CaptureEditor({ selectId, onSaved }: { selectId: string; onSaved: () => void }) {
  const [view, setView] = useState<CaptureView | undefined>();
  const [draft, setDraft] = useState<Draft | undefined>();
  const [hidden, setHidden] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [save, setSave] = useState<SaveState>("idle");
  /** What the server holds or was last sent, as JSON. */
  const lastSent = useRef<string | undefined>(undefined);
  /** Saves go one after another, so an earlier one can never land after a later one. */
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const saved = useRef(onSaved);
  saved.current = onSaved;

  const load = useCallback(async () => {
    try {
      const { data, error } = await api.selects({ id: selectId }).capture.get();
      if (data) {
        setView(data);
        return data;
      }
      setLoadError(error !== null);
    } catch {
      setLoadError(true);
    }
    return undefined;
  }, [selectId]);

  useEffect(() => {
    let live = true;
    void load().then((loaded) => {
      if (!live || loaded === undefined) return;
      const initial = draftOf(loaded.edited);
      setDraft(initial);
      setHidden(loaded.locationHidden);
      lastSent.current = JSON.stringify({
        edits: editsFrom(initial, loaded.file, loaded.edits).edits,
        locationHidden: loaded.locationHidden,
      });
    });
    return () => {
      live = false;
    };
  }, [load]);

  const result = useMemo(
    () => (view === undefined || draft === undefined ? undefined : editsFrom(draft, view.file, view.edits)),
    [view, draft],
  );
  const payload = useMemo<Payload | undefined>(
    () => (result === undefined ? undefined : { edits: result.edits, locationHidden: hidden }),
    [result, hidden],
  );

  const send = useCallback(
    (next: Payload) => {
      const json = JSON.stringify(next);
      lastSent.current = json;
      setSave("saving");
      const sent = saving.current.then(() => api.selects({ id: selectId }).capture.put(next));
      saving.current = sent.catch(() => {});
      return sent
        .then(({ data, error }) => {
          if (lastSent.current !== json) return;
          if (data) {
            setView(data);
            setSave("saved");
            saved.current();
          } else {
            setSave(error ? "failed" : "saved");
          }
        })
        .catch(() => {
          if (lastSent.current === json) setSave("failed");
        });
    },
    [selectId],
  );

  // Saves a payload that has stayed the same for a moment and differs from what was sent.
  useEffect(() => {
    if (payload === undefined || JSON.stringify(payload) === lastSent.current) return;
    const timer = setTimeout(() => void send(payload), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [payload, send]);

  // Closing the dialog before a change has settled still saves it.
  const pending = useRef(payload);
  pending.current = payload;
  useEffect(
    () => () => {
      const last = pending.current;
      if (last !== undefined && JSON.stringify(last) !== lastSent.current) void send(last);
    },
    [send],
  );

  if (loadError) return <p className="text-sm text-destructive">Couldn't load the capture data.</p>;
  if (view === undefined || draft === undefined || result === undefined) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  const fromFile = draftOf(view.file);
  const set = (change: Partial<Draft>) =>
    setDraft((current) => (current === undefined ? current : { ...current, ...change }));
  const hasCoordinates = draft.latitude.trim() !== "" || draft.longitude.trim() !== "";
  const status: Withheld | "published" = view.withheld ?? "published";

  return (
    <div className="flex flex-col gap-6">
      <form
        aria-label="Capture data"
        className="grid grid-cols-2 gap-x-3 gap-y-4"
        onSubmit={(event) => event.preventDefault()}
      >
        {INPUTS.map((input) => {
          const edited = draft[input.field].trim() !== fromFile[input.field];
          const error = result.errors[input.edit];
          const wide = input.field === "camera" || input.field === "lens" || input.field === "capturedAt";
          const id = `capture-${input.field}`;
          return (
            <div
              key={input.field}
              className={cn("flex min-w-0 flex-col gap-1.5 text-sm", wide && "col-span-2")}
            >
              <label htmlFor={id} className="font-medium">
                {input.label}
              </label>
              <input
                id={id}
                type={input.type ?? "text"}
                step={input.type === "datetime-local" ? 1 : undefined}
                inputMode={input.inputMode}
                placeholder={input.placeholder}
                value={draft[input.field]}
                aria-invalid={error !== undefined}
                aria-describedby={edited || error ? `${id}-note` : undefined}
                onChange={(event) => {
                  // A date still being filled in reads as blank: it is not a cleared one.
                  if (event.currentTarget.validity.badInput) return;
                  set({ [input.field]: event.currentTarget.value });
                }}
                className={cn(
                  "h-10 w-full min-w-0 rounded-md border bg-card px-3 text-base text-card-foreground md:text-sm",
                  error !== undefined && "border-destructive",
                )}
              />
              {(edited || error) && (
                <span id={`${id}-note`} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                  {error ? (
                    <span className="text-destructive">{error}</span>
                  ) : (
                    <span className="text-muted-foreground">
                      {fromFile[input.field] === "" ? "Not in the file." : `File: ${fromFile[input.field]}`}
                    </span>
                  )}
                  {edited && (
                    <button
                      type="button"
                      className="font-medium text-foreground underline underline-offset-2"
                      onClick={() =>
                        set(
                          input.edit === "coordinates"
                            ? { latitude: fromFile.latitude, longitude: fromFile.longitude }
                            : { [input.field]: fromFile[input.field] },
                        )
                      }
                    >
                      Reset
                    </button>
                  )}
                </span>
              )}
            </div>
          );
        })}
        <p className="col-span-2 text-xs text-muted-foreground">
          Edits change what is published, never the file. An emptied field is left off the frame.
        </p>
      </form>

      <section aria-labelledby="location-privacy" className="flex flex-col gap-3">
        <h3 id="location-privacy" className="text-sm font-medium">
          Location
        </h3>
        <p className="text-sm text-muted-foreground">{WITHHELD[status]}</p>
        <label className={cn("flex items-center gap-2 text-sm", !hasCoordinates && !hidden && "opacity-50")}>
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={hidden}
            disabled={!hasCoordinates && !hidden}
            onChange={(event) => setHidden(event.currentTarget.checked)}
          />
          Hide this select's location
        </label>
        {view.edited.latitude !== null && (
          <ZoneFromSelect
            selectId={selectId}
            onAdded={async () => {
              await load();
              // The frame and the Library's map change with the new zone.
              saved.current();
            }}
          />
        )}
      </section>

      <p role="status" className="min-h-5 text-sm text-muted-foreground">
        {save === "saving" && "Saving…"}
        {save === "saved" && "Saved."}
        {save === "failed" && (
          <span className="text-destructive">Couldn't save. Change a field to try again.</span>
        )}
      </p>
    </div>
  );
}

/** Makes a privacy zone around where the select was taken. */
function ZoneFromSelect({ selectId, onAdded }: { selectId: string; onAdded: () => Promise<unknown> }) {
  const [radius, setRadius] = useState("500");
  const [state, setState] = useState<"idle" | "adding" | "added" | "failed">("idle");
  // Digits only, with a decimal point at most: "1,000" must not be read as one metre.
  const radiusMetres = /^\d+(\.\d+)?$/.test(radius.trim()) ? Number(radius.trim()) : Number.NaN;
  const valid = Number.isFinite(radiusMetres) && radiusMetres > 0;

  const add = async () => {
    setState("adding");
    try {
      const { error } = await api.zones.post({ selectId, radiusMetres });
      setState(error ? "failed" : "added");
      if (!error) await onAdded();
    } catch {
      setState("failed");
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">Radius in metres</span>
          <input
            inputMode="numeric"
            value={radius}
            onChange={(event) => setRadius(event.currentTarget.value)}
            aria-invalid={!valid}
            className="h-10 w-28 rounded-md border bg-card px-3 text-base text-card-foreground md:text-sm"
          />
        </label>
        <Button variant="outline" disabled={!valid || state === "adding"} onClick={add}>
          {state === "adding" ? "Adding…" : "Make a privacy zone here"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {state === "added"
          ? "Zone added around where this select was taken. Manage zones in Settings."
          : state === "failed"
            ? "Couldn't add the zone. Try again."
            : "Hides this place for every select taken near it, not just this one."}
      </p>
    </div>
  );
}
