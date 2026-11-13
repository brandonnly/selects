import { describe, expect, test } from "bun:test";
import { isTimeZone, localDate, occurrenceOn, occurrences, type Slot, zonedInstant } from "./slots";

const at = (iso: string) => Date.parse(iso);
const daily = (time: string, id = "a"): Slot => ({ id, days: [1, 2, 3, 4, 5, 6, 7], time, spreadMinutes: 0 });

describe("slot times", () => {
  test("a slot's time is a wall-clock time in the install's timezone", () => {
    // 09:00 in Tokyo (UTC+9, no daylight saving) is midnight UTC.
    expect(zonedInstant("2026-11-16", "09:00", "Asia/Tokyo")).toBe(at("2026-11-16T00:00:00Z"));
    // And in New York in November (UTC-5).
    expect(zonedInstant("2026-11-16", "09:00", "America/New_York")).toBe(at("2026-11-16T14:00:00Z"));
  });

  test("a slot runs only on its days of the week", () => {
    // Monday and Thursday at 18:30, UTC. 2026-11-16 is a Monday.
    const slot: Slot = { id: "mon-thu", days: [1, 4], time: "18:30", spreadMinutes: 0 };
    const found = occurrences([slot], "UTC", at("2026-11-16T00:00:00Z"), at("2026-11-23T00:00:00Z"));
    expect(found).toEqual([
      { slotId: "mon-thu", date: "2026-11-16", at: at("2026-11-16T18:30:00Z") },
      { slotId: "mon-thu", date: "2026-11-19", at: at("2026-11-19T18:30:00Z") },
    ]);
  });

  test("with no slots there is nothing", () => {
    expect(occurrences([], "UTC", at("2026-11-16T00:00:00Z"), at("2026-12-16T00:00:00Z"))).toEqual([]);
  });

  test("occurrences of several slots come in time order, within the range only", () => {
    const found = occurrences(
      [daily("20:00", "evening"), daily("08:00", "morning")],
      "UTC",
      at("2026-11-16T12:00:00Z"),
      at("2026-11-17T12:00:00Z"),
    );
    expect(found.map((o) => `${o.slotId} ${o.date}`)).toEqual(["evening 2026-11-16", "morning 2026-11-17"]);
  });

  test("weekdays are the install's, not UTC's", () => {
    // Monday 07:00 in Tokyo is Sunday 22:00 UTC.
    const slot: Slot = { id: "monday", days: [1], time: "07:00", spreadMinutes: 0 };
    const found = occurrences([slot], "Asia/Tokyo", at("2026-11-15T00:00:00Z"), at("2026-11-16T00:00:00Z"));
    expect(found).toEqual([{ slotId: "monday", date: "2026-11-16", at: at("2026-11-15T22:00:00Z") }]);
  });

  test("the local date of an instant is the install's", () => {
    expect(localDate(at("2026-11-15T22:00:00Z"), "Asia/Tokyo")).toBe("2026-11-16");
    expect(localDate(at("2026-11-15T22:00:00Z"), "UTC")).toBe("2026-11-15");
  });
});

describe("daylight saving", () => {
  // In New York, 2026-03-08 jumps from 02:00 to 03:00, and 2026-11-01 goes from 02:00 back to 01:00.
  const NY = "America/New_York";

  test("a time that does not exist on the spring-forward day posts once, as the clocks go forward", () => {
    // 02:30 never happens that day: it posts at 03:30 EDT, as far past the change as 02:30 is.
    expect(zonedInstant("2026-03-08", "02:30", NY)).toBe(at("2026-03-08T07:30:00Z"));
    const found = occurrences([daily("02:30")], NY, at("2026-03-07T00:00:00Z"), at("2026-03-10T00:00:00Z"));
    expect(found).toEqual([
      { slotId: "a", date: "2026-03-07", at: at("2026-03-07T07:30:00Z") },
      { slotId: "a", date: "2026-03-08", at: at("2026-03-08T07:30:00Z") },
      { slotId: "a", date: "2026-03-09", at: at("2026-03-09T06:30:00Z") },
    ]);
  });

  test("a time that happens twice on the fall-back day posts once, the first time", () => {
    expect(zonedInstant("2026-11-01", "01:30", NY)).toBe(at("2026-11-01T05:30:00Z"));
    const found = occurrences([daily("01:30")], NY, at("2026-10-31T00:00:00Z"), at("2026-11-03T00:00:00Z"));
    expect(found).toEqual([
      { slotId: "a", date: "2026-10-31", at: at("2026-10-31T05:30:00Z") },
      { slotId: "a", date: "2026-11-01", at: at("2026-11-01T05:30:00Z") },
      { slotId: "a", date: "2026-11-02", at: at("2026-11-02T06:30:00Z") },
    ]);
  });

  test("a zone that changes at another hour keeps every other time", () => {
    // Central Europe goes forward at 02:00 on 2026-03-29: 09:00 that day is UTC+2.
    expect(zonedInstant("2026-03-29", "09:00", "Europe/Berlin")).toBe(at("2026-03-29T07:00:00Z"));
    expect(zonedInstant("2026-03-28", "09:00", "Europe/Berlin")).toBe(at("2026-03-28T08:00:00Z"));
  });
});

describe("timezones", () => {
  test("only IANA names are timezones", () => {
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Europe/Berlin")).toBe(true);
    expect(isTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isTimeZone("")).toBe(false);
  });
});

describe("occurrenceOn", () => {
  test("is a slot's time on a local date, or nothing on a day it does not run", () => {
    const mondays: Slot = { id: "m", days: [1], time: "09:00", spreadMinutes: 0 };
    expect(occurrenceOn(mondays, "2026-11-16", "Asia/Tokyo")).toBe(at("2026-11-16T00:00:00Z"));
    expect(occurrenceOn(mondays, "2026-11-17", "Asia/Tokyo")).toBeUndefined();
  });
});
