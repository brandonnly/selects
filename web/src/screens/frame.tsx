import type { FontOverride, FrameField, FrameSettings, Select } from "@selects/server";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api";
import { debounce, previewUrl } from "@/lib/frame";
import { cn } from "@/lib/utils";
import { Screen } from "./screen";

/** How long settings must stay still before the preview renders and they are saved. */
const SETTLE_MS = 350;
/** The preview is rendered at half the frame's width: sharp on a phone, quick to make. */
const PREVIEW_WIDTH = 720;

const FIELD_LABELS: Record<FrameField, string> = {
  camera: "Camera",
  lens: "Lens",
  focalLength: "Focal length",
  shutter: "Shutter speed",
  aperture: "Aperture",
  iso: "ISO",
  coordinates: "Coordinates",
  date: "Date",
};

type Options = {
  typefaces: { id: FrameSettings["typeface"]; name: string }[];
  fontOverride: FontOverride | null;
  maxBorder: number;
};

type SaveState = "idle" | "saving" | "saved" | "failed";

/** `value`, once it has stopped changing for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  const update = useMemo(() => debounce(setSettled, ms), [ms]);
  useEffect(() => update(value), [value, update]);
  useEffect(() => update.cancel, [update]);
  return settled;
}

export function FrameScreen() {
  const [settings, setSettings] = useState<FrameSettings | undefined>();
  const [options, setOptions] = useState<Options | undefined>();
  const [selects, setSelects] = useState<Select[] | undefined>();
  const [previewId, setPreviewId] = useState<string | undefined>();
  const [loadError, setLoadError] = useState(false);
  const [save, setSave] = useState<SaveState>("idle");
  /** The settings the server holds, as JSON: what was loaded or last sent. */
  const lastSaved = useRef<string | undefined>(undefined);
  const latest = useRef<FrameSettings | undefined>(undefined);
  latest.current = settings;

  useEffect(() => {
    let live = true;
    Promise.all([api.frame.get(), api.selects.get()])
      .then(([frame, library]) => {
        if (!live) return;
        if (frame.data) {
          const { settings: saved, ...rest } = frame.data;
          lastSaved.current = JSON.stringify(saved);
          setSettings(saved);
          setOptions(rest);
        }
        if (library.data) {
          setSelects(library.data);
          setPreviewId(library.data[0]?.id);
        }
        setLoadError(frame.error !== null || library.error !== null);
      })
      .catch(() => {
        if (live) setLoadError(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const settled = useSettled(settings, SETTLE_MS);

  // Saves settled settings that differ from what the server holds.
  useEffect(() => {
    if (settled === undefined || lastSaved.current === undefined) return;
    const json = JSON.stringify(settled);
    if (json === lastSaved.current) return;
    lastSaved.current = json;
    setSave("saving");
    api.frame
      .put(settled)
      .then(({ error }) => {
        if (lastSaved.current === json) setSave(error ? "failed" : "saved");
      })
      .catch(() => {
        if (lastSaved.current === json) setSave("failed");
      });
  }, [settled]);

  // Leaving the screen before a change has settled still saves it.
  useEffect(
    () => () => {
      const pending = latest.current;
      if (pending === undefined || lastSaved.current === undefined) return;
      if (JSON.stringify(pending) === lastSaved.current) return;
      api.frame.put(pending).catch(() => {});
    },
    [],
  );

  const change = (update: Partial<FrameSettings>) =>
    setSettings((current) => (current === undefined ? current : { ...current, ...update }));

  return (
    <Screen title="Frame">
      {loadError && <p className="text-sm text-destructive">Can't reach the server.</p>}
      <div className="flex flex-col gap-8 md:grid md:grid-cols-[minmax(0,1fr)_18rem] md:items-start">
        <section aria-labelledby="preview" className="flex flex-col gap-3">
          <h2 id="preview" className="sr-only">
            Preview
          </h2>
          <Preview
            url={
              previewId !== undefined && settled !== undefined
                ? previewUrl(previewId, settled, PREVIEW_WIDTH)
                : undefined
            }
            pending={settings !== settled}
            empty={selects?.length === 0}
          />
          {selects !== undefined && selects.length > 1 && (
            <PreviewPicker selects={selects} chosen={previewId} onChoose={setPreviewId} />
          )}
        </section>

        {settings !== undefined && options !== undefined && (
          <form
            aria-label="Frame settings"
            className="flex flex-col gap-6"
            onSubmit={(event) => event.preventDefault()}
          >
            <Choice
              legend="Frame"
              name="color"
              value={settings.color}
              options={[
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
              onChange={(color) => change({ color })}
            />

            <label className="flex flex-col gap-2 text-sm">
              <span className="flex justify-between font-medium">
                Border
                <span className="tabular-nums text-muted-foreground">{settings.border} px</span>
              </span>
              <input
                type="range"
                min={0}
                max={options.maxBorder}
                step={4}
                value={settings.border}
                onChange={(event) => change({ border: Number(event.currentTarget.value) })}
                className="accent-primary"
              />
            </label>

            <label className="flex flex-col gap-2 text-sm">
              <span className="font-medium">Typeface</span>
              <select
                value={settings.typeface}
                onChange={(event) =>
                  change({ typeface: event.currentTarget.value as FrameSettings["typeface"] })
                }
                className="h-10 rounded-md border bg-card px-3 text-base text-card-foreground md:text-sm"
              >
                {options.typefaces.map((typeface) => (
                  <option key={typeface.id} value={typeface.id}>
                    {typeface.name}
                  </option>
                ))}
              </select>
              <FontOverrideNote override={options.fontOverride} />
            </label>

            <fieldset className="flex flex-col gap-2 text-sm">
              <legend className="mb-2 font-medium">Show</legend>
              {(Object.keys(FIELD_LABELS) as FrameField[]).map((field) => (
                <label key={field} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={settings.fields[field]}
                    onChange={(event) =>
                      change({ fields: { ...settings.fields, [field]: event.currentTarget.checked } })
                    }
                  />
                  {FIELD_LABELS[field]}
                </label>
              ))}
              <span className="text-xs text-muted-foreground">
                A field a photo doesn't have is left off its frame.
              </span>
            </fieldset>

            <Choice
              legend="Coordinates as"
              name="coordinateFormat"
              value={settings.coordinateFormat}
              options={[
                { value: "dms", label: "Degrees, minutes, seconds" },
                { value: "decimal", label: "Decimal degrees" },
              ]}
              onChange={(coordinateFormat) => change({ coordinateFormat })}
            />

            <p role="status" className="min-h-5 text-sm text-muted-foreground">
              {save === "saving" && "Saving…"}
              {save === "saved" && "Saved."}
              {save === "failed" && (
                <span className="text-destructive">Couldn't save. Change a setting to try again.</span>
              )}
            </p>
          </form>
        )}
      </div>
    </Screen>
  );
}

/**
 * The rendered frame. A new render is loaded behind the one on show and swapped in once it
 * arrives, so the preview never blanks while a setting changes.
 */
function Preview({ url, pending, empty }: { url: string | undefined; pending: boolean; empty: boolean }) {
  const [shown, setShown] = useState<string | undefined>();
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    if (url === undefined) return;
    let live = true;
    setState("loading");
    const image = new Image();
    image.onload = () => {
      if (!live) return;
      setShown(url);
      setState("ready");
    };
    image.onerror = () => {
      if (live) setState("failed");
    };
    image.src = url;
    return () => {
      live = false;
      image.onload = null;
      image.onerror = null;
    };
  }, [url]);

  const busy = pending || (url !== undefined && state === "loading");

  return (
    <div className="flex flex-col gap-2">
      <div
        aria-busy={busy}
        className="relative mx-auto aspect-[4/5] w-full max-w-md overflow-hidden rounded-md border bg-muted"
      >
        {shown !== undefined && (
          <img
            src={shown}
            alt="The frame with these settings"
            className={cn("size-full object-contain transition-opacity", busy && "opacity-70")}
          />
        )}
        {empty && (
          <p className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
            Add a photo in the Library to preview the frame.
          </p>
        )}
      </div>
      {state === "failed" && (
        <p className="text-center text-sm text-destructive">Couldn't render the preview.</p>
      )}
    </div>
  );
}

function PreviewPicker({
  selects,
  chosen,
  onChoose,
}: {
  selects: Select[];
  chosen: string | undefined;
  onChoose: (id: string) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium text-muted-foreground">Preview with</legend>
      <div className="-mx-1 flex gap-2 overflow-x-auto p-1">
        {selects.map((select) => (
          <label
            key={select.id}
            className="relative size-16 shrink-0 cursor-pointer overflow-hidden rounded-md bg-muted has-[:checked]:outline-2 has-[:checked]:outline-offset-2 has-[:checked]:outline-primary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring"
          >
            <input
              type="radio"
              name="preview-select"
              className="sr-only"
              checked={select.id === chosen}
              onChange={() => onChoose(select.id)}
            />
            <img
              src={`/api/selects/${select.id}/thumbnail`}
              alt={select.fileName}
              loading="lazy"
              className="size-full object-cover"
            />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function FontOverrideNote({ override }: { override: FontOverride | null }) {
  if (override === null) {
    return (
      <span className="text-xs text-muted-foreground">
        To use another font, put its file in the <code>fonts</code> folder of the data folder.
      </span>
    );
  }
  if (!override.usable) {
    return (
      <span className="text-xs text-destructive">
        {override.fileName} in the data folder can't be read, so the typeface chosen here is used.
      </span>
    );
  }
  return (
    <span className="text-xs text-muted-foreground">
      {override.fileName} from the data folder is used in place of this typeface.
    </span>
  );
}

function Choice<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
}: {
  legend: ReactNode;
  name: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2 text-sm">
      <legend className="mb-2 font-medium">{legend}</legend>
      <div className="flex rounded-md border bg-card p-1">
        {options.map((option) => (
          <label
            key={option.value}
            className="flex-1 cursor-pointer rounded-sm px-3 py-2 text-center text-muted-foreground has-[:checked]:bg-secondary has-[:checked]:text-secondary-foreground has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring"
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              className="sr-only"
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
