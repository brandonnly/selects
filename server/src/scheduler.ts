import type { Database } from "bun:sqlite";
import type { Captures } from "./capture";
import { type Clock, DAY, MINUTE } from "./clock";
import { errorKind, type Library } from "./library";
import { type Candidate, choose, DEFAULT_PICK_RULES, eligible, type PickRules } from "./pick";
import type { PostState, Publisher } from "./publisher";
import { isTimeZone, occurrenceOn, occurrences, type Slot } from "./slots";

/** The schedule as the owner sets it. */
export type Schedule = {
  slots: Slot[];
  /** IANA name. Slot times are wall-clock times here. */
  timeZone: string;
  /** How late a slot missed while Selects was down may still post. */
  graceMinutes: number;
};

export const DEFAULT_SCHEDULE: Schedule = { slots: [], timeZone: "UTC", graceMinutes: 120 };

/** How often the timer calls `tick`. */
export const SCHEDULE_INTERVAL_MS = 30 * 1000;

/**
 * How late a tick may find a slot and still count it as on time: one timer interval, and as much
 * again for a tick that runs late. Lateness past this is downtime, which the grace period covers,
 * so a grace period of 0 means "never post after downtime" and still posts on time.
 */
export const toleranceFor = (intervalMs: number) => 2 * intervalMs;

/** Limits on what the schedule editor can save. */
export const SCHEDULE_LIMITS = { slots: 50, spreadMinutes: 720, graceMinutes: 24 * 60 } as const;

/**
 * What became of a slot on one day.
 * - `planned`: still to come; `selectId` is next up once one is chosen, a day ahead.
 * - `skipped`: the owner skipped it; nothing posts.
 * - `posting`: claimed and handed to the publisher; set before it is called.
 * - `posted`: the publisher took a post for it. The post's own state says how that went.
 * - `dry-run`: dry run was on; a dry run was recorded and the select stayed where it was.
 * - `missed`: Selects was not running at its time, past the grace period, or a later slot
 *   posted in its place after a stop.
 * - `late`: Selects was running but checked later than the tolerance (a tick held up): past the
 *   grace period, or a later slot posted in its place.
 * - `paused`: the pause switch was on at its time.
 * - `empty`: nothing was left to post.
 * - `unavailable`: no account or bucket to publish with; nothing was taken from the queue.
 * - `failed`: the publisher could not start the post.
 */
export type RunState =
  | "planned"
  | "skipped"
  | "posting"
  | "posted"
  | "dry-run"
  | "missed"
  | "late"
  | "paused"
  | "empty"
  | "unavailable"
  | "failed";

/** A slot on one day, as the API shows it. Never a location. */
export type Run = {
  /** `<slotId>_<date>`: names the slot on its day in a URL. Never parsed by the UI as a date. */
  id: string;
  slotId: string;
  date: string;
  /** The slot's time that day, and when it posts: later by its random spread. */
  slotAt: number;
  dueAt: number;
  state: RunState;
  /** Next up, or what was posted. */
  selectId: string | null;
  /** Where next up came from: the head of the queue, the pool, or a swap. */
  picked: "queue" | "pool" | "swap" | null;
  postId: string | null;
  /** What became of the post it made, followed to the end: published, failed, waiting to be checked. */
  post: { state: PostState; error: string | null } | null;
  /** The file name of `selectId`'s select, while it exists. */
  fileName: string | null;
  note: string | null;
};

/**
 * A select slots pass over: one that cannot be posted as it stands, until it is fixed, or one
 * whose latest post failed for good, until `heldUntil` or until its owner clears the hold.
 */
export type Attention = {
  selectId: string;
  fileName: string;
  problems: string[];
  /** When a select held back after a failed post is tried again; null when it is not held. */
  heldUntil: number | null;
};

/** What the scheduler did, for notifications (issue #10). */
export type ScheduleEvent = { kind: Exclude<RunState, "planned" | "posting" | "skipped">; run: Run };

export type SchedulerOptions = {
  db: Database;
  library: Library;
  captures: Captures;
  /** The only way the scheduler posts. */
  publisher: Pick<Publisher, "publish" | "preview">;
  clock: Clock;
  /** Draws each slot's spread and random picks. Default: Math.random. */
  random?: () => number;
  /** Told about each slot that came round. Issue #10 sends notifications from here. */
  notify?: (event: ScheduleEvent) => void;
  /** How often the timer calls `tick`. Default: `SCHEDULE_INTERVAL_MS`. */
  intervalMs?: number;
};

type RunRow = {
  slot_id: string;
  date: string;
  slot_at: number;
  due_at: number;
  select_id: string | null;
  picked: Run["picked"];
  passed: string;
  state: RunState;
  claimed_at: number | null;
  post_id: string | null;
  note: string | null;
};

/** A slot as stored: with when it last changed, so a slot never posts for a time before it existed. */
type StoredSlot = Slot & { since: number };
type StoredSchedule = Omit<Schedule, "slots"> & { slots: StoredSlot[] };

const MISSED_PAST_GRACE = "Selects was not running at its time, and the grace period has passed.";
const MISSED_STACKED =
  "Selects was not running at its time. Missed slots never stack: only the latest within the grace period may post.";
const NOTHING_POSTABLE =
  "Nothing left could be posted as it stands: the selects that need attention are on the Queue screen.";
const LATE_PAST_GRACE =
  "Selects was running but checked more than a minute late, and the grace period has passed.";
const LATE_STACKED =
  "Selects was running but checked more than a minute late. Late slots never stack: only the latest within the grace period may post.";

/** How long a select whose post failed for good is held back from slots. */
export const HOLD_MS = 7 * DAY;
/**
 * How many selects one plan, or one read of the schedule, checks for what would be sent. Picks
 * past these are taken as postable until their turn comes; each is checked before it posts.
 */
export const PREVIEW_CAP = 50;
/** Of those, how many listed as needing attention are checked again, oldest check first. */
const RECHECK = 20;
/** How many times a slot about to post plans again when next up turns out not to be postable. */
const VERIFY_TRIES = 20;
/** A last tick this recent means Selects was running: a slot found late was a tick held up. */
const RUNNING_WITHIN = 10;
/** How many times a hashtag set is drawn for a post before its select is taken as not postable. */
const HASHTAG_DRAWS = 8;

/** How far ahead next up is chosen. */
const LOOKAHEAD = DAY;
/** Slots that came round are kept this long. */
const KEEP_RUNS = 30 * DAY;

/**
 * Posts on the schedule (docs/PRODUCT.md, "Picking" and "Schedule"; ADR 0007). `tick` is called
 * on a timer: it records each slot coming round in the next day with its random spread drawn
 * once, chooses next up a day ahead, and posts the slots that are due through the publisher.
 *
 * A slot posts at most once on a day: its row is claimed (`posting`) before the publisher is
 * called, and `recover` settles a claim a stop left behind by finding the post it made, or
 * letting the slot post again within the grace period when it made none.
 */
export function createScheduler(options: SchedulerOptions) {
  const { db, library, captures, publisher, clock } = options;
  const random = options.random ?? Math.random;
  const notify = options.notify ?? (() => {});

  const postOf = (id: string | null) =>
    id === null
      ? null
      : db
          .query<{ state: PostState; error: string | null }, [string]>(
            "SELECT state, error FROM posts WHERE id = ?",
          )
          .get(id);

  const toRun = (row: RunRow): Run => ({
    id: `${row.slot_id}_${row.date}`,
    slotId: row.slot_id,
    date: row.date,
    slotAt: row.slot_at,
    dueAt: row.due_at,
    state: row.state,
    selectId: row.select_id,
    picked: row.picked,
    postId: row.post_id,
    post: postOf(row.post_id),
    fileName: row.select_id === null ? null : (library.get(row.select_id)?.fileName ?? null),
    note: row.note,
  });
  const interval = options.intervalMs ?? SCHEDULE_INTERVAL_MS;
  const tolerance = toleranceFor(interval);

  const readSetting = <T>(key: string): T | undefined => {
    const row = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key);
    return row === null ? undefined : (JSON.parse(row.value) as T);
  };
  const writeSetting = (key: string, value: unknown) =>
    db
      .query(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(key, JSON.stringify(value));

  const stored = (): StoredSchedule => ({
    ...DEFAULT_SCHEDULE,
    slots: [],
    ...readSetting<StoredSchedule>("schedule"),
  });
  const rules = (): PickRules => {
    const saved = readSetting<Partial<PickRules>>("pickRules");
    return {
      captureDay: { ...DEFAULT_PICK_RULES.captureDay, ...saved?.captureDay },
      place: { ...DEFAULT_PICK_RULES.place, ...saved?.place },
      order: saved?.order ?? DEFAULT_PICK_RULES.order,
    };
  };
  const paused = () => readSetting<boolean>("schedulePaused") ?? false;

  const runRow = (slotId: string, date: string) =>
    db
      .query<RunRow, [string, string]>("SELECT * FROM slot_runs WHERE slot_id = ? AND date = ?")
      .get(slotId, date);

  const queued = (): string[] =>
    db
      .query<{ select_id: string }, []>("SELECT select_id FROM queue ORDER BY position")
      .all()
      .map((row) => row.select_id)
      .filter((id) => library.get(id)?.inPool === true);

  const candidate = (id: string): Candidate | undefined => {
    const select = library.get(id);
    if (select === undefined) return undefined;
    // The owner's view, edits applied: the place rule is about variety and never publishes.
    const seen = captures.withEdits(select);
    return {
      id,
      capturedAt: seen.capturedAt,
      location:
        seen.latitude === null || seen.longitude === null
          ? null
          : { latitude: seen.latitude, longitude: seen.longitude },
    };
  };

  /** The selects of the latest posts, newest first: those out, and those on their way. */
  const recent = (count: number): Candidate[] =>
    db
      .query<{ select_id: string }, [number]>(
        `SELECT post_selects.select_id FROM posts JOIN post_selects ON post_selects.post_id = posts.id
         WHERE posts.state IN ('publishing', 'retrying', 'unconfirmed', 'published') AND post_selects.select_id IS NOT NULL
         ORDER BY posts.created_at DESC, posts.rowid DESC LIMIT ?`,
      )
      .all(count)
      .map((row) => candidate(row.select_id))
      .filter((found) => found !== undefined);

  /**
   * What stops a select being posted as it stands: the caption or alt text over a limit, or the
   * select gone. Not the account or the bucket, which stop every select alike.
   */
  const problemsOf = (id: string): string[] => {
    const preview = publisher.preview([id]);
    return preview === undefined ? ["The select is gone."] : preview.check.problems;
  };
  /**
   * Selects found not postable as they stand, with why. Kept across plans, so the Queue screen
   * lists them until they are fixed or leave the pool; each plan checks a few of them again, the
   * longest unchecked first (a check moves one to the end).
   */
  const unpostable = new Map<string, string[]>();
  /** Selects the latest plan checked and found postable. */
  let verified = new Set<string>();

  /** Records each post that failed for good as Selects first sees it: from then it holds its select back. */
  const noteFailures = (now: number) =>
    db
      .query(
        `INSERT INTO post_failures (post_id, failed_at) SELECT id, ? FROM posts
         WHERE state = 'failed' AND id NOT IN (SELECT post_id FROM post_failures)`,
      )
      .run(now);

  type Hold = { postId: string; until: number; error: string | null };
  /**
   * Selects held back from slots: those whose latest post (dry runs aside) failed for good less
   * than `HOLD_MS` ago because of the select itself (Instagram refused its image or caption), and
   * whose owner has not cleared the hold. A failure that was not the select's (a refused token,
   * Instagram not answering, an edit made while it retried) holds nothing: the next slot tries it
   * again. A later post replaces the hold.
   */
  const holds = (now: number): Map<string, Hold> => {
    noteFailures(now);
    const rows = db
      .query<{ select_id: string; post_id: string; failed_at: number; error: string | null }, [number]>(
        `SELECT post_selects.select_id, posts.id AS post_id, post_failures.failed_at, posts.error
         FROM post_failures JOIN posts ON posts.id = post_failures.post_id
         JOIN post_selects ON post_selects.post_id = posts.id
         WHERE post_failures.cleared = 0 AND post_failures.failed_at > ? AND posts.state = 'failed'
           AND posts.failure_kind = 'select'
           AND post_selects.select_id IS NOT NULL
           AND posts.id = (
             SELECT latest.id FROM posts AS latest JOIN post_selects AS its ON its.post_id = latest.id
             WHERE its.select_id = post_selects.select_id AND latest.state != 'dry-run'
             ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1)`,
      )
      .all(now - HOLD_MS);
    return new Map(
      rows.map((row) => [
        row.select_id,
        { postId: row.post_id, until: row.failed_at + HOLD_MS, error: row.error },
      ]),
    );
  };

  /** Queued selects whose post was published, or that were marked as posted, leave the queue. */
  function pruneQueue() {
    const remove = db.query("DELETE FROM queue WHERE select_id = ?");
    for (const { select_id } of db.query<{ select_id: string }, []>("SELECT select_id FROM queue").all()) {
      const select = library.get(select_id);
      if (select === undefined || select.alreadyPosted || select.post === "published") remove.run(select_id);
    }
  }

  /** Drawn once and stored with the row: a whole minute from 0 to the spread, never drawn again. */
  const drawSpread = (slot: Slot) => Math.floor(random() * (slot.spreadMinutes + 1)) * MINUTE;

  const inPool = (id: string | null) => id !== null && library.get(id)?.inPool === true;

  /**
   * Records each slot coming round up to a day ahead, spread drawn once, and back to the grace
   * period, or to the last tick before a stop (within the history kept) so the runs a stop missed
   * are recorded as missed.
   */
  function plan(now: number) {
    const schedule = stored();
    if (schedule.slots.length === 0) return;
    const grace = schedule.graceMinutes * MINUTE;
    const widest = Math.max(...schedule.slots.map((slot) => slot.spreadMinutes)) * MINUTE;
    const ticked = readSetting<number>("scheduleTickedAt");
    const from = Math.max(now - KEEP_RUNS, Math.min(ticked ?? now, now - grace - widest - tolerance));
    const insert = db.query(
      `INSERT OR IGNORE INTO slot_runs (slot_id, date, slot_at, due_at, state) VALUES (?, ?, ?, ?, 'planned')`,
    );
    for (const found of occurrences(schedule.slots, schedule.timeZone, from, now + LOOKAHEAD)) {
      const slot = schedule.slots.find((s) => s.id === found.slotId);
      // A slot never posts for a time before it was added or last changed.
      if (slot === undefined || found.at < slot.since) continue;
      insert.run(found.slotId, found.date, found.at, found.at + drawSpread(slot));
    }
  }

  /**
   * Plans next up for every slot still to come, soonest first, counting each earlier slot's pick
   * as posted. A swap stands while its select is free. Any other slot takes the queue's head while
   * the queue has a free select, so planned pool picks give way to it; otherwise it keeps its pool
   * pick while the pick rules still allow it, or picks again. `swapping` names a slot to choose
   * afresh for, passing over what it holds. Runs before a slot posts, after every change to who is
   * free, and whenever next up is shown. Returns false when the swapped slot found nothing.
   */
  function replan(swapping?: { slotId: string; date: string }): boolean {
    pruneQueue();
    const held = holds(clock.now());
    const poolIds = library.pool();
    const inPoolNow = new Set(poolIds);
    let previews = 0;
    const check = (id: string) => {
      previews++;
      return problemsOf(id);
    };
    /** What this plan found, select by select: each is checked at most once. */
    const checked = new Map<string, boolean>();
    verified = new Set();
    const record = (id: string, problems: string[]) => {
      unpostable.delete(id);
      if (problems.length > 0) unpostable.set(id, problems);
      checked.set(id, problems.length === 0);
      if (problems.length === 0) verified.add(id);
    };
    // Those listed that left the pool leave the list; a few of the rest are checked again.
    for (const id of [...unpostable.keys()]) if (!inPoolNow.has(id)) unpostable.delete(id);
    for (const id of [...unpostable.keys()].slice(0, RECHECK)) record(id, check(id));
    const rows = db
      .query<RunRow, []>("SELECT * FROM slot_runs WHERE state = 'planned' ORDER BY due_at, slot_id")
      .all();
    if (rows.length === 0) {
      // With no slot to plan, the queue is still checked, so what needs attention shows.
      for (const id of queued()) {
        if (previews >= PREVIEW_CAP) break;
        if (!checked.has(id) && !unpostable.has(id) && !held.has(id)) record(id, check(id));
      }
      return false;
    }
    /** True when the select can be posted as it stands, as far as this plan has checked. */
    const postable = (id: string) => {
      if (held.has(id)) return false;
      const known = checked.get(id);
      if (known !== undefined) return known;
      if (unpostable.has(id)) return false;
      // Past the cap, taken as postable until its turn: a slot checks next up before it posts.
      if (previews >= PREVIEW_CAP) return true;
      record(id, check(id));
      return checked.get(id) as boolean;
    };
    const current = rules();
    // Built once for the plan, without the selects already known to be held back.
    const pool = poolIds
      .filter((id) => !held.has(id) && !unpostable.has(id))
      .map(candidate)
      .filter((found) => found !== undefined);
    const free = inPoolNow;
    const queue = queued();
    const isSwapping = (row: RunRow) => row.slot_id === swapping?.slotId && row.date === swapping.date;
    const swapStands = (row: RunRow) =>
      row.picked === "swap" &&
      !isSwapping(row) &&
      row.select_id !== null &&
      free.has(row.select_id) &&
      postable(row.select_id);
    // Swaps are the owner's: they hold their selects before anything is planned around them.
    const taken = new Set(rows.filter(swapStands).map((row) => row.select_id as string));
    const real = recent(Math.max(current.captureDay.posts, current.place.posts));
    /** The picks of earlier slots, newest first: counted as posted. */
    const ahead: Candidate[] = [];
    const update = db.query(
      "UPDATE slot_runs SET select_id = ?, picked = ? WHERE slot_id = ? AND date = ? AND state = 'planned'",
    );
    /**
     * A pool pick under the rules: the one planned while the rules still allow it, or another in
     * the rules' order, passing over those that cannot be posted. The rules are worked out once
     * for each step of relaxing them, never once per select passed over.
     */
    const pickFromPool = (row: RunRow, excluded: Set<string>): string | null => {
      for (;;) {
        const found = eligible({ pool, recent: [...ahead, ...real], rules: current, exclude: excluded });
        if (found === undefined) return null;
        const planned = row.select_id;
        if (
          row.picked === "pool" &&
          !isSwapping(row) &&
          planned !== null &&
          found.candidates.some((candidate) => candidate.id === planned) &&
          postable(planned)
        )
          return planned;
        const left = [...found.candidates];
        while (left.length > 0) {
          const next = choose(left, current.order, random);
          if (postable(next.id)) return next.id;
          excluded.add(next.id);
          left.splice(left.indexOf(next), 1);
        }
      }
    };
    let swapped = false;
    for (const row of rows) {
      let selectId: string | null = null;
      let picked: Run["picked"] = null;
      if (swapStands(row)) {
        selectId = row.select_id;
        picked = "swap";
      } else {
        const passed = JSON.parse(row.passed) as string[];
        // Passed over in a swap is a preference: a select passed over still posts when nothing else is left.
        for (const exclude of isSwapping(row)
          ? [[...taken, ...passed]]
          : [[...taken, ...passed], [...taken]]) {
          const excluded = new Set(exclude);
          const head = queue.find((id) => !excluded.has(id) && postable(id));
          if (head !== undefined) {
            selectId = head;
            picked = "queue";
            break;
          }
          selectId = pickFromPool(row, excluded);
          if (selectId !== null) {
            picked = "pool";
            break;
          }
        }
        if (isSwapping(row)) {
          swapped = selectId !== null;
          if (swapped) picked = "swap";
        }
      }
      if (selectId !== row.select_id || picked !== row.picked) {
        update.run(selectId, picked, row.slot_id, row.date);
      }
      if (selectId !== null) {
        taken.add(selectId);
        const found = candidate(selectId);
        if (found !== undefined) ahead.unshift(found);
      }
    }
    return swapped;
  }

  const finish = (
    row: RunRow,
    state: RunState,
    fields: { note?: string | null; postId?: string | null; selectId?: string | null } = {},
  ) => {
    db.query(
      "UPDATE slot_runs SET state = ?, note = ?, post_id = ?, select_id = ? WHERE slot_id = ? AND date = ?",
    ).run(
      state,
      fields.note ?? null,
      fields.postId ?? row.post_id,
      fields.selectId === undefined ? row.select_id : fields.selectId,
      row.slot_id,
      row.date,
    );
    const done = runRow(row.slot_id, row.date);
    if (done !== null && state !== "planned" && state !== "posting" && state !== "skipped") {
      notify({ kind: state, run: toRun(done) });
    }
  };

  /**
   * Posts the slots that are due. A slot found within the timer's tolerance is on time, and
   * posts; every such slot posts, one after another. A slot found later than that came due while
   * Selects was not running, or while it ran but checked late (`running`: the last tick was
   * recent): of those, only the latest posts, only within the grace period, and only when no slot
   * on time posts in its place. Late slots never stack.
   *
   * Each slot is read again after the one before it posted, as posting awaits: one paused, moved
   * later, skipped or settled meanwhile does not post now.
   */
  async function fire(now: number, running: boolean) {
    const due = db
      .query<RunRow, [number]>(
        "SELECT * FROM slot_runs WHERE state = 'planned' AND due_at <= ? ORDER BY due_at, slot_id",
      )
      .all(now);
    if (due.length === 0) return;
    const grace = stored().graceMinutes * MINUTE;
    const onTime = (row: RunRow) => now - row.due_at <= tolerance;
    const withinGrace = (row: RunRow) => now - row.due_at <= grace + tolerance;
    const lateState = running ? "late" : "missed";
    const pastGrace = running ? LATE_PAST_GRACE : MISSED_PAST_GRACE;
    if (paused()) {
      for (const row of due) {
        if (withinGrace(row)) finish(row, "paused", { note: "Posting was paused." });
        else finish(row, lateState, { note: pastGrace });
      }
      return;
    }
    const timely = due.filter(onTime);
    const late = due.filter((row) => !onTime(row));
    // Of the late slots, the latest within grace posts, unless one on time posts instead.
    const survivor = timely.length === 0 ? late.filter(withinGrace).at(-1) : undefined;
    for (const row of late) {
      if (row === survivor) continue;
      finish(row, lateState, {
        note: withinGrace(row) ? (running ? LATE_STACKED : MISSED_STACKED) : pastGrace,
      });
    }
    for (const row of survivor === undefined ? timely : [survivor]) {
      const current = ready(row);
      if (current === undefined) continue;
      if (paused()) {
        finish(current, "paused", { note: "Posting was paused." });
        continue;
      }
      await post(current);
    }
  }

  /**
   * A due run as it stands now, with next up planned again and checked: who is free changed with
   * each slot settled before it. Undefined when it is no longer to post now: settled, skipped or
   * moved later meanwhile, or left with nothing that can be posted.
   */
  function ready(row: RunRow): RunRow | undefined {
    for (let tries = 0; ; tries++) {
      replan();
      const current = runRow(row.slot_id, row.date);
      if (current?.state !== "planned" || current.due_at > clock.now()) return undefined;
      const id = current.select_id;
      // A pick past the plan's cap was taken as postable: it is checked now, before it posts.
      if (id === null || verified.has(id)) return current;
      const problems = problemsOf(id);
      if (problems.length === 0) return current;
      unpostable.set(id, problems);
      if (tries >= VERIFY_TRIES) {
        finish(current, "empty", { note: NOTHING_POSTABLE, selectId: null });
        return undefined;
      }
    }
  }

  /** A run, for the logs: by its date and the slot's place in the schedule, never the slot's ID. */
  const label = (row: RunRow) => {
    const place = stored().slots.findIndex((slot) => slot.id === row.slot_id);
    return `${place < 0 ? "A removed slot" : `Slot ${place + 1}`} on ${row.date}`;
  };

  async function post(row: RunRow) {
    const selectId = row.select_id;
    if (selectId === null || !inPool(selectId)) {
      const note =
        unpostable.size > 0 || holds(clock.now()).size > 0 ? NOTHING_POSTABLE : "Nothing left to post.";
      finish(row, "empty", { note, selectId: null });
      return;
    }
    // The hashtag set is drawn here and sent with the post, so the caption checked is the caption
    // posted. A draw whose caption is over a limit is drawn again; a select no draw fits is left
    // as needing attention.
    let hashtagSet: string | undefined;
    let fits = false;
    let problems: string[] = [];
    for (let draw = 0; draw < HASHTAG_DRAWS && !fits; draw++) {
      const shown = publisher.preview([selectId]);
      problems = shown === undefined ? ["The select is gone."] : shown.check.problems;
      fits = problems.length === 0;
      hashtagSet = shown?.hashtagSet ?? undefined;
    }
    if (!fits) {
      unpostable.set(selectId, problems);
      finish(row, "empty", { note: NOTHING_POSTABLE, selectId: null });
      return;
    }
    // Claimed before the publisher is called: from here a restart finds it and never posts it twice.
    const claimed = db
      .query(
        "UPDATE slot_runs SET state = 'posting', select_id = ?, claimed_at = ? WHERE slot_id = ? AND date = ? AND state = 'planned'",
      )
      .run(selectId, clock.now(), row.slot_id, row.date);
    if (claimed.changes !== 1) return;
    const claimedRow = runRow(row.slot_id, row.date) ?? row;
    let result: Awaited<ReturnType<typeof publisher.publish>>;
    try {
      result = await publisher.publish({ selectIds: [selectId], hashtagSet });
    } catch (error) {
      finish(claimedRow, "failed", { note: `The post could not be started (${errorKind(error)}).` });
      console.error(`${label(row)} could not post (${errorKind(error)}).`);
      return;
    }
    switch (result.status) {
      case "started": {
        // A failed publish is handled by the publisher: retries, then back to the pool.
        result.done.then(() => replan()).catch(() => {});
        settle(claimedRow, result.post.id, result.post.state === "dry-run");
        console.log(
          `${label(row)}: ${result.post.state === "dry-run" ? "dry run" : "post"} ${result.post.id}.`,
        );
        return;
      }
      case "unavailable":
        // Nothing was taken: the select stays queued or in the pool for the next slot.
        finish(claimedRow, "unavailable", { note: result.problems.join(" ") });
        console.error(`${label(row)} did not post: publishing is unavailable.`);
        return;
      case "not-found":
      case "not-in-pool":
        finish(claimedRow, "failed", { note: "Next up left the pool as it was being posted." });
        return;
      case "changed":
        finish(claimedRow, "failed", { note: result.changes.join(" ") });
        return;
    }
  }

  /**
   * Records the post a claimed slot made. A queued select stays in the queue until its post is
   * published, so one whose post fails for good is back at the head.
   */
  function settle(row: RunRow, postId: string, dryRun: boolean) {
    finish(row, dryRun ? "dry-run" : "posted", { postId });
  }

  function prune(now: number) {
    db.query("DELETE FROM slot_runs WHERE state != 'planned' AND state != 'posting' AND slot_at < ?").run(
      now - KEEP_RUNS,
    );
  }

  /** When this process last finished a tick. */
  let lastTick: number | undefined;
  let running: Promise<void> | undefined;
  async function tickNow() {
    const now = clock.now();
    // A tick this recent means Selects was running: a slot found late was a tick held up.
    // Kept in memory, so a tick just after a restart is never taken for a tick held up.
    const last = lastTick;
    const running = last !== undefined && now - last <= RUNNING_WITHIN * interval;
    plan(now);
    writeSetting("scheduleTickedAt", now);
    // Settles what is missed or paused first, then plans again before each slot posts.
    await fire(now, running);
    replan();
    prune(now);
    // Posting may take minutes: the next tick counts from the end of this one.
    writeSetting("scheduleTickedAt", clock.now());
    lastTick = clock.now();
  }

  const planned = (slotId: string, date: string) => {
    const row = runRow(slotId, date);
    return row?.state === "planned" ? row : undefined;
  };

  return {
    /** Plans, chooses next up and posts what is due. Called on a timer; a call while one runs joins it. */
    tick(): Promise<void> {
      if (running !== undefined) return running;
      running = tickNow().finally(() => {
        running = undefined;
      });
      return running;
    },

    /**
     * Settles slots a stop left claimed. One whose post was made is recorded with it; one that
     * made none goes back to planned, to post now if still within the grace period. Called once at
     * start, before the first tick.
     */
    recover(): void {
      const claimed = db.query<RunRow, []>("SELECT * FROM slot_runs WHERE state = 'posting'").all();
      for (const row of claimed) {
        const made = db
          .query<{ id: string; state: string }, [string, number]>(
            `SELECT posts.id, posts.state FROM posts JOIN post_selects ON post_selects.post_id = posts.id
             WHERE post_selects.select_id = ? AND posts.created_at >= ? ORDER BY posts.created_at, posts.rowid LIMIT 1`,
          )
          .get(row.select_id ?? "", row.claimed_at ?? 0);
        if (made !== null) {
          settle(row, made.id, made.state === "dry-run");
        } else {
          db.query(
            "UPDATE slot_runs SET state = 'planned', claimed_at = NULL WHERE slot_id = ? AND date = ?",
          ).run(row.slot_id, row.date);
        }
      }
    },

    schedule(): Schedule {
      const { slots, timeZone, graceMinutes } = stored();
      return {
        slots: slots.map(({ id, days, time, spreadMinutes }) => ({ id, days, time, spreadMinutes })),
        timeZone,
        graceMinutes,
      };
    },

    /**
     * Saves the schedule. A slot added or changed posts only from its next time on. A skip stays
     * with the day it was made for, whatever is edited; a slot moved later than a time it missed
     * that day comes round again at the new time.
     */
    setSchedule(next: Schedule): { ok: true } | { ok: false; problems: string[] } {
      const problems = scheduleProblems(next);
      if (problems.length > 0) return { ok: false, problems };
      const now = clock.now();
      const before = stored();
      const zoneChanged = before.timeZone !== next.timeZone;
      const slots: StoredSlot[] = next.slots.map((slot) => {
        const days = [...new Set(slot.days)].sort();
        const old = before.slots.find((s) => s.id === slot.id);
        const same =
          old !== undefined &&
          !zoneChanged &&
          old.time === slot.time &&
          old.spreadMinutes === slot.spreadMinutes &&
          JSON.stringify(old.days) === JSON.stringify(days);
        return { ...slot, days, since: same ? old.since : now };
      });
      db.transaction(() => {
        writeSetting("schedule", { ...next, slots });
        const remove = db.query("DELETE FROM slot_runs WHERE slot_id = ? AND date = ?");
        const move = db.query("UPDATE slot_runs SET slot_at = ?, due_at = ? WHERE slot_id = ? AND date = ?");
        for (const row of db
          .query<RunRow, []>("SELECT * FROM slot_runs WHERE state NOT IN ('posting', 'posted', 'dry-run')")
          .all()) {
          const slot = slots.find((s) => s.id === row.slot_id);
          const toCome = row.state === "planned" || row.state === "skipped";
          if (slot === undefined) {
            if (toCome) remove.run(row.slot_id, row.date);
            continue;
          }
          if (slot.since !== now) continue;
          const slotAt = occurrenceOn(slot, row.date, next.timeZone);
          if (!toCome) {
            // Missed, paused or not posted earlier that day: a later new time comes round again.
            if (slotAt !== undefined && slotAt > now && slotAt !== row.slot_at)
              remove.run(row.slot_id, row.date);
            continue;
          }
          // No longer one of its days: nothing comes round, and nothing is left to skip.
          if (slotAt === undefined) {
            remove.run(row.slot_id, row.date);
            continue;
          }
          const old = before.slots.find((s) => s.id === slot.id);
          const spread =
            old?.spreadMinutes === slot.spreadMinutes
              ? Math.min(row.due_at - row.slot_at, slot.spreadMinutes * MINUTE)
              : drawSpread(slot);
          // Moved to a time already past: it posts from its next time on, whatever its spread. A
          // skip stays, for that day.
          if (row.state === "planned" && slotAt <= now) {
            // Its time unchanged and already past, still waiting on its spread: it stands as
            // drawn, so an edit to its days or spread never drops today's post.
            if (slotAt !== row.slot_at) remove.run(row.slot_id, row.date);
          } else move.run(slotAt, slotAt + spread, row.slot_id, row.date);
        }
      })();
      plan(now);
      replan();
      return { ok: true };
    },

    rules,

    setRules(next: PickRules): PickRules {
      writeSetting("pickRules", next);
      // Pool picks are made again under the new rules.
      db.query(
        "UPDATE slot_runs SET select_id = NULL, picked = NULL WHERE state = 'planned' AND picked = 'pool'",
      ).run();
      replan();
      return next;
    },

    paused,

    setPaused(value: boolean): boolean {
      writeSetting("schedulePaused", value);
      replan();
      return value;
    },

    /** Queued select IDs, in order: those still in the pool. */
    queue: queued,

    /** Replaces the queue with these selects, in this order. Any not in the pool are left out. */
    setQueue(ids: string[]): string[] {
      const keep = [...new Set(ids)].filter((id) => library.get(id)?.inPool === true);
      // A queued select out in a post the owner cannot see stays at the head, to come back if it fails.
      const out = db
        .query<{ select_id: string }, []>("SELECT select_id FROM queue ORDER BY position")
        .all()
        .map((row) => row.select_id)
        .filter((id) => !keep.includes(id) && library.get(id)?.inPool === false);
      db.transaction(() => {
        db.query("DELETE FROM queue").run();
        for (const [position, id] of [...out, ...keep].entries()) {
          db.query("INSERT INTO queue (select_id, position) VALUES (?, ?)").run(id, position);
        }
      })();
      replan();
      return queued();
    },

    /** Slots still to come within a day, soonest first, with next up. A skipped one shows until its time. */
    upcoming(): Run[] {
      return db
        .query<RunRow, [number]>(
          `SELECT * FROM slot_runs WHERE state IN ('planned', 'posting') OR (state = 'skipped' AND due_at > ?)
           ORDER BY due_at, slot_id`,
        )
        .all(clock.now())
        .map(toRun);
    },

    /** Slots that came round, latest first: skipped ones once their time has passed. */
    history(limit = 20): Run[] {
      return db
        .query<RunRow, [number, number]>(
          `SELECT * FROM slot_runs WHERE state NOT IN ('planned', 'posting', 'skipped') OR (state = 'skipped' AND due_at <= ?)
           ORDER BY due_at DESC, slot_id DESC LIMIT ?`,
        )
        .all(clock.now(), limit)
        .map(toRun);
    },

    /** When the next run that will post is due: planned, with next up, and not paused. Null if none. */
    nextSlotAt(): number | null {
      if (paused()) return null;
      const next = db
        .query<{ due_at: number }, []>(
          "SELECT due_at FROM slot_runs WHERE state = 'planned' AND select_id IS NOT NULL ORDER BY due_at LIMIT 1",
        )
        .get();
      return next?.due_at ?? null;
    },

    /** Plans next up again, as it would be before a slot posts. Called before next up is shown. */
    refresh(): void {
      replan();
    },

    /** What would stop a real post now: no account, no bucket. Said in dry run too. */
    problems(): string[] {
      const any = queued()[0] ?? library.pool()[0];
      if (any === undefined) return [];
      const preview = publisher.preview([any]);
      if (preview === undefined) return [];
      // The preview lists the select's own problems first, then those that stop every post.
      return preview.problems.slice(preview.check.problems.length);
    },

    /**
     * Selects slots pass over, with why: those found not postable as they stand, and those held
     * back after a failed post. Reads only what the plans found: it previews nothing itself.
     */
    attention(): Attention[] {
      const held = holds(clock.now());
      const ids = [...new Set([...unpostable.keys(), ...held.keys()])].filter(inPool);
      return ids.map((selectId) => {
        const hold = held.get(selectId);
        return {
          selectId,
          fileName: library.get(selectId)?.fileName ?? "A deleted select",
          problems: [
            ...(unpostable.get(selectId) ?? []),
            ...(hold === undefined ? [] : [`Its last post failed: ${hold.error ?? "no reason was given."}`]),
          ],
          heldUntil: hold?.until ?? null,
        };
      });
    },

    /** Lets a select held back after a failed post be picked again at once. False if it was not held. */
    clearHold(selectId: string): boolean {
      const hold = holds(clock.now()).get(selectId);
      if (hold === undefined) return false;
      db.query("UPDATE post_failures SET cleared = 1 WHERE post_id = ?").run(hold.postId);
      replan();
      return true;
    },

    /**
     * Chooses another next up for a slot to come, passing over each select in turn and coming
     * round again once all have been passed. "none" when there is nothing else to choose.
     */
    swap(slotId: string, date: string): Run | "not-found" | "none" {
      replan();
      const row = planned(slotId, date);
      if (row === undefined) return "not-found";
      const current = row.select_id === null ? [] : [row.select_id];
      const setPassed = db.query("UPDATE slot_runs SET passed = ? WHERE slot_id = ? AND date = ?");
      setPassed.run(JSON.stringify([...(JSON.parse(row.passed) as string[]), ...current]), slotId, date);
      if (!replan({ slotId, date })) {
        // Every other select has been passed over: round again from the start.
        setPassed.run(JSON.stringify(current), slotId, date);
        if (!replan({ slotId, date })) {
          db.query(
            "UPDATE slot_runs SET select_id = ?, picked = ?, passed = ? WHERE slot_id = ? AND date = ?",
          ).run(row.select_id, row.picked, row.passed, slotId, date);
          replan();
          return "none";
        }
      }
      replan();
      return toRun(runRow(slotId, date) as RunRow);
    },

    /** Leaves a slot to come empty. Its select stays where it was, free for the slots after. */
    skip(slotId: string, date: string): Run | "not-found" {
      const row = planned(slotId, date);
      if (row === undefined) return "not-found";
      db.query(
        "UPDATE slot_runs SET state = 'skipped', select_id = NULL, picked = NULL, passed = '[]' WHERE slot_id = ? AND date = ?",
      ).run(slotId, date);
      replan();
      return toRun(runRow(slotId, date) as RunRow);
    },

    /** Takes back a skip while the slot is still to come: next up is chosen afresh. */
    unskip(slotId: string, date: string): Run | "not-found" {
      const row = runRow(slotId, date);
      if (row?.state !== "skipped" || row.due_at <= clock.now()) return "not-found";
      db.query("UPDATE slot_runs SET state = 'planned', passed = '[]' WHERE slot_id = ? AND date = ?").run(
        slotId,
        date,
      );
      replan();
      return toRun(runRow(slotId, date) as RunRow);
    },
  };
}

export type Scheduler = ReturnType<typeof createScheduler>;

/** The slot and date in a run's `id`. */
export function runKey(id: string): { slotId: string; date: string } | undefined {
  const at = id.lastIndexOf("_");
  if (at <= 0) return undefined;
  return { slotId: id.slice(0, at), date: id.slice(at + 1) };
}

/** What a slot's ID may be: it names the slot in a URL. */
export const SLOT_ID = /^[A-Za-z0-9_-]{1,64}$/;

function scheduleProblems(schedule: Schedule): string[] {
  const problems: string[] = [];
  if (!isTimeZone(schedule.timeZone)) problems.push(`${schedule.timeZone} is not a timezone.`);
  if (schedule.slots.length > SCHEDULE_LIMITS.slots) problems.push(`At most ${SCHEDULE_LIMITS.slots} slots.`);
  const ids = new Set(schedule.slots.map((slot) => slot.id));
  if (ids.size !== schedule.slots.length) problems.push("Two slots have the same ID.");
  if (schedule.slots.some((slot) => !SLOT_ID.test(slot.id)))
    problems.push("A slot's ID is 1 to 64 letters, digits, - or _.");
  for (const slot of schedule.slots) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.time)) problems.push(`${slot.time} is not a time.`);
    if (slot.days.length === 0) problems.push(`The slot at ${slot.time} has no days.`);
  }
  return problems;
}
