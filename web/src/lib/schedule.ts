import type { Run, Schedule, Weekday } from "@selects/server";

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

export const DEFAULT_GRACE_MINUTES = 120;

/** A slot as the editor holds it: the spread as typed. */
export type SlotDraft = { id: string; days: number[]; time: string; spreadText: string };
export type ScheduleDraft = { slots: SlotDraft[]; timeZone: string; graceText: string };

const wholeNumber = (text: string, fallback: number) => {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : fallback;
};

/** The schedule to save: a slot with no day or no time yet is left out until it has both. */
export function toSchedule(draft: ScheduleDraft): Schedule {
  return {
    slots: draft.slots
      .filter((slot) => slot.days.length > 0 && /^\d{2}:\d{2}$/.test(slot.time))
      .map((slot) => ({
        id: slot.id,
        days: [...slot.days].sort() as Weekday[],
        time: slot.time,
        spreadMinutes: wholeNumber(slot.spreadText, 0),
      })),
    timeZone: draft.timeZone,
    graceMinutes: wholeNumber(draft.graceText, DEFAULT_GRACE_MINUTES),
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

/** What became of a slot, in words. */
export function describeRun(run: Pick<Run, "state" | "note">): { label: string; detail: string | null } {
  const labels: Record<Run["state"], string> = {
    planned: "To come",
    skipped: "Skipped",
    posting: "Posting…",
    posted: "Posted",
    "dry-run": "Dry run",
    missed: "Missed",
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
