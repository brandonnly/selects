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
    onPublished: gallery.published,
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

describe("gallery output", () => {
  test("with the switch on and a public base URL, a post writes a clean 2048 px image and a manifest entry", async () => {
    const parts = setup();
    await connect(parts.account);
    const id = await addFile(large);

    const post = await postNow(parts, id);

    const written = manifest();
    expect(written?.version).toBe(1);
    expect(written?.posts).toHaveLength(1);
    const [entry] = written?.posts ?? [];
    expect(entry?.id).toBe(post.id);
    expect(entry?.permalink).toBe(post.permalink);
    expect(entry?.caption).toBe(post.caption);
    const clean = fakeBucket.objects.get(keyOf(entry?.images.clean.url ?? ""));
    const meta = await sharp(clean?.bytes).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 2048, 1365]);
    expect([entry?.images.clean.width, entry?.images.clean.height]).toEqual([2048, 1365]);
    // The framed image Instagram was given stays, and is listed too.
    expect(fakeBucket.objects.has(keyOf(entry?.images.framed?.url ?? ""))).toBe(true);
  });
});

/** The markers of a JPEG's segments before its image data, such as 0xe0 for APP0. */
function jpegMarkers(jpeg: Uint8Array): number[] {
  const markers: number[] = [];
  let at = 2;
  while (at + 4 <= jpeg.length && jpeg[at] === 0xff) {
    const marker = jpeg[at + 1] ?? 0;
    markers.push(marker);
    if (marker === 0xda) break; // start of scan: image data follows
    at += 2 + (((jpeg[at + 2] ?? 0) << 8) | (jpeg[at + 3] ?? 0));
  }
  return markers;
}

/** The clean image a post wrote, from the bucket. */
function cleanOf(written: Manifest | undefined, index = 0) {
  const url = written?.posts[index]?.images.clean.url ?? "";
  return { key: keyOf(url), object: fakeBucket.objects.get(keyOf(url)) };
}

describe("the clean image", () => {
  test("carries no embedded metadata and no original file name", async () => {
    const parts = setup();
    await connect(parts.account);
    // The portrait carries a full EXIF block with GPS.
    const id = await addSelect("portrait");

    await postNow(parts, id);

    const { key, object } = cleanOf(manifest());
    const jpeg = object?.bytes ?? new Uint8Array();
    const meta = await sharp(jpeg).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.space).toBe("srgb");
    for (const field of ["exif", "xmp", "icc", "iptc", "orientation", "comments"] as const) {
      expect(meta[field]).toBeUndefined();
    }
    // Nothing but the JFIF header and the image: no APP1 to APP15 (EXIF, XMP, ICC, IPTC) and no comment.
    expect(jpegMarkers(jpeg).filter((m) => (m >= 0xe1 && m <= 0xef) || m === 0xfe)).toEqual([]);
    expect(Buffer.from(jpeg).includes("Fixture Optics")).toBe(false);
    expect(key).toMatch(/^gallery\/[0-9a-f-]{36}\.jpg$/);
    expect(JSON.stringify(manifest())).not.toContain("portrait");
    expect(object?.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(object?.contentType).toBe("image/jpeg");
  });

  test("is never enlarged from a smaller original", async () => {
    const parts = setup();
    await connect(parts.account);
    const id = await addSelect("portrait");

    await postNow(parts, id);

    const meta = await sharp(cleanOf(manifest()).object?.bytes).metadata();
    expect([meta.width, meta.height]).toEqual([800, 1000]);
  });

  test("is upright for an original with an orientation tag", async () => {
    const parts = setup();
    await connect(parts.account);
    const id = await addSelect("rotated");

    await postNow(parts, id);

    const meta = await sharp(cleanOf(manifest()).object?.bytes).metadata();
    expect([meta.width, meta.height]).toEqual([800, 1000]);
  });

  test("keeps the colors of wide-gamut and 16-bit originals", async () => {
    const sixteenBit = join(fixtureDir, "sixteen-bit-p3.png");
    await sharp(fixtures.landscape).toColourspace("rgb16").withIccProfile("p3").png().toFile(sixteenBit);
    const parts = setup();
    await connect(parts.account);
    const ids = [await addSelect("landscape"), await addSelect("wideGamut"), await addFile(sixteenBit)];

    for (const id of ids) await postNow(parts, id);

    // Newest first: the 16-bit one, the wide-gamut one, then the sRGB one.
    const [sixteen, wide, srgb] = await Promise.all(
      [0, 1, 2].map(async (index) =>
        sharp(cleanOf(manifest(), index).object?.bytes).raw().toBuffer({ resolveWithObject: true }),
      ),
    );
    const difference = (a: Buffer, b: Buffer) => {
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
      return sum / a.length;
    };
    expect(wide?.info.width).toBe(srgb?.info.width);
    // Read as if they were sRGB, these differ by about 5 on average; converted, by rounding and JPEG noise.
    expect(difference(srgb?.data ?? Buffer.alloc(0), wide?.data ?? Buffer.alloc(0))).toBeLessThan(2);
    expect(difference(srgb?.data ?? Buffer.alloc(0), sixteen?.data ?? Buffer.alloc(0))).toBeLessThan(2);
  });
});

/** Every field path in a value, with its JSON type: `posts[].images.clean.url` is a string. */
function shapeOf(value: unknown, path = "", into = new Map<string, Set<string>>()) {
  const add = (type: string) => {
    if (path !== "") into.set(path, (into.get(path) ?? new Set()).add(type));
  };
  if (Array.isArray(value)) {
    add("array");
    for (const item of value) shapeOf(item, `${path}[]`, into);
  } else if (value !== null && typeof value === "object") {
    add("object");
    for (const [key, item] of Object.entries(value))
      shapeOf(item, path === "" ? key : `${path}.${key}`, into);
  } else {
    add(value === null ? "null" : typeof value);
  }
  return into;
}

/** The fields docs/manifest.md lists, with the types it allows each: rows like "| `version` | number | … |". */
function documentedShape() {
  const doc = readFileSync(join(import.meta.dir, "../../docs/manifest.md"), "utf8");
  const fields = new Map<string, Set<string>>();
  for (const [, path, types] of doc.matchAll(/^\| `([^`]+)` \| ([a-z ,]+?) \|/gm)) {
    fields.set(path ?? "", new Set((types ?? "").split(/\s*(?:,|or)\s*/).filter(Boolean)));
  }
  return fields;
}

/** A zone around the large fixture's location, as a privacy zone added in Settings would be. */
const zoneAroundLarge = { latitude: -20.5, longitude: -120.75, radiusMetres: 1000 };

describe("the manifest", () => {
  test("has the shape docs/manifest.md documents, every field listed and no other", async () => {
    const parts = setup();
    await connect(parts.account);
    // One entry with every field, one with nulls where a select lacks a field or its location.
    await postNow(parts, await addFile(large));
    await postNow(parts, await addSelect("noExif"));

    const documented = documentedShape();
    const written = shapeOf(manifest());
    expect([...written.keys()].sort()).toEqual([...documented.keys()].sort());
    for (const [path, types] of written) {
      for (const type of types)
        expect(`${path}: ${[...(documented.get(path) ?? [])].join(", ")}`).toContain(type);
    }
  });

  test("holds no coordinates, in any field, for a select whose location is hidden", async () => {
    const parts = setup();
    await connect(parts.account);
    const id = await addFile(large);
    parts.captures.save(id, { edits: {}, locationHidden: true });

    await postNow(parts, id);

    const [entry] = manifest()?.posts ?? [];
    expect(entry?.location).toBeNull();
    const text = new TextDecoder().decode(fakeBucket.objects.get("posts.json")?.bytes);
    for (const printed of ["20.5", "120.75", "20°30'00\"S", "120°45'00\"W"])
      expect(text).not.toContain(printed);
  });

  test("lists a select's coordinates, in its caption too, while they may be published", async () => {
    const parts = setup();
    await connect(parts.account);

    await postNow(parts, await addFile(large));

    const [entry] = manifest()?.posts ?? [];
    expect(entry?.location).toEqual({ latitude: -20.5, longitude: -120.75 });
    expect(entry?.caption).toBe(`20°30'00"S 120°45'00"W\nFixture Optics FX-3 · Fixture 85mm F1.8\n\n#film`);
  });

  test("is rewritten without a location hidden after the post, caption included, on the next run", async () => {
    const parts = setup();
    await connect(parts.account);
    const id = await addFile(large);
    await postNow(parts, id);

    const frame = keyOf(manifest()?.posts[0]?.images.framed?.url ?? "");
    expect(fakeBucket.objects.has(frame)).toBe(true);

    parts.captures.save(id, { edits: {}, locationHidden: true });
    await parts.gallery.runDue();

    const [entry] = manifest()?.posts ?? [];
    expect(entry?.location).toBeNull();
    expect(entry?.caption).toBe("Fixture Optics FX-3 · Fixture 85mm F1.8\n\n#film");
    const text = new TextDecoder().decode(fakeBucket.objects.get("posts.json")?.bytes);
    for (const printed of ["20.5", "120.75", "20°30'"]) expect(text).not.toContain(printed);
    // The framed image prints the coordinates: it leaves the manifest, then the bucket.
    expect(entry?.images.framed).toBeNull();
    expect(fakeBucket.objects.has(frame)).toBe(false);
    expect(fakeBucket.objects.has(keyOf(entry?.images.clean.url ?? ""))).toBe(true);
  });

  test("is rewritten without a location inside a privacy zone added after the post", async () => {
    const parts = setup();
    await connect(parts.account);
    await postNow(parts, await addFile(large));
    const frame = keyOf(manifest()?.posts[0]?.images.framed?.url ?? "");

    parts.zones.add(zoneAroundLarge);
    await parts.gallery.runDue();

    expect(manifest()?.posts[0]?.location).toBeNull();
    expect(manifest()?.posts[0]?.caption).not.toContain("20°30'");
    expect(manifest()?.posts[0]?.images.framed).toBeNull();
    expect(fakeBucket.objects.has(frame)).toBe(false);
  });

  test("is rewritten without a location, or the framed image, once the select is deleted", async () => {
    const parts = setup();
    await connect(parts.account);
    const id = await addFile(large);
    await postNow(parts, id);
    const frame = keyOf(manifest()?.posts[0]?.images.framed?.url ?? "");

    library.remove(id);
    await parts.gallery.runDue();

    const [entry] = manifest()?.posts ?? [];
    expect(entry?.location).toBeNull();
    expect(entry?.caption).not.toContain("20°30'");
    expect(entry?.images.framed).toBeNull();
    expect(fakeBucket.objects.has(frame)).toBe(false);
  });

  test("keeps the framed image of a post that had no coordinates to withhold", async () => {
    const parts = setup();
    await connect(parts.account);
    await postNow(parts, await addSelect("noExif"));

    await parts.gallery.runDue();

    const framed = manifest()?.posts[0]?.images.framed;
    expect(framed).not.toBeNull();
    expect(fakeBucket.objects.has(keyOf(framed?.url ?? ""))).toBe(true);
  });

  test("keeps the capture data a post was published with, whatever is edited later", async () => {
    const parts = setup();
    await connect(parts.account);
    const id = await addFile(large);
    await postNow(parts, id);

    parts.captures.save(id, { edits: { camera: "Edited Camera" }, locationHidden: false });
    await parts.gallery.runDue();

    expect(manifest()?.posts[0]?.capture.camera).toBe("Fixture Optics FX-3");
  });
});

const objectKeys = () => [...fakeBucket.objects.keys()].sort();
const manifestWrites = () =>
  fakeBucket.requests.filter((r) => r.method === "PUT" && r.path.endsWith("/posts.json")).length;

describe("the gallery switch", () => {
  test("off, as it is by default, deletes the framed image once published and writes nothing else", async () => {
    const parts = setup({ gallery: false });
    await connect(parts.account);
    expect(parts.gallery.view().enabled).toBe(false);

    const post = await postNow(parts, await addSelect("portrait"));

    expect(post.state).toBe("published");
    expect(objectKeys()).toEqual([]);
    expect(fakeBucket.requests.some((r) => r.path.endsWith("/posts.json"))).toBe(false);
  });

  test("turned off later stops new posts writing to the gallery, and leaves earlier ones listed", async () => {
    const parts = setup();
    await connect(parts.account);
    const first = await postNow(parts, await addSelect("portrait"));

    parts.gallery.setEnabled(false);
    await postNow(parts, await addSelect("square"));
    await parts.gallery.runDue();

    expect(manifest()?.posts.map((p) => p.id)).toEqual([first.id]);
    // The first post's two images, and the manifest: the second post's frame is gone.
    expect(objectKeys()).toHaveLength(3);
  });

  test("is unavailable without a public base URL, saying why, and cannot be turned on", async () => {
    const parts = setup({ publicBaseUrl: null });
    await connect(parts.account);

    const availability = parts.gallery.availability();
    expect(availability.available).toBe(false);
    expect(availability.available ? "" : availability.reason).toContain("public base URL");
    expect(parts.gallery.setEnabled(true).ok).toBe(false);
    expect(parts.gallery.view().enabled).toBe(false);

    await postNow(parts, await addSelect("portrait"));
    expect(objectKeys()).toEqual([]);
  });
});

describe("remove from gallery", () => {
  test("deletes the post's public images and its manifest entry, and leaves the select posted", async () => {
    const parts = setup();
    await connect(parts.account);
    const id = await addSelect("portrait");
    const post = await postNow(parts, id);
    const other = await postNow(parts, await addSelect("square"));
    const instagramRequests = instagram.requests.length;

    expect(parts.gallery.remove(post.id)).toBe("removing");
    await parts.gallery.settled();

    expect(manifest()?.posts.map((p) => p.id)).toEqual([other.id]);
    const left = manifest()?.posts[0];
    expect(objectKeys()).toEqual(
      ["posts.json", keyOf(left?.images.clean.url ?? ""), keyOf(left?.images.framed?.url ?? "")].sort(),
    );
    expect(parts.publisher.post(post.id)?.state).toBe("published");
    expect(library.get(id)?.inPool).toBe(false);
    expect(instagram.requests.length).toBe(instagramRequests);
    expect(parts.gallery.view().posts.find((p) => p.postId === post.id)?.state).toBe("removed");
  });

  test("works while the bucket is failing, finishing once it answers again", async () => {
    const parts = setup();
    await connect(parts.account);
    const post = await postNow(parts, await addSelect("portrait"));
    const listed = manifest()?.posts[0];

    fakeBucket.failNext(1000);
    parts.gallery.remove(post.id);
    await parts.gallery.settled();
    expect(parts.gallery.view().posts[0]?.state).toBe("removing");
    // The manifest could not be rewritten, so the images it lists are still there.
    expect(manifest()?.posts).toHaveLength(1);
    expect(fakeBucket.objects.has(keyOf(listed?.images.clean.url ?? ""))).toBe(true);

    fakeBucket.failNext(0);
    clock.advance(60 * 60 * 1000);
    await parts.gallery.runDue();
    await parts.publisher.runDue();

    expect(manifest()?.posts).toEqual([]);
    expect(objectKeys()).toEqual(["posts.json"]);
    expect(parts.gallery.view().posts[0]?.state).toBe("removed");
  });

  test("deletes images that fail to delete later, through the cleanup record", async () => {
    let deletesFail = true;
    const parts = setup({
      wrapBucket: (bucket) => ({
        ...bucket,
        delete: async (key) => {
          if (deletesFail) throw new BucketError("The bucket refused to delete the object.");
          return bucket.delete(key);
        },
      }),
    });
    await connect(parts.account);
    const post = await postNow(parts, await addSelect("portrait"));

    parts.gallery.remove(post.id);
    await parts.gallery.settled();
    expect(manifest()?.posts).toEqual([]);
    expect(objectKeys()).toHaveLength(3);

    deletesFail = false;
    await parts.publisher.runDue();
    expect(objectKeys()).toEqual(["posts.json"]);
  });

  test("twice, or of a post not in the gallery, changes nothing more", async () => {
    const parts = setup();
    await connect(parts.account);
    const post = await postNow(parts, await addSelect("portrait"));

    parts.gallery.remove(post.id);
    parts.gallery.remove(post.id);
    await parts.gallery.settled();

    expect(manifest()?.posts).toEqual([]);
    expect(parts.gallery.remove("no-such-post")).toBe("not-found");
  });
});

/** A bucket whose object uploads fail while `failing.on` is set, for keys that `failing.match`. */
function failingObjects(failing: { on: boolean; match: (key: string) => boolean }) {
  return (bucket: Bucket): Bucket => ({
    ...bucket,
    putObject: async (key, ...rest) => {
      if (failing.on && failing.match(key)) throw new BucketError("The bucket refused to store the object.");
      return bucket.putObject(key, ...rest);
    },
  });
}

describe("gallery output that fails", () => {
  test("never fails, undoes or repeats the post, and is retried on its own", async () => {
    const failing = { on: true, match: (key: string) => key.startsWith("gallery/") };
    const parts = setup({ wrapBucket: failingObjects(failing) });
    await connect(parts.account);
    const id = await addSelect("portrait");

    const post = await postNow(parts, id);

    expect(post.state).toBe("published");
    expect(post.error).toBeNull();
    expect(library.get(id)?.inPool).toBe(false);
    const [state] = parts.gallery.view().posts;
    expect(state?.state).toBe("writing");
    expect(state?.error).toBe("The bucket refused to store the object.");
    expect(manifest()?.posts ?? []).toEqual([]);

    failing.on = false;
    // Not before its wait is over.
    await parts.gallery.runDue();
    expect(manifest()?.posts ?? []).toEqual([]);
    clock.advance(60 * 1000);
    await parts.gallery.runDue();
    await parts.publisher.runDue();

    expect(manifest()?.posts.map((p) => p.id)).toEqual([post.id]);
    expect(parts.gallery.view().posts[0]).toMatchObject({ state: "listed", error: null });
    expect(instagram.media).toHaveLength(1);
    expect(parts.publisher.post(post.id)?.state).toBe("published");
  });

  test("never records or shows a link to the bucket in its error", async () => {
    const parts = setup({ wrapBucket: failingObjects({ on: true, match: () => true }) });
    await connect(parts.account);

    await postNow(parts, await addSelect("portrait"));

    expect(JSON.stringify(parts.gallery.view())).not.toContain("X-Amz");
    const stored = db.query<{ error: string | null }, []>("SELECT error FROM gallery_posts").all();
    expect(stored.map((row) => row.error)).toEqual(["The bucket refused to store the object."]);
  });
});

describe("a stop part way", () => {
  test("between storing the images and the manifest lists the post on the next run after the restart", async () => {
    const failing = { on: true, match: (key: string) => key === "posts.json" };
    const before = setup({ wrapBucket: failingObjects(failing) });
    await connect(before.account);
    const post = await postNow(before, await addSelect("portrait"));
    expect(manifest()).toBeUndefined();

    // Restarted: a new gallery over the same database.
    failing.on = false;
    const after = setup();
    await after.gallery.runDue();

    const [entry] = manifest()?.posts ?? [];
    expect(entry?.id).toBe(post.id);
    expect(fakeBucket.objects.has(keyOf(entry?.images.clean.url ?? ""))).toBe(true);
  });

  test("after storing the clean image but before recording it stores it again under the same key", async () => {
    // The image lands, and the answer is lost.
    let lose = true;
    const parts = setup({
      wrapBucket: (bucket) => ({
        ...bucket,
        putObject: async (key, ...rest) => {
          await bucket.putObject(key, ...rest);
          if (lose && key.startsWith("gallery/")) throw new BucketError("The bucket did not answer in time.");
        },
      }),
    });
    await connect(parts.account);
    await postNow(parts, await addSelect("portrait"));

    lose = false;
    clock.advance(60 * 1000);
    await parts.gallery.runDue();

    const gallery = objectKeys().filter((key) => key.startsWith("gallery/"));
    expect(gallery).toHaveLength(1);
    expect(keyOf(manifest()?.posts[0]?.images.clean.url ?? "")).toBe(gallery[0] ?? "missing");
  });
});

describe("modes", () => {
  test("a post made in fake mode never has gallery files written to or deleted from another mode's bucket", async () => {
    const fake = setup();
    await connect(fake.account);
    const post = await postNow(fake, await addSelect("portrait"));
    const requests = fakeBucket.requests.length;

    // Restarted in live mode, against a bucket that stands in for the live one.
    const live = setup({ mode: "live" });
    await live.gallery.runDue();
    expect(live.gallery.remove(post.id)).toBe("other-mode");
    await live.gallery.settled();

    expect(fakeBucket.requests.length).toBe(requests);
  });
});

describe("manifest writes", () => {
  test("keep entries newest first in a stable order, and are not repeated when nothing changed", async () => {
    const parts = setup();
    await connect(parts.account);
    const first = await postNow(parts, await addSelect("portrait"));
    clock.advance(60 * 1000);
    const second = await postNow(parts, await addSelect("square"));
    const writes = manifestWrites();

    await parts.gallery.runDue();
    await parts.gallery.runDue();

    expect(manifest()?.posts.map((p) => p.id)).toEqual([second.id, first.id]);
    expect(manifestWrites()).toBe(writes);
  });

  test("list a post once however often it is reported published", async () => {
    const parts = setup();
    await connect(parts.account);
    const post = await postNow(parts, await addSelect("portrait"));

    parts.gallery.published(post.id);
    parts.gallery.published(post.id);
    await parts.gallery.settled();

    expect(manifest()?.posts.map((p) => p.id)).toEqual([post.id]);
    expect(objectKeys().filter((key) => key.startsWith("gallery/"))).toHaveLength(1);
  });

  test("that time out and land late never delete the manifest, and a stale one is replaced", async () => {
    const parts = setup({ timeoutMs: 150 });
    await connect(parts.account);
    const id = await addFile(large);
    await postNow(parts, id);

    // A write of the manifest without the location is given up on, and is still on its way.
    parts.captures.save(id, { edits: {}, locationHidden: true });
    fakeBucket.slow(500);
    await parts.gallery.runDue();
    expect(parts.gallery.view().manifestError).toContain("did not answer in time");
    fakeBucket.slow(0);
    // Meanwhile the location is shown again, and that manifest is stored at once.
    parts.captures.save(id, { edits: {}, locationHidden: false });
    await parts.gallery.runDue();
    expect(manifest()?.posts[0]?.location).not.toBeNull();

    // The stale one lands over it, then is replaced.
    await Bun.sleep(600);
    await parts.gallery.settled();

    expect(fakeBucket.objects.has("posts.json")).toBe(true);
    expect(manifest()?.posts[0]?.location).toEqual({ latitude: -20.5, longitude: -120.75 });
  });

  test("write nothing to a bucket whose gallery was never used", async () => {
    const parts = setup();
    await parts.gallery.runDue();
    expect(fakeBucket.requests).toEqual([]);
  });
});

/** Posts a select that Instagram then never confirms: it is left unconfirmed, its frame deleted. */
async function postUnconfirmed(parts: ReturnType<typeof setup>, selectId: string) {
  instagram.fail("publish", "lost");
  let post = await postNow(parts, selectId);
  instagram.fail("status", "transient", "transient", "transient");
  while (post.state === "retrying") {
    clock.advance((post.nextAttemptAt ?? 0) - clock.now());
    await parts.publisher.runDue();
    post = parts.publisher.post(post.id) ?? post;
  }
  expect(post.state).toBe("unconfirmed");
  return post;
}

/** Every way a caption or the manifest could print the large fixture's coordinates. */
const LARGE_PRINTED = ["20.5", "120.75", "20°30'", "120°45'", "-20.5000", "20,5"];

describe("a post Instagram had not confirmed", () => {
  test("marked as posted by the owner is listed, with no framed image since its frame was deleted", async () => {
    const parts = setup();
    await connect(parts.account);
    const post = await postUnconfirmed(parts, await addSelect("portrait"));

    await parts.publisher.resolve(post.id, { posted: true, permalink: "https://www.instagram.com/p/abc/" });
    await parts.gallery.settled();

    const [entry] = manifest()?.posts ?? [];
    expect(entry).toMatchObject({ id: post.id, permalink: "https://www.instagram.com/p/abc/" });
    expect(entry?.images.framed).toBeNull();
    expect(fakeBucket.objects.has(keyOf(entry?.images.clean.url ?? ""))).toBe(true);
  });
});

describe("what an entry says", () => {
  test("for a post marked as posted after its location was hidden, lists no coordinates anywhere", async () => {
    const parts = setup();
    await connect(parts.account);
    const id = await addFile(large);
    const post = await postUnconfirmed(parts, id);

    // Days later the owner hides its location, then says it was posted.
    clock.advance(3 * 24 * 60 * 60 * 1000);
    parts.captures.save(id, { edits: {}, locationHidden: true });
    await parts.publisher.resolve(post.id, { posted: true });
    await parts.gallery.settled();

    const [entry] = manifest()?.posts ?? [];
    expect(entry?.id).toBe(post.id);
    expect(entry?.location).toBeNull();
    expect(entry?.images.framed).toBeNull();
    expect(entry?.caption).toBe("Fixture Optics FX-3 · Fixture 85mm F1.8\n\n#film");
    const text = new TextDecoder().decode(fakeBucket.objects.get("posts.json")?.bytes);
    for (const printed of LARGE_PRINTED) expect(text).not.toContain(printed);
  });

  test("for a post marked as posted after its capture data was edited, lists what was posted", async () => {
    const parts = setup();
    await connect(parts.account);
    const id = await addFile(large);
    const post = await postUnconfirmed(parts, id);

    parts.captures.save(id, {
      edits: { camera: "Edited Camera", coordinates: { latitude: 10.25, longitude: 30.75 } },
      locationHidden: false,
    });
    await parts.publisher.resolve(post.id, { posted: true });
    await parts.gallery.settled();

    const [entry] = manifest()?.posts ?? [];
    expect(entry?.capture.camera).toBe("Fixture Optics FX-3");
    // What was posted is no longer what the select says: its place is not listed.
    expect(entry?.location).toBeNull();
    const text = new TextDecoder().decode(fakeBucket.objects.get("posts.json")?.bytes);
    for (const printed of ["Edited Camera", "10.25", "30.75", "10°15'", ...LARGE_PRINTED])
      expect(text).not.toContain(printed);
  });

  test("lists a hand-written caption as empty once its post's location is withheld", async () => {
    const parts = setup();
    await connect(parts.account);
    const id = await addFile(large);
    // Coordinates written by hand, in forms no template prints.
    parts.captionStore.setOverride(id, {
      caption: "Twenty and a half south (lat -20.50, lon -120.750), S 20 30 W 120 45",
      altText: null,
    });
    await postNow(parts, id);
    expect(manifest()?.posts[0]?.caption).toContain("-20.50");

    parts.captures.save(id, { edits: {}, locationHidden: true });
    await parts.gallery.runDue();

    const [entry] = manifest()?.posts ?? [];
    expect(entry?.caption).toBe("");
    // Alt text from the template is listed as it reads with the location withheld.
    expect(entry?.altText).toBe("Photograph with Fixture Optics FX-3");
  });

  test("lists hand-written alt text as empty once its post's location is withheld", async () => {
    const parts = setup();
    await connect(parts.account);
    const id = await addFile(large);
    parts.captionStore.setOverride(id, { caption: null, altText: "Taken at 20.5 S, 120.75 W" });
    await postNow(parts, id);

    parts.zones.add(zoneAroundLarge);
    await parts.gallery.runDue();

    const [entry] = manifest()?.posts ?? [];
    expect(entry?.altText).toBe("");
    expect(entry?.caption).toBe("Fixture Optics FX-3 · Fixture 85mm F1.8\n\n#film");
  });
});
