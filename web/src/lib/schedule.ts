import type { PickRules, Run, Schedule, Weekday } from "@selects/server";

/** Monday first, as the server numbers them (ISO: 1 is Monday). */
export const WEEKDAYS: { day: Weekday; short: string; long: string }[] = [
  { day: 1, short: "Mon", long: "Monday" },
  { day: 2, short: "Tue", long: "Tuesday" },
  { day: 3, short: "Wed", long: "Wednesday" },
  { day: 4, short: "Thu", long: "Thursday" },
  { day: 5, short: "Fri", long: "Friday" },
  { day: 6, short: "Sat", long: "Saturday" },
  { day: 7, short: "Sun", long: "Sunday" },
];

/** What the server accepts: `SCHEDULE_LIMITS` and `PICK_RULE_LIMITS` on the server. */
export const LIMITS = { spreadMinutes: 720, graceMinutes: 24 * 60, posts: 50, km: 20_000 } as const;

/** A slot as the editor holds it: the spread as typed. */
export type SlotDraft = { id: string; days: number[]; time: string; spreadText: string };
export type ScheduleDraft = { slots: SlotDraft[]; timeZone: string; graceText: string };

type Parsed = { ok: true; value: number } | { ok: false; problem: string };

/**
 * A whole number typed in a field, within bounds. Anything else ("1,000", "1.5", "1e2") is a
 * problem, never read as some other number. `empty` is what an empty field stands for, if anything.
 */
export function wholeNumber(text: string, bounds: { min: number; max: number; empty?: number }): Parsed {
  const trimmed = text.trim();
  if (trimmed === "" && bounds.empty !== undefined) return { ok: true, value: bounds.empty };
  const value = Number(trimmed);
  if (/^\d+$/.test(trimmed) && value >= bounds.min && value <= bounds.max) return { ok: true, value };
  return {
    ok: false,
    problem: `A whole number from ${bounds.min.toLocaleString("en-US")} to ${bounds.max.toLocaleString("en-US")}.`,
  };
}

export type ScheduleErrors = {
  grace?: string;
  slots: Record<string, { days?: string; time?: string; spread?: string }>;
};

/**
 * The schedule to save: every whole field as typed, and for a field that is not whole what was
 * last saved, so an edit elsewhere still saves. A slot with no day or no time, or a number out of
 * bounds, keeps its saved version; a new one is left out until it is whole. A slot is only ever
 * removed by its remove button, never by being left incomplete. `complete` is false while any
 * field is not whole.
 */
export function parseSchedule(
  draft: ScheduleDraft,
  saved: Schedule,
): { schedule: Schedule; complete: boolean; errors: ScheduleErrors } {
  const errors: ScheduleErrors = { slots: {} };
  const slots: Schedule["slots"] = [];
  for (const slot of draft.slots) {
    const slotErrors: ScheduleErrors["slots"][string] = {};
    if (slot.days.length === 0) slotErrors.days = "Pick at least one day.";
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.time)) slotErrors.time = "Set a time.";
    const spread = wholeNumber(slot.spreadText, { min: 0, max: LIMITS.spreadMinutes, empty: 0 });
    if (!spread.ok) slotErrors.spread = spread.problem;
    if (Object.keys(slotErrors).length > 0 || !spread.ok) {
      errors.slots[slot.id] = slotErrors;
      const before = saved.slots.find((s) => s.id === slot.id);
      if (before !== undefined) slots.push(before);
    } else
      slots.push({
        id: slot.id,
        days: [...new Set(slot.days)].sort() as Weekday[],
        time: slot.time,
        spreadMinutes: spread.value,
      });
  }
  const grace = wholeNumber(draft.graceText, { min: 0, max: LIMITS.graceMinutes });
  if (!grace.ok) errors.grace = grace.problem;
  return {
    schedule: { slots, timeZone: draft.timeZone, graceMinutes: grace.ok ? grace.value : saved.graceMinutes },
    complete: grace.ok && Object.keys(errors.slots).length === 0,
    errors,
  };
}

export function toDraft(schedule: Schedule): ScheduleDraft {
  return {
    slots: schedule.slots.map((slot) => ({
      id: slot.id,
      days: slot.days,
      time: slot.time,
      spreadText: slot.spreadMinutes === 0 ? "" : String(slot.spreadMinutes),
    })),
    timeZone: schedule.timeZone,
    graceText: String(schedule.graceMinutes),
  };
}

/** The pick rules as the editor holds them: the numbers as typed. */
export type PickRulesDraft = {
  captureDay: { on: boolean; posts: string };
  place: { on: boolean; km: string; posts: string };
  order: PickRules["order"];
};

export type PickRulesErrors = { captureDayPosts?: string; placeKm?: string; placePosts?: string };

export function toRulesDraft(rules: PickRules): PickRulesDraft {
  return {
    captureDay: { on: rules.captureDay.on, posts: String(rules.captureDay.posts) },
    place: { on: rules.place.on, km: String(rules.place.km), posts: String(rules.place.posts) },
    order: rules.order,
  };
}

/**
 * The rules to save: each number as typed while whole and within bounds, and otherwise the number
 * last saved, so the other edits still save. A rule switched off keeps the numbers last saved, so
 * a field it greys out is never in error. `complete` is false while a number is in error.
 */
export function parsePickRules(
  draft: PickRulesDraft,
  saved: PickRules,
): { rules: PickRules; complete: boolean; errors: PickRulesErrors } {
  const errors: PickRulesErrors = {};
  const field = (on: boolean, text: string, max: number, fallback: number, key: keyof PickRulesErrors) => {
    if (!on) return fallback;
    const parsed = wholeNumber(text, { min: 1, max });
    if (parsed.ok) return parsed.value;
    errors[key] = parsed.problem;
    return fallback;
  };
  const rules: PickRules = {
    captureDay: {
      on: draft.captureDay.on,
      posts: field(
        draft.captureDay.on,
        draft.captureDay.posts,
        LIMITS.posts,
        saved.captureDay.posts,
        "captureDayPosts",
      ),
    },
    place: {
      on: draft.place.on,
      km: field(draft.place.on, draft.place.km, LIMITS.km, saved.place.km, "placeKm"),
      posts: field(draft.place.on, draft.place.posts, LIMITS.posts, saved.place.posts, "placePosts"),
    },
    order: draft.order,
  };
  return { rules, complete: Object.keys(errors).length === 0, errors };
}

/** "1 minute", "15 minutes". */
export function minutes(count: number): string {
  return `${count} ${count === 1 ? "minute" : "minutes"}`;
}

/** The list with the item at `from` moved to `to`, clamped to the ends. */
export function move<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item === undefined) return next;
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}

/** A slot's time, in the install's timezone: "Fri 13 Nov, 18:30". */
export function slotTime(at: number, timeZone: string, locale?: string): string {
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("weekday")} ${part("day")} ${part("month")}, ${part("hour")}:${part("minute")}`;
}

/** What became of a slot, in words: for one that posted, what became of its post. */
export function describeRun(run: Pick<Run, "state" | "note" | "post">): {
  label: string;
  detail: string | null;
} {
  if (run.state === "posted" && run.post !== null) {
    const { state, error } = run.post;
    switch (state) {
      case "publishing":
        return { label: "Posting…", detail: null };
      case "retrying":
        return { label: "Retrying", detail: error };
      case "unconfirmed":
        return { label: "Needs checking", detail: error ?? "Instagram has not said whether it posted it." };
      case "failed":
        return {
          label: "Failed",
          detail: `${error ?? "It could not be posted."} The select is back where it was.`,
        };
      case "published":
      case "dry-run":
        return { label: "Posted", detail: run.note };
    }
  }
  const labels: Record<Run["state"], string> = {
    planned: "To come",
    skipped: "Skipped",
    posting: "Posting…",
    posted: "Sent to post",
    "dry-run": "Dry run",
    missed: "Missed",
    late: "Found late",
    paused: "Paused",
    empty: "Nothing to post",
    unavailable: "Not posted",
    failed: "Not posted",
  };
  return { label: labels[run.state], detail: run.note };
}

/** Every IANA timezone this browser knows, with UTC. */
export function timeZones(): string[] {
  const known = Intl.supportedValuesOf?.("timeZone") ?? [];
  return known.includes("UTC") ? known : ["UTC", ...known];
}

/** This device's timezone, to suggest. */
export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
