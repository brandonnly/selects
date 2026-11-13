import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import sharp from "sharp";
import { type Bucket, createBucket } from "./bucket";
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
  return { publisher, gallery, captures, zones, settings, account };
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
