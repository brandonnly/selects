import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { type Bucket, BucketError, type ObjectHeaders } from "./bucket";
import type { Captures, PublishedCapture } from "./capture";
import { type Clock, MINUTE } from "./clock";
import type { InstagramMode } from "./config";
import { FRAME_HEIGHT, FRAME_WIDTH, fieldValues } from "./frame";
import { errorKind, type Library } from "./library";
import type { Settings } from "./settings";
import { insideZone, type Zones } from "./zones";

/** The manifest's key in the bucket. A gallery reads it from the public base URL. */
export const MANIFEST_KEY = "posts.json";

/** The manifest format's version. See docs/manifest.md: a change that breaks a reader is a new version. */
export const MANIFEST_VERSION = 1;

/** The clean image's long side, in pixels. A smaller original is never enlarged. */
export const CLEAN_SIZE = 2048;
const CLEAN_QUALITY = 90;

/** Images live under random keys and never change: kept for a year. */
const IMAGE_HEADERS: ObjectHeaders = {
  type: "image/jpeg",
  cacheControl: "public, max-age=31536000, immutable",
};

/** The manifest changes with each post: checked with the bucket on every read. */
const MANIFEST_HEADERS: ObjectHeaders = {
  type: "application/json; charset=utf-8",
  cacheControl: "no-cache",
};

/** The wait before each retry of a failed write: then once an hour, for as long as it fails. */
const RETRY_DELAYS = [MINUTE, 5 * MINUTE, 15 * MINUTE, 60 * MINUTE] as const;

/** Decimal places kept in a published coordinate: about 10 cm. */
const COORDINATE_PLACES = 6;

/** One post in `posts.json`, as docs/manifest.md documents it. */
export type ManifestEntry = {
  id: string;
  postedAt: string;
  permalink: string | null;
  caption: string;
  altText: string;
  images: {
    clean: { url: string; width: number; height: number };
    framed: { url: string; width: number; height: number } | null;
  };
  capture: {
    camera: string | null;
    lens: string | null;
    focalLength: number | null;
    exposureTime: number | null;
    fNumber: number | null;
    iso: number | null;
    takenAt: string | null;
  };
  location: { latitude: number; longitude: number } | null;
};

export type Manifest = { version: typeof MANIFEST_VERSION; posts: ManifestEntry[] };

export type GalleryAvailability =
  | { available: true; manifestUrl: string }
  | { available: false; reason: string };

/**
 * A post's gallery output, as the owner sees it.
 * - `writing`: its clean image or the manifest entry is still to be written, or is being retried.
 * - `listed`: in the manifest.
 * - `removing`: being taken out of the manifest, then its images deleted.
 * - `removed`: gone from the gallery. The post stays published.
 */
export type GalleryState = "writing" | "listed" | "removing" | "removed";

export type GalleryPost = {
  postId: string;
  state: GalleryState;
  /** Why the last write failed; it is tried again. */
  error: string | null;
  /** Which bucket its objects are in. Only a run in that mode writes or deletes them. */
  mode: InstagramMode;
};

export type GalleryView = {
  /** The switch as saved. Gallery output is written only while it is on and available. */
  enabled: boolean;
  availability: GalleryAvailability;
  /** Why the manifest could not be written; it is tried again. */
  manifestError: string | null;
  posts: GalleryPost[];
};

export type RemoveResult = "removing" | "not-found" | "other-mode";

export type GalleryOptions = {
  db: Database;
  library: Library;
  captures: Captures;
  zones: Zones;
  settings: Settings;
  /** The bucket in use: the fake one in fake mode. */
  bucket: Bucket | { missing: string[] };
  /** Which Instagram, and so which bucket, this run uses. */
  mode: InstagramMode;
  clock: Clock;
};

type Row = {
  post_id: string;
  mode: InstagramMode;
  state: "writing" | "written" | "removing" | "removed";
  capture: string;
  image_key: string | null;
  image_url: string | null;
  image_width: number | null;
  image_height: number | null;
  frame_key: string | null;
  frame_url: string | null;
  attempts: number;
  next_attempt_at: number | null;
  error: string | null;
  added_at: number;
};

type Listed = Row & {
  caption: string;
  alt_text: string;
  permalink: string | null;
  published_at: number | null;
  created_at: number;
};

/**
 * Gallery output (docs/PRODUCT.md, ADR 0008): a clean image and a manifest entry in the bucket
 * for each post published while the switch is on, for a public gallery to read.
 *
 * The database is the source of truth: `posts.json` is rebuilt from it whole on every write,
 * never read back. An entry is listed only once its clean image is stored, and an image is
 * deleted only once a manifest without it is stored, so the manifest never points at a missing
 * image. Failed writes are retried by `runDue`, apart from the post, which they never touch.
 * Capture data comes only from `captures.published`, and a location withheld since a post is
 * taken out of its entry, caption included, on the next run.
 */
export function createGallery(options: GalleryOptions) {
  const { db, library, captures, zones, settings, mode, clock } = options;
  const bucket = "missing" in options.bucket ? undefined : options.bucket;

  /** The manifest last stored by this process, and how its writes are going. Rewritten once at start. */
  const manifest = {
    hash: undefined as string | undefined,
    error: null as string | null,
    failures: 0,
    nextAt: 0,
  };

  const rowOf = (postId: string) =>
    db.query<Row, [string]>("SELECT * FROM gallery_posts WHERE post_id = ?").get(postId);
  const selectOf = (postId: string) =>
    db
      .query<{ select_id: string | null }, [string]>(
        "SELECT select_id FROM post_selects WHERE post_id = ? ORDER BY position LIMIT 1",
      )
      .get(postId)?.select_id ?? undefined;

  function availability(): GalleryAvailability {
    if (bucket === undefined) {
      const missing = "missing" in options.bucket ? options.bucket.missing : [];
      return {
        available: false,
        reason:
          missing.length === 0
            ? "No bucket is available."
            : `The bucket is not configured: set ${missing.join(", ")}.`,
      };
    }
    if (bucket.urlKind !== "public") {
      return {
        available: false,
        reason:
          mode === "fake"
            ? "Gallery output needs a public base URL. In fake mode the fake bucket has one when BUCKET_PUBLIC_URL is set; its value is not used."
            : "Gallery output needs a public base URL: set BUCKET_PUBLIC_URL and restart Selects.",
      };
    }
    return { available: true, manifestUrl: bucket.urlFor(MANIFEST_KEY) };
  }

  const enabled = () => settings.gallery().enabled && availability().available;

  // One run at a time, and at most one waiting: a run that starts after a change sees it.
  let tail: Promise<void> = Promise.resolve();
  let waiting = false;
  function runDue(): Promise<void> {
    if (waiting) return tail;
    waiting = true;
    tail = tail
      .then(() => {
        waiting = false;
        return runDueNow();
      })
      .catch((error) => console.error(`Gallery output failed (${errorKind(error)}).`));
    return tail;
  }

  /** Takes a post into the gallery: its frame and its capture data as published. */
  function adopt(postId: string): boolean {
    if (bucket === undefined || !enabled()) return false;
    return db
      .transaction(() => {
        const post = db
          .query<{ state: string; mode: InstagramMode | null; object_key: string | null }, [string]>(
            "SELECT state, mode, object_key FROM posts WHERE id = ?",
          )
          .get(postId);
        // Only a post published in this mode, into this mode's bucket; and only once.
        if (post === null || post.state !== "published" || post.mode !== mode) return false;
        if (rowOf(postId) !== null) return false;
        const selectId = selectOf(postId);
        const capture = selectId === undefined ? undefined : captures.published(selectId);
        if (capture === undefined) return false;
        const frameKey = post.object_key;
        db.query(
          `INSERT INTO gallery_posts (post_id, mode, state, capture, frame_key, frame_url, added_at)
           VALUES (?, ?, 'writing', ?, ?, ?, ?)`,
        ).run(
          postId,
          mode,
          JSON.stringify(capture),
          frameKey,
          frameKey === null ? null : bucket.urlFor(frameKey),
          clock.now(),
        );
        // The frame is the gallery's now: the publisher no longer deletes it.
        db.query("UPDATE posts SET object_key = NULL WHERE id = ?").run(postId);
        return true;
      })
      .immediate();
  }

  async function runDueNow(): Promise<void> {
    if (bucket === undefined) return;
    const due = db
      .query<Row, [InstagramMode, number]>(
        `SELECT * FROM gallery_posts WHERE mode = ? AND state = 'writing'
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY added_at, post_id`,
      )
      .all(mode, clock.now());
    for (const row of due) await writeImage(bucket, row);
    await writeManifest(bucket);
  }

  async function writeImage(bucket: Bucket, row: Row): Promise<void> {
    const selectId = selectOf(row.post_id);
    const original = selectId === undefined ? undefined : library.original(selectId);
    if (original === undefined) {
      db.query(
        "UPDATE gallery_posts SET state = 'removing', error = ? WHERE post_id = ? AND state = 'writing'",
      ).run("The select was deleted before its gallery image was written.", row.post_id);
      return;
    }
    // The key is recorded before the upload, so an image stored is never one nothing knows about.
    const key = row.image_key ?? `gallery/${randomUUID()}.jpg`;
    if (row.image_key === null) {
      db.query("UPDATE gallery_posts SET image_key = ? WHERE post_id = ?").run(key, row.post_id);
    }
    try {
      if (bucket.urlKind !== "public") {
        throw new BucketError("Gallery output needs a public base URL: set BUCKET_PUBLIC_URL.");
      }
      const image = await cleanImage(original.path);
      await bucket.putObject(key, image.jpeg, IMAGE_HEADERS, async () => {
        // An upload given up on that landed after its post left the gallery is deleted.
        const now = rowOf(row.post_id);
        if (now?.image_key === key && (now.state === "writing" || now.state === "written")) return;
        await discard(bucket, [key]);
      });
      db.query(
        `UPDATE gallery_posts SET state = 'written', image_url = ?, image_width = ?, image_height = ?,
           error = NULL, next_attempt_at = NULL WHERE post_id = ? AND state = 'writing'`,
      ).run(bucket.urlFor(key), image.width, image.height, row.post_id);
    } catch (error) {
      const message = describe(error);
      const delay = RETRY_DELAYS[Math.min(row.attempts, RETRY_DELAYS.length - 1)] ?? MINUTE;
      db.query(
        `UPDATE gallery_posts SET attempts = attempts + 1, next_attempt_at = ?, error = ?
           WHERE post_id = ? AND state = 'writing'`,
      ).run(clock.now() + delay, message, row.post_id);
      console.error(
        `Gallery: the image for post ${row.post_id} could not be written; trying again in ${delay / MINUTE} minutes (${message})`,
      );
    }
  }

  /** The manifest as it should be now, from the database, and its hash. */
  function build(): { body: string; hash: string } {
    const rows = db
      .query<Listed, [InstagramMode]>(
        `SELECT g.*, p.caption, p.alt_text, p.permalink, p.published_at, p.created_at
           FROM gallery_posts g JOIN posts p ON p.id = g.post_id
          WHERE g.mode = ? AND g.state = 'written'
          ORDER BY COALESCE(p.published_at, p.created_at) DESC, g.post_id`,
      )
      .all(mode);
    const currentZones = zones.list();
    const body = JSON.stringify({
      version: MANIFEST_VERSION,
      posts: rows.map((row) => entry(row, currentZones)),
    } satisfies Manifest);
    return { body, hash: createHash("sha256").update(body).digest("hex") };
  }

  function entry(row: Listed, currentZones: ReturnType<Zones["list"]>): ManifestEntry {
    // As `published(id)` gave it when the post was published.
    const published = JSON.parse(row.capture) as PublishedCapture;
    const selectId = selectOf(row.post_id);
    const now = selectId === undefined ? undefined : captures.published(selectId);
    const { latitude, longitude } = published;
    // Shown only while it still may be: the select is there, its location is not withheld now,
    // and the place it was published with is in no privacy zone added since.
    const shown =
      latitude !== null &&
      longitude !== null &&
      now !== undefined &&
      now.latitude !== null &&
      now.longitude !== null &&
      !currentZones.some((zone) => insideZone({ latitude, longitude }, zone));
    const text = (value: string) => (shown ? value : withoutCoordinates(value, published));
    return {
      id: row.post_id,
      postedAt: new Date(row.published_at ?? row.created_at).toISOString(),
      permalink: row.permalink,
      caption: text(row.caption),
      altText: text(row.alt_text),
      images: {
        clean: { url: row.image_url ?? "", width: row.image_width ?? 0, height: row.image_height ?? 0 },
        framed:
          row.frame_url === null ? null : { url: row.frame_url, width: FRAME_WIDTH, height: FRAME_HEIGHT },
      },
      capture: {
        camera: published.camera,
        lens: published.lens,
        focalLength: published.focalLength,
        exposureTime: published.exposureTime,
        fNumber: published.fNumber,
        iso: published.iso,
        takenAt: published.capturedAt,
      },
      location:
        shown && latitude !== null && longitude !== null
          ? { latitude: round(latitude), longitude: round(longitude) }
          : null,
    };
  }

  async function writeManifest(bucket: Bucket): Promise<void> {
    const any = db
      .query<{ n: number }, [InstagramMode]>("SELECT COUNT(*) AS n FROM gallery_posts WHERE mode = ?")
      .get(mode);
    // A gallery never used writes nothing to the bucket.
    if ((any?.n ?? 0) === 0) return;
    // Taken before the manifest is built: these are out of it, so their images can go once it is stored.
    const removing = db
      .query<{ post_id: string }, [InstagramMode]>(
        "SELECT post_id FROM gallery_posts WHERE mode = ? AND state = 'removing'",
      )
      .all(mode)
      .map((row) => row.post_id);
    const { body, hash } = build();
    if (hash !== manifest.hash) {
      if (manifest.nextAt > clock.now()) return;
      try {
        await bucket.putObject(MANIFEST_KEY, new TextEncoder().encode(body), MANIFEST_HEADERS);
        Object.assign(manifest, { hash, error: null, failures: 0, nextAt: 0 });
      } catch (error) {
        const delay = RETRY_DELAYS[Math.min(manifest.failures, RETRY_DELAYS.length - 1)] ?? MINUTE;
        Object.assign(manifest, {
          error: describe(error),
          failures: manifest.failures + 1,
          nextAt: clock.now() + delay,
        });
        console.error(
          `Gallery: the manifest could not be written; trying again in ${delay / MINUTE} minutes (${manifest.error})`,
        );
        return;
      }
    }
    for (const postId of removing) await finishRemoving(bucket, postId);
  }

  /** Moves a removed post's images to the cleanup record, and deletes them. */
  async function finishRemoving(bucket: Bucket, postId: string): Promise<void> {
    const keys = db
      .transaction(() => {
        const row = rowOf(postId);
        if (row?.state !== "removing") return [];
        db.query(
          `UPDATE gallery_posts SET state = 'removed', image_key = NULL, image_url = NULL,
             frame_key = NULL, frame_url = NULL, next_attempt_at = NULL WHERE post_id = ?`,
        ).run(postId);
        return [row.image_key, row.frame_key].filter((key): key is string => key !== null);
      })
      .immediate();
    await discard(bucket, keys);
  }

  /** Deletes objects through the cleanup record, which the publisher's timer retries. */
  async function discard(bucket: Bucket, keys: string[]): Promise<void> {
    for (const key of keys) {
      db.query("INSERT OR IGNORE INTO bucket_cleanup (key, added_at, mode) VALUES (?, ?, ?)").run(
        key,
        clock.now(),
        mode,
      );
    }
    for (const key of keys) {
      try {
        await bucket.delete(key);
        db.query("DELETE FROM bucket_cleanup WHERE key = ?").run(key);
      } catch (error) {
        console.error(`Gallery: an image could not be deleted; it will be tried again (${describe(error)})`);
      }
    }
  }

  return {
    availability,

    /** Turns the switch on or off. It cannot be turned on while gallery output is unavailable. */
    setEnabled(on: boolean): { ok: true } | { ok: false; reason: string } {
      const available = availability();
      if (on && !available.available) return { ok: false, reason: available.reason };
      settings.setGallery({ enabled: on });
      return { ok: true };
    },

    /**
     * Called by the publisher once a post is recorded as published. With the switch on, the post
     * keeps its frame and its gallery output is written in the background. Never throws.
     */
    published: (postId: string): void => {
      try {
        if (adopt(postId)) void runDue();
      } catch (error) {
        console.error(`Gallery: post ${postId} could not be taken into the gallery (${errorKind(error)}).`);
      }
    },

    /**
     * Takes a post out of the gallery: its entry leaves the manifest, then its images are
     * deleted, retried until the bucket allows. The post and its select are left as they are.
     */
    remove(postId: string): RemoveResult {
      const row = rowOf(postId);
      if (row === null) return "not-found";
      if (row.mode !== mode) return "other-mode";
      db.query(
        "UPDATE gallery_posts SET state = 'removing', error = NULL WHERE post_id = ? AND state IN ('writing', 'written')",
      ).run(postId);
      void runDue();
      return "removing";
    },

    view(): GalleryView {
      const listed = bucket !== undefined && manifest.hash !== undefined && build().hash === manifest.hash;
      const posts = db
        .query<Row, []>("SELECT * FROM gallery_posts ORDER BY added_at DESC, post_id")
        .all()
        .map((row): GalleryPost => {
          const pending = row.state === "written" && row.mode === mode && !listed;
          return {
            postId: row.post_id,
            state: row.state === "written" ? (pending ? "writing" : "listed") : row.state,
            error: row.error ?? (pending ? manifest.error : null),
            mode: row.mode,
          };
        });
      return {
        enabled: settings.gallery().enabled,
        availability: availability(),
        manifestError: manifest.error,
        posts,
      };
    },

    /** Writes what is due: clean images, the manifest, and deletions after a removal. Called on a timer. */
    runDue,

    /** Settles once every run asked for so far has finished. */
    settled: (): Promise<void> => tail,
  };
}

export type Gallery = ReturnType<typeof createGallery>;

/**
 * The select's photo with no frame: upright, at most 2048 px on its long side and never
 * enlarged, converted to sRGB, as a JPEG with no embedded metadata of any kind.
 */
export async function cleanImage(path: string): Promise<{ jpeg: Uint8Array; width: number; height: number }> {
  const converted = await sharp(path)
    .rotate()
    .resize(CLEAN_SIZE, CLEAN_SIZE, { fit: "inside", withoutEnlargement: true })
    // As for the frame: converts from the original's own profile, 16-bit originals included.
    .toColourspace("srgb")
    .withIccProfile("srgb")
    .flatten({ background: "#ffffff" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  // Encoded from bare pixels, so nothing of the original's metadata or profile can follow.
  const { width, height, channels } = converted.info;
  const jpeg = await sharp(converted.data, { raw: { width, height, channels } })
    .jpeg({ quality: CLEAN_QUALITY })
    .toBuffer();
  return { jpeg: new Uint8Array(jpeg), width, height };
}

/**
 * Text with a select's coordinates taken out, as captions and alt text print them in either
 * format. A line left with no letter or digit goes with them; blank lines never stack.
 */
export function withoutCoordinates(text: string, capture: PublishedCapture): string {
  const printed = [
    fieldValues(capture, "dms").coordinates,
    fieldValues(capture, "decimal").coordinates,
  ].filter((value): value is string => value !== null);
  if (printed.length === 0) return text;
  const lines = text.split("\n").flatMap((line) => {
    if (!printed.some((value) => line.includes(value))) return [line];
    const left = printed
      .reduce((rest, value) => rest.split(value).join(""), line)
      .replace(/\s{2,}/g, " ")
      .trim();
    if (!/[\p{L}\p{N}]/u.test(left)) return [];
    // A separator left at either end, such as " · ", goes too.
    return [left.replace(/^[^\p{L}\p{N}#@([]+|[^\p{L}\p{N})\]]+$/gu, "").trim()];
  });
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function round(value: number): number {
  return Number(value.toFixed(COORDINATE_PLACES));
}

/** A failure in words that carry no link, key or path. */
function describe(error: unknown): string {
  if (error instanceof BucketError) return error.message;
  return `Something went wrong (${errorKind(error)}).`;
}
