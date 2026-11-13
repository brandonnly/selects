import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { type Clock, DAY, HOUR } from "./clock";
import { errorKind } from "./library";
import { isTimeZone, localDate, zonedInstant } from "./slots";

/** Copies kept: a week of nights. */
export const BACKUPS_KEPT = 7;
/** When the nightly copy is made, in the install's timezone. */
export const BACKUP_TIME = "03:30";
/** How long after a failed backup it is tried again. */
const RETRY_AFTER_MS = HOUR;

const COPY_NAME = /^selects-\d{4}-\d{2}-\d{2}\.db$/;
const TEMPORARY = /^\.selects-.*\.tmp$/;

export type BackupCopy = { name: string; at: number; bytes: number };

export type BackupStatus = {
  /** When the latest copy was made; null with none. */
  lastAt: number | null;
  /** Why the last try failed, when it did and no copy has been made since. */
  lastError: { at: number; reason: string } | null;
  /** Newest first. */
  copies: BackupCopy[];
  kept: number;
  time: string;
  timeZone: string;
};

export type BackupsOptions = {
  db: Database;
  dataDir: string;
  clock: Clock;
  /** The install's timezone: the scheduler's. */
  timeZone: () => string;
};

/**
 * Nightly copies of the database in `backups` in the data volume (docs/PRODUCT.md,
 * "Configuration and operations"; ADR 0009). Each is made with `VACUUM INTO` from the app's own
 * connection: a read transaction, so the copy is one consistent snapshot while Selects runs, and
 * nothing in the WAL is lost. It is written owner-only under a temporary name and renamed, so a
 * copy on disk is always whole. Named by its date in the install's timezone; seven are kept.
 */
export function createBackups(options: BackupsOptions) {
  const { db, clock } = options;
  const dir = join(options.dataDir, "backups");
  let lastError: BackupStatus["lastError"] = null;
  let running: Promise<void> | undefined;

  const timeZone = () => {
    const zone = options.timeZone();
    return isTimeZone(zone) ? zone : "UTC";
  };

  function listCopies(): BackupCopy[] {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .filter((name) => COPY_NAME.test(name))
      .sort()
      .reverse()
      .flatMap((name) => {
        const stats = statSync(join(dir, name), { throwIfNoEntry: false });
        return stats?.isFile() ? [{ name, at: stats.mtimeMs, bytes: stats.size }] : [];
      });
  }

  /** The latest 03:30 in the install's timezone at or before `now`. */
  function latestNight(now: number): number {
    const zone = timeZone();
    const today = zonedInstant(localDate(now, zone), BACKUP_TIME, zone);
    if (today <= now) return today;
    return zonedInstant(localDate(now - DAY, zone), BACKUP_TIME, zone);
  }

  function backUp() {
    const now = clock.now();
    const name = `selects-${localDate(now, timeZone())}.db`;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Leftovers of a copy a stop interrupted.
    for (const found of readdirSync(dir)) {
      if (TEMPORARY.test(found)) rmSync(join(dir, found), { force: true });
    }
    const temporary = join(dir, `.${name}.${randomUUID()}.tmp`);
    // Created owner-only and empty: VACUUM INTO writes into an empty file, keeping its mode.
    closeSync(openSync(temporary, "wx", 0o600));
    try {
      db.query("VACUUM INTO ?").run(temporary);
      chmodSync(temporary, 0o600);
      utimesSync(temporary, now / 1000, now / 1000);
      renameSync(temporary, join(dir, name));
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    for (const old of listCopies().slice(BACKUPS_KEPT)) rmSync(join(dir, old.name), { force: true });
  }

  function run(): Promise<void> {
    if (running !== undefined) return running;
    running = Promise.resolve()
      .then(() => {
        try {
          backUp();
          lastError = null;
        } catch (error) {
          // The kind only: the message can carry the data directory's path.
          lastError = { at: clock.now(), reason: `The backup failed (${errorKind(error)}).` };
          console.error(`${lastError.reason} It is tried again in an hour.`);
        }
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  }

  return {
    /** Makes a copy now. A call while one is being made joins it. Never throws. */
    run,

    /**
     * Makes a copy when the latest 03:30 has none: nightly, and at start when the last copy is
     * from before last night. After a failure, waits an hour. Called on a timer.
     */
    runDue(): Promise<void> {
      const now = clock.now();
      const last = listCopies()[0]?.at ?? null;
      if (last !== null && last >= latestNight(now)) return Promise.resolve();
      if (lastError !== null && now - lastError.at < RETRY_AFTER_MS) return Promise.resolve();
      return run();
    },

    status(): BackupStatus {
      const copies = listCopies();
      return {
        lastAt: copies[0]?.at ?? null,
        lastError,
        copies,
        kept: BACKUPS_KEPT,
        time: BACKUP_TIME,
        timeZone: timeZone(),
      };
    },
  };
}

export type Backups = ReturnType<typeof createBackups>;
