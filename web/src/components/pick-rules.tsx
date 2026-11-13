import type { PickRules } from "@selects/server";
import { useMemo, useState } from "react";
import { api } from "@/api";
import { useAutosave } from "@/lib/autosave";
import { SaveStatus } from "./schedule-editor";

const SETTLE_MS = 600;

type Draft = {
  captureDay: { on: boolean; posts: string };
  place: { on: boolean; km: string; posts: string };
  order: PickRules["order"];
};

const count = (text: string, fallback: number) => (/^\d+$/.test(text.trim()) ? Number(text) : fallback);
const distance = (text: string, fallback: number) => {
  const value = Number(text.trim().replace(",", "."));
  return text.trim() !== "" && Number.isFinite(value) && value > 0 ? value : fallback;
};

/** The pick rules for picks from the pool, each with a switch and its numbers. Saved as they change. */
export function PickRulesEditor({ rules, onSaved }: { rules: PickRules; onSaved: () => void }) {
  const [loaded] = useState(rules);
  const [draft, setDraft] = useState<Draft>({
    captureDay: { on: rules.captureDay.on, posts: String(rules.captureDay.posts) },
    place: { on: rules.place.on, km: String(rules.place.km), posts: String(rules.place.posts) },
    order: rules.order,
  });
  const value = useMemo<PickRules>(
    () => ({
      captureDay: { on: draft.captureDay.on, posts: count(draft.captureDay.posts, loaded.captureDay.posts) },
      place: {
        on: draft.place.on,
        km: distance(draft.place.km, loaded.place.km),
        posts: count(draft.place.posts, loaded.place.posts),
      },
      order: draft.order,
    }),
    [draft, loaded],
  );
  const save = useAutosave({
    value,
    loaded,
    save: async (next) => {
      const answer = await api["pick-rules"].put(next);
      if (answer.data) onSaved();
      return answer;
    },
    url: "/api/pick-rules",
    ms: SETTLE_MS,
  });

  const numberInput = (label: string, text: string, change: (text: string) => void, disabled: boolean) => (
    <input
      inputMode="decimal"
      aria-label={label}
      value={text}
      disabled={disabled}
      onChange={(event) => change(event.currentTarget.value)}
      className="h-10 w-16 rounded-md border bg-background px-2 text-center text-base disabled:opacity-50 md:text-sm"
    />
  );

  return (
    <form
      aria-label="Pick rules"
      className="flex flex-col gap-3 text-sm"
      onSubmit={(event) => event.preventDefault()}
    >
      <p className="text-muted-foreground">
        For picks from the pool. Queued selects ignore them. A rule that would leave nothing to pick is
        relaxed: spacing by place first, then spacing by capture day.
      </p>
      <div className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground">
        <label className="flex items-center gap-2 font-medium">
          <input
            type="checkbox"
            checked={draft.captureDay.on}
            onChange={(event) => {
              const on = event.currentTarget.checked;
              setDraft((d) => ({ ...d, captureDay: { ...d.captureDay, on } }));
            }}
            className="size-4 accent-primary"
          />
          Spacing by capture day
        </label>
        <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
          Not taken the same day as any of the last
          {numberInput(
            "Posts to space capture days from",
            draft.captureDay.posts,
            (posts) => setDraft((d) => ({ ...d, captureDay: { ...d.captureDay, posts } })),
            !draft.captureDay.on,
          )}
          posts.
        </p>
      </div>
      <div className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground">
        <label className="flex items-center gap-2 font-medium">
          <input
            type="checkbox"
            checked={draft.place.on}
            onChange={(event) => {
              const on = event.currentTarget.checked;
              setDraft((d) => ({ ...d, place: { ...d.place, on } }));
            }}
            className="size-4 accent-primary"
          />
          Spacing by place
        </label>
        <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
          Not within
          {numberInput(
            "Kilometres to space places by",
            draft.place.km,
            (km) => setDraft((d) => ({ ...d, place: { ...d.place, km } })),
            !draft.place.on,
          )}
          km of any of the last
          {numberInput(
            "Posts to space places from",
            draft.place.posts,
            (posts) => setDraft((d) => ({ ...d, place: { ...d.place, posts } })),
            !draft.place.on,
          )}
          posts.
        </p>
        <p className="text-xs text-muted-foreground">
          Uses every select's location, hidden or not, only to choose. It never publishes one.
        </p>
      </div>
      <fieldset className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground">
        <legend className="sr-only">Order</legend>
        <span className="font-medium">Order</span>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {(
            [
              ["random", "Random"],
              ["oldest", "Oldest first"],
              ["newest", "Newest first"],
            ] as const
          ).map(([order, label]) => (
            <label key={order} className="flex items-center gap-2">
              <input
                type="radio"
                name="pick-order"
                checked={draft.order === order}
                onChange={() => setDraft((d) => ({ ...d, order }))}
                className="size-4 accent-primary"
              />
              {label}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Oldest and newest go by when each photo was taken.</p>
      </fieldset>
      <SaveStatus save={save} />
    </form>
  );
}
