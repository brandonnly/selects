import type { Migration } from "./db";

/**
 * Every schema change, oldest first. Append only: a shipped migration is never edited,
 * removed or reordered, because its position is the schema version it produces.
 */
export const migrations: readonly Migration[] = [
  // 1: selects, the fingerprints that block duplicates, and files rejected at ingest.
  `
  CREATE TABLE selects (
    id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('upload', 'inbox')),
    format TEXT NOT NULL CHECK (format IN ('jpeg', 'png', 'tiff')),
    bytes INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    camera TEXT,
    lens TEXT,
    focal_length REAL,
    exposure_time REAL,
    f_number REAL,
    iso INTEGER,
    latitude REAL,
    longitude REAL,
    captured_at TEXT,
    already_posted INTEGER NOT NULL DEFAULT 0 CHECK (already_posted IN (0, 1)),
    added_at TEXT NOT NULL
  );

  CREATE TABLE fingerprints (
    sha256 TEXT PRIMARY KEY,
    phash TEXT NOT NULL,
    captured_at TEXT,
    file_name TEXT NOT NULL,
    select_id TEXT UNIQUE REFERENCES selects (id) ON DELETE SET NULL,
    added_at TEXT NOT NULL
  );
  CREATE INDEX fingerprints_captured_at ON fingerprints (captured_at);

  CREATE TABLE rejections (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL CHECK (source IN ('upload', 'inbox')),
    file_name TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('unsupported', 'duplicate', 'reexport')),
    matched_file_name TEXT,
    matched_select_id TEXT REFERENCES selects (id) ON DELETE SET NULL,
    stored_path TEXT,
    already_posted INTEGER NOT NULL DEFAULT 0 CHECK (already_posted IN (0, 1)),
    rejected_at TEXT NOT NULL
  );
  `,
  // 2: settings set in the UI, one JSON value per key.
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];
