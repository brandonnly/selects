import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createApp } from "./app";
import { createFakeClock } from "./clock";
import { BucketSettings, loadConfig } from "./config";
import { openDatabase } from "./db";
import { createFakeBucket, FAKE_BUCKET_KEYS, type FakeBucket } from "./fake-bucket";
import { createFakeInstagram, type FakeInstagram } from "./fake-instagram";
import { type FixtureName, generateFixtures } from "./fixtures";
import { createInstagramApi } from "./instagram";
import { migrations } from "./migrations";

const TOKEN = "IGfake-gallery-api-token-0001";

let fixtureDir: string;
let fixtures: Record<FixtureName, string>;
beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), "selects-gallery-api-fixtures-"));
  fixtures = await generateFixtures(fixtureDir);
});
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

let dataDir: string;
let db: Database;
let instagram: FakeInstagram;
let bucket: FakeBucket;
let app: ReturnType<typeof createApp>;
let bodies: string[];

/** The app in fake mode, with the fake bucket given a public base URL or not. */
const appWith = ({ publicUrl }: { publicUrl: boolean }) =>
  createApp({
    config: loadConfig({ DATA_DIR: dataDir }),
    db,
    webDir: join(dataDir, "no-ui"),
    instagram: createInstagramApi({ baseUrl: instagram.url }),
    fakeBucket: new BucketSettings(
      bucket.endpoint,
      bucket.name,
      "auto",
      publicUrl ? bucket.publicBaseUrl : undefined,
      FAKE_BUCKET_KEYS,
    ),
    clock: createFakeClock(),
  });

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "selects-gallery-api-"));
  db = openDatabase(dataDir, migrations);
  instagram = createFakeInstagram();
  bucket = createFakeBucket();
  bodies = [];
  app = appWith({ publicUrl: true });
});
afterEach(async () => {
  await instagram.stop();
  await bucket.stop();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// biome-ignore lint/suspicious/noExplicitAny: each test's assertions check the body's shape.
type Body = any;

async function request(path: string, init?: RequestInit): Promise<{ status: number; body: Body }> {
  const response = await app.fetch(new Request(`http://selects.test${path}`, init));
  const text = await response.text();
  bodies.push(text);
  let body: Body = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: response.status, body };
}

const send = (method: string, path: string, body?: unknown) =>
  request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** Adds a select and posts it, as Post now does, then waits for its gallery output. */
async function posted(name: FixtureName): Promise<{ selectId: string; postId: string }> {
  const upload = await request(`/api/uploads?name=${basename(fixtures[name])}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: readFileSync(fixtures[name]),
  });
  const selectId = upload.body.select.id;
  const preview = (await request(`/api/selects/${selectId}/publish`)).body;
  const { caption, altText, hashtagSet, dryRun, instagram: mode, account, frame } = preview;
  const post = await send("POST", `/api/selects/${selectId}/publish`, {
    caption,
    altText,
    hashtagSet,
    dryRun,
    instagram: mode,
    account,
    frame,
  });
  await app.publisher.settled();
  await app.gallery.settled();
  return { selectId, postId: post.body.post.id };
}

async function connect() {
  instagram.addAccount(TOKEN, { userId: "1784140003", username: "selects_gallery_api" });
  await send("PUT", "/api/instagram/token", { token: TOKEN });
}

describe("the gallery in Settings", () => {
  test("is off by default, and available with a public base URL", async () => {
    const { status, body } = await request("/api/gallery");

    expect(status).toBe(200);
    expect(body.enabled).toBe(false);
    expect(body.availability).toEqual({ available: true, manifestUrl: `${bucket.publicBaseUrl}/posts.json` });
  });

  test("is unavailable without a public base URL, says why, and refuses to be turned on", async () => {
    app = appWith({ publicUrl: false });

    const { body } = await request("/api/gallery");
    expect(body.availability.available).toBe(false);
    expect(body.availability.reason).toContain("public base URL");

    const turnOn = await send("PUT", "/api/gallery", { enabled: true });
    expect(turnOn.status).toBe(409);
    expect(turnOn.body.problems[0]).toContain("public base URL");
    expect((await request("/api/gallery")).body.enabled).toBe(false);
  });

  test("turned on lists each post with its gallery state", async () => {
    await connect();
    expect((await send("PUT", "/api/gallery", { enabled: true })).body.enabled).toBe(true);

    const { postId } = await posted("portrait");

    const { body } = await request("/api/gallery");
    expect(body.posts).toEqual([{ postId, state: "listed", error: null, mode: "fake" }]);
    expect(bodies.join("\n")).not.toContain("X-Amz");
    expect(bodies.join("\n")).not.toContain(TOKEN);
  });
});

describe("Remove from gallery", () => {
  test("takes the post out of the gallery and leaves it posted", async () => {
    await connect();
    await send("PUT", "/api/gallery", { enabled: true });
    const { selectId, postId } = await posted("portrait");

    const removed = await send("DELETE", `/api/gallery/posts/${postId}`);
    await app.gallery.settled();

    expect(removed.status).toBe(202);
    expect((await request("/api/gallery")).body.posts[0].state).toBe("removed");
    expect((await request(`/api/posts/${postId}`)).body.state).toBe("published");
    expect((await request("/api/pool")).body).not.toContain(selectId);
    expect([...bucket.objects.keys()]).toEqual(["posts.json"]);
  });

  test("answers 404 for a post not in the gallery", async () => {
    expect((await send("DELETE", "/api/gallery/posts/no-such-post")).status).toBe(404);
  });
});
