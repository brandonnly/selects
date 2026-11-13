import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import sharp from "sharp";
import { type Bucket, BucketError, createBucket } from "./bucket";
import { createCaptionStore } from "./caption-store";
import { createCaptures } from "./capture";
import { createFakeClock, type FakeClock } from "./clock";
import { BucketSettings, type InstagramMode } from "./config";
import { openDatabase } from "./db";
import { createFakeBucket, FAKE_BUCKET_KEYS, type FakeBucket } from "./fake-bucket";
import { createFakeInstagram, type FakeInstagram } from "./fake-instagram";
import { type FixtureName, generateFixtures, makePhoto } from "./fixtures";
import { createFrameRenderer } from "./frame";
import { createGallery } from "./gallery";
import { createInstagramApi } from "./instagram";
import { createInstagramAccount } from "./instagram-account";
import { createLibrary, type Library } from "./library";
import { migrations } from "./migrations";
import { createPublisher } from "./publisher";
import { createSettings } from "./settings";
import { createZones } from "./zones";

const TOKEN = "IGfake-gallery-token-0001";

let fixtureDir: string;
let fixtures: Record<FixtureName, string>;
/** A photo larger than the gallery image, 3000 × 2000, with full EXIF and GPS. */
let large: string;
beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), "selects-gallery-fixtures-"));
  fixtures = await generateFixtures(fixtureDir);
  large = join(fixtureDir, "large.jpg");
  writeFileSync(
    large,
    await makePhoto({
      scene: 2,
      width: 3000,
      height: 2000,
      format: "jpeg",
      exif: {
        make: "Fixture Optics",
        model: "FX-3",
        lens: "Fixture 85mm F1.8",
        capturedAt: "2025:03:04 05:06:07",
        latitude: -20.5,
        longitude: -120.75,
      },
    }),
  );
});
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

let dataDir: string;
let db: Database;
let clock: FakeClock;
let instagram: FakeInstagram;
let fakeBucket: FakeBucket;
let library: Library;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "selects-gallery-"));
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

const TEMPLATES = {
  caption: "{coordinates}\n{camera} · {lens}\n\n{hashtags}",
  altText: "Photograph[ with {camera}]",
  hashtagSets: [{ name: "Film", tags: ["#film"] }],
};

/** A publisher and its gallery against the fakes, with the gallery switch on unless told otherwise. */
function setup(
  options: {
    publicBaseUrl?: string | null;
    gallery?: boolean;
    mode?: InstagramMode;
    wrapBucket?: (bucket: Bucket) => Bucket;
    /** How long one bucket request may take. */
    timeoutMs?: number;
    /** Whether the gallery hears of posts as they are published: not when Selects stops first. */
    told?: boolean;
  } = {},
) {
  const mode = options.mode ?? "fake";
  const zones = createZones(db);
  const captures = createCaptures({ db, library, zones });
  const settings = createSettings(db);
  const captionStore = createCaptionStore(db);
  captionStore.setTemplates(TEMPLATES);
  const api = createInstagramApi({ baseUrl: instagram.url });
  const account = createInstagramAccount({ db, api, clock, mode });
  const publicBaseUrl =
    options.publicBaseUrl === null ? undefined : (options.publicBaseUrl ?? fakeBucket.publicBaseUrl);
  const plain = createBucket(
    new BucketSettings(fakeBucket.endpoint, fakeBucket.name, "auto", publicBaseUrl, FAKE_BUCKET_KEYS),
    { timeoutMs: options.timeoutMs },
  );
  const bucket = options.wrapBucket?.(plain) ?? plain;
  const gallery = createGallery({ db, library, captures, zones, settings, bucket, mode, clock });
  const publisher = createPublisher({
    db,
    dataDir,
    library,
    captures,
    renderer: createFrameRenderer({ dataDir }),
    settings,
    captionStore,
    account,
    api,
    bucket,
    clock,
    mode,
    random: () => 0,
    galleryWanted: gallery.wanted,
    onPublished: options.told === false ? () => {} : gallery.published,
  });
  if (options.gallery !== false && gallery.availability().available) gallery.setEnabled(true);
  return { publisher, gallery, captures, zones, settings, account, captionStore };
}

async function connect(account: ReturnType<typeof setup>["account"]) {
  instagram.addAccount(TOKEN, { userId: "1784140002", username: "selects_gallery" });
  await account.connect(TOKEN);
}

async function addFile(path: string): Promise<string> {
  const copy = join(dataDir, `incoming-${basename(path)}`);
  copyFileSync(path, copy);
  const result = await library.addUpload(copy, { fileName: basename(path), alreadyPosted: false });
  if (result.status !== "added") throw new Error(`could not add ${path}`);
  return result.select.id;
}

const addSelect = (name: FixtureName) => addFile(fixtures[name]);

/** Posts a select now and waits for its gallery output. */
async function postNow(parts: ReturnType<typeof setup>, selectId: string) {
  const result = await parts.publisher.publish({ selectIds: [selectId], dryRun: false });
  if (result.status !== "started") throw new Error(`publish was ${result.status}`);
  const post = await result.done;
  await parts.gallery.settled();
  return post;
}

type Manifest = {
  version: number;
  posts: {
    id: string;
    postedAt: string;
    permalink: string | null;
    caption: string;
    altText: string;
    images: {
      clean: { url: string; width: number; height: number };
      framed: { url: string; width: number; height: number } | null;
    };
    capture: Record<string, string | number | null>;
    location: { latitude: number; longitude: number } | null;
  }[];
};

function manifest(): Manifest | undefined {
  const object = fakeBucket.objects.get("posts.json");
  return object === undefined ? undefined : JSON.parse(new TextDecoder().decode(object.bytes));
}

/** The bucket key of a public URL. */
const keyOf = (url: string) => url.slice(`${fakeBucket.publicBaseUrl}/`.length);
function failingObjects(failing: { on: boolean; match: (key: string) => boolean }) {
  return (bucket: Bucket): Bucket => ({
    ...bucket,
    putObject: async (key, ...rest) => {
      if (failing.on && failing.match(key)) throw new BucketError("The bucket refused to store the object.");
      return bucket.putObject(key, ...rest);
    },
  });
}

describe("review scenarios", () => {
  test("no public base URL: a location hidden after the post stays public, and removal never finishes", async () => {
    const before = setup();
    await connect(before.account);
    const id = await addFile(large);
    const post = await postNow(before, id);
    const listed = manifest()?.posts[0];
    const frameKey = keyOf(listed?.images.framed?.url ?? "");
    const cleanKey = keyOf(listed?.images.clean.url ?? "");
    expect(listed?.location).not.toBeNull();

    // Restarted without BUCKET_PUBLIC_URL, same bucket and database.
    const after = setup({ publicBaseUrl: null });
    after.captures.save(id, { edits: {}, locationHidden: true });
    for (let i = 0; i < 3; i++) {
      clock.advance(60 * 60 * 1000);
      await after.gallery.runDue();
    }
    console.log("manifest location still:", JSON.stringify(manifest()?.posts[0]?.location));
    console.log("manifest caption still:", JSON.stringify(manifest()?.posts[0]?.caption));
    console.log("frame still stored:", fakeBucket.objects.has(frameKey));
    console.log("view:", JSON.stringify(after.gallery.view()));

    expect(after.gallery.remove(post.id)).toBe("removing");
    await after.gallery.runDue();
    await after.gallery.settled();
    console.log("after remove: manifest lists it:", manifest()?.posts.length, "clean stored:", fakeBucket.objects.has(cleanKey), "frame stored:", fakeBucket.objects.has(frameKey));
    console.log("view:", JSON.stringify(after.gallery.view().posts));
  });

  test("switch turned off between recording a post for the gallery and adopting it", async () => {
    const parts = setup({ told: false });
    await connect(parts.account);
    await postNow(parts, await addSelect("portrait"));
    parts.gallery.setEnabled(false);
    await parts.gallery.runDue();
    console.log("listed after switch off:", manifest()?.posts.length);
  });

  test("a stale manifest with coordinates lands after a newer one withheld them", async () => {
    const parts = setup({ timeoutMs: 150 });
    await connect(parts.account);
    const a = await addFile(large);
    const b = await addSelect("portrait");
    const postA = await postNow(parts, a);
    const postB = await postNow(parts, b);
    const frameA = keyOf(manifest()?.posts.find((p) => p.id === postA.id)?.images.framed?.url ?? "");

    fakeBucket.slow(500);
    parts.gallery.remove(postB.id);
    await parts.gallery.runDue();
    fakeBucket.slow(0);
    parts.captures.save(a, { edits: {}, locationHidden: true });
    await parts.gallery.runDue();
    console.log("newer: A location", JSON.stringify(manifest()?.posts.find((p) => p.id === postA.id)?.location), "frame A stored:", fakeBucket.objects.has(frameA));
    // Watch the bucket while the stale write lands.
    const seen: string[] = [];
    for (let i = 0; i < 40; i++) {
      await Bun.sleep(20);
      const e = manifest()?.posts.find((p) => p.id === postA.id);
      seen.push(JSON.stringify(e?.location ?? null) + (e?.images.framed ? "+frame" : ""));
    }
    await parts.gallery.settled();
    console.log("seen:", [...new Set(seen)].join(" | "));
    console.log("final A location:", JSON.stringify(manifest()?.posts.find((p) => p.id === postA.id)?.location));
  });
});
