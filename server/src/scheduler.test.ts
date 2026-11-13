import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createBucket } from "./bucket";
import { createCaptionStore } from "./caption-store";
import { createCaptures } from "./capture";
import { createFakeClock, DAY, type FakeClock, HOUR, MINUTE } from "./clock";
import { BucketSettings } from "./config";
import { openDatabase } from "./db";
import { createFakeBucket, FAKE_BUCKET_KEYS, type FakeBucket } from "./fake-bucket";
import { createFakeInstagram, type FakeInstagram } from "./fake-instagram";
import { type FixtureName, generateFixtures } from "./fixtures";
import { createFrameRenderer } from "./frame";
import { createInstagramApi, type InstagramApi } from "./instagram";
import { createInstagramAccount } from "./instagram-account";
import { createLibrary, type Library } from "./library";
import { migrations } from "./migrations";
import { createPublisher, type Publisher } from "./publisher";
import { createScheduler, type Scheduler } from "./scheduler";
import { createSettings } from "./settings";
import type { Slot } from "./slots";
import { createZones } from "./zones";

const TOKEN = "IGfake-scheduler-token-0001";

let fixtureDir: string;
let fixtures: Record<FixtureName, string>;
beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), "selects-scheduler-fixtures-"));
  fixtures = await generateFixtures(fixtureDir);
});
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

let dataDir: string;
let db: Database;
let clock: FakeClock;
let instagram: FakeInstagram;
let fakeBucket: FakeBucket;
let library: Library;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "selects-scheduler-"));
  db = openDatabase(dataDir, migrations);
  // Friday 2026-11-13, 09:00 UTC.
  clock = createFakeClock();
  instagram = createFakeInstagram({ clock });
  fakeBucket = createFakeBucket();
  library = createLibrary({ db, dataDir });
});
afterEach(async () => {
  await instagram.stop();
  await fakeBucket.stop();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

type Setup = {
  connect?: boolean;
  wrapApi?: (api: InstagramApi) => InstagramApi;
  /** Stands in for the publisher the scheduler calls, around the real one. */
  wrapPublisher?: (publisher: Publisher) => Publisher;
  random?: () => number;
};

/** A publisher and a scheduler against the fakes, as the app builds them. */
async function setup(options: Setup = {}) {
  const zones = createZones(db);
  const captures = createCaptures({ db, library, zones });
  const settings = createSettings(db);
  const captionStore = createCaptionStore(db);
  const realApi = createInstagramApi({ baseUrl: instagram.url });
  const api = options.wrapApi?.(realApi) ?? realApi;
  const account = createInstagramAccount({ db, api, clock, mode: "fake" });
  const bucket = createBucket(
    new BucketSettings(fakeBucket.endpoint, fakeBucket.name, "auto", undefined, FAKE_BUCKET_KEYS),
  );
  const publisher = createPublisher({
    db,
    dataDir,
    library,
    captures,
    renderer: createFrameRenderer({ dataDir }),
    settings,
    captionStore,
    account,
    api,
    bucket,
    clock,
    mode: "fake",
    containerPolling: { intervalMs: 1000, limitMs: MINUTE },
    random: () => 0,
  });
  if (options.connect !== false) {
    instagram.addAccount(TOKEN, { userId: "1784140001", username: "selects_test" });
    await account.connect(TOKEN);
  }
  const make = () =>
    createScheduler({
      db,
      library,
      captures,
      publisher: options.wrapPublisher?.(publisher) ?? publisher,
      clock,
      random: options.random ?? (() => 0),
    });
  return { scheduler: make(), restart: make, publisher, settings, captures, zones, account };
}

async function addSelect(name: FixtureName, alreadyPosted = false): Promise<string> {
  const copy = join(dataDir, `incoming-${basename(fixtures[name])}`);
  copyFileSync(fixtures[name], copy);
  const result = await library.addUpload(copy, { fileName: basename(fixtures[name]), alreadyPosted });
  if (result.status !== "added") throw new Error(`could not add ${name}`);
  return result.select.id;
}

const at = (iso: string) => Date.parse(iso);
const everyDay = (time: string, id = "daily", spreadMinutes = 0): Slot => ({
  id,
  days: [1, 2, 3, 4, 5, 6, 7],
  time,
  spreadMinutes,
});

/** Moves the clock to `iso`, ticking every `step` on the way as the timer would. */
async function runUntil(scheduler: Scheduler, publisher: Publisher, iso: string, step = 10 * MINUTE) {
  const end = at(iso);
  while (clock.now() < end) {
    clock.advance(Math.min(step, end - clock.now()));
    await scheduler.tick();
    await publisher.settled();
  }
}

/** The select of every post that went out, or is going out, oldest first. Not dry runs. */
const postedSelects = (publisher: Publisher) =>
  publisher
    .posts()
    .reverse()
    .map((post) => post.selectIds[0]);

describe("slots", () => {
  test("with no slots, nothing posts", async () => {
    const { scheduler, publisher } = await setup();
    const id = await addSelect("portrait");
    scheduler.setQueue([id]);
    await runUntil(scheduler, publisher, "2026-11-20T09:00:00Z", HOUR);
    expect(publisher.posts()).toEqual([]);
    expect(scheduler.upcoming()).toEqual([]);
  });

  test("a slot posts at its time in the install's timezone, and not before", async () => {
    const { scheduler, publisher } = await setup();
    const id = await addSelect("portrait");
    // 18:30 in Tokyo is 09:30 UTC.
    expect(
      scheduler.setSchedule({ slots: [everyDay("18:30")], timeZone: "Asia/Tokyo", graceMinutes: 120 }),
    ).toEqual({
      ok: true,
    });
    await runUntil(scheduler, publisher, "2026-11-13T09:29:00Z", MINUTE);
    expect(publisher.posts()).toEqual([]);
    await runUntil(scheduler, publisher, "2026-11-13T09:31:00Z", MINUTE);
    expect(postedSelects(publisher)).toEqual([id]);
    expect(publisher.posts()[0]?.state).toBe("published");
  });

  test("a slot runs only on its days", async () => {
    const { scheduler, publisher } = await setup();
    await addSelect("portrait");
    await addSelect("landscape");
    // Mondays only; the clock starts on a Friday.
    scheduler.setSchedule({
      slots: [{ id: "monday", days: [1], time: "12:00", spreadMinutes: 0 }],
      timeZone: "UTC",
      graceMinutes: 120,
    });
    await runUntil(scheduler, publisher, "2026-11-16T11:00:00Z", HOUR);
    expect(publisher.posts()).toEqual([]);
    await runUntil(scheduler, publisher, "2026-11-16T13:00:00Z");
    expect(publisher.posts()).toHaveLength(1);
  });

  test("a slot comes round once a day", async () => {
    const { scheduler, publisher } = await setup();
    for (const name of ["portrait", "landscape", "square", "rotated"] as const) await addSelect(name);
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
    await runUntil(scheduler, publisher, "2026-11-16T09:00:00Z", 5 * MINUTE);
    // Friday, Saturday and Sunday at noon.
    expect(publisher.posts()).toHaveLength(3);
  });

  test("a timezone that is not one is refused", async () => {
    const { scheduler } = await setup();
    const result = scheduler.setSchedule({ slots: [], timeZone: "Mars/Olympus_Mons", graceMinutes: 120 });
    expect(result).toEqual({ ok: false, problems: ["Mars/Olympus_Mons is not a timezone."] });
    expect(scheduler.schedule().timeZone).toBe("UTC");
  });
});

describe("the queue", () => {
  test("drains before the pool, in order", async () => {
    const { scheduler, publisher } = await setup();
    const pooled = await addSelect("portrait");
    const second = await addSelect("landscape");
    const first = await addSelect("square");
    scheduler.setQueue([first, second]);
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
    await runUntil(scheduler, publisher, "2026-11-15T13:00:00Z");
    expect(postedSelects(publisher)).toEqual([first, second, pooled]);
    expect(scheduler.queue()).toEqual([]);
  });

  test("a queued select ignores the pick rules", async () => {
    const { scheduler, publisher, captures } = await setup();
    const portrait = await addSelect("portrait");
    const sameDay = await addSelect("landscape");
    const otherDay = await addSelect("square");
    // Taken, as edited, the same day as the portrait: spacing by capture day keeps it from the pool.
    captures.save(sameDay, { edits: { capturedAt: "2024-05-01T15:00:00" }, locationHidden: false });
    scheduler.setQueue([portrait]);
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
    await runUntil(scheduler, publisher, "2026-11-13T13:00:00Z");
    scheduler.setQueue([sameDay]);
    await runUntil(scheduler, publisher, "2026-11-14T13:00:00Z");
    expect(postedSelects(publisher)).toEqual([portrait, sameDay]);
    await runUntil(scheduler, publisher, "2026-11-15T13:00:00Z");
    expect(postedSelects(publisher)).toEqual([portrait, sameDay, otherDay]);
  });
});
