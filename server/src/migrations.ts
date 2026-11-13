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
  // 3: edits to a select's capture data, selects whose location is hidden, and privacy zones.
  `
  CREATE TABLE capture_edits (
    select_id TEXT NOT NULL REFERENCES selects (id) ON DELETE CASCADE,
    field TEXT NOT NULL CHECK (field IN ('camera', 'lens', 'focalLength', 'exposureTime', 'fNumber', 'iso',
      'coordinates', 'capturedAt')),
    -- The edited value as JSON. JSON null clears the field.
    value TEXT NOT NULL,
    PRIMARY KEY (select_id, field)
  );

  CREATE TABLE hidden_locations (
    select_id TEXT PRIMARY KEY REFERENCES selects (id) ON DELETE CASCADE
  );

  CREATE TABLE privacy_zones (
    id TEXT PRIMARY KEY,
    latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    radius_metres REAL NOT NULL CHECK (radius_metres > 0),
    created_at TEXT NOT NULL
  );
  `,
  // 4: a caption or alt text written for one select, in place of the template. Null takes it.
  `
  CREATE TABLE select_captions (
    select_id TEXT PRIMARY KEY REFERENCES selects (id) ON DELETE CASCADE,
    caption TEXT,
    alt_text TEXT
  );
  `,
  // 5: the connected Instagram account, and posts: what was sent, or is being sent, and of which selects.
  `
  CREATE TABLE instagram_account (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    -- Secret: never returned by the API and never logged.
    token TEXT NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('connected', 'invalid')),
    connected_at INTEGER NOT NULL,
    -- When the token in use was issued or last refreshed, and when it expires. Milliseconds.
    refreshed_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE posts (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('publishing', 'retrying', 'published', 'failed', 'dry-run')),
    caption TEXT NOT NULL,
    alt_text TEXT NOT NULL,
    -- Chosen once for the post, so every attempt sends the same caption.
    hashtag_set TEXT,
    -- The published capture data the caption was built from, as JSON: a change means build again.
    capture TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    -- The bucket object holding the frame, while it is there.
    object_key TEXT,
    -- The Instagram media container, and when publishing it was asked for. Instagram publishes a
    -- container once, so a container that may have been published is checked, never replaced.
    container_id TEXT,
    publish_requested_at INTEGER,
    media_id TEXT,
    permalink TEXT,
    error TEXT,
    -- What a dry run did, as JSON.
    report TEXT,
    created_at INTEGER NOT NULL,
    published_at INTEGER
  );
  CREATE INDEX posts_state ON posts (state);

  -- The selects in a post, in order. One today; several when carousels come.
  CREATE TABLE post_selects (
    post_id TEXT NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    select_id TEXT REFERENCES selects (id) ON DELETE SET NULL,
    PRIMARY KEY (post_id, position)
  );
  CREATE INDEX post_selects_select ON post_selects (select_id);
  `,
];
