import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createApp } from "./app";
import { createFakeClock, type FakeClock } from "./clock";
import { BucketSettings, loadConfig } from "./config";
import { openDatabase } from "./db";
import { createFakeBucket, FAKE_BUCKET_KEYS, type FakeBucket } from "./fake-bucket";
import { createFakeInstagram, type FakeInstagram } from "./fake-instagram";
import { type FixtureName, generateFixtures } from "./fixtures";
import { createInstagramApi } from "./instagram";
import { migrations } from "./migrations";

const TOKEN = "IGfake-api-token-0001";

let fixtureDir: string;
let fixtures: Record<FixtureName, string>;
beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), "selects-publish-api-fixtures-"));
  fixtures = await generateFixtures(fixtureDir);
});
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

let dataDir: string;
let db: Database;
let clock: FakeClock;
let instagram: FakeInstagram;
let bucket: FakeBucket;
let app: ReturnType<typeof createApp>;
/** Every response body the app sent in a test, to check for secrets. */
let bodies: string[];

/** The app in fake mode, as `main.ts` runs it: the fake Instagram and the fake bucket. */
const appWith = (env: Record<string, string> = {}, options: { noBucket?: boolean } = {}) =>
  createApp({
    config: loadConfig({ DATA_DIR: dataDir, ...env }),
    db,
    webDir: join(dataDir, "no-ui"),
    instagram: createInstagramApi({ baseUrl: instagram.url }),
    fakeBucket: options.noBucket ? undefined : fakeBucketSettings(bucket),
    clock,
  });

const fakeBucketSettings = (fake: FakeBucket) =>
  new BucketSettings(fake.endpoint, fake.name, "auto", undefined, FAKE_BUCKET_KEYS);

const bucketEnv = (fake: FakeBucket) => ({
  BUCKET_ENDPOINT: fake.endpoint,
  BUCKET_NAME: fake.name,
  BUCKET_ACCESS_KEY_ID: FAKE_BUCKET_KEYS.accessKeyId,
  BUCKET_SECRET_ACCESS_KEY: FAKE_BUCKET_KEYS.secretAccessKey,
});

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "selects-publish-api-"));
  db = openDatabase(dataDir, migrations);
  clock = createFakeClock();
  instagram = createFakeInstagram({ clock });
  bucket = createFakeBucket();
  bodies = [];
  app = appWith();
});
afterEach(async () => {
  await instagram.stop();
  await bucket.stop();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// biome-ignore lint/suspicious/noExplicitAny: each test's assertions check the body's shape.
type Body = any;

async function request(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: Body; text: string }> {
  const response = await app.fetch(new Request(`http://selects.test${path}`, init));
  const text = await response.text();
  bodies.push(text);
  let body: Body = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: response.status, body, text };
}

const send = (method: string, path: string, body: unknown) =>
  request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function addSelect(name: FixtureName): Promise<string> {
  const { body } = await request(`/api/uploads?name=${basename(fixtures[name])}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: readFileSync(fixtures[name]),
  });
  return body.select.id;
}

async function connect() {
  instagram.addAccount(TOKEN, { userId: "1784140001", username: "selects_test" });
  return send("PUT", "/api/instagram/token", { token: TOKEN });
}

/** What the owner confirms: everything the preview showed. */
const confirmed = (preview: Body) => ({
  caption: preview.caption,
  altText: preview.altText,
  hashtagSet: preview.hashtagSet,
  dryRun: preview.dryRun,
  instagram: preview.instagram,
  account: preview.account,
  frame: preview.frame,
});

/** Asks for the post as shown, confirms it, and waits for its first attempt. */
async function postNow(selectId: string) {
  const preview = await request(`/api/selects/${selectId}/publish`);
  const posted = await send("POST", `/api/selects/${selectId}/publish`, confirmed(preview.body));
  if (posted.status === 202) await app.publisher.settled();
  return posted;
}

describe("the Instagram token in Settings", () => {
  test("is confirmed against its account, and only the account name comes back", async () => {
    const { status, body } = await connect();

    expect(status).toBe(200);
    expect(body.account).toMatchObject({ username: "selects_test", status: "connected" });
    const settings = await request("/api/publishing");
    expect(settings.body.instagram.account.username).toBe("selects_test");
    expect(bodies.join("\n")).not.toContain(TOKEN);
  });

  test("is refused when Instagram does not accept it, without echoing it", async () => {
    const { status, body } = await send("PUT", "/api/instagram/token", { token: "IGwrong-token-0002" });

    expect(status).toBe(422);
    expect(body.problems).toEqual(["Instagram did not accept the token. Check it and paste it again."]);
    expect(bodies.join("\n")).not.toContain("IGwrong-token-0002");
  });

  test("is refused when empty or too long, without echoing it", async () => {
    const long = `IG${"x".repeat(5000)}`;

    expect((await send("PUT", "/api/instagram/token", { token: "  " })).status).toBe(422);
    expect((await send("PUT", "/api/instagram/token", { token: long })).status).toBe(422);
    expect(bodies.join("\n")).not.toContain(long);
  });

  test("is not echoed when the request is malformed", async () => {
    const sent = [
      await request("/api/instagram/token", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify("IGbare-token-0004"),
      }),
      await send("PUT", "/api/instagram/token", { token: "IGbare-token-0004", extra: true }),
      await send("PUT", "/api/instagram/token", { secret: "IGbare-token-0004" }),
    ];

    expect(sent.map((r) => r.status)).toEqual([422, 422, 422]);
    expect(bodies.join("\n")).not.toContain("IGbare-token-0004");
  });

  test("is never logged", async () => {
    const lines: unknown[] = [];
    const spies = (["log", "error", "warn", "info"] as const).map((method) =>
      spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(...args);
      }),
    );
    try {
      await connect();
      await send("PUT", "/api/instagram/token", { token: "IGwrong-token-0003" });
      const id = await addSelect("portrait");
      await postNow(id);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    const output = lines.map((line) => Bun.inspect(line)).join("\n");
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain("IGwrong-token-0003");
    expect(output).not.toContain(FAKE_BUCKET_KEYS.secretAccessKey);
    expect(output).not.toContain("X-Amz-");
  });

  test("can be removed", async () => {
    await connect();

    const { status } = await request("/api/instagram/token", { method: "DELETE" });

    expect(status).toBe(204);
    expect((await request("/api/publishing")).body.instagram.account).toBeNull();
  });
});

describe("publishing settings", () => {
  test("say which bucket variables are missing, by name only", async () => {
    app = appWith({ INSTAGRAM_API: "live" });

    const { body } = await request("/api/publishing");

    expect(body.bucket).toEqual({
      configured: false,
      fake: false,
      missing: ["BUCKET_ENDPOINT", "BUCKET_NAME", "BUCKET_ACCESS_KEY_ID", "BUCKET_SECRET_ACCESS_KEY"],
      url: null,
    });
  });

  test("in fake mode never send anything to the bucket set in the environment", async () => {
    // `bucket` stands in for a real bucket the owner has set; the fakes run beside it.
    const fakes = createFakeBucket();
    try {
      app = createApp({
        config: loadConfig({ DATA_DIR: dataDir, ...bucketEnv(bucket) }),
        db,
        webDir: join(dataDir, "no-ui"),
        instagram: createInstagramApi({ baseUrl: instagram.url }),
        fakeBucket: fakeBucketSettings(fakes),
        clock,
      });
      await connect();
      const id = await addSelect("portrait");

      const { body } = await postNow(id);

      expect(app.publisher.post(body.post.id)?.state).toBe("published");
      expect(fakes.requests.length).toBeGreaterThan(0);
      expect(bucket.requests).toHaveLength(0);
      expect((await request("/api/publishing")).body.bucket).toMatchObject({ configured: true, fake: true });
    } finally {
      await fakes.stop();
    }
  });

  test("say how Instagram will be given the frame, and never show the keys", async () => {
    const { body } = await request("/api/publishing");

    expect(body.bucket).toEqual({ configured: true, fake: true, missing: [], url: "presigned" });
    expect(body.instagram.mode).toBe("fake");
    expect(bodies.join("\n")).not.toContain(FAKE_BUCKET_KEYS.accessKeyId);
    expect(bodies.join("\n")).not.toContain(FAKE_BUCKET_KEYS.secretAccessKey);
  });

  test("switch dry run on and off", async () => {
    expect((await request("/api/publishing")).body.dryRun).toBe(false);

    const { body } = await send("PUT", "/api/publishing", { dryRun: true });

    expect(body.dryRun).toBe(true);
    expect((await request("/api/publishing")).body.dryRun).toBe(true);
  });
});

describe("post now", () => {
  test("shows the caption, alt text and readiness before anything is sent", async () => {
    await connect();
    const id = await addSelect("portrait");

    const { status, body } = await request(`/api/selects/${id}/publish`);

    expect(status).toBe(200);
    expect(body).toMatchObject({ problems: [], dryRun: false, account: "selects_test", url: "presigned" });
    expect(body.caption).toContain(`10°30'00"N 40°15'00"W`);
    expect(body.altText).toBe("Photograph taken on 2024-05-01 with Fixture Optics FX-1");
    expect(instagram.requests.filter((r) => r.operation === "container")).toHaveLength(0);
    expect(bucket.requests).toHaveLength(0);
  });

  test("publishes the select, which leaves the pool and is listed as posted with its link", async () => {
    await connect();
    const id = await addSelect("portrait");

    const { status, body } = await postNow(id);

    expect(status).toBe(202);
    expect(body.post.selectIds).toEqual([id]);
    const posts = await request("/api/posts");
    expect(posts.body.posts).toHaveLength(1);
    expect(posts.body.posts[0]).toMatchObject({
      state: "published",
      selectIds: [id],
      permalink: instagram.media[0]?.permalink,
    });
    expect((await request("/api/pool")).body).toEqual([]);
    const selects = (await request("/api/selects")).body;
    expect(selects[0]).toMatchObject({ id, inPool: false, post: "published" });
  });

  test("refuses when what was confirmed is no longer what would be sent", async () => {
    await connect();
    const id = await addSelect("portrait");

    const preview = (await request(`/api/selects/${id}/publish`)).body;
    const { status, body } = await send("POST", `/api/selects/${id}/publish`, {
      ...confirmed(preview),
      caption: "Not the caption",
      altText: "Not the alt text",
    });

    expect(status).toBe(409);
    expect(body.status).toBe("changed");
    expect(instagram.media).toHaveLength(0);
  });

  test("never turns a confirmed dry run into a real post", async () => {
    await connect();
    await send("PUT", "/api/publishing", { dryRun: true });
    const id = await addSelect("portrait");
    const preview = (await request(`/api/selects/${id}/publish`)).body;
    expect(preview.dryRun).toBe(true);
    // Dry run is switched off, in another tab, before the owner confirms.
    await send("PUT", "/api/publishing", { dryRun: false });

    const { status, body } = await send("POST", `/api/selects/${id}/publish`, confirmed(preview));
    await app.publisher.settled();

    expect(status).toBe(409);
    expect(body.status).toBe("changed");
    expect(body.problems.join(" ")).toContain("Dry run");
    expect(instagram.media).toHaveLength(0);
    expect(bucket.requests).toHaveLength(0);
  });

  test("refuses when the account it would go to is not the one shown", async () => {
    await connect();
    const id = await addSelect("portrait");
    const preview = (await request(`/api/selects/${id}/publish`)).body;
    instagram.addAccount("IGfake-other-token-0009", { userId: "1784140009", username: "someone_else" });
    await send("PUT", "/api/instagram/token", { token: "IGfake-other-token-0009" });

    const { status, body } = await send("POST", `/api/selects/${id}/publish`, confirmed(preview));

    expect(status).toBe(409);
    expect(body.problems.join(" ")).toContain("account");
    expect(instagram.media).toHaveLength(0);
  });

  test("refuses when the frame changed since it was shown", async () => {
    await connect();
    const id = await addSelect("portrait");
    const preview = (await request(`/api/selects/${id}/publish`)).body;
    const frame = (await request("/api/frame")).body.settings;
    await send("PUT", "/api/frame", { ...frame, border: frame.border + 10 });

    const { status, body } = await send("POST", `/api/selects/${id}/publish`, confirmed(preview));

    expect(status).toBe(409);
    expect(body.problems.join(" ")).toContain("frame");
    expect(instagram.media).toHaveLength(0);
  });

  test("is refused without a bucket, saying what is missing", async () => {
    // Live mode with no bucket set; Instagram is still the fake.
    app = appWith({ INSTAGRAM_API: "live" });
    await connect();
    const id = await addSelect("portrait");

    const { status, body } = await postNow(id);

    expect(status).toBe(409);
    expect(body.problems[0]).toContain("BUCKET_ENDPOINT");
  });

  test("is refused for a select already posted", async () => {
    await connect();
    const id = await addSelect("portrait");
    await postNow(id);

    const { status } = await postNow(id);

    expect(status).toBe(409);
    expect(instagram.media).toHaveLength(0 + 1);
  });

  test("never stores, logs or shows the link Instagram could not fetch the frame from", async () => {
    await connect();
    const id = await addSelect("portrait");
    // Every fetch of the frame fails, and Meta's error names the URI it tried.
    bucket.failReads(true);
    const lines: unknown[] = [];
    const spies = (["log", "error", "warn", "info"] as const).map((method) =>
      spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(...args);
      }),
    );
    try {
      await postNow(id);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    const fetched = instagram.fetches[0]?.url ?? "missing";
    expect(fetched).toContain("X-Amz-Signature");
    const output = lines.map((line) => Bun.inspect(line)).join("\n");
    const stored = JSON.stringify(db.query("SELECT * FROM posts").all());
    const shown = (await request("/api/posts")).text;
    for (const place of [output, stored, shown]) {
      expect(place).not.toContain(bucket.endpoint);
      expect(place).not.toContain("X-Amz-");
    }
    expect(shown).toContain("could not be fetched");
  });

  test("that Instagram has not confirmed is shown as needing a check, and the owner says what happened", async () => {
    await connect();
    const id = await addSelect("portrait");
    instagram.fail("publish", "lost");
    const { body } = await postNow(id);
    instagram.fail("status", "transient", "transient", "transient");
    for (let i = 0; i < 3; i++) {
      clock.advance(10 * 60 * 1000);
      await app.publisher.runDue();
    }

    const listed = (await request("/api/posts")).body.posts;
    expect(listed.map((post: Body) => post.state)).toEqual(["unconfirmed"]);
    expect((await request("/api/pool")).body).toEqual([]);

    const unsafe = await send("POST", `/api/posts/${body.post.id}/resolve`, {
      posted: true,
      permalink: "javascript:alert(1)",
    });
    expect(unsafe.status).toBe(422);
    const resolved = await send("POST", `/api/posts/${body.post.id}/resolve`, {
      posted: true,
      permalink: "https://www.instagram.com/p/abc/",
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({
      state: "published",
      permalink: "https://www.instagram.com/p/abc/",
    });
    const again = await send("POST", `/api/posts/${body.post.id}/resolve`, { posted: false });
    expect(again.status).toBe(409);
    expect((await send("POST", "/api/posts/missing/resolve", { posted: false })).status).toBe(404);
  });

  test("is a dry run while the switch is on: recorded and shown, with its frame, and nothing sent", async () => {
    await connect();
    await send("PUT", "/api/publishing", { dryRun: true });
    const id = await addSelect("portrait");
    const requestsBefore = instagram.requests.length;

    const { status, body } = await postNow(id);

    expect(status).toBe(202);
    expect(body.post.state).toBe("dry-run");
    expect(instagram.requests).toHaveLength(requestsBefore);
    expect(instagram.media).toHaveLength(0);
    expect(bucket.requests).toHaveLength(0);
    const posts = await request("/api/posts");
    expect(posts.body.posts).toEqual([]);
    expect(posts.body.dryRuns).toHaveLength(1);
    const frame = await app.fetch(new Request(`http://selects.test/api/posts/${body.post.id}/frame`));
    expect(frame.headers.get("content-type")).toBe("image/jpeg");
    expect((await request("/api/pool")).body).toEqual([id]);
  });
});
