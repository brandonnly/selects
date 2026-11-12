import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
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
  const db = new Database(join(dataDir, FILE_NAME), { create: true, strict: true });
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
  const current = schemaVersion(db);
  if (current > migrations.length) {
    throw new Error(
      `The database is at schema version ${current}, newer than this version of Selects knows (${migrations.length}).`,
    );
  }
  if (current === migrations.length) return;
  // All pending migrations apply together or not at all.
  db.transaction(() => {
    for (const sql of migrations.slice(current)) db.run(sql);
    db.run(`PRAGMA user_version = ${migrations.length}`);
  })();
}

function schemaVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}

export function databaseStatus(db: Database): DatabaseStatus {
  try {
    return { status: "ok", schemaVersion: schemaVersion(db) };
  } catch {
    return { status: "error" };
  }
}
