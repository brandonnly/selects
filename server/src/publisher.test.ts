import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import sharp from "sharp";
import { type Bucket, createBucket } from "./bucket";
import { createCaptionStore } from "./caption-store";
import { createCaptures } from "./capture";
import { createFakeClock, type FakeClock, MINUTE } from "./clock";
import { BucketSettings } from "./config";
import { openDatabase } from "./db";
import { createFakeBucket, FAKE_BUCKET_KEYS, type FakeBucket } from "./fake-bucket";
import { createFakeInstagram, type FakeInstagram } from "./fake-instagram";
import { type FixtureName, generateFixtures } from "./fixtures";
import { createFrameRenderer } from "./frame";
import { createInstagramApi, type InstagramApi } from "./instagram";
import { createInstagramAccount } from "./instagram-account";
import { createLibrary, type Library } from "./library";
import { migrations } from "./migrations";
import { createPublisher, type Publisher, type PublisherOptions, RETRY_DELAYS } from "./publisher";
import { createSettings } from "./settings";
import { createZones } from "./zones";

const TOKEN = "IGfake-publisher-token-0001";

let fixtureDir: string;
let fixtures: Record<FixtureName, string>;
beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), "selects-publisher-fixtures-"));
  fixtures = await generateFixtures(fixtureDir);
});
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

let dataDir: string;
let db: Database;
let clock: FakeClock;
let instagram: FakeInstagram;
let fakeBucket: FakeBucket;
let library: Library;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "selects-publisher-"));
  db = openDatabase(dataDir, migrations);
  clock = createFakeClock();
  instagram = createFakeInstagram({ clock });
  fakeBucket = createFakeBucket();
  library = createLibrary({ db, dataDir });
});
afterEach(async () => {
  await instagram.stop();
  await fakeBucket.stop();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Caption templates whose output is easy to read: ISO, coordinates, then the hashtag set. */
const TEMPLATES = {
  caption: "{iso}\n{coordinates}\n\n{hashtags}",
  altText: "Photograph[ with {camera}]",
  hashtagSets: [
    { name: "Film", tags: ["#film", "#35mm"] },
    { name: "Night", tags: ["#night"] },
  ],
};

/** Everything a publisher needs, against the fakes. Each piece can be swapped by a test. */
function setup(
  options: {
    publicBaseUrl?: string;
    noBucket?: boolean;
    connect?: boolean;
    wrapBucket?: (bucket: Bucket) => Bucket;
    wrapApi?: (api: InstagramApi) => InstagramApi;
    renderer?: PublisherOptions["renderer"];
  } = {},
) {
  const zones = createZones(db);
  const captures = createCaptures({ db, library, zones });
  const settings = createSettings(db);
  const captionStore = createCaptionStore(db);
  captionStore.setTemplates(TEMPLATES);
  const realApi = createInstagramApi({ baseUrl: instagram.url });
  const api = options.wrapApi?.(realApi) ?? realApi;
  const account = createInstagramAccount({ db, api, clock });
  const bucket = createBucket(
    new BucketSettings(fakeBucket.endpoint, fakeBucket.name, "auto", options.publicBaseUrl, FAKE_BUCKET_KEYS),
  );
  const renderer = createFrameRenderer({ dataDir });
  const publisher = createPublisher({
    db,
    dataDir,
    library,
    captures,
    renderer: options.renderer ?? renderer,
    settings,
    captionStore,
    account,
    api,
    bucket: options.noBucket
      ? { missing: ["BUCKET_ENDPOINT", "BUCKET_NAME"] }
      : (options.wrapBucket?.(bucket) ?? bucket),
    clock,
    random: () => 0,
  });
  return { publisher, zones, captures, settings, captionStore, account, renderer };
}

async function connect(account: ReturnType<typeof setup>["account"]) {
  instagram.addAccount(TOKEN, { userId: "1784140001", username: "selects_test" });
  await account.connect(TOKEN);
}

async function addSelect(name: FixtureName): Promise<string> {
  const copy = join(dataDir, `incoming-${basename(fixtures[name])}`);
  copyFileSync(fixtures[name], copy);
  const result = await library.addUpload(copy, { fileName: basename(fixtures[name]), alreadyPosted: false });
  if (result.status !== "added") throw new Error(`could not add ${name}`);
  return result.select.id;
}

async function postNow(publisher: Publisher, selectId: string, options: { dryRun?: boolean } = {}) {
  const result = await publisher.publish({ selectIds: [selectId], dryRun: options.dryRun ?? false });
  if (result.status !== "started") throw new Error(`publish was ${result.status}`);
  return result.done;
}

/** Runs the retries that are due after the clock moves on by `ms`. */
async function after(publisher: Publisher, ms: number) {
  clock.advance(ms);
  await publisher.runDue();
}

/** Lets an attempt left hanging by a simulated stop finish, before the database closes. */
async function stopStale(done: Promise<unknown>) {
  await instagram.stop();
  await done.catch(() => {});
}

const PORTRAIT_CAPTION = `ISO 400\n10°30'00"N 40°15'00"W\n\n#film #35mm`;

describe("post now", () => {
  test("renders the frame, uploads it, publishes it with its caption and alt text, and records the permalink", async () => {
    const { publisher, account, renderer, captures, settings } = setup();
    await connect(account);
    const id = await addSelect("portrait");

    const post = await postNow(publisher, id);

    expect(instagram.media).toHaveLength(1);
    const [media] = instagram.media;
    expect(media?.caption).toBe(PORTRAIT_CAPTION);
    expect(media?.altText).toBe("Photograph with Fixture Optics FX-1");
    // What Instagram fetched is the frame, as the renderer makes it for this select.
    const expected = await renderer.render(
      // biome-ignore lint/style/noNonNullAssertion: the select was just added.
      { path: library.original(id)!.path, capture: captures.published(id)! },
      settings.frame(),
    );
    expect(new Uint8Array(media?.image ?? [])).toEqual(new Uint8Array(expected));
    const meta = await sharp(media?.image).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 1440, 1800]);

    expect(post.state).toBe("published");
    expect(post.permalink).toBe(media?.permalink ?? "missing");
    expect(post.selectIds).toEqual([id]);
    expect(post.caption).toBe(PORTRAIT_CAPTION);
    expect(publisher.posts().map((p) => p.id)).toEqual([post.id]);
  });

  test("uploads the frame under a random key that is not the file name", async () => {
    const { publisher, account } = setup();
    await connect(account);
    const id = await addSelect("portrait");

    await postNow(publisher, id);

    const fetched = new URL(instagram.fetches[0]?.url ?? "http://missing");
    expect(fetched.pathname).toMatch(/^\/selects\/frames\/[0-9a-f-]{36}\.jpg$/);
    expect(fetched.href).not.toContain("portrait");
    const put = fakeBucket.requests.find((request) => request.method === "PUT");
    expect(put?.path).toBe(fetched.pathname);
  });

  test("moves the select out of the pool", async () => {
    const { publisher, account } = setup();
    await connect(account);
    const id = await addSelect("portrait");
    const other = await addSelect("square");

    await postNow(publisher, id);

    expect(library.pool()).toEqual([other]);
    expect(library.get(id)?.inPool).toBe(false);
  });

  test("never posts a select twice", async () => {
    const { publisher, account } = setup();
    await connect(account);
    const id = await addSelect("portrait");
    await postNow(publisher, id);

    const again = await publisher.publish({ selectIds: [id], dryRun: false });

    expect(again.status).toBe("not-in-pool");
    expect(instagram.media).toHaveLength(1);
  });

  test("refuses a second post of a select while the first is still being published", async () => {
    const { publisher, account } = setup();
    await connect(account);
    const id = await addSelect("portrait");

    const [first, second] = await Promise.all([
      publisher.publish({ selectIds: [id], dryRun: false }),
      publisher.publish({ selectIds: [id], dryRun: false }),
    ]);
    if (first.status === "started") await first.done;

    expect([first.status, second.status].sort()).toEqual(["not-in-pool", "started"]);
    expect(instagram.media).toHaveLength(1);
  });

  test("deletes the framed image from the bucket once it is published", async () => {
    const { publisher, account } = setup();
    await connect(account);
    const id = await addSelect("portrait");

    await postNow(publisher, id);

    expect(fakeBucket.objects.size).toBe(0);
  });

  test("waits for Instagram to finish processing the image before publishing it", async () => {
    const { publisher, account } = setup();
    await connect(account);
    instagram.setProcessingPolls(4);
    const id = await addSelect("portrait");

    const post = await postNow(publisher, id);

    expect(post.state).toBe("published");
    expect(instagram.requests.filter((r) => r.operation === "status").length).toBeGreaterThanOrEqual(5);
  });

  test("is unavailable without a bucket, naming what is missing", async () => {
    const { publisher, account } = setup({ noBucket: true });
    await connect(account);
    const id = await addSelect("portrait");

    const result = await publisher.publish({ selectIds: [id], dryRun: false });

    expect(result).toEqual({
      status: "unavailable",
      problems: ["The bucket is not configured: set BUCKET_ENDPOINT and BUCKET_NAME."],
    });
    expect(library.pool()).toEqual([id]);
  });

  test("is unavailable without a connected Instagram account", async () => {
    const { publisher } = setup();
    const id = await addSelect("portrait");

    const result = await publisher.publish({ selectIds: [id], dryRun: false });

    expect(result).toEqual({ status: "unavailable", problems: ["No Instagram account is connected."] });
    expect(fakeBucket.objects.size).toBe(0);
  });
});

describe("the URL Instagram is given", () => {
  test("is the public URL when the bucket has a public base URL", async () => {
    const { publisher, account } = setup({ publicBaseUrl: fakeBucket.publicBaseUrl });
    await connect(account);
    const id = await addSelect("portrait");

    await postNow(publisher, id);

    expect(instagram.fetches[0]?.url).toMatch(
      new RegExp(`^${fakeBucket.publicBaseUrl}/frames/[0-9a-f-]{36}\\.jpg$`),
    );
    expect(instagram.fetches[0]?.status).toBe(200);
  });

  test("is a one-hour presigned link when there is no public base URL", async () => {
    const { publisher, account } = setup();
    await connect(account);
    const id = await addSelect("portrait");

    await postNow(publisher, id);

    const url = new URL(instagram.fetches[0]?.url ?? "http://missing");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(url.searchParams.get("X-Amz-Signature")).not.toBeNull();
    expect(instagram.fetches[0]?.status).toBe(200);
  });
});

describe("a failed publish", () => {
  test("retries three times over about fifteen minutes, then returns the select to the pool", async () => {
    const { publisher, account } = setup();
    await connect(account);
    const id = await addSelect("portrait");
    instagram.fail("container", "transient", "transient", "transient", "transient");
    const started = clock.now();

    let post = await postNow(publisher, id);
    expect(post.state).toBe("retrying");
    expect(library.pool()).toEqual([]);

    const waits: number[] = [];
    while (post.state === "retrying") {
      const wait = (post.nextAttemptAt ?? 0) - clock.now();
      waits.push(wait);
      // Not yet due: nothing happens.
      await after(publisher, wait - 1000);
      expect(publisher.post(post.id)?.attempts).toBe(post.attempts);
      await after(publisher, 1000);
      post = publisher.post(post.id) ?? post;
    }

    expect(waits).toHaveLength(3);
    expect(post.attempts).toBe(4);
    expect(post.state).toBe("failed");
    expect(post.error).toContain("Service temporarily unavailable");
    const elapsed = clock.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(12 * MINUTE);
    expect(elapsed).toBeLessThanOrEqual(18 * MINUTE);
    expect(library.pool()).toEqual([id]);
    expect(instagram.media).toHaveLength(0);
  });

  test("is attempted once when due, and keeps its waits however often the timer fires", async () => {
    const { publisher, account } = setup();
    await connect(account);
    const id = await addSelect("portrait");
    instagram.fail("container", "transient", "transient", "transient", "transient");

    let post = await postNow(publisher, id);
    const waits: number[] = [];
    while (post.state === "retrying") {
      const wait = (post.nextAttemptAt ?? 0) - clock.now();
      waits.push(wait);
      clock.advance(wait);
      // The timer fires several times while the due attempt is still running.
      await Promise.all([publisher.runDue(), publisher.runDue(), publisher.runDue()]);
      const next = publisher.post(post.id) ?? post;
      expect(next.attempts).toBe(post.attempts + 1);
      post = next;
    }

    expect(waits).toEqual(RETRY_DELAYS.slice());
    expect(post.attempts).toBe(4);
  });

  test("that succeeds on a retry is published once, with the same hashtag set", async () => {
    const { publisher, account } = setup();
    await connect(account);
    const id = await addSelect("portrait");
    // The first container is made with its caption, then checking on it fails.
    instagram.fail("status", "transient");

    const first = await postNow(publisher, id);
    expect(first.state).toBe("retrying");
    expect(first.hashtagSet).toBe("Film");
    await after(publisher, 2 * MINUTE);

    const post = publisher.post(first.id);
    expect(post?.state).toBe("published");
    expect(instagram.media).toHaveLength(1);
    expect(instagram.containers().map((c) => c.caption)).toEqual([PORTRAIT_CAPTION, PORTRAIT_CAPTION]);
  });

  test("retries a rate limit", async () => {
    const { publisher, account } = setup();
    await connect(account);
    const id = await addSelect("portrait");
    instagram.fail("publish", "publish-limit");

    const first = await postNow(publisher, id);
    expect(first.state).toBe("retrying");
    expect(first.error).toContain("publishing limit");
    await after(publisher, 2 * MINUTE);

    expect(publisher.post(first.id)?.state).toBe("published");
    expect(instagram.media).toHaveLength(1);
  });

  test("refused by Instagram for its image fails at once with Instagram's reason, and frees the select", async () => {
    // A frame of an aspect ratio Instagram refuses.
    const wide = await sharp({ create: { width: 1440, height: 400, channels: 3, background: "#808080" } })
      .jpeg()
      .toBuffer();
    const { publisher, account } = setup({ renderer: { render: async () => wide } });
    await connect(account);
    const id = await addSelect("portrait");

    const post = await postNow(publisher, id);

    expect(post.state).toBe("failed");
    expect(post.attempts).toBe(1);
    expect(post.error).toContain("aspect ratio");
    expect(library.pool()).toEqual([id]);
  });

  test("refused for a missing permission fails at once and asks for a token with the right permissions", async () => {
    const { publisher, account } = setup();
    await connect(account);
    const id = await addSelect("portrait");
    instagram.fail("container", "permission");

    const post = await postNow(publisher, id);

    expect(post.state).toBe("failed");
    expect(post.attempts).toBe(1);
    expect(post.error).toContain("instagram_business_content_publish");
    expect(library.pool()).toEqual([id]);
  });

  test("restricted by Instagram as spam fails at once, and is not retried as a rate limit", async () => {
    const { publisher, account } = setup();
    await connect(account);
    const id = await addSelect("portrait");
    instagram.fail("container", "spam");

    const post = await postNow(publisher, id);

    expect(post.state).toBe("failed");
    expect(post.attempts).toBe(1);
    expect(post.error).toContain("restrict certain activity");
    expect(library.pool()).toEqual([id]);
  });

  test("refused for a reason Selects does not know fails at once", async () => {
    const { publisher, account } = setup();
    await connect(account);
    const id = await addSelect("portrait");
    instagram.fail("container", "invalid");

    const post = await postNow(publisher, id);

    expect(post.state).toBe("failed");
    expect(post.attempts).toBe(1);
  });

  test("retries a bucket that fails for a while", async () => {
    const { publisher, account } = setup();
    await connect(account);
    const id = await addSelect("portrait");
    fakeBucket.failNext(1);

    const first = await postNow(publisher, id);
    expect(first.state).toBe("retrying");
    await after(publisher, 2 * MINUTE);

    expect(publisher.post(first.id)?.state).toBe("published");
  });

  test("with a caption over Instagram's limit fails at once, sends nothing and frees the select", async () => {
    const { publisher, account, captionStore } = setup();
    await connect(account);
    const id = await addSelect("portrait");
    captionStore.setOverride(id, { caption: `${"#tag ".repeat(31)}`.trim(), altText: null });

    const post = await postNow(publisher, id);

    expect(post.state).toBe("failed");
    expect(post.attempts).toBe(1);
    expect(post.error).toContain("31 hashtags, over Instagram's limit of 30");
    expect(fakeBucket.requests).toHaveLength(0);
    expect(instagram.requests.filter((r) => r.operation === "container")).toHaveLength(0);
    expect(library.pool()).toEqual([id]);
  });

  test("with a token Instagram no longer accepts fails at once and asks for a new token", async () => {
    const { publisher, account } = setup();
    await connect(account);
    const id = await addSelect("portrait");
    // biome-ignore lint/style/noNonNullAssertion: connected above.
    instagram.expireToken(account.credentials()!.token);

    const post = await postNow(publisher, id);

    expect(post.state).toBe("failed");
    expect(post.attempts).toBe(1);
    expect(post.error).toContain("Paste a new token in Settings");
    expect(account.view()?.status).toBe("invalid");
    expect(library.pool()).toEqual([id]);
  });

  test("refused with a token replaced while it ran keeps the new token and retries with it", async () => {
    let replace: (() => Promise<void>) | undefined;
    const { publisher, account } = setup({
      wrapApi: (api) => ({
        ...api,
        async createContainer(...args) {
          const run = replace;
          replace = undefined;
          await run?.();
          return api.createContainer(...args);
        },
      }),
    });
    await connect(account);
    const id = await addSelect("portrait");
    // The owner pastes a new token while the attempt runs, and the old one stops working.
    replace = async () => {
      instagram.expireToken(TOKEN);
      instagram.addAccount("IGfake-replacement-token-0002", {
        userId: "1784140001",
        username: "selects_test",
      });
      await account.connect("IGfake-replacement-token-0002");
    };

    const first = await postNow(publisher, id);

    expect(first.state).toBe("retrying");
    expect(account.view()?.status).toBe("connected");
    expect(library.pool()).toEqual([]);
    await publisher.runDue();
    expect(publisher.post(first.id)?.state).toBe("published");
    expect(instagram.media).toHaveLength(1);
  });

  test("never records the token or a presigned link", async () => {
    const { publisher, account } = setup();
    await connect(account);
    const id = await addSelect("portrait");
    instagram.fail("container", "transient");

    const post = await postNow(publisher, id);
    await after(publisher, 2 * MINUTE);

    // biome-ignore lint/style/noNonNullAssertion: connected above.
    const token = account.credentials()!.token;
    const everything = JSON.stringify(db.query("SELECT * FROM posts").all());
    expect(everything).not.toContain(token);
    expect(everything).not.toContain("X-Amz-");
    expect(everything).not.toContain(FAKE_BUCKET_KEYS.accessKeyId);
    expect(JSON.stringify(publisher.post(post.id))).not.toContain("X-Amz-");
  });
});

describe("location privacy while publishing", () => {
  const zoneAroundPortrait = { latitude: 10.5, longitude: -40.25, radiusMetres: 500 };
  const withheldCaption = "ISO 400\n\n#film #35mm";

  test("a privacy zone added after the frame is rendered is caught before the upload", async () => {
    const parts = setup();
    let zoned = false;
    const renderer = {
      ...parts.renderer,
      render: async (...args: Parameters<typeof parts.renderer.render>) => {
        const jpeg = await parts.renderer.render(...args);
        if (!zoned) {
          zoned = true;
          parts.zones.add(zoneAroundPortrait);
        }
        return jpeg;
      },
    };
    const { publisher, account, captures, settings } = setup({ renderer });
    await connect(account);
    const id = await addSelect("portrait");

    await postNow(publisher, id);

    const [media] = instagram.media;
    expect(media?.caption).toBe(withheldCaption);
    const withheld = await parts.renderer.render(
      // biome-ignore lint/style/noNonNullAssertion: the select was just added.
      { path: library.original(id)!.path, capture: captures.published(id)! },
      settings.frame(),
    );
    expect(new Uint8Array(media?.image ?? [])).toEqual(new Uint8Array(withheld));
  });

  test("a privacy zone added after the upload is caught before the publish call", async () => {
    let zones: ReturnType<typeof setup>["zones"] | undefined;
    let zoned = false;
    const {
      publisher,
      account,
      captures,
      renderer,
      settings,
      zones: z,
    } = setup({
      wrapApi: (api) => ({
        ...api,
        async containerStatus(...args) {
          const status = await api.containerStatus(...args);
          if (status === "FINISHED" && !zoned) {
            zoned = true;
            zones?.add(zoneAroundPortrait);
          }
          return status;
        },
      }),
    });
    zones = z;
    await connect(account);
    const id = await addSelect("portrait");

    const post = await postNow(publisher, id);

    expect(post.state).toBe("published");
    expect(instagram.media).toHaveLength(1);
    const [media] = instagram.media;
    expect(media?.caption).toBe(withheldCaption);
    const withheld = await renderer.render(
      // biome-ignore lint/style/noNonNullAssertion: the select was just added.
      { path: library.original(id)!.path, capture: captures.published(id)! },
      settings.frame(),
    );
    expect(new Uint8Array(media?.image ?? [])).toEqual(new Uint8Array(withheld));
    // The container made under the old rules was never published, and its frame is gone.
    expect(instagram.containers().filter((c) => c.status === "PUBLISHED")).toHaveLength(1);
    expect(fakeBucket.objects.size).toBe(0);
  });

  test("a location hidden between retries is withheld from the retry", async () => {
    const { publisher, account, captures } = setup();
    await connect(account);
    const id = await addSelect("portrait");
    instagram.fail("container", "transient");

    await postNow(publisher, id);
    captures.save(id, { edits: {}, locationHidden: true });
    await after(publisher, 2 * MINUTE);

    expect(instagram.media[0]?.caption).toBe(withheldCaption);
  });
});

describe("a publish interrupted part way", () => {
  test("whose answer was lost is recorded from Instagram, not published again", async () => {
    const { publisher, account } = setup();
    await connect(account);
    const id = await addSelect("portrait");
    instagram.fail("publish", "lost");

    const first = await postNow(publisher, id);
    expect(first.state).toBe("retrying");
    await after(publisher, 2 * MINUTE);

    const post = publisher.post(first.id);
    expect(instagram.media).toHaveLength(1);
    expect(post?.state).toBe("published");
    expect(post?.permalink).toBe(instagram.media[0]?.permalink ?? "missing");
  });

  test("by a restart is finished after it, and published once", async () => {
    const before = setup();
    await connect(before.account);
    const id = await addSelect("portrait");
    // Instagram publishes, and the app stops before the answer comes.
    instagram.fail("publish", "hang");
    const started = await before.publisher.publish({ selectIds: [id], dryRun: false });
    if (started.status !== "started") throw new Error(started.status);
    while (instagram.media.length === 0) await Bun.sleep(5);

    // The app starts again on the same database.
    const { publisher } = setup();
    publisher.recover();
    await publisher.runDue();

    expect(instagram.media).toHaveLength(1);
    expect(publisher.post(started.post.id)?.state).toBe("published");
    expect(publisher.post(started.post.id)?.permalink).toBe(instagram.media[0]?.permalink ?? "missing");
    expect(library.pool()).toEqual([]);

    // The attempt from before the restart hears back at last, and can no longer touch the post.
    await stopStale(started.done);
    expect(publisher.post(started.post.id)?.state).toBe("published");
  });

  test("by a restart before Instagram was asked to publish is published once after it", async () => {
    const before = setup();
    await connect(before.account);
    const id = await addSelect("portrait");
    instagram.fail("container", "hang");
    const started = await before.publisher.publish({ selectIds: [id], dryRun: false });
    if (started.status !== "started") throw new Error(started.status);
    while (instagram.containers().length === 0) await Bun.sleep(5);
    expect(library.pool()).toEqual([]);

    const { publisher } = setup();
    publisher.recover();
    await publisher.runDue();

    expect(instagram.media).toHaveLength(1);
    expect(publisher.post(started.post.id)?.state).toBe("published");

    await stopStale(started.done);
    expect(publisher.post(started.post.id)?.state).toBe("published");
    expect(instagram.media).toHaveLength(1);
  });
});

describe("a publish whose outcome Instagram has not confirmed", () => {
  /** Publishes with the answer lost, then lets every retry fail to check the container. */
  async function unconfirmed(publisher: Publisher, id: string, statusFailures = 3) {
    instagram.fail("publish", "lost");
    let post = await postNow(publisher, id);
    instagram.fail("status", ...Array<"transient">(statusFailures).fill("transient"));
    while (post.state === "retrying") {
      await after(publisher, (post.nextAttemptAt ?? 0) - clock.now());
      post = publisher.post(post.id) ?? post;
    }
    return post;
  }

  test("is kept out of the pool and needs checking, never posted twice", async () => {
    const { publisher, account } = setup();
    await connect(account);
    const id = await addSelect("portrait");

    const post = await unconfirmed(publisher, id);

    expect(post.state).toBe("unconfirmed");
    expect(post.error).toContain("Check Instagram");
    expect(library.pool()).toEqual([]);
    expect(library.get(id)?.post).toBe("unconfirmed");
    expect((await publisher.publish({ selectIds: [id], dryRun: false })).status).toBe("not-in-pool");
    expect(instagram.media).toHaveLength(1);
  });

  test("is recorded as published once Instagram answers a later check", async () => {
    const { publisher, account } = setup();
    await connect(account);
    const id = await addSelect("portrait");
    const post = await unconfirmed(publisher, id);
    expect(post.state).toBe("unconfirmed");

    await after(publisher, (post.nextAttemptAt ?? 0) - clock.now());

    const checked = publisher.post(post.id);
    expect(checked?.state).toBe("published");
    expect(checked?.permalink).toBe(instagram.media[0]?.permalink ?? "missing");
    expect(instagram.media).toHaveLength(1);
    expect(fakeBucket.objects.size).toBe(0);
  });

  test("is returned to the pool once Instagram shows it was never published", async () => {
    const { publisher, account } = setup();
    await connect(account);
    const id = await addSelect("portrait");
    // The publish request fails before Instagram does anything, then every check fails too.
    instagram.fail("publish", "transient");
    let post = await postNow(publisher, id);
    instagram.fail("status", "transient", "transient", "transient");
    while (post.state === "retrying") {
      await after(publisher, (post.nextAttemptAt ?? 0) - clock.now());
      post = publisher.post(post.id) ?? post;
    }
    expect(post.state).toBe("unconfirmed");

    await after(publisher, 30 * MINUTE);

    expect(publisher.post(post.id)?.state).toBe("failed");
    expect(publisher.post(post.id)?.error).toContain("not published");
    expect(library.pool()).toEqual([id]);
    expect(instagram.media).toHaveLength(0);
  });

  test("with a token that stops working stays out of the pool until the owner says what happened", async () => {
    const { publisher, account } = setup();
    await connect(account);
    const id = await addSelect("portrait");
    instagram.fail("publish", "lost");
    const first = await postNow(publisher, id);
    expect(first.state).toBe("retrying");
    instagram.expireToken(TOKEN);

    await after(publisher, 2 * MINUTE);

    const post = publisher.post(first.id);
    expect(post?.state).toBe("unconfirmed");
    expect(library.pool()).toEqual([]);
    expect(account.view()?.status).toBe("invalid");
  });

  test("is marked as posted by the owner, with the link they give", async () => {
    const { publisher, account } = setup();
    await connect(account);
    const id = await addSelect("portrait");
    const post = await unconfirmed(publisher, id);

    const resolved = await publisher.resolve(post.id, {
      posted: true,
      permalink: "https://www.instagram.com/p/abc/",
    });

    expect(resolved).toMatchObject({ state: "published", permalink: "https://www.instagram.com/p/abc/" });
    expect(library.pool()).toEqual([]);
    // A later check no longer touches it.
    await after(publisher, 30 * MINUTE);
    expect(publisher.post(post.id)?.permalink).toBe("https://www.instagram.com/p/abc/");
  });

  test("is marked as not posted by the owner, which returns the select to the pool", async () => {
    const { publisher, account } = setup();
    await connect(account);
    const id = await addSelect("portrait");
    const post = await unconfirmed(publisher, id);

    const resolved = await publisher.resolve(post.id, { posted: false });

    expect(resolved).toMatchObject({ state: "failed" });
    expect(library.pool()).toEqual([id]);
    expect(fakeBucket.objects.size).toBe(0);
  });

  test("can be resolved by hand only while it needs checking", async () => {
    const { publisher, account } = setup();
    await connect(account);
    const id = await addSelect("portrait");
    const post = await postNow(publisher, id);

    expect(await publisher.resolve(post.id, { posted: false })).toBe("not-unconfirmed");
    expect(await publisher.resolve("missing", { posted: false })).toBe("not-found");
    expect(publisher.post(post.id)?.state).toBe("published");
  });

  test("found published is recorded so even when its link cannot be looked up", async () => {
    const { publisher, account } = setup({
      wrapApi: (api) => ({
        ...api,
        recentMedia: async () => {
          throw new Error("down");
        },
        permalink: async () => {
          throw new Error("down");
        },
      }),
    });
    await connect(account);
    const id = await addSelect("portrait");
    instagram.fail("publish", "lost");

    const first = await postNow(publisher, id);
    await after(publisher, 2 * MINUTE);

    const post = publisher.post(first.id);
    expect(post?.state).toBe("published");
    expect(post?.permalink).toBeNull();
    expect(instagram.media).toHaveLength(1);
  });
});

describe("dry run", () => {
  test("goes through every step and publishes and uploads nothing", async () => {
    const { publisher, account } = setup();
    await connect(account);
    const id = await addSelect("portrait");
    const requestsBefore = instagram.requests.length;

    const post = await postNow(publisher, id, { dryRun: true });

    expect(post.state).toBe("dry-run");
    expect(instagram.requests.length).toBe(requestsBefore);
    expect(instagram.media).toHaveLength(0);
    expect(fakeBucket.requests).toHaveLength(0);
    expect(library.pool()).toEqual([id]);

    expect(post.caption).toBe(PORTRAIT_CAPTION);
    expect(post.altText).toBe("Photograph with Fixture Optics FX-1");
    expect(post.report).toMatchObject({
      frame: { width: 1440, height: 1800 },
      check: { hashtags: 2, problems: [] },
      upload: { url: "presigned" },
      account: "selects_test",
      problems: [],
    });
    expect(post.report?.upload?.key).toMatch(/^frames\/[0-9a-f-]{36}\.jpg$/);
    // The frame that would have gone out is kept for the owner to look at.
    const frame = publisher.dryRunFrame(post.id);
    expect(frame !== undefined && existsSync(frame)).toBe(true);
  });

  test("reports what would stop a real publish instead of stopping", async () => {
    const { publisher, captionStore } = setup({ noBucket: true });
    const id = await addSelect("portrait");
    captionStore.setOverride(id, { caption: "x".repeat(2300), altText: null });

    const post = await postNow(publisher, id, { dryRun: true });

    expect(post.state).toBe("dry-run");
    expect(post.report?.upload).toBeNull();
    expect(post.report?.account).toBeNull();
    expect(post.report?.problems).toEqual([
      "The caption is 2,300 characters, over Instagram's limit of 2,200.",
      "The bucket is not configured: set BUCKET_ENDPOINT and BUCKET_NAME.",
      "No Instagram account is connected.",
    ]);
  });

  test("is used for every publish while the dry run switch is on", async () => {
    const { publisher, account, settings } = setup();
    await connect(account);
    settings.setPublishing({ dryRun: true });
    const id = await addSelect("portrait");

    const result = await publisher.publish({ selectIds: [id] });
    if (result.status !== "started") throw new Error(result.status);
    const post = await result.done;

    expect(post.state).toBe("dry-run");
    expect(instagram.media).toHaveLength(0);
  });
});
