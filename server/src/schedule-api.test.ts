import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createApp } from "./app";
import { createCaptionStore } from "./caption-store";
import { createFakeClock, type FakeClock } from "./clock";
import { BucketSettings, loadConfig } from "./config";
import { openDatabase } from "./db";
import { createFakeBucket, FAKE_BUCKET_KEYS, type FakeBucket } from "./fake-bucket";
import { createFakeInstagram, type FakeInstagram } from "./fake-instagram";
import { type FixtureName, generateFixtures } from "./fixtures";
import { createInstagramApi } from "./instagram";
import { migrations } from "./migrations";

const TOKEN = "IGfake-schedule-api-token-0001";

let fixtureDir: string;
let fixtures: Record<FixtureName, string>;
beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), "selects-schedule-api-fixtures-"));
  fixtures = await generateFixtures(fixtureDir);
});
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

let dataDir: string;
let db: Database;
let clock: FakeClock;
let instagram: FakeInstagram;
let bucket: FakeBucket;
let app: ReturnType<typeof createApp>;
let bodies: string[];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "selects-schedule-api-"));
  db = openDatabase(dataDir, migrations);
  // Friday 2026-11-13, 09:00 UTC.
  clock = createFakeClock();
  instagram = createFakeInstagram({ clock });
  bucket = createFakeBucket();
  bodies = [];
  app = createApp({
    config: loadConfig({ DATA_DIR: dataDir }),
    db,
    webDir: join(dataDir, "no-ui"),
    instagram: createInstagramApi({ baseUrl: instagram.url }),
    fakeBucket: new BucketSettings(bucket.endpoint, bucket.name, "auto", undefined, FAKE_BUCKET_KEYS),
    clock,
  });
});
afterEach(async () => {
  await instagram.stop();
  await bucket.stop();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// biome-ignore lint/suspicious/noExplicitAny: each test's assertions check the body's shape.
type Body = any;

async function request(path: string, init?: RequestInit): Promise<{ status: number; body: Body }> {
  const response = await app.fetch(new Request(`http://selects.test${path}`, init));
  const text = await response.text();
  bodies.push(text);
  let body: Body = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: response.status, body };
}

const send = (method: string, path: string, body?: unknown) =>
  request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function addSelect(name: FixtureName): Promise<string> {
  const { body } = await request(`/api/uploads?name=${basename(fixtures[name])}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: readFileSync(fixtures[name]),
  });
  return body.select.id;
}

const NOON = { id: "noon", days: [1, 2, 3, 4, 5, 6, 7], time: "12:00", spreadMinutes: 0 };

describe("the schedule", () => {
  test("starts with no slots, in UTC, with two hours' grace, unpaused", async () => {
    const { status, body } = await request("/api/schedule");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      schedule: { slots: [], timeZone: "UTC", graceMinutes: 120 },
      paused: false,
      rules: { captureDay: { on: true, posts: 5 }, place: { on: false }, order: "random" },
      upcoming: [],
      history: [],
      nextSlotAt: null,
      problems: [],
    });
  });

  test("saves slots with days, a time and a spread, in a timezone, and shows next up", async () => {
    const id = await addSelect("portrait");
    const slot = { ...NOON, days: [5, 1], spreadMinutes: 30 };
    const { status, body } = await send("PUT", "/api/schedule", {
      slots: [slot],
      timeZone: "Europe/Berlin",
      graceMinutes: 90,
    });
    expect(status).toBe(200);
    expect(body.schedule).toEqual({
      slots: [{ ...slot, days: [1, 5] }],
      timeZone: "Europe/Berlin",
      graceMinutes: 90,
    });
    // Noon in Berlin on Friday is 11:00 UTC; the next post is due within the spread after it.
    expect(body.upcoming[0].slotAt).toBe(Date.parse("2026-11-13T11:00:00Z"));
    expect(body.nextSlotAt).toBe(body.upcoming[0].dueAt);
    expect(body.upcoming).toEqual([
      expect.objectContaining({
        slotId: "noon",
        date: "2026-11-13",
        state: "planned",
        selectId: id,
        picked: "pool",
      }),
    ]);
    expect(body.problems).toEqual(["No Instagram account is connected."]);
    expect(body.attention).toEqual([]);
  });

  test("shows a select that cannot be posted as needing attention, with why", async () => {
    const id = await addSelect("portrait");
    // The caption route refuses text over the limit, so it is written as the store holds it.
    createCaptionStore(db).setOverride(id, { caption: "x".repeat(2300), altText: null });
    await send("PUT", "/api/queue", { selectIds: [id] });
    const { body } = await request("/api/schedule");
    expect(body.attention).toEqual([
      { selectId: id, fileName: "portrait.jpg", problems: [expect.stringContaining("2,200")] },
    ]);
  });

  test("refuses a timezone that is not one, and a time that is not one", async () => {
    const zone = await send("PUT", "/api/schedule", {
      slots: [],
      timeZone: "Atlantis/Lost",
      graceMinutes: 120,
    });
    expect(zone.status).toBe(422);
    expect(zone.body.problems).toEqual(["Atlantis/Lost is not a timezone."]);
    const time = await send("PUT", "/api/schedule", {
      slots: [{ ...NOON, time: "25:00" }],
      timeZone: "UTC",
      graceMinutes: 120,
    });
    expect(time.status).toBe(422);
    // A slot's ID names its runs in a URL: only letters, digits, - and _.
    const id = await send("PUT", "/api/schedule", {
      slots: [{ ...NOON, id: "a/b" }],
      timeZone: "UTC",
      graceMinutes: 120,
    });
    expect(id.status).toBe(422);
    expect((await request("/api/schedule")).body.schedule.slots).toEqual([]);
  });

  test("the pause switch and the pick rules are saved", async () => {
    expect((await send("PUT", "/api/schedule/paused", { paused: true })).status).toBe(200);
    const rules = {
      captureDay: { on: false, posts: 3 },
      place: { on: true, km: 25, posts: 4 },
      order: "newest",
    };
    expect((await send("PUT", "/api/pick-rules", rules)).body).toEqual(rules);
    const { body } = await request("/api/schedule");
    expect(body.paused).toBe(true);
    expect(body.rules).toEqual(rules);
    for (const km of [-1, 0, 2.5, 20_001]) {
      const bad = await send("PUT", "/api/pick-rules", { ...rules, place: { on: true, km, posts: 4 } });
      expect(bad.status).toBe(422);
    }
  });

  test("next up can be swapped and skipped", async () => {
    const a = await addSelect("portrait");
    const b = await addSelect("landscape");
    const saved = await send("PUT", "/api/schedule", { slots: [NOON], timeZone: "UTC", graceMinutes: 120 });
    const chosen = saved.body.upcoming[0].selectId;
    const swapped = await send("POST", "/api/schedule/runs/noon_2026-11-13/swap");
    expect(swapped.status).toBe(200);
    expect(swapped.body.upcoming[0].selectId).toBe(chosen === a ? b : a);
    const skipped = await send("POST", "/api/schedule/runs/noon_2026-11-13/skip");
    expect(skipped.body.upcoming[0]).toMatchObject({ state: "skipped", selectId: null });
    const back = await send("POST", "/api/schedule/runs/noon_2026-11-13/unskip");
    expect(back.body.upcoming[0]).toMatchObject({ state: "planned" });
    expect([a, b]).toContain(back.body.upcoming[0].selectId);
    expect((await send("POST", "/api/schedule/runs/noon_2030-01-01/swap")).status).toBe(404);
    expect((await send("POST", "/api/schedule/runs/nonsense/skip")).status).toBe(404);
  });

  test("swapping with nothing else to choose says so", async () => {
    await addSelect("portrait");
    await send("PUT", "/api/schedule", { slots: [NOON], timeZone: "UTC", graceMinutes: 120 });
    const { status, body } = await send("POST", "/api/schedule/runs/noon_2026-11-13/swap");
    expect(status).toBe(409);
    expect(body.problems).toEqual(["Nothing else to choose: the queue and the pool hold no other select."]);
  });

  test("the scheduler posts through the app's publisher", async () => {
    instagram.addAccount(TOKEN, { userId: "1784140001", username: "selects_test" });
    await send("PUT", "/api/instagram/token", { token: TOKEN });
    const id = await addSelect("portrait");
    await send("PUT", "/api/schedule", { slots: [NOON], timeZone: "UTC", graceMinutes: 120 });
    clock.advance(Date.parse("2026-11-13T12:00:00Z") - clock.now());
    await app.scheduler.tick();
    await app.publisher.settled();
    const { body } = await request("/api/schedule");
    expect(body.history[0]).toMatchObject({ state: "posted", selectId: id });
    expect((await request("/api/posts")).body.posts[0].state).toBe("published");
    expect(bodies.join("\n")).not.toContain(TOKEN);
  });
});

describe("the queue", () => {
  test("is set in order, holds only selects in the pool, and lists the rest of the pool", async () => {
    const a = await addSelect("portrait");
    const b = await addSelect("landscape");
    const c = await addSelect("square");
    const { status, body } = await send("PUT", "/api/queue", { selectIds: [c, "no-such-select", a] });
    expect(status).toBe(200);
    expect(body.queue.map((select: Body) => select.id)).toEqual([c, a]);
    expect(body.pool.map((select: Body) => select.id)).toEqual([b]);
    const reordered = await send("PUT", "/api/queue", { selectIds: [a, c] });
    expect(reordered.body.queue.map((select: Body) => select.id)).toEqual([a, c]);
    expect((await request("/api/queue")).body.queue.map((select: Body) => select.id)).toEqual([a, c]);
  });

  test("a deleted select leaves it", async () => {
    const a = await addSelect("portrait");
    const b = await addSelect("landscape");
    await send("PUT", "/api/queue", { selectIds: [a, b] });
    await send("DELETE", `/api/selects/${a}`);
    expect((await request("/api/queue")).body.queue.map((select: Body) => select.id)).toEqual([b]);
  });
});
