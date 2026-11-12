import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseStatus, type Migration, openDatabase } from "./db";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "selects-db-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const createNotes: Migration = "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)";
const addTitle: Migration = "ALTER TABLE notes ADD COLUMN title TEXT";

describe("openDatabase", () => {
  test("creates the data directory and a database file in it", () => {
    const db = openDatabase(join(dir, "nested"), []);

    expect(databaseStatus(db)).toEqual({ status: "ok", schemaVersion: 0 });
    expect(Bun.file(join(dir, "nested", "selects.db")).size).toBeGreaterThan(0);
    db.close();
  });

  test("applies migrations in order and reports the schema version", () => {
    const db = openDatabase(dir, [createNotes, addTitle]);

    db.run("INSERT INTO notes (body, title) VALUES ('b', 't')");
    expect(databaseStatus(db)).toEqual({ status: "ok", schemaVersion: 2 });
    db.close();
  });

  test("applies only new migrations when reopened", () => {
    openDatabase(dir, [createNotes]).close();
    const db = openDatabase(dir, [createNotes, addTitle]);

    expect(databaseStatus(db)).toEqual({ status: "ok", schemaVersion: 2 });
    db.close();
  });

  test("rolls back every pending migration when one fails", () => {
    openDatabase(dir, [createNotes]).close();

    expect(() => openDatabase(dir, [createNotes, addTitle, "NOT VALID SQL"])).toThrow();

    const db = openDatabase(dir, [createNotes]);
    expect(databaseStatus(db)).toEqual({ status: "ok", schemaVersion: 1 });
    db.close();
  });

  test("refuses a database newer than this version of the app", () => {
    openDatabase(dir, [createNotes, addTitle]).close();

    expect(() => openDatabase(dir, [createNotes])).toThrow(/newer/);
  });
});

describe("databaseStatus", () => {
  test("reports an error once the database is unreachable", () => {
    const db = openDatabase(dir, []);
    db.close();

    expect(databaseStatus(db)).toEqual({ status: "error" });
  });
});
