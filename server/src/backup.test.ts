import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUPS_KEPT, createBackups } from "./backup";
import { createFakeClock, DAY, type FakeClock, HOUR, MINUTE } from "./clock";
import { openDatabase } from "./db";
import { migrations } from "./migrations";

let dataDir: string;
let db: Database;
let clock: FakeClock;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "selects-backup-"));
  db = openDatabase(dataDir, migrations);
  // 09:00 UTC.
  clock = createFakeClock(Date.parse("2026-11-13T09:00:00Z"));
});
afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const backupDir = () => join(dataDir, "backups");
const copies = () => readdirSync(backupDir()).sort();

function backupsWith(timeZone = "UTC") {
  return createBackups({ db, dataDir, clock, timeZone: () => timeZone });
}

describe("a backup", () => {
  test("opens as a valid database holding the rows the live one held, readable by the owner only", async () => {
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("backup-test", '"kept"');
    const backups = backupsWith();

    await backups.run();

    expect(copies()).toEqual(["selects-2026-11-13.db"]);
    const file = join(backupDir(), "selects-2026-11-13.db");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const copy = new Database(file, { readonly: true, strict: true });
    try {
      expect(copy.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(copy.query("PRAGMA user_version").get()).toEqual({ user_version: migrations.length });
      expect(copy.query("SELECT value FROM settings WHERE key = 'backup-test'").get()).toEqual({
        value: '"kept"',
      });
    } finally {
      copy.close();
    }
  });

  test("taken while another connection is writing holds only what was committed", async () => {
    const writer = new Database(join(dataDir, "selects.db"), { strict: true });
    try {
      writer.run("BEGIN IMMEDIATE");
      writer.query("INSERT INTO settings (key, value) VALUES ('uncommitted', '1')").run();

      await backupsWith().run();

      writer.run("ROLLBACK");
    } finally {
      writer.close();
    }
    const copy = new Database(join(backupDir(), "selects-2026-11-13.db"), { readonly: true, strict: true });
    try {
      expect(copy.query("SELECT key FROM settings WHERE key = 'uncommitted'").get()).toBeNull();
      expect(copy.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      copy.close();
    }
  });

  test("is named by its date in the install's timezone, and seven are kept", async () => {
    // Fourteen hours ahead of UTC: 11:00 UTC is already the next day there.
    clock.advance(2 * HOUR);
    const backups = backupsWith("Etc/GMT-14");

    for (let day = 0; day < 9; day++) {
      await backups.run();
      clock.advance(DAY);
    }

    expect(BACKUPS_KEPT).toBe(7);
    expect(copies()).toEqual([
      "selects-2026-11-16.db",
      "selects-2026-11-17.db",
      "selects-2026-11-18.db",
      "selects-2026-11-19.db",
      "selects-2026-11-20.db",
      "selects-2026-11-21.db",
      "selects-2026-11-22.db",
    ]);
    expect(backups.status().copies.map((copy) => copy.name)).toEqual([...copies()].reverse());
  });

  test("taken twice on one day replaces that day's copy, and leaves no temporary file", async () => {
    const backups = backupsWith();
    await backups.run();
    clock.advance(HOUR);
    db.query("INSERT INTO settings (key, value) VALUES ('later', '1')").run();

    await backups.run();

    expect(copies()).toEqual(["selects-2026-11-13.db"]);
    const copy = new Database(join(backupDir(), "selects-2026-11-13.db"), { readonly: true, strict: true });
    expect(copy.query("SELECT value FROM settings WHERE key = 'later'").get()).toEqual({ value: "1" });
    copy.close();
  });

  test("never runs twice at once", async () => {
    const backups = backupsWith();

    const [first, second] = [backups.run(), backups.run()];

    expect(first).toBe(second);
    await first;
    expect(copies()).toEqual(["selects-2026-11-13.db"]);
  });
});

describe("the nightly backup", () => {
  test("runs at start when there is no copy, then at 03:30 in the install's timezone", async () => {
    // Five hours behind UTC: 09:00 UTC is 04:00 there.
    const backups = backupsWith("Etc/GMT+5");

    await backups.runDue();
    expect(backups.status().lastAt).toBe(clock.now());

    // 03:29 there the next day: not yet.
    clock.advance(DAY - 31 * MINUTE);
    await backups.runDue();
    expect(copies()).toEqual(["selects-2026-11-13.db"]);

    clock.advance(MINUTE);
    await backups.runDue();
    expect(copies()).toEqual(["selects-2026-11-13.db", "selects-2026-11-14.db"]);

    // Once that night.
    const at = backups.status().lastAt;
    clock.advance(10 * MINUTE);
    await backups.runDue();
    expect(backups.status().lastAt).toBe(at);
  });

  test("runs at start when the last copy is more than a day old, and not when it is from last night", async () => {
    const backups = backupsWith();
    await backups.run();

    // 02:00 the next day: last night's 03:30 has its copy.
    clock.advance(17 * HOUR);
    await backups.runDue();
    expect(backups.status().lastAt).toBe(clock.now() - 17 * HOUR);

    // Down for two days: a copy at start.
    clock.advance(2 * DAY);
    const restarted = backupsWith();
    await restarted.runDue();
    expect(restarted.status().lastAt).toBe(clock.now());
  });

  test("that fails shows why in its status, and is tried again an hour later, not every minute", async () => {
    // Something that is not a directory where the copies go.
    writeFileSync(backupDir(), "");
    const backups = backupsWith();

    await backups.runDue();
    const failed = backups.status();
    expect(failed.lastAt).toBeNull();
    expect(failed.lastError).toEqual({
      at: clock.now(),
      reason: expect.stringMatching(/^The backup failed/),
    });
    expect(failed.lastError?.reason).not.toContain(dataDir);

    rmSync(backupDir());
    clock.advance(MINUTE);
    await backups.runDue();
    expect(backups.status().lastAt).toBeNull();

    clock.advance(HOUR);
    await backups.runDue();
    expect(backups.status()).toMatchObject({ lastAt: clock.now(), lastError: null });
  });
});
