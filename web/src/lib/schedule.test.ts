import { describe, expect, test } from "bun:test";
import { describeRun, minutes, move, parsePickRules, parseSchedule, slotTime, wholeNumber } from "./schedule";

describe("move", () => {
  test("moves an item to a new place, keeping the rest in order", () => {
    expect(move(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(move(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
  });

  test("a place past either end is the end", () => {
    expect(move(["a", "b", "c"], 1, -4)).toEqual(["b", "a", "c"]);
    expect(move(["a", "b", "c"], 1, 9)).toEqual(["a", "c", "b"]);
  });
});

describe("wholeNumber", () => {
  const bounds = { min: 1, max: 1000 };

  test("takes digits within the bounds", () => {
    expect(wholeNumber(" 42 ", bounds)).toEqual({ ok: true, value: 42 });
    expect(wholeNumber("1000", bounds)).toEqual({ ok: true, value: 1000 });
  });

  test("refuses anything else, and never reads it as another number", () => {
    for (const text of ["1,000", "1.5", "1e2", "-3", "0", "1001", "abc", "", "0x10"]) {
      const parsed = wholeNumber(text, bounds);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.problem).toBe("A whole number from 1 to 1,000.");
    }
  });

  test("an empty field can stand for a value", () => {
    expect(wholeNumber("", { min: 0, max: 720, empty: 0 })).toEqual({ ok: true, value: 0 });
  });
});

describe("parseSchedule", () => {
  const draft = {
    slots: [
      { id: "a", days: [3, 1], time: "18:30", spreadText: "15" },
      { id: "d", days: [7], time: "07:05", spreadText: "" },
    ],
    timeZone: "Europe/Berlin",
    graceText: "90",
  };

  test("is the schedule to save when every field is whole", () => {
    expect(parseSchedule(draft, saved)).toEqual({
      complete: true,
      schedule: {
        slots: [
          { id: "a", days: [1, 3], time: "18:30", spreadMinutes: 15 },
          { id: "d", days: [7], time: "07:05", spreadMinutes: 0 },
        ],
        timeZone: "Europe/Berlin",
        graceMinutes: 90,
      },
      errors: { slots: {} },
    });
  });

  const saved = {
    slots: [
      { id: "a", days: [1, 3], time: "18:30", spreadMinutes: 15 },
      { id: "d", days: [7], time: "07:05", spreadMinutes: 0 },
    ],
    timeZone: "Europe/Berlin",
    graceMinutes: 90,
  } as never;

  test("a slot with its last day or its time cleared keeps what was saved for it, never drops it", () => {
    // Slot d's new time is saved; slot a stays as it was saved until it is whole again.
    const noDay = parseSchedule(
      {
        ...draft,
        slots: [
          { ...draft.slots[0], days: [] },
          { ...draft.slots[1], time: "08:00" },
        ],
      } as never,
      saved,
    );
    expect(noDay.complete).toBe(false);
    expect(noDay.errors.slots.a?.days).toBe("Pick at least one day.");
    expect(noDay.schedule.slots).toEqual([
      { id: "a", days: [1, 3], time: "18:30", spreadMinutes: 15 },
      { id: "d", days: [7], time: "08:00", spreadMinutes: 0 },
    ]);
    const noTime = parseSchedule(
      { ...draft, slots: [{ ...draft.slots[0], time: "" }, draft.slots[1]] } as never,
      saved,
    );
    expect(noTime.complete).toBe(false);
    expect(noTime.errors.slots.a?.time).toBe("Set a time.");
    expect(noTime.schedule.slots[0]).toEqual({ id: "a", days: [1, 3], time: "18:30", spreadMinutes: 15 });
  });

  test("a new slot is left out until it is whole: it starts with no days", () => {
    const added = parseSchedule(
      { ...draft, slots: [...draft.slots, { id: "new", days: [], time: "18:00", spreadText: "" }] } as never,
      saved,
    );
    expect(added.complete).toBe(false);
    expect(added.schedule.slots.map((slot) => slot.id)).toEqual(["a", "d"]);
  });

  test("a spread or grace period that is not a whole number within bounds is a field error", () => {
    const spread = parseSchedule(
      { ...draft, slots: [{ ...draft.slots[0], spreadText: "1.5" }] } as never,
      saved,
    );
    expect(spread.complete).toBe(false);
    expect(spread.errors.slots.a?.spread).toBe("A whole number from 0 to 720.");
    expect(spread.schedule.slots[0]?.spreadMinutes).toBe(15);
    for (const graceText of ["", "1e2", "1,000", "1441"]) {
      // The timezone changed alongside: it is saved; the grace period keeps what was saved.
      const grace = parseSchedule({ ...draft, timeZone: "Asia/Tokyo", graceText }, saved);
      expect(grace.complete).toBe(false);
      expect(grace.errors.grace).toBe("A whole number from 0 to 1,440.");
      expect(grace.schedule).toMatchObject({ timeZone: "Asia/Tokyo", graceMinutes: 90 });
    }
    expect(parseSchedule({ ...draft, graceText: "0" }, saved).schedule.graceMinutes).toBe(0);
  });
});

describe("parsePickRules", () => {
  const saved = {
    captureDay: { on: true, posts: 5 },
    place: { on: false, km: 10, posts: 5 },
    order: "random",
  } as const;
  const draft = {
    captureDay: { on: true, posts: "3" },
    place: { on: true, km: "25", posts: "4" },
    order: "oldest" as const,
  };

  test("is the rules to save when every number is whole and within bounds", () => {
    expect(parsePickRules(draft, saved)).toEqual({
      rules: { captureDay: { on: true, posts: 3 }, place: { on: true, km: 25, posts: 4 }, order: "oldest" },
      complete: true,
      errors: {},
    });
  });

  test("a number out of bounds is a field error and keeps what was saved; the other edits save", () => {
    for (const posts of ["0", "51", "1.5"]) {
      const parsed = parsePickRules({ ...draft, captureDay: { on: true, posts } }, saved);
      expect(parsed.complete).toBe(false);
      expect(parsed.errors.captureDayPosts).toBe("A whole number from 1 to 50.");
      expect(parsed.rules).toEqual({
        captureDay: { on: true, posts: 5 },
        place: { on: true, km: 25, posts: 4 },
        order: "oldest",
      });
    }
    const km = parsePickRules({ ...draft, place: { ...draft.place, km: "20001" } }, saved);
    expect(km.errors.placeKm).toBe("A whole number from 1 to 20,000.");
  });

  test("a switched-off rule keeps its saved numbers, so it never blocks a save", () => {
    const parsed = parsePickRules({ ...draft, place: { on: false, km: "1e9", posts: "" } }, saved);
    expect(parsed.rules?.place).toEqual({ on: false, km: 10, posts: 5 });
  });
});

describe("minutes", () => {
  test("says one minute, or several", () => {
    expect(minutes(1)).toBe("1 minute");
    expect(minutes(15)).toBe("15 minutes");
  });
});

describe("slotTime", () => {
  test("is shown in the install's timezone, whatever the device's", () => {
    // 09:30 UTC is 18:30 in Tokyo.
    expect(slotTime(Date.parse("2026-11-13T09:30:00Z"), "Asia/Tokyo", "en-GB")).toBe("Fri 13 Nov, 18:30");
  });
});

describe("describeRun", () => {
  test("says what became of each slot", () => {
    expect(
      describeRun({ state: "unavailable", note: "No Instagram account is connected.", post: null }),
    ).toEqual({
      label: "Not posted",
      detail: "No Instagram account is connected.",
    });
    expect(
      describeRun({ state: "missed", note: "Selects was not running at its time.", post: null }).label,
    ).toBe("Missed");
  });

  test("follows a slot's post to the end, never a bare Posted for one that failed", () => {
    const posted = (
      state: "publishing" | "retrying" | "unconfirmed" | "published" | "failed",
      error: string | null,
    ) => describeRun({ state: "posted", note: null, post: { state, error } });
    expect(posted("published", null).label).toBe("Posted");
    expect(posted("publishing", null).label).toBe("Posting…");
    expect(posted("retrying", "Instagram did not answer.")).toEqual({
      label: "Retrying",
      detail: "Instagram did not answer.",
    });
    expect(posted("unconfirmed", null).label).toBe("Needs checking");
    expect(posted("failed", "The image was refused.")).toEqual({
      label: "Failed",
      detail: "The image was refused. The select is back where it was.",
    });
  });
});
