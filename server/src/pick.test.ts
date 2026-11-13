import { describe, expect, test } from "bun:test";
import { type Candidate, DEFAULT_PICK_RULES, type PickRules, pick } from "./pick";

// Invented points in the open Pacific: A and B are about 5.6 km apart, FAR is over 1,000 km away.
const A = { latitude: 0.5, longitude: -150 };
const B = { latitude: 0.55, longitude: -150 };
const FAR = { latitude: 10, longitude: -150 };

const select = (
  id: string,
  capturedAt: string | null,
  location: Candidate["location"] = null,
): Candidate => ({
  id,
  capturedAt,
  location,
});

const rules = (change: Partial<PickRules> = {}): PickRules => ({ ...DEFAULT_PICK_RULES, ...change });
/** Always the first eligible select, in whatever order the rule gives. */
const first = () => 0;

describe("the queue", () => {
  test("drains first, in order, ignoring the pick rules", () => {
    // Q1 was taken the same day as the last post: the rules would refuse it from the pool.
    const recent = [select("posted", "2026-05-01T10:00:00")];
    const pool = [
      select("P1", "2026-06-01T10:00:00"),
      select("Q2", null),
      select("Q1", "2026-05-01T18:00:00"),
    ];
    const found = pick({ queue: ["Q1", "Q2"], pool, recent, rules: rules(), random: first });
    expect(found).toEqual({ selectId: "Q1", from: "queue", relaxed: [] });
  });

  test("passes over selects excluded for this pick", () => {
    const pool = [select("Q1", null), select("Q2", null)];
    const found = pick({
      queue: ["Q1", "Q2"],
      pool,
      recent: [],
      rules: rules(),
      random: first,
      exclude: new Set(["Q1"]),
    });
    expect(found?.selectId).toBe("Q2");
  });

  test("with every queued select excluded, the pool is next", () => {
    const pool = [select("P1", null), select("Q1", null)];
    const found = pick({
      queue: ["Q1"],
      pool,
      recent: [],
      rules: rules(),
      random: first,
      exclude: new Set(["Q1"]),
    });
    expect(found).toEqual({ selectId: "P1", from: "pool", relaxed: [] });
  });
});

describe("the pool", () => {
  test("nothing to pick from is no pick", () => {
    expect(pick({ queue: [], pool: [], recent: [], rules: rules(), random: first })).toBeUndefined();
  });

  test("spacing by capture day leaves out the days of the last N posts", () => {
    const recent = ["01", "02", "03", "04", "05", "06"].map((day, n) =>
      select(`posted${n}`, `2026-05-${day}T12:00:00`),
    );
    const pool = [
      select("same-as-newest", "2026-05-01T23:59:00"),
      select("same-as-fifth", "2026-05-05T08:00:00"),
      select("same-as-sixth", "2026-05-06T08:00:00"),
    ];
    const found = pick({ queue: [], pool, recent, rules: rules(), random: first });
    // The sixth latest post is beyond the default five.
    expect(found).toEqual({ selectId: "same-as-sixth", from: "pool", relaxed: [] });
  });

  test("a select with no capture date passes spacing by capture day", () => {
    const recent = [select("posted", "2026-05-01T12:00:00")];
    const pool = [select("same-day", "2026-05-01T09:00:00"), select("undated", null)];
    expect(pick({ queue: [], pool, recent, rules: rules(), random: first })?.selectId).toBe("undated");
  });

  test("spacing by capture day can be switched off and tuned", () => {
    const recent = [select("newest", "2026-05-01T12:00:00"), select("older", "2026-05-02T12:00:00")];
    const pool = [select("day1", "2026-05-01T09:00:00"), select("day2", "2026-05-02T09:00:00")];
    const off = rules({ captureDay: { on: false, posts: 5 } });
    expect(pick({ queue: [], pool, recent, rules: off, random: first })?.selectId).toBe("day1");
    const lastOne = rules({ captureDay: { on: true, posts: 1 } });
    expect(pick({ queue: [], pool, recent, rules: lastOne, random: first })?.selectId).toBe("day2");
  });

  test("spacing by place is off by default", () => {
    const recent = [select("posted", null, A)];
    const pool = [select("near", null, B)];
    expect(pick({ queue: [], pool, recent, rules: rules(), random: first })?.selectId).toBe("near");
  });

  test("spacing by place leaves out selects within X km of the last N posts", () => {
    const recent = [select("posted", null, A)];
    const pool = [select("near", null, B), select("far", null, FAR), select("nowhere", null)];
    const place = (km: number) => rules({ place: { on: true, km, posts: 5 } });
    expect(pick({ queue: [], pool, recent, rules: place(10), random: first })?.selectId).toBe("far");
    // Five kilometres is closer than the two are.
    expect(pick({ queue: [], pool, recent, rules: place(5), random: first })?.selectId).toBe("near");
    // A select with no location passes.
    const noFar = pool.filter((c) => c.id !== "far");
    expect(pick({ queue: [], pool: noFar, recent, rules: place(10), random: first })?.selectId).toBe(
      "nowhere",
    );
  });

  test("order: oldest first and newest first go by capture time, undated last", () => {
    const pool = [
      select("undated", null),
      select("2024", "2024-01-01T00:00:00"),
      select("2025", "2025-01-01T00:00:00"),
      select("2023", "2023-01-01T00:00:00"),
    ];
    const order = (o: PickRules["order"]) =>
      pick({ queue: [], pool, recent: [], rules: rules({ order: o }), random: first })?.selectId;
    expect(order("oldest")).toBe("2023");
    expect(order("newest")).toBe("2025");
    const undatedOnly = [select("u1", null), select("u2", null)];
    expect(
      pick({ queue: [], pool: undatedOnly, recent: [], rules: rules({ order: "oldest" }), random: first })
        ?.selectId,
    ).toBe("u1");
  });

  test("order: random takes the injected random source", () => {
    const pool = [select("P1", null), select("P2", null), select("P3", null)];
    const at = (n: number) =>
      pick({ queue: [], pool, recent: [], rules: rules(), random: () => n })?.selectId;
    expect(at(0)).toBe("P1");
    expect(at(0.5)).toBe("P2");
    expect(at(0.999)).toBe("P3");
  });
});

describe("relaxing", () => {
  test("a rule that would leave nothing to pick is relaxed", () => {
    const recent = [select("posted", "2026-05-01T12:00:00")];
    const pool = [select("same-day", "2026-05-01T09:00:00")];
    expect(pick({ queue: [], pool, recent, rules: rules(), random: first })).toEqual({
      selectId: "same-day",
      from: "pool",
      relaxed: ["captureDay"],
    });
  });

  test("spacing by place is relaxed before spacing by capture day", () => {
    const recent = [select("posted", "2026-05-01T12:00:00", A)];
    // Each passes one rule only: relaxing place keeps the day rule.
    const pool = [
      select("near-other-day", "2026-05-02T09:00:00", B),
      select("far-same-day", "2026-05-01T09:00:00", FAR),
    ];
    const both = rules({ place: { on: true, km: 10, posts: 5 } });
    expect(pick({ queue: [], pool, recent, rules: both, random: first })).toEqual({
      selectId: "near-other-day",
      from: "pool",
      relaxed: ["place"],
    });
    // With only the day rule's fail left, capture day is relaxed and place kept.
    const onlyFar = [pool[1] as Candidate];
    expect(pick({ queue: [], pool: onlyFar, recent, rules: both, random: first })?.relaxed).toEqual([
      "captureDay",
    ]);
    // And when neither can hold, both are.
    const near = [select("near-same-day", "2026-05-01T09:00:00", B)];
    expect(pick({ queue: [], pool: near, recent, rules: both, random: first })?.relaxed).toEqual([
      "place",
      "captureDay",
    ]);
  });
});
