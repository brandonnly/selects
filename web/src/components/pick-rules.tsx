import type { PickRules } from "@selects/server";
import { useMemo, useState } from "react";
import { api } from "@/api";
import { useAutosave } from "@/lib/autosave";
import { LIMITS, type PickRulesDraft, parsePickRules, toRulesDraft } from "@/lib/schedule";
import { SaveStatus } from "./schedule-editor";

const SETTLE_MS = 600;

/**
 * The pick rules for picks from the pool, each with a switch and its numbers. Saved as they
 * change, and only while every number is whole and within bounds. Newer rules from the server
 * are taken up while nothing is unsaved.
 */
export function PickRulesEditor({ rules, onSaved }: { rules: PickRules; onSaved: () => void }) {
  const [draft, setDraft] = useState<PickRulesDraft>(() => toRulesDraft(rules));
  const parsed = useMemo(() => parsePickRules(draft, rules), [draft, rules]);
  const save = useAutosave({
    value: parsed.rules,
    loaded: rules,
    save: async (next) => {
      const answer = await api["pick-rules"].put(next);
      if (answer.data) onSaved();
      return answer;
    },
    url: "/api/pick-rules",
    ms: SETTLE_MS,
    onNewer: (newer) => setDraft(toRulesDraft(newer)),
  });
  const { errors } = parsed;

  const numberInput = (
    label: string,
    text: string,
    change: (text: string) => void,
    disabled: boolean,
    error: string | undefined,
    id: string,
  ) => (
    <input
      inputMode="numeric"
      pattern="[0-9]*"
      aria-label={label}
      aria-invalid={error !== undefined}
      aria-describedby={error === undefined ? undefined : id}
      value={text}
      disabled={disabled}
      onChange={(event) => change(event.currentTarget.value)}
      className="h-10 w-20 rounded-md border bg-background px-2 text-center text-base aria-invalid:border-destructive disabled:opacity-50 md:text-sm"
    />
  );
  const fieldError = (error: string | undefined, id: string, what: string) =>
    error === undefined ? null : (
      <p id={id} className="text-destructive">
        {what}: {error}
      </p>
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
            errors.captureDayPosts,
            "capture-day-posts-error",
          )}
          posts.
        </p>
        {fieldError(errors.captureDayPosts, "capture-day-posts-error", "Posts")}
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
            errors.placeKm,
            "place-km-error",
          )}
          km of any of the last
          {numberInput(
            "Posts to space places from",
            draft.place.posts,
            (posts) => setDraft((d) => ({ ...d, place: { ...d.place, posts } })),
            !draft.place.on,
            errors.placePosts,
            "place-posts-error",
          )}
          posts.
        </p>
        {fieldError(errors.placeKm, "place-km-error", "Kilometres")}
        {fieldError(errors.placePosts, "place-posts-error", "Posts")}
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
      <p className="text-xs text-muted-foreground">
        Posts: 1 to {LIMITS.posts}. Kilometres: 1 to {LIMITS.km.toLocaleString("en-US")}.
      </p>
      {parsed.rules === undefined ? (
        <p role="status" className="text-sm text-destructive">
          Not saved until the numbers marked above are fixed.
        </p>
      ) : (
        <SaveStatus save={save} />
      )}
    </form>
  );
}
