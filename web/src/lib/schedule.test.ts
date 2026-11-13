import { describe, expect, test } from "bun:test";
import { describeRun, move, slotTime, toSchedule } from "./schedule";

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

describe("toSchedule", () => {
  test("sends only slots with a day and a time, with the spread as a whole number", () => {
    const draft = {
      slots: [
        { id: "a", days: [3, 1], time: "18:30", spreadText: "15" },
        { id: "b", days: [], time: "09:00", spreadText: "" },
        { id: "c", days: [2], time: "", spreadText: "" },
        { id: "d", days: [7], time: "07:05", spreadText: "abc" },
      ],
      timeZone: "Europe/Berlin",
      graceText: "90",
    };
    expect(toSchedule(draft)).toEqual({
      slots: [
        { id: "a", days: [1, 3], time: "18:30", spreadMinutes: 15 },
        { id: "d", days: [7], time: "07:05", spreadMinutes: 0 },
      ],
      timeZone: "Europe/Berlin",
      graceMinutes: 90,
    });
  });

  test("an empty grace period is the default two hours", () => {
    expect(toSchedule({ slots: [], timeZone: "UTC", graceText: "" }).graceMinutes).toBe(120);
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
    expect(describeRun({ state: "unavailable", note: "No Instagram account is connected." })).toEqual({
      label: "Not posted",
      detail: "No Instagram account is connected.",
    });
    expect(describeRun({ state: "posted", note: null }).label).toBe("Posted");
    expect(describeRun({ state: "missed", note: "Selects was not running at its time." }).label).toBe(
      "Missed",
    );
  });
});
