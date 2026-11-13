import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createBucket } from "./bucket";
import { createCaptionStore } from "./caption-store";
import { createCaptures } from "./capture";
import { createFakeClock, type FakeClock, HOUR, MINUTE } from "./clock";
import { BucketSettings } from "./config";
import { openDatabase } from "./db";
import { createFakeBucket, FAKE_BUCKET_KEYS, type FakeBucket } from "./fake-bucket";
import { createFakeInstagram, type FakeInstagram } from "./fake-instagram";
import { type FixtureName, generateFixtures } from "./fixtures";
import { createFrameRenderer } from "./frame";
import { createInstagramApi, type InstagramApi, InstagramError } from "./instagram";
import { createInstagramAccount } from "./instagram-account";
import { createLibrary, type Library } from "./library";
import { migrations } from "./migrations";
import { createPublisher, type Publisher, RETRY_DELAYS } from "./publisher";
import { createScheduler, PREVIEW_CAP, type ScheduleEvent, type Scheduler } from "./scheduler";
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
  notify?: (event: ScheduleEvent) => void;
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
      notify: options.notify,
    });
  return { scheduler: make(), restart: make, publisher, settings, captures, zones, account, captionStore };
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

/** Posts a select now, as "Post now" does, and says how its post ended. */
async function postNow(publisher: Publisher, selectId: string) {
  const result = await publisher.publish({ selectIds: [selectId] });
  if (result.status !== "started") return result.status;
  return (await result.done).state;
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

  describe("a skip survives an edit", () => {
    // Every day at 08:00; at 09:00 on Friday, Saturday's run is a day ahead.
    const EARLY = { slots: [everyDay("08:00")], timeZone: "UTC", graceMinutes: 120 };

    async function skipTomorrow() {
      const context = await setup();
      await addSelect("portrait");
      context.scheduler.setSchedule(EARLY);
      expect(context.scheduler.skip("daily", "2026-11-14")).toMatchObject({ state: "skipped" });
      return context;
    }

    test("to its spread", async () => {
      const { scheduler, publisher } = await skipTomorrow();
      scheduler.setSchedule({ ...EARLY, slots: [everyDay("08:00", "daily", 30)] });
      expect(scheduler.upcoming()[0]).toMatchObject({ date: "2026-11-14", state: "skipped" });
      await runUntil(scheduler, publisher, "2026-11-14T10:00:00Z");
      expect(publisher.posts()).toEqual([]);
    });

    test("to its days and the grace period", async () => {
      const { scheduler, publisher } = await skipTomorrow();
      scheduler.setSchedule({ ...EARLY, slots: [{ ...everyDay("08:00"), days: [5, 6] }], graceMinutes: 30 });
      await runUntil(scheduler, publisher, "2026-11-14T10:00:00Z");
      expect(publisher.posts()).toEqual([]);
    });

    test("to its time or the timezone: the skip stays with that day", async () => {
      const { scheduler, publisher } = await skipTomorrow();
      scheduler.setSchedule({ ...EARLY, slots: [everyDay("08:30")] });
      scheduler.setSchedule({ ...EARLY, slots: [everyDay("08:30")], timeZone: "Europe/Lisbon" });
      expect(scheduler.upcoming()[0]).toMatchObject({ date: "2026-11-14", state: "skipped" });
      await runUntil(scheduler, publisher, "2026-11-14T10:00:00Z");
      expect(publisher.posts()).toEqual([]);
      // The next day's run still posts.
      await runUntil(scheduler, publisher, "2026-11-15T10:00:00Z");
      expect(publisher.posts()).toHaveLength(1);
    });
  });

  test("a slot that was missed and is moved later the same day posts at its new time", async () => {
    const { scheduler, publisher } = await setup();
    await addSelect("portrait");
    scheduler.setSchedule({ slots: [everyDay("10:00")], timeZone: "UTC", graceMinutes: 0 });
    clock.advance(at("2026-11-13T11:00:00Z") - clock.now());
    await scheduler.tick();
    expect(scheduler.history()[0]?.state).toBe("missed");
    scheduler.setSchedule({ slots: [everyDay("15:00")], timeZone: "UTC", graceMinutes: 0 });
    await runUntil(scheduler, publisher, "2026-11-13T15:01:00Z", 30_000);
    expect(publisher.posts()).toHaveLength(1);
  });

  test("an edit to a slot's days after its time, while it waits on its spread, leaves today's post", async () => {
    const { scheduler, publisher } = await setup({ random: () => 0.75 });
    await addSelect("portrait");
    const slot: Slot = { ...everyDay("12:00"), days: [1, 2, 3, 4, 5], spreadMinutes: 60 };
    scheduler.setSchedule({ slots: [slot], timeZone: "UTC", graceMinutes: 120 });
    await runUntil(scheduler, publisher, "2026-11-13T12:10:00Z");
    expect(publisher.posts()).toHaveLength(0);

    // Saturday is added; its time and spread are as they were.
    scheduler.setSchedule({
      slots: [{ ...slot, days: [1, 2, 3, 4, 5, 6] }],
      timeZone: "UTC",
      graceMinutes: 120,
    });
    await runUntil(scheduler, publisher, "2026-11-13T13:05:00Z");

    expect(publisher.posts()).toHaveLength(1);
  });

  test("a slot moved to a time already past does not post later today through its spread", async () => {
    // A spread of 60 drawn as its whole: the 18:00 slot is due at 19:00.
    const { scheduler, publisher } = await setup({ random: () => 0.99 });
    await addSelect("portrait");
    scheduler.setSchedule({ slots: [everyDay("18:00", "daily", 60)], timeZone: "UTC", graceMinutes: 120 });
    await runUntil(scheduler, publisher, "2026-11-13T12:30:00Z");
    // Moved to 12:00, already past: kept, its spread would make it due at 13:00.
    scheduler.setSchedule({ slots: [everyDay("12:00", "daily", 60)], timeZone: "UTC", graceMinutes: 120 });
    expect(scheduler.upcoming()[0]?.date).toBe("2026-11-14");
    await runUntil(scheduler, publisher, "2026-11-13T23:00:00Z");
    expect(publisher.posts()).toEqual([]);
    await runUntil(scheduler, publisher, "2026-11-14T13:30:00Z");
    expect(publisher.posts()).toHaveLength(1);
  });

  test("saving the same schedule with a day repeated changes nothing", async () => {
    const { scheduler, publisher } = await setup({ random: () => 0.5 });
    await addSelect("portrait");
    scheduler.setSchedule({ slots: [everyDay("12:00", "daily", 60)], timeZone: "UTC", graceMinutes: 120 });
    expect(scheduler.upcoming()[0]?.dueAt).toBe(at("2026-11-13T12:30:00Z"));
    await runUntil(scheduler, publisher, "2026-11-13T12:10:00Z");
    const repeated = { ...everyDay("12:00", "daily", 60), days: [1, 1, 2, 3, 4, 5, 6, 7] } as Slot;
    expect(scheduler.setSchedule({ slots: [repeated], timeZone: "UTC", graceMinutes: 120 })).toEqual({
      ok: true,
    });
    expect(scheduler.schedule().slots[0]?.days).toEqual([1, 2, 3, 4, 5, 6, 7]);
    await runUntil(scheduler, publisher, "2026-11-13T12:31:00Z", MINUTE);
    expect(publisher.posts()).toHaveLength(1);
  });

  test("a slot ID must be letters, digits, - or _, and unique", async () => {
    const { scheduler } = await setup();
    for (const id of ["a/b", "x y", "", "é", "a".repeat(65)]) {
      const result = scheduler.setSchedule({
        slots: [everyDay("12:00", id)],
        timeZone: "UTC",
        graceMinutes: 120,
      });
      expect(result.ok).toBe(false);
    }
    expect(
      scheduler.setSchedule({
        slots: [everyDay("12:00", "same"), everyDay("13:00", "same")],
        timeZone: "UTC",
        graceMinutes: 120,
      }),
    ).toEqual({ ok: false, problems: ["Two slots have the same ID."] });
    expect(
      scheduler.setSchedule({
        slots: [everyDay("12:00", "Morning_post-2")],
        timeZone: "UTC",
        graceMinutes: 120,
      }),
    ).toEqual({ ok: true });
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

  test("keeps its order when a slot before did not post", async () => {
    const { scheduler, publisher, account } = await setup({ connect: false });
    const first = await addSelect("portrait");
    const second = await addSelect("landscape");
    scheduler.setQueue([first, second]);
    scheduler.setSchedule({
      slots: [everyDay("12:00", "noon"), everyDay("13:00", "one")],
      timeZone: "UTC",
      graceMinutes: 120,
    });
    expect(scheduler.upcoming().map((run) => run.selectId)).toEqual([first, second]);
    // No account at noon: the slot takes nothing, so the queue's head is next.
    await runUntil(scheduler, publisher, "2026-11-13T12:30:00Z");
    expect(scheduler.upcoming()[0]).toMatchObject({ slotId: "one", selectId: first });
    instagram.addAccount(TOKEN, { userId: "1784140001", username: "selects_test" });
    await account.connect(TOKEN);
    await runUntil(scheduler, publisher, "2026-11-13T13:30:00Z");
    expect(postedSelects(publisher)).toEqual([first]);
  });

  describe("always goes first, whatever left a queued select free", () => {
    const TWO_SLOTS = {
      slots: [everyDay("10:00", "morning"), everyDay("20:00", "evening")],
      timeZone: "UTC",
      graceMinutes: 120,
    };

    test("a slot paused: the following posts are the queue's, then the pool's", async () => {
      const { scheduler, publisher } = await setup();
      const q1 = await addSelect("portrait");
      const q2 = await addSelect("landscape");
      const pooled = await addSelect("square");
      scheduler.setQueue([q1, q2]);
      scheduler.setSchedule(TWO_SLOTS);
      await runUntil(scheduler, publisher, "2026-11-13T19:00:00Z");
      scheduler.setPaused(true);
      await runUntil(scheduler, publisher, "2026-11-13T21:00:00Z");
      scheduler.setPaused(false);
      await runUntil(scheduler, publisher, "2026-11-14T21:00:00Z");
      expect(postedSelects(publisher)).toEqual([q1, q2, pooled]);
    });

    test("a slot that could not post: the next takes the queue's head, not its pool pick", async () => {
      const { scheduler, publisher, account } = await setup({ connect: false });
      const queued = await addSelect("portrait");
      await addSelect("landscape");
      scheduler.setQueue([queued]);
      scheduler.setSchedule(TWO_SLOTS);
      await runUntil(scheduler, publisher, "2026-11-13T11:00:00Z");
      instagram.addAccount(TOKEN, { userId: "1784140001", username: "selects_test" });
      await account.connect(TOKEN);
      await runUntil(scheduler, publisher, "2026-11-13T21:00:00Z");
      expect(postedSelects(publisher)).toEqual([queued]);
    });

    test("a dry run: the next real slot takes the queue's head", async () => {
      const { scheduler, publisher, settings } = await setup();
      const queued = await addSelect("portrait");
      await addSelect("landscape");
      scheduler.setQueue([queued]);
      scheduler.setSchedule(TWO_SLOTS);
      settings.setPublishing({ dryRun: true });
      await runUntil(scheduler, publisher, "2026-11-13T11:00:00Z");
      settings.setPublishing({ dryRun: false });
      await runUntil(scheduler, publisher, "2026-11-13T21:00:00Z");
      expect(postedSelects(publisher)).toEqual([queued]);
    });

    test("a slot skipped: the next one shows the queue's head as soon as the skip is answered", async () => {
      const { scheduler, publisher } = await setup();
      const queued = await addSelect("portrait");
      const pooled = await addSelect("landscape");
      scheduler.setQueue([queued]);
      scheduler.setSchedule(TWO_SLOTS);
      expect(scheduler.upcoming().map((run) => run.selectId)).toEqual([queued, pooled]);
      scheduler.skip("morning", "2026-11-13");
      expect(scheduler.upcoming().map((run) => run.selectId)).toEqual([null, queued]);
      scheduler.unskip("morning", "2026-11-13");
      expect(scheduler.upcoming().map((run) => run.selectId)).toEqual([queued, pooled]);
      scheduler.skip("morning", "2026-11-13");
      await runUntil(scheduler, publisher, "2026-11-13T21:00:00Z");
      expect(postedSelects(publisher)).toEqual([queued]);
    });

    test("a slot swapped away from the head: the next one takes it at once", async () => {
      const { scheduler } = await setup();
      const queued = await addSelect("portrait");
      const pooled = await addSelect("landscape");
      scheduler.setQueue([queued]);
      scheduler.setSchedule(TWO_SLOTS);
      expect(scheduler.swap("morning", "2026-11-13")).toMatchObject({ selectId: pooled });
      expect(scheduler.upcoming().map((run) => run.selectId)).toEqual([pooled, queued]);
    });

    test("slots missed in downtime: the one that posts late takes the queue's head", async () => {
      const { scheduler, publisher, restart } = await setup();
      const q1 = await addSelect("portrait");
      const q2 = await addSelect("landscape");
      await addSelect("square");
      scheduler.setQueue([q1, q2]);
      scheduler.setSchedule({
        slots: [everyDay("10:00", "ten"), everyDay("11:00", "eleven")],
        timeZone: "UTC",
        graceMinutes: 120,
      });
      expect(scheduler.upcoming().map((run) => run.selectId)).toEqual([q1, q2]);
      clock.advance(at("2026-11-13T11:05:00Z") - clock.now());
      const restarted = restart();
      restarted.recover();
      await restarted.tick();
      await publisher.settled();
      expect(postedSelects(publisher)).toEqual([q1]);
      expect(restarted.queue()).toEqual([q2]);
    });

    test("a select queued after the pool was picked from takes the next slot", async () => {
      const { scheduler } = await setup();
      await addSelect("portrait");
      const queued = await addSelect("landscape");
      scheduler.setSchedule(TWO_SLOTS);
      scheduler.setQueue([queued]);
      expect(scheduler.upcoming()[0]?.selectId).toBe(queued);
    });
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
    expect(scheduler.history()[0]).toMatchObject({ date: "2026-11-13", state: "skipped" });
    expect(scheduler.upcoming().map((run) => run.date)).toEqual(["2026-11-14"]);
    // The next day's slot posts it.
    await runUntil(scheduler, publisher, "2026-11-14T12:30:00Z");
    expect(postedSelects(publisher)).toEqual([id]);
  });

  test("a skip can be taken back while the slot is still to come", async () => {
    const { scheduler, publisher } = await setup();
    const id = await addSelect("portrait");
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
    await addSelect("landscape");
    // Swapped away from the first, then skipped: taking the skip back chooses afresh.
    scheduler.swap("daily", "2026-11-13");
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
    // Chosen again at once, then swapped past the landscape to the square, which is posted by hand.
    expect(scheduler.swap("daily", "2026-11-13")).toMatchObject({ selectId: left });
    const now = await publisher.publish({ selectIds: [left] });
    if (now.status !== "started") throw new Error(now.status);
    await now.done;
    // The landscape was passed over, but it is all that is left: the slot posts it.
    await runUntil(scheduler, publisher, "2026-11-13T12:30:00Z");
    expect(postedSelects(publisher)).toEqual([left, byHand]);
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
  test("with a grace period of 0, a slot still posts on time with the timer at any offset", async () => {
    const { scheduler, publisher } = await setup();
    const id = await addSelect("portrait");
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 0 });
    // The timer runs every 30 seconds from an arbitrary start: it never lands on the slot's millisecond.
    clock.advance(7_300);
    await runUntil(scheduler, publisher, "2026-11-13T12:01:00Z", 30_000);
    expect(postedSelects(publisher)).toEqual([id]);
  });

  test("with a grace period of 0, a slot found after downtime does not post", async () => {
    const { scheduler, publisher } = await setup();
    await addSelect("portrait");
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 0 });
    clock.advance(at("2026-11-13T12:05:00Z") - clock.now());
    await scheduler.tick();
    await publisher.settled();
    expect(publisher.posts()).toEqual([]);
    expect(scheduler.history()[0]?.state).toBe("missed");
  });

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
    // Past the two hours and the timer's minute of tolerance.
    clock.advance(at("2026-11-13T14:02:00Z") - clock.now());
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

  test("while Selects runs, two slots at the same minute both post", async () => {
    const { scheduler, publisher } = await setup();
    const a = await addSelect("portrait");
    const b = await addSelect("landscape");
    scheduler.setSchedule({
      slots: [everyDay("09:30", "first"), everyDay("09:30", "second")],
      timeZone: "UTC",
      graceMinutes: 120,
    });
    await runUntil(scheduler, publisher, "2026-11-13T09:31:00Z", 30_000);
    expect(postedSelects(publisher)).toEqual([a, b]);
    expect(scheduler.history().map((run) => run.state)).toEqual(["posted", "posted"]);
  });

  test("a slot not chosen is never called downtime", async () => {
    const { scheduler, publisher } = await setup();
    await addSelect("portrait");
    scheduler.setSchedule({
      slots: [everyDay("09:30", "first"), everyDay("09:30", "second")],
      timeZone: "UTC",
      graceMinutes: 120,
    });
    await runUntil(scheduler, publisher, "2026-11-13T09:31:00Z", 30_000);
    const notes = scheduler.history().map((run) => `${run.state} ${run.note ?? ""}`);
    expect(notes.join("\n")).not.toContain("not running");
    expect(scheduler.history().map((run) => run.state)).toEqual(["empty", "posted"]);
  });

  test("a slot found late while Selects runs is recorded as found late, not as downtime", async () => {
    const { scheduler, publisher } = await setup();
    await addSelect("portrait");
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 0 });
    await runUntil(scheduler, publisher, "2026-11-13T11:59:30Z", 30_000);
    // The next tick is held up for three minutes.
    await runUntil(scheduler, publisher, "2026-11-13T12:02:30Z", 3 * MINUTE);
    expect(publisher.posts()).toEqual([]);
    expect(scheduler.history()[0]?.state).toBe("late");
    expect(scheduler.history()[0]?.note).toContain("running but checked more than a minute late");
    expect(scheduler.history()[0]?.note).not.toContain("not running");
  });

  test("a slot found after a real gap in ticks says Selects was not running", async () => {
    const { scheduler, publisher } = await setup();
    await addSelect("portrait");
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 0 });
    await runUntil(scheduler, publisher, "2026-11-13T10:00:00Z", 30_000);
    await runUntil(scheduler, publisher, "2026-11-13T12:05:00Z", 125 * MINUTE);
    expect(scheduler.history()[0]?.state).toBe("missed");
    expect(scheduler.history()[0]?.note).toContain("not running");
  });

  test("after a long stop, the runs it missed are recorded as missed", async () => {
    const { scheduler, publisher, restart } = await setup();
    for (const name of ["portrait", "landscape"] as const) await addSelect(name);
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
    await runUntil(scheduler, publisher, "2026-11-13T13:00:00Z");
    // Down until Monday 13:30: Saturday and Sunday went by, and Monday is within grace.
    clock.advance(at("2026-11-16T13:30:00Z") - clock.now());
    const restarted = restart();
    restarted.recover();
    await restarted.tick();
    await publisher.settled();
    expect(restarted.history().map((run) => `${run.date} ${run.state} ${run.fileName}`)).toEqual([
      "2026-11-16 posted landscape.tif",
      // Planned before the stop: what was next up. Never planned: nothing.
      "2026-11-15 missed null",
      "2026-11-14 missed landscape.tif",
      "2026-11-13 posted portrait.jpg",
    ]);
  });

  test("while paused, a run already past grace is missed, not paused", async () => {
    const { scheduler, publisher } = await setup();
    await addSelect("portrait");
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 30 });
    scheduler.setPaused(true);
    clock.advance(at("2026-11-13T13:00:00Z") - clock.now());
    await scheduler.tick();
    await publisher.settled();
    expect(scheduler.history()[0]?.state).toBe("missed");
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

describe("a change while a slot posts", () => {
  /** A scheduler whose publisher runs `during` once the first post's switches were read. */
  async function withHook() {
    let during: (() => void) | undefined;
    const context = await setup({
      wrapPublisher: (publisher) => ({
        ...publisher,
        publish: async (request) => {
          const result = await publisher.publish(request);
          const hook = during;
          during = undefined;
          hook?.();
          return result;
        },
      }),
    });
    return { ...context, setDuring: (hook: () => void) => (during = hook) };
  }
  const TWO_AT_NOON = {
    slots: [everyDay("12:00", "a"), everyDay("12:00", "b")],
    timeZone: "UTC",
    graceMinutes: 120,
  };

  test("pausing and turning dry run off while the first renders: the second does not post", async () => {
    const { scheduler, publisher, settings, setDuring } = await withHook();
    await addSelect("portrait");
    await addSelect("landscape");
    settings.setPublishing({ dryRun: true });
    scheduler.setSchedule(TWO_AT_NOON);
    setDuring(() => {
      scheduler.setPaused(true);
      settings.setPublishing({ dryRun: false });
    });
    await runUntil(scheduler, publisher, "2026-11-13T12:30:00Z", 30_000);
    expect(publisher.dryRuns()).toHaveLength(1);
    expect(publisher.posts()).toEqual([]);
    expect(scheduler.history().map((run) => [run.slotId, run.state])).toEqual([
      ["b", "paused"],
      ["a", "dry-run"],
    ]);
  });

  test("a slot moved later while the first posts posts at its new time, not now", async () => {
    const { scheduler, publisher, setDuring } = await withHook();
    const first = await addSelect("portrait");
    const second = await addSelect("landscape");
    scheduler.setSchedule(TWO_AT_NOON);
    setDuring(() =>
      scheduler.setSchedule({ ...TWO_AT_NOON, slots: [everyDay("12:00", "a"), everyDay("18:00", "b")] }),
    );
    await runUntil(scheduler, publisher, "2026-11-13T17:59:30Z", 30_000);
    expect(postedSelects(publisher)).toEqual([first]);
    await runUntil(scheduler, publisher, "2026-11-13T18:01:00Z", 30_000);
    expect(postedSelects(publisher)).toEqual([first, second]);
    expect(publisher.posts()[0]?.createdAt).toBe(at("2026-11-13T18:00:00Z"));
  });
});

describe("switches", () => {
  test("a slot that came due while paused does not post when posting resumes before the next tick", async () => {
    const { scheduler, publisher } = await setup();
    await addSelect("portrait");
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
    scheduler.setPaused(true);
    await runUntil(scheduler, publisher, "2026-11-13T11:59:50Z");
    // Due at 12:00:00, and resumed at 12:00:10, before any tick found it.
    clock.advance(20_000);
    scheduler.setPaused(false);
    await runUntil(scheduler, publisher, "2026-11-13T12:30:00Z");

    expect(publisher.posts()).toEqual([]);
    expect(scheduler.history()[0]?.state).toBe("paused");
  });

  test("the pause switch stops all posting", async () => {
    const { scheduler, publisher } = await setup();
    const id = await addSelect("portrait");
    scheduler.setQueue([id]);
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
    scheduler.setPaused(true);
    await runUntil(scheduler, publisher, "2026-11-13T13:00:00Z");
    expect(publisher.posts()).toEqual([]);
    expect(scheduler.history()[0]?.state).toBe("paused");
    expect(scheduler.queue()).toEqual([id]);
    // Unpaused within the grace period, the paused slot still does not post: the next one does.
    scheduler.setPaused(false);
    await runUntil(scheduler, publisher, "2026-11-14T11:00:00Z");
    expect(publisher.posts()).toEqual([]);
    await runUntil(scheduler, publisher, "2026-11-14T12:30:00Z");
    expect(postedSelects(publisher)).toEqual([id]);
  });

  test("in dry run, a slot records a dry run and the select stays where it was", async () => {
    const { scheduler, publisher, settings } = await setup();
    const id = await addSelect("portrait");
    scheduler.setQueue([id]);
    settings.setPublishing({ dryRun: true });
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
    await runUntil(scheduler, publisher, "2026-11-13T12:30:00Z");
    expect(publisher.posts()).toEqual([]);
    expect(publisher.dryRuns().map((post) => post.selectIds[0])).toEqual([id]);
    expect(scheduler.history()[0]).toMatchObject({ state: "dry-run", postId: publisher.dryRuns()[0]?.id });
    expect(scheduler.queue()).toEqual([id]);
    expect(library.get(id)?.inPool).toBe(true);
  });
});

describe("publishing", () => {
  test("with no account, slots do not burn through the queue, and say why", async () => {
    const { scheduler, publisher, account } = await setup({ connect: false });
    const a = await addSelect("portrait");
    const b = await addSelect("landscape");
    scheduler.setQueue([a, b]);
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
    expect(scheduler.problems()).toEqual(["No Instagram account is connected."]);
    await runUntil(scheduler, publisher, "2026-11-15T13:00:00Z");
    expect(publisher.posts()).toEqual([]);
    expect(scheduler.queue()).toEqual([a, b]);
    expect(scheduler.history().map((run) => [run.state, run.note])).toEqual([
      ["unavailable", "No Instagram account is connected."],
      ["unavailable", "No Instagram account is connected."],
      ["unavailable", "No Instagram account is connected."],
    ]);
    instagram.addAccount(TOKEN, { userId: "1784140001", username: "selects_test" });
    await account.connect(TOKEN);
    expect(scheduler.problems()).toEqual([]);
    await runUntil(scheduler, publisher, "2026-11-16T13:00:00Z");
    expect(postedSelects(publisher)).toEqual([a]);
  });

  describe("a select that cannot be posted as it stands", () => {
    const TOO_LONG = "x".repeat(2300);

    test("is passed over, stays queued, and is shown as needing attention", async () => {
      const { scheduler, publisher, captionStore } = await setup();
      const bad = await addSelect("portrait");
      const good = await addSelect("landscape");
      captionStore.setOverride(bad, { caption: TOO_LONG, altText: null });
      scheduler.setQueue([bad, good]);
      scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
      expect(scheduler.upcoming()[0]?.selectId).toBe(good);
      await runUntil(scheduler, publisher, "2026-11-13T12:30:00Z");
      expect(postedSelects(publisher)).toEqual([good]);
      expect(publisher.posts().map((post) => post.state)).toEqual(["published"]);
      expect(scheduler.queue()).toEqual([bad]);
      const [attention] = scheduler.attention();
      expect(attention?.selectId).toBe(bad);
      expect(attention?.problems.join(" ")).toContain("2,200");
    });

    test("is passed over in the pool for the next candidate", async () => {
      const { scheduler, publisher, captionStore } = await setup();
      const bad = await addSelect("portrait");
      const good = await addSelect("landscape");
      captionStore.setOverride(bad, { caption: null, altText: "y".repeat(1100) });
      scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
      await runUntil(scheduler, publisher, "2026-11-13T12:30:00Z");
      expect(postedSelects(publisher)).toEqual([good]);
      expect(library.get(bad)?.inPool).toBe(true);
    });

    test("leaves a slot with nothing else empty, and says why", async () => {
      const { scheduler, publisher, captionStore } = await setup();
      const bad = await addSelect("portrait");
      captionStore.setOverride(bad, { caption: TOO_LONG, altText: null });
      scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
      await runUntil(scheduler, publisher, "2026-11-13T12:30:00Z");
      expect(publisher.posts()).toEqual([]);
      expect(scheduler.history()[0]).toMatchObject({ state: "empty" });
      expect(scheduler.history()[0]?.note).toContain("need attention");
    });

    test("stays listed from the pool across reads, until it is fixed", async () => {
      const { scheduler, captionStore } = await setup();
      const bad = await addSelect("portrait");
      await addSelect("landscape");
      captionStore.setOverride(bad, { caption: TOO_LONG, altText: null });
      scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
      expect(scheduler.attention().map((item) => item.selectId)).toEqual([bad]);
      scheduler.refresh();
      scheduler.refresh();
      expect(scheduler.attention().map((item) => item.selectId)).toEqual([bad]);
      captionStore.setOverride(bad, { caption: null, altText: null });
      scheduler.refresh();
      expect(scheduler.attention()).toEqual([]);
    });

    test("stays listed from the queue across reads, and leaves the list when it is deleted", async () => {
      const { scheduler, captionStore } = await setup();
      const bad = await addSelect("portrait");
      const good = await addSelect("landscape");
      captionStore.setOverride(bad, { caption: TOO_LONG, altText: null });
      scheduler.setQueue([bad, good]);
      scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
      scheduler.refresh();
      expect(scheduler.attention().map((item) => item.selectId)).toEqual([bad]);
      library.remove(bad);
      scheduler.refresh();
      expect(scheduler.attention()).toEqual([]);
    });
  });

  describe("with thousands of selects", () => {
    test("a schedule save stays quick, and previews no more than the cap", async () => {
      const unpostable = new Set<string>();
      let previews = 0;
      const { scheduler } = await setup({
        wrapPublisher: (publisher) => ({
          ...publisher,
          preview: (ids) => {
            previews++;
            const problems = unpostable.has(ids[0] as string)
              ? ["The caption is over 2,200 characters."]
              : [];
            return { check: { problems } as never, problems } as never;
          },
        }),
      });
      const insert = db.query(
        `INSERT INTO selects (id, file_name, source, format, bytes, width, height, captured_at, added_at)
         VALUES (?, ?, 'upload', 'jpeg', 1000, 800, 1000, ?, ?)`,
      );
      db.transaction(() => {
        for (let n = 0; n < 5000; n++) {
          const id = `bulk${String(n).padStart(5, "0")}`;
          const day = new Date(Date.UTC(2010, 0, 1) + n * 24 * HOUR).toISOString().slice(0, 10);
          insert.run(id, `${id}.jpg`, `${day}T12:00:00`, "2026-01-01T00:00:00Z");
          // The 1,000 oldest cannot be posted as they stand.
          if (n < 1000) unpostable.add(id);
        }
      })();
      scheduler.setRules({ ...scheduler.rules(), order: "oldest" });
      const slots = Array.from({ length: 20 }, (_, n) =>
        everyDay(`${String(n).padStart(2, "0")}:30`, `slot${n}`),
      );
      previews = 0;
      const started = performance.now();
      expect(scheduler.setSchedule({ slots, timeZone: "UTC", graceMinutes: 120 })).toEqual({ ok: true });
      expect(performance.now() - started).toBeLessThan(2000);
      expect(previews).toBeLessThanOrEqual(PREVIEW_CAP);
      // A read previews no more than the cap either.
      previews = 0;
      scheduler.refresh();
      scheduler.attention();
      expect(previews).toBeLessThanOrEqual(PREVIEW_CAP);
    });
  });

  test("a slot's history follows its post to the end", async () => {
    const { scheduler, publisher } = await setup({
      wrapApi: (api) => ({
        ...api,
        createContainer: () => Promise.reject(new InstagramError("refused", "The image was refused.")),
      }),
    });
    await addSelect("portrait");
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
    await runUntil(scheduler, publisher, "2026-11-13T13:00:00Z");
    expect(scheduler.history()[0]).toMatchObject({ state: "posted", post: { state: "failed" } });
    expect(scheduler.history()[0]?.post?.error).toContain("refused");
  });

  test("a queued select whose post failed through no fault of its own goes back to its place and is next", async () => {
    let refuse = true;
    const { scheduler, publisher } = await setup({
      wrapApi: (api) => ({
        ...api,
        createContainer: (...args) =>
          refuse
            ? Promise.reject(new InstagramError("transient", "Instagram did not answer."))
            : api.createContainer(...args),
      }),
    });
    const a = await addSelect("portrait");
    const b = await addSelect("landscape");
    scheduler.setQueue([a, b]);
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
    await runUntil(scheduler, publisher, "2026-11-13T12:00:00Z");
    expect(scheduler.queue()).toEqual([b]);
    // Reordered while a is out: the queue the owner sees does not hold it.
    scheduler.setQueue([b]);
    for (const delay of RETRY_DELAYS) {
      clock.advance(delay);
      await publisher.runDue();
    }
    expect(publisher.posts().map((post) => post.state)).toEqual(["failed"]);
    expect(scheduler.queue()).toEqual([a, b]);
    refuse = false;
    await runUntil(scheduler, publisher, "2026-11-14T12:30:00Z");
    // Instagram not answering was not the select's doing: nothing holds it, and it is tried again.
    expect(postedSelects(publisher)).toEqual([a, a]);
    await runUntil(scheduler, publisher, "2026-11-15T12:30:00Z");
    expect(postedSelects(publisher)).toEqual([a, a, b]);
  });

  test("a post that fails for good returns its select to the pool, and the schedule keeps running", async () => {
    let refuse = true;
    const { scheduler, publisher } = await setup({
      wrapApi: (api) => ({
        ...api,
        createContainer: (...args) =>
          refuse
            ? Promise.reject(new InstagramError("refused", "The image was refused."))
            : api.createContainer(...args),
      }),
    });
    const id = await addSelect("portrait");
    scheduler.setQueue([id]);
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
    await runUntil(scheduler, publisher, "2026-11-13T13:00:00Z");
    expect(publisher.posts().map((post) => post.state)).toEqual(["failed"]);
    expect(library.get(id)?.inPool).toBe(true);
    refuse = false;
    // Held back the next day; the slot after it is cleared posts it.
    await runUntil(scheduler, publisher, "2026-11-14T13:00:00Z");
    expect(publisher.posts().map((post) => post.state)).toEqual(["failed"]);
    scheduler.clearHold(id);
    await runUntil(scheduler, publisher, "2026-11-15T13:00:00Z");
    expect(publisher.posts().map((post) => post.state)).toEqual(["published", "failed"]);
  });

  describe("a select Instagram refuses for good", () => {
    /** A scheduler whose fake Instagram refuses `refused`'s image, every time. */
    async function refusing() {
      const refused = new Set<string>();
      let sending: string | undefined;
      const context = await setup({
        wrapPublisher: (publisher) => ({
          ...publisher,
          publish: (request) => {
            sending = request.selectIds[0];
            return publisher.publish(request);
          },
        }),
        wrapApi: (api) => ({
          ...api,
          createContainer: (...args) =>
            sending !== undefined && refused.has(sending)
              ? Promise.reject(new InstagramError("refused", "The image was refused."))
              : api.createContainer(...args),
        }),
      });
      return { ...context, refused };
    }
    const states = (publisher: Publisher) =>
      publisher
        .posts()
        .reverse()
        .map((post) => [post.selectIds[0], post.state]);

    test("is held back from the queue's head, and the queue behind it posts", async () => {
      const { scheduler, publisher, refused } = await refusing();
      const bad = await addSelect("portrait");
      const good = await addSelect("landscape");
      const next = await addSelect("square");
      refused.add(bad);
      scheduler.setQueue([bad, good, next]);
      scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
      await runUntil(scheduler, publisher, "2026-11-15T13:00:00Z");
      expect(states(publisher)).toEqual([
        [bad, "failed"],
        [good, "published"],
        [next, "published"],
      ]);
      // It keeps its place in the queue.
      expect(scheduler.queue()).toEqual([bad]);
    });

    test("is held back from the pool under oldest first", async () => {
      const { scheduler, publisher, refused } = await refusing();
      const newest = await addSelect("portrait");
      const newer = await addSelect("landscape");
      const older = await addSelect("square");
      const bad = await addSelect("rotated");
      refused.add(bad);
      scheduler.setRules({ ...scheduler.rules(), order: "oldest" });
      scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
      await runUntil(scheduler, publisher, "2026-11-16T13:00:00Z");
      expect(states(publisher)).toEqual([
        [bad, "failed"],
        [older, "published"],
        [newer, "published"],
        [newest, "published"],
      ]);
    });

    test("is listed as needing attention with why, and when it will be tried again", async () => {
      const { scheduler, publisher, refused } = await refusing();
      const bad = await addSelect("portrait");
      refused.add(bad);
      scheduler.setQueue([bad]);
      scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
      await runUntil(scheduler, publisher, "2026-11-13T13:00:00Z");
      expect(scheduler.attention()).toEqual([
        {
          selectId: bad,
          fileName: expect.any(String),
          problems: [expect.stringContaining("refused")],
          heldUntil: at("2026-11-20T12:00:00Z"),
        },
      ]);
      expect(scheduler.upcoming()[0]?.selectId).toBeNull();
    });

    test("is tried again once 7 days have passed since it failed", async () => {
      const { scheduler, publisher, refused } = await refusing();
      const bad = await addSelect("portrait");
      refused.add(bad);
      scheduler.setQueue([bad]);
      scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
      await runUntil(scheduler, publisher, "2026-11-19T13:00:00Z", HOUR);
      expect(publisher.posts()).toHaveLength(1);
      refused.delete(bad);
      await runUntil(scheduler, publisher, "2026-11-20T13:00:00Z", HOUR);
      expect(states(publisher)).toEqual([
        [bad, "failed"],
        [bad, "published"],
      ]);
    });

    test("is eligible at once when its owner clears the hold", async () => {
      const { scheduler, publisher, refused } = await refusing();
      const bad = await addSelect("portrait");
      refused.add(bad);
      scheduler.setQueue([bad]);
      scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
      await runUntil(scheduler, publisher, "2026-11-13T13:00:00Z");
      expect(scheduler.clearHold(bad)).toBe(true);
      expect(scheduler.attention()).toEqual([]);
      expect(scheduler.upcoming()[0]?.selectId).toBe(bad);
      refused.delete(bad);
      await runUntil(scheduler, publisher, "2026-11-14T13:00:00Z");
      expect(states(publisher).at(-1)).toEqual([bad, "published"]);
      expect(scheduler.clearHold(bad)).toBe(false);
    });

    test("can still be posted now, and a newer failure replaces the hold", async () => {
      const { scheduler, publisher, refused } = await refusing();
      const bad = await addSelect("portrait");
      refused.add(bad);
      scheduler.setQueue([bad]);
      scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
      await runUntil(scheduler, publisher, "2026-11-13T13:00:00Z");
      clock.advance(2 * 24 * HOUR);
      const now = await postNow(publisher, bad);
      expect(now).toBe("failed");
      await scheduler.tick();
      expect(scheduler.attention()[0]?.heldUntil).toBe(at("2026-11-22T13:00:00Z"));
    });
  });

  test("an unconfirmed post keeps its select out of the pool", async () => {
    const { scheduler, publisher } = await setup({
      wrapApi: (api) => ({
        ...api,
        publish: () => Promise.reject(new InstagramError("transient", "Instagram did not answer.")),
      }),
    });
    const a = await addSelect("portrait");
    const b = await addSelect("landscape");
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
    await runUntil(scheduler, publisher, "2026-11-13T12:00:00Z");
    for (const delay of RETRY_DELAYS) {
      clock.advance(delay);
      await publisher.runDue();
    }
    expect(publisher.posts().map((post) => post.state)).toEqual(["unconfirmed"]);
    expect(library.get(a)?.inPool).toBe(false);
    await runUntil(scheduler, publisher, "2026-11-14T12:30:00Z");
    expect(postedSelects(publisher)).toEqual([a, b]);
  });
});

describe("pick rules", () => {
  test("are the scheduler's, and a change chooses next up again", async () => {
    const { scheduler } = await setup();
    await addSelect("portrait");
    const oldest = await addSelect("rotated");
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
    expect(scheduler.upcoming()[0]?.selectId).not.toBe(oldest);
    scheduler.setRules({ ...scheduler.rules(), order: "oldest" });
    expect(scheduler.upcoming()[0]?.selectId).toBe(oldest);
  });

  test("spacing by capture day counts the picks of earlier slots that have not posted yet", async () => {
    const { scheduler, publisher, captures } = await setup();
    const a = await addSelect("portrait");
    const b = await addSelect("landscape");
    const c = await addSelect("square");
    // a and b were taken the same day; c another.
    captures.save(b, { edits: { capturedAt: "2024-05-01T18:00:00" }, locationHidden: false });
    scheduler.setSchedule({
      slots: [everyDay("10:00", "ten"), everyDay("12:00", "noon")],
      timeZone: "UTC",
      graceMinutes: 120,
    });
    expect(scheduler.upcoming().map((run) => run.selectId)).toEqual([a, c]);
    await runUntil(scheduler, publisher, "2026-11-13T13:00:00Z");
    expect(postedSelects(publisher)).toEqual([a, c]);
    expect(b).toBeDefined();
  });

  test("a planned pick that no longer meets the rules when its slot comes is picked again", async () => {
    const { scheduler, publisher, captures } = await setup();
    const a = await addSelect("portrait");
    const b = await addSelect("landscape");
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
    expect(scheduler.upcoming()[0]?.selectId).toBe(a);
    // A posted by hand from the same capture day as a, before the slot comes.
    const sameDay = await addSelect("square");
    captures.save(sameDay, { edits: { capturedAt: "2024-05-01T08:00:00" }, locationHidden: false });
    const now = await publisher.publish({ selectIds: [sameDay] });
    if (now.status !== "started") throw new Error(now.status);
    await now.done;
    await runUntil(scheduler, publisher, "2026-11-13T12:30:00Z");
    expect(postedSelects(publisher)).toEqual([sameDay, b]);
  });

  test("spacing by place never puts a location in the logs", async () => {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...args) => void lines.push(args.join(" ")));
    const error = spyOn(console, "error").mockImplementation((...args) => void lines.push(args.join(" ")));
    try {
      const { scheduler, publisher } = await setup();
      await addSelect("portrait");
      await addSelect("landscape");
      scheduler.setRules({ ...scheduler.rules(), place: { on: true, km: 100, posts: 5 } });
      scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
      await runUntil(scheduler, publisher, "2026-11-14T13:00:00Z");
      expect(publisher.posts()).toHaveLength(2);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
    const text = lines.join("\n");
    for (const coordinate of ["10.5", "40.25", "35.125", "165.75"]) expect(text).not.toContain(coordinate);
  });
});

describe("what the Queue screen is told", () => {
  test("the next slot is the due time of the next run that will post, or nothing", async () => {
    const { scheduler } = await setup({ random: () => 0.5 });
    scheduler.setSchedule({
      slots: [everyDay("12:00", "noon", 20), everyDay("18:00", "evening")],
      timeZone: "UTC",
      graceMinutes: 120,
    });
    // Nothing to post: no run will post.
    expect(scheduler.nextSlotAt()).toBeNull();
    await addSelect("portrait");
    await addSelect("landscape");
    scheduler.refresh();
    // The spread's draw, not the slot's time.
    expect(scheduler.nextSlotAt()).toBe(at("2026-11-13T12:10:00Z"));
    scheduler.skip("noon", "2026-11-13");
    expect(scheduler.nextSlotAt()).toBe(at("2026-11-13T18:00:00Z"));
    scheduler.setPaused(true);
    expect(scheduler.nextSlotAt()).toBeNull();
  });

  test("each run names its select's file, posted or not", async () => {
    const { scheduler, publisher } = await setup();
    await addSelect("portrait");
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
    expect(scheduler.upcoming()[0]?.fileName).toBe("portrait.jpg");
    await runUntil(scheduler, publisher, "2026-11-13T13:00:00Z");
    expect(scheduler.history()[0]).toMatchObject({ state: "posted", fileName: "portrait.jpg" });
  });

  test("in dry run, what a real post would lack is still said", async () => {
    const { scheduler, settings } = await setup({ connect: false });
    await addSelect("portrait");
    settings.setPublishing({ dryRun: true });
    expect(scheduler.problems()).toEqual(["No Instagram account is connected."]);
  });

  test("logs name a run by its date and the slot's place, never the slot's ID", async () => {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...args) => void lines.push(args.join(" ")));
    const error = spyOn(console, "error").mockImplementation((...args) => void lines.push(args.join(" ")));
    try {
      const { scheduler, publisher } = await setup({ connect: false });
      await addSelect("portrait");
      scheduler.setSchedule({
        slots: [everyDay("12:00", "owners-private-name")],
        timeZone: "UTC",
        graceMinutes: 120,
      });
      await runUntil(scheduler, publisher, "2026-11-13T13:00:00Z");
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
    const text = lines.join("\n");
    expect(text).toContain("Slot 1 on 2026-11-13");
    expect(text).not.toContain("owners-private-name");
  });
});

describe("daylight saving", () => {
  // In New York, 2027-03-14 jumps from 02:00 to 03:00, and 2027-11-07 goes from 02:00 back to 01:00.
  async function dryRunsEachDay(time: string, from: string, to: string) {
    const { scheduler, publisher, settings } = await setup({ connect: false });
    await addSelect("portrait");
    settings.setPublishing({ dryRun: true });
    clock.advance(at(from) - clock.now());
    scheduler.setSchedule({ slots: [everyDay(time)], timeZone: "America/New_York", graceMinutes: 120 });
    await runUntil(scheduler, publisher, to, 10 * MINUTE);
    return scheduler
      .history()
      .reverse()
      .map((run) => `${run.date} ${run.state} ${new Date(run.dueAt).toISOString()}`);
  }

  test("a slot at a time skipped as the clocks go forward posts once that day", async () => {
    expect(await dryRunsEachDay("02:30", "2027-03-13T00:00:00Z", "2027-03-16T00:00:00Z")).toEqual([
      "2027-03-13 dry-run 2027-03-13T07:30:00.000Z",
      "2027-03-14 dry-run 2027-03-14T07:30:00.000Z",
      "2027-03-15 dry-run 2027-03-15T06:30:00.000Z",
    ]);
  });

  test("a slot at a time that happens twice as the clocks go back posts once that day", async () => {
    expect(await dryRunsEachDay("01:30", "2027-11-06T00:00:00Z", "2027-11-09T00:00:00Z")).toEqual([
      "2027-11-06 dry-run 2027-11-06T05:30:00.000Z",
      "2027-11-07 dry-run 2027-11-07T05:30:00.000Z",
      "2027-11-08 dry-run 2027-11-08T06:30:00.000Z",
    ]);
  });
});

describe("notifications", () => {
  test("each slot that came round is told to the notify seam", async () => {
    const events: ScheduleEvent[] = [];
    const { scheduler, publisher } = await setup({ notify: (event) => events.push(event) });
    const id = await addSelect("portrait");
    scheduler.setSchedule({ slots: [everyDay("12:00")], timeZone: "UTC", graceMinutes: 120 });
    await runUntil(scheduler, publisher, "2026-11-14T13:00:00Z");
    expect(events.map((event) => [event.kind, event.run.date, event.run.selectId])).toEqual([
      ["posted", "2026-11-13", id],
      ["empty", "2026-11-14", null],
    ]);
  });
});
