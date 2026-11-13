/**
 * Slot times: the one place wall-clock times in the install's timezone become instants. Pure, and
 * never the server's own zone: every function takes the timezone it works in.
 */

import { DAY } from "./clock";

/** ISO weekday: 1 is Monday, 7 is Sunday. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** One entry in the schedule. */
export type Slot = {
  id: string;
  days: Weekday[];
  /** `HH:MM`, 24-hour, in the install's timezone. */
  time: string;
  /** A random wait of up to this many minutes after the time. 0 for none. */
  spreadMinutes: number;
};

/** A slot on one day: `at` is its time that day, before any spread. */
export type Occurrence = { slotId: string; date: string; at: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (found === undefined) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, found);
  }
  return found;
}

/** The wall-clock time of an instant in a zone, as if it were UTC, in milliseconds. */
function wallClock(instant: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const { year = 0, month = 1, day = 1, hour = 0, minute = 0, second = 0 } = parts;
  return Date.UTC(year, month - 1, day, hour, minute, second) + (instant % 1000);
}

/** How far a zone's wall clock is ahead of UTC at an instant, in milliseconds. */
const offsetAt = (instant: number, timeZone: string) => wallClock(instant, timeZone) - instant;

/** True for an IANA timezone name this platform knows. */
export function isTimeZone(value: string): boolean {
  if (value === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** `YYYY-MM-DD` of an instant, in a zone. */
export function localDate(instant: number, timeZone: string): string {
  return new Date(wallClock(instant, timeZone)).toISOString().slice(0, 10);
}

/**
 * The instant a wall-clock time happens on a date in a zone. Daylight saving is handled as
 * Temporal's "compatible" choice: a time skipped as the clocks go forward happens as far past
 * the change as it would have been (02:30 becomes 03:30), and a time that happens twice as they
 * go back is the first of the two.
 */
export function zonedInstant(date: string, time: string, timeZone: string): number {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // The offsets either side of the date: a zone changes at most once in two days.
  const before = offsetAt(wall - DAY, timeZone);
  const after = offsetAt(wall + DAY, timeZone);
  const candidates = [wall - before, wall - after].filter(
    (instant) => wallClock(instant, timeZone) === wall,
  );
  // Two that match: the time happens twice, and the first is taken. None: it never happens.
  if (candidates.length > 0) return Math.min(...candidates);
  return wall - before;
}

/** ISO weekday of a `YYYY-MM-DD` date. */
function weekday(date: string): Weekday {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return (day === 0 ? 7 : day) as Weekday;
}

/** Every time a slot comes round with `from <= at < to`, in time order. */
export function occurrences(slots: readonly Slot[], timeZone: string, from: number, to: number): Occurrence[] {
  if (slots.length === 0 || to <= from) return [];
  const found: Occurrence[] = [];
  // A day either side, since a slot's local date may differ from UTC's.
  const last = localDate(to + DAY, timeZone);
  for (let date = localDate(from - DAY, timeZone); date <= last; date = nextDate(date)) {
    const day = weekday(date);
    for (const slot of slots) {
      if (!slot.days.includes(day)) continue;
      const at = zonedInstant(date, slot.time, timeZone);
      if (at >= from && at < to) found.push({ slotId: slot.id, date, at });
    }
  }
  return found.sort((a, b) => a.at - b.at || a.slotId.localeCompare(b.slotId));
}

function nextDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
}
