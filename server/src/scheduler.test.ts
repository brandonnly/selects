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
  /** A scheduler as after a restart: the same database, and its own random source if given. */
  const make = (random = options.random ?? (() => 0)) =>
    createScheduler({
      db,
      library,
      captures,
      publisher: options.wrapPublisher?.(publisher) ?? publisher,
      clock,
      random,
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

  test("a slot added or moved just after its time waits for its next one", async () => {
    const { scheduler, publisher } = await setup();
    await addSelect("portrait");
    // Added at 09:00 for 08:30: within the grace period, but it did not exist then.
    scheduler.setSchedule({ slots: [everyDay("08:30")], timeZone: "UTC", graceMinutes: 120 });
    await runUntil(scheduler, publisher, "2026-11-13T10:00:00Z");
    // Moved at 10:00 to 09:45.
    scheduler.setSchedule({ slots: [everyDay("09:45")], timeZone: "UTC", graceMinutes: 120 });
    await runUntil(scheduler, publisher, "2026-11-13T11:00:00Z");
    expect(publisher.posts()).toEqual([]);
    await runUntil(scheduler, publisher, "2026-11-14T10:00:00Z");
    expect(publisher.posts()).toHaveLength(1);
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

describe("next up", () => {
  /** Mondays at noon UTC; the clock starts on a Friday. */
  const MONDAY_NOON: Slot = { id: "monday", days: [1], time: "12:00", spreadMinutes: 0 };

  test("is chosen a day ahead and stored", async () => {
    const { scheduler, publisher, restart } = await setup({ random: () => 0 });
    const first = await addSelect("portrait");
    await addSelect("landscape");
    scheduler.setSchedule({ slots: [MONDAY_NOON], timeZone: "UTC", graceMinutes: 120 });
    await runUntil(scheduler, publisher, "2026-11-15T11:00:00Z", HOUR);
    // More than a day before: not chosen yet.
    expect(scheduler.upcoming()).toEqual([]);
    await runUntil(scheduler, publisher, "2026-11-15T13:00:00Z", HOUR);
    const [run] = scheduler.upcoming();
    expect(run).toMatchObject({
      slotId: "monday",
      date: "2026-11-16",
      state: "planned",
      selectId: first,
      picked: "pool",
    });
    expect(run?.dueAt).toBe(at("2026-11-16T12:00:00Z"));

    // After a restart whose random source would choose otherwise, the stored choice stands.
    const restarted = restart(() => 0.99);
    expect(restarted.upcoming()[0]?.selectId).toBe(first);
    await runUntil(restarted, publisher, "2026-11-16T12:30:00Z");
    expect(postedSelects(publisher)).toEqual([first]);
  });

  test("its frame and caption are built when it posts, not when it is chosen", async () => {
    const { scheduler, publisher, captures } = await setup();
    const id = await addSelect("portrait");
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
    expect(scheduler.upcoming()[0]?.selectId).toBe(id);
    expect(publisher.preview([id])?.caption).toContain("°");
    // Its location is hidden after it was chosen: the post never carries it.
    captures.save(id, { edits: {}, locationHidden: true });
    await runUntil(scheduler, publisher, "2026-11-13T12:30:00Z");
    const [post] = publisher.posts();
    expect(post?.state).toBe("published");
    expect(post?.caption).not.toContain("°");
  });

  test("swap chooses another, and comes round again once all have been passed", async () => {
    const { scheduler, publisher } = await setup();
    const a = await addSelect("portrait");
    const b = await addSelect("landscape");
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
    expect(scheduler.upcoming()[0]?.selectId).toBe(a);
    const swapped = scheduler.swap("daily", "2026-11-13");
    expect(swapped).toMatchObject({ selectId: b, picked: "swap" });
    expect(scheduler.swap("daily", "2026-11-13")).toMatchObject({ selectId: a });
    await runUntil(scheduler, publisher, "2026-11-13T12:30:00Z");
    expect(postedSelects(publisher)).toEqual([a]);
  });

  test("swap with nothing else to choose says so", async () => {
    const { scheduler } = await setup();
    await addSelect("portrait");
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
    expect(scheduler.swap("daily", "2026-11-13")).toBe("none");
    expect(scheduler.swap("daily", "2026-12-25")).toBe("not-found");
  });

  test("skip leaves that slot empty, and the select where it was", async () => {
    const { scheduler, publisher } = await setup();
    const id = await addSelect("portrait");
    scheduler.setQueue([id]);
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
    expect(scheduler.skip("daily", "2026-11-13")).toMatchObject({ state: "skipped" });
    await runUntil(scheduler, publisher, "2026-11-13T13:00:00Z");
    expect(publisher.posts()).toEqual([]);
    expect(scheduler.queue()).toEqual([id]);
    // The next day's slot posts it.
    await runUntil(scheduler, publisher, "2026-11-14T12:30:00Z");
    expect(postedSelects(publisher)).toEqual([id]);
  });

  test("a skip can be taken back while the slot is still to come", async () => {
    const { scheduler, publisher } = await setup();
    const id = await addSelect("portrait");
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
    scheduler.skip("daily", "2026-11-13");
    expect(scheduler.unskip("daily", "2026-11-13")).toMatchObject({ state: "planned", selectId: id });
    await runUntil(scheduler, publisher, "2026-11-13T12:30:00Z");
    expect(postedSelects(publisher)).toEqual([id]);
  });

  test("next up that left the pool is chosen again when its time comes", async () => {
    const { scheduler, publisher } = await setup();
    const deleted = await addSelect("portrait");
    const byHand = await addSelect("landscape");
    const left = await addSelect("square");
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
    expect(scheduler.upcoming()[0]?.selectId).toBe(deleted);
    library.remove(deleted);
    // Swapped to the landscape, which is then posted by hand.
    expect(scheduler.swap("daily", "2026-11-13")).toMatchObject({ selectId: byHand });
    const now = await publisher.publish({ selectIds: [byHand] });
    if (now.status !== "started") throw new Error(now.status);
    await now.done;
    await runUntil(scheduler, publisher, "2026-11-13T12:30:00Z");
    expect(postedSelects(publisher)).toEqual([byHand, left]);
  });

  test("two slots on a day get different selects", async () => {
    const { scheduler } = await setup();
    const a = await addSelect("portrait");
    const b = await addSelect("landscape");
    scheduler.setSchedule({
      slots: [everyDay("12:00", "noon"), everyDay("18:00", "evening")],
      timeZone: "UTC",
      graceMinutes: 120,
    });
    expect(scheduler.upcoming().map((run) => run.selectId)).toEqual([a, b]);
  });
});

describe("downtime", () => {
  test("a slot missed while the app was down posts late within the grace period", async () => {
    const { scheduler, publisher, restart } = await setup();
    const id = await addSelect("portrait");
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
    // Down from 09:00 to 13:30: the first tick after the start is 90 minutes after the slot.
    clock.advance(at("2026-11-13T13:30:00Z") - clock.now());
    const restarted = restart();
    restarted.recover();
    await restarted.tick();
    await publisher.settled();
    expect(postedSelects(publisher)).toEqual([id]);
  });

  test("past the grace period it is skipped, and shown as missed", async () => {
    const { scheduler, publisher } = await setup();
    const id = await addSelect("portrait");
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
    clock.advance(at("2026-11-13T14:01:00Z") - clock.now());
    await scheduler.tick();
    await publisher.settled();
    expect(publisher.posts()).toEqual([]);
    expect(scheduler.history()[0]).toMatchObject({ date: "2026-11-13", state: "missed" });
    // And the select is still there for the next slot.
    expect(library.get(id)?.inPool).toBe(true);
  });

  test("the grace period can be set", async () => {
    const { scheduler, publisher } = await setup();
    await addSelect("portrait");
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 30 });
    clock.advance(at("2026-11-13T12:45:00Z") - clock.now());
    await scheduler.tick();
    await publisher.settled();
    expect(publisher.posts()).toEqual([]);
    expect(scheduler.history()[0]?.state).toBe("missed");
  });

  test("missed slots never stack: after downtime, at most one late post", async () => {
    const { scheduler, publisher } = await setup();
    for (const name of ["portrait", "landscape", "square", "rotated"] as const) await addSelect(name);
    scheduler.setSchedule({
      slots: [everyDay("12:00", "noon"), everyDay("12:30", "half"), everyDay("13:00", "one")],
      timeZone: "UTC",
      graceMinutes: 120,
    });
    clock.advance(at("2026-11-13T13:10:00Z") - clock.now());
    await scheduler.tick();
    await publisher.settled();
    expect(publisher.posts()).toHaveLength(1);
    expect(scheduler.history().map((run) => `${run.slotId} ${run.state}`)).toEqual([
      "one posted",
      "half missed",
      "noon missed",
    ]);
  });

  test("a slot's random spread is drawn once, and a restart neither moves it nor fires it twice", async () => {
    let draw = 0.5;
    const { scheduler, publisher, restart } = await setup({ random: () => draw });
    await addSelect("portrait");
    await addSelect("landscape");
    scheduler.setSchedule({ slots: [everyDay("12:00", "daily", 60)], timeZone: "UTC", graceMinutes: 120 });
    // Half of 61 possible minutes: 30 minutes after noon.
    expect(scheduler.upcoming()[0]?.dueAt).toBe(at("2026-11-13T12:30:00Z"));
    draw = 0;
    const restarted = restart(() => draw);
    await restarted.tick();
    expect(restarted.upcoming()[0]?.dueAt).toBe(at("2026-11-13T12:30:00Z"));
    await runUntil(restarted, publisher, "2026-11-13T12:29:00Z", MINUTE);
    expect(publisher.posts()).toEqual([]);
    await runUntil(restarted, publisher, "2026-11-13T12:31:00Z", MINUTE);
    expect(publisher.posts()).toHaveLength(1);
    // Restarted again after it posted: the slot does not post a second time.
    const again = restart(() => 0);
    again.recover();
    await runUntil(again, publisher, "2026-11-13T23:00:00Z");
    expect(publisher.posts()).toHaveLength(1);
  });

  test("a stop after a slot was claimed and before the post was made posts it once on restart", async () => {
    // The first publisher call never answers, as if Selects stopped while it ran.
    let hang = true;
    const { publisher, restart } = await setup({
      wrapPublisher: (real) => ({
        ...real,
        publish: (request) => (hang ? new Promise(() => {}) : real.publish(request)),
      }),
    });
    const id = await addSelect("portrait");
    const first = restart();
    first.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
    clock.advance(at("2026-11-13T12:00:00Z") - clock.now());
    void first.tick();
    await Bun.sleep(0);
    expect(first.upcoming()[0]?.state).toBe("posting");
    expect(publisher.posts()).toEqual([]);

    hang = false;
    const second = restart();
    second.recover();
    clock.advance(5 * MINUTE);
    await second.tick();
    await publisher.settled();
    expect(postedSelects(publisher)).toEqual([id]);
    expect(second.history()[0]).toMatchObject({ state: "posted" });
  });

  test("a stop after the post was made and before it was recorded never posts twice", async () => {
    // The post is made, then the answer is lost, as if Selects stopped right after.
    let lose = true;
    const { publisher, restart } = await setup({
      wrapPublisher: (real) => ({
        ...real,
        publish: async (request) => {
          const result = await real.publish(request);
          if (lose) return new Promise(() => {});
          return result;
        },
      }),
    });
    const id = await addSelect("portrait");
    await addSelect("landscape");
    const first = restart();
    first.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
    clock.advance(at("2026-11-13T12:00:00Z") - clock.now());
    void first.tick();
    await publisher.settled();
    expect(publisher.posts()).toHaveLength(1);

    lose = false;
    const second = restart();
    second.recover();
    await runUntil(second, publisher, "2026-11-13T13:00:00Z");
    expect(postedSelects(publisher)).toEqual([id]);
    const [run] = second.history();
    expect(run).toMatchObject({ state: "posted", selectId: id, postId: publisher.posts()[0]?.id });
  });
});
