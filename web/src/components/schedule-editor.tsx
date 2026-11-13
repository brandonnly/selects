import type { Schedule } from "@selects/server";
import { Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { type SaveState, useAutosave } from "@/lib/autosave";
import {
  deviceTimeZone,
  LIMITS,
  minutes,
  parseSchedule,
  type ScheduleDraft,
  type SlotDraft,
  timeZones,
  toDraft,
  WEEKDAYS,
} from "@/lib/schedule";
import { cn } from "@/lib/utils";

const SETTLE_MS = 600;

/** A random ID for a new slot. `crypto.randomUUID` needs HTTPS, which a home server may not have. */
function newSlotId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The schedule: slots with days of the week, a time and an optional spread, the install's
 * timezone and the grace period. Saved as it changes, and only while every field is whole: a slot
 * left without a day or a time holds the save back and is never saved as removed. `onSaved` takes
 * what the server answered. A newer schedule from the server is taken up while nothing is unsaved.
 */
export function ScheduleEditor({
  schedule,
  onSaved,
}: {
  schedule: Schedule;
  onSaved: (answer: NonNullable<Awaited<ReturnType<typeof api.schedule.put>>["data"]>) => void;
}) {
  const [draft, setDraft] = useState<ScheduleDraft>(() => toDraft(schedule));
  const parsed = useMemo(() => parseSchedule(draft), [draft]);
  const zones = useMemo(timeZones, []);
  const device = useMemo(deviceTimeZone, []);

  const save = useAutosave({
    value: parsed.schedule,
    loaded: schedule,
    save: async (next) => {
      const answer = await api.schedule.put(next);
      if (answer.data) onSaved(answer.data);
      return answer;
    },
    url: "/api/schedule",
    ms: SETTLE_MS,
    onNewer: (newer) => setDraft(toDraft(newer)),
  });

  const changeSlot = (id: string, change: Partial<SlotDraft>) =>
    setDraft((current) => ({
      ...current,
      slots: current.slots.map((slot) => (slot.id === id ? { ...slot, ...change } : slot)),
    }));

  return (
    <form className="flex flex-col gap-4" aria-label="Schedule" onSubmit={(event) => event.preventDefault()}>
      {draft.slots.length === 0 && (
        <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
          No slots: nothing posts until one is added.
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {draft.slots.map((slot, index) => {
          const errors = parsed.errors.slots[slot.id] ?? {};
          const spread = /^\d+$/.test(slot.spreadText.trim()) ? Number(slot.spreadText.trim()) : 0;
          return (
            <li
              key={slot.id}
              className="flex flex-col gap-3 rounded-lg border bg-card p-3 text-sm text-card-foreground"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">Slot {index + 1}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove slot ${index + 1}`}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      slots: current.slots.filter((s) => s.id !== slot.id),
                    }))
                  }
                  className="size-11 px-0"
                >
                  <X aria-hidden className="size-4" />
                </Button>
              </div>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-muted-foreground">Days</legend>
                <div className="grid grid-cols-7 gap-1">
                  {WEEKDAYS.map(({ day, short, long }) => {
                    const on = slot.days.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        aria-pressed={on}
                        aria-label={long}
                        onClick={() =>
                          changeSlot(slot.id, {
                            days: on ? slot.days.filter((d) => d !== day) : [...slot.days, day],
                          })
                        }
                        className={cn(
                          "h-10 rounded-md border text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                          on
                            ? "border-primary bg-primary text-primary-foreground"
                            : "bg-background text-muted-foreground",
                        )}
                      >
                        {short}
                      </button>
                    );
                  })}
                </div>
                {errors.days !== undefined && (
                  <p id={`days-${slot.id}`} className="text-destructive">
                    {errors.days}
                  </p>
                )}
              </fieldset>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-muted-foreground">Time</span>
                  <input
                    type="time"
                    required
                    value={slot.time}
                    aria-invalid={errors.time !== undefined}
                    aria-describedby={errors.time === undefined ? undefined : `time-${slot.id}`}
                    onChange={(event) => changeSlot(slot.id, { time: event.currentTarget.value })}
                    className="h-10 rounded-md border bg-background px-3 text-base aria-invalid:border-destructive md:text-sm"
                  />
                  {errors.time !== undefined && (
                    <span id={`time-${slot.id}`} className="text-destructive">
                      {errors.time}
                    </span>
                  )}
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-muted-foreground">Random spread</span>
                  <span className="flex items-center gap-2">
                    <input
                      inputMode="numeric"
                      pattern="[0-9]*"
                      placeholder="0"
                      value={slot.spreadText}
                      onChange={(event) => changeSlot(slot.id, { spreadText: event.currentTarget.value })}
                      className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-base aria-invalid:border-destructive md:text-sm"
                      aria-invalid={errors.spread !== undefined}
                      aria-describedby={`spread-${slot.id}`}
                    />
                    <span className="text-muted-foreground">min</span>
                  </span>
                </label>
              </div>
              <p
                id={`spread-${slot.id}`}
                className={
                  errors.spread === undefined ? "text-xs text-muted-foreground" : "text-xs text-destructive"
                }
              >
                {errors.spread !== undefined
                  ? `Random spread: ${errors.spread}`
                  : spread > 0
                    ? `Posts at a random time up to ${minutes(spread)} after ${slot.time || "its time"}.`
                    : `Posts at its time. With a spread (at most ${LIMITS.spreadMinutes} minutes), it posts up to that many minutes later, at random.`}
              </p>
            </li>
          );
        })}
      </ul>
      <Button
        variant="outline"
        className="self-start"
        onClick={() =>
          setDraft((current) => ({
            ...current,
            slots: [
              ...current.slots,
              { id: newSlotId(), days: [1, 2, 3, 4, 5, 6, 7], time: "18:00", spreadText: "" },
            ],
          }))
        }
      >
        <Plus aria-hidden className="size-4" />
        Add slot
      </Button>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Timezone</span>
          <select
            value={draft.timeZone}
            onChange={(event) => {
              const timeZone = event.currentTarget.value;
              setDraft((current) => ({ ...current, timeZone }));
            }}
            className="h-10 rounded-md border bg-background px-3 text-base md:text-sm"
          >
            {(zones.includes(draft.timeZone) ? zones : [draft.timeZone, ...zones]).map((zone) => (
              <option key={zone} value={zone}>
                {zone.replaceAll("_", " ")}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">Slot times are in this timezone.</span>
          {device !== draft.timeZone && (
            <Button
              variant="ghost"
              size="sm"
              className="self-start px-0 underline underline-offset-4 hover:bg-transparent"
              onClick={() => setDraft((current) => ({ ...current, timeZone: device }))}
            >
              Use this device's: {device.replaceAll("_", " ")}
            </Button>
          )}
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Grace period</span>
          <span className="flex items-center gap-2">
            <input
              inputMode="numeric"
              pattern="[0-9]*"
              value={draft.graceText}
              aria-invalid={parsed.errors.grace !== undefined}
              aria-describedby="grace-help"
              onChange={(event) => {
                const graceText = event.currentTarget.value;
                setDraft((current) => ({ ...current, graceText }));
              }}
              className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-base aria-invalid:border-destructive md:text-sm"
            />
            <span className="text-muted-foreground">min</span>
          </span>
          {parsed.errors.grace !== undefined && (
            <span className="text-destructive">Grace period: {parsed.errors.grace}</span>
          )}
          <span id="grace-help" className="text-xs text-muted-foreground">
            While Selects runs, every slot posts on time. A slot missed while it was down posts late only
            within this long, and only the latest; 0 never posts late. Up to {LIMITS.graceMinutes} minutes.
          </span>
        </label>
      </div>
      {parsed.schedule === undefined ? (
        <p role="status" className="text-sm text-destructive">
          Not saved until the fields marked above are fixed. Nothing changes on the server until then; to drop
          a slot, use its remove button.
        </p>
      ) : (
        <SaveStatus save={save} />
      )}
    </form>
  );
}

export function SaveStatus({ save }: { save: SaveState }) {
  return (
    <div role="status" className="min-h-5 text-sm text-muted-foreground">
      {save.state === "saving" && "Saving…"}
      {save.state === "saved" && "Saved."}
      {save.state === "failed" && (
        <span className="text-destructive">
          {save.problems.length > 0
            ? `Not saved. ${save.problems.join(" ")}`
            : "Couldn't save. Change something to try again."}
        </span>
      )}
    </div>
  );
}
