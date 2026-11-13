import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db";
import { migrations } from "./migrations";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "selects-migrations-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("migration 6", () => {
  test("keeps every post, the selects in it and the account, and adds the needs-checking state", () => {
    const before = openDatabase(dir, migrations.slice(0, 5));
    before.run(
      `INSERT INTO selects (id, file_name, source, format, bytes, width, height, added_at)
       VALUES ('s1', 'a.jpg', 'upload', 'jpeg', 1, 1, 1, '2026-11-13T09:00:00Z')`,
    );
    before.run(
      `INSERT INTO posts (id, state, caption, alt_text, capture, attempts, created_at)
       VALUES ('p1', 'published', 'c', 'a', '[]', 1, 5)`,
    );
    before.run("INSERT INTO post_selects (post_id, position, select_id) VALUES ('p1', 0, 's1')");
    before.run(
      `INSERT INTO instagram_account (id, token, user_id, username, status, connected_at, refreshed_at, expires_at)
       VALUES (1, 'token', 'u', 'name', 'connected', 1, 2, 3)`,
    );
    before.close();

    const db = openDatabase(dir, migrations);

    expect(db.query("SELECT id, state, mode FROM posts").all()).toEqual([
      { id: "p1", state: "published", mode: null },
    ]);
    expect(db.query("SELECT post_id, select_id FROM post_selects").all()).toEqual([
      { post_id: "p1", select_id: "s1" },
    ]);
    expect(db.query("SELECT username, expires_at, refresh FROM instagram_account").all()).toEqual([
      { username: "name", expires_at: 3, refresh: "refreshed" },
    ]);
    db.run("UPDATE posts SET state = 'unconfirmed' WHERE id = 'p1'");
    // The selects in a post still go with it.
    db.run("DELETE FROM posts WHERE id = 'p1'");
    expect(db.query("SELECT * FROM post_selects").all()).toEqual([]);
    db.close();
  });
});
