import { Database } from "bun:sqlite";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

/**
 * One SQL migration. The list is append-only: never edit or reorder a migration that has
 * shipped. A migration's position in the list (from 1) is the schema version it produces.
 */
export type Migration = string;

export type DatabaseStatus = { status: "ok"; schemaVersion: number } | { status: "error" };

const FILE_NAME = "selects.db";

/** Opens the database in `dataDir`, creating both if needed, and applies pending migrations. */
export function openDatabase(dataDir: string, migrations: readonly Migration[]): Database {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, FILE_NAME);
  // Created owner-only before SQLite opens it; SQLite gives its journal files the same mode.
  closeSync(openSync(file, "a", 0o600));
  const db = new Database(file, { create: true, strict: true });
  try {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    migrate(db, migrations);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

function migrate(db: Database, migrations: readonly Migration[]) {
  // All pending migrations apply together or not at all. The version is read under the write
  // lock, so two processes opening the same database never apply a migration twice.
  db.transaction(() => {
    const current = schemaVersion(db);
    if (current > migrations.length) {
      throw new Error(
        `The database is at schema version ${current}, newer than this version of Selects knows (${migrations.length}).`,
      );
    }
    for (const sql of migrations.slice(current)) db.run(sql);
    if (current < migrations.length) db.run(`PRAGMA user_version = ${migrations.length}`);
  }).immediate();
}

function schemaVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}

export function databaseStatus(db: Database): DatabaseStatus {
  try {
    return { status: "ok", schemaVersion: schemaVersion(db) };
  } catch (error) {
    console.error("Database status check failed:", error);
    return { status: "error" };
  }
}
