import { randomUUID } from "node:crypto";
import type { BucketSettings } from "./config";

/** How long a presigned link to a frame lasts, in seconds: Meta fetches it at once. */
export const PRESIGNED_SECONDS = 60 * 60;

/**
 * How long one bucket request may take. A bucket that takes a request and never answers would
 * otherwise hold up every post, as attempts run one at a time.
 */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * The bucket frames are uploaded to, for Instagram to fetch. Keys are random IDs, never a file
 * name, and objects carry no metadata. See ADR 0003.
 */
export type Bucket = {
  /** Whether `urlFor` gives a public URL or a one-hour presigned link. */
  readonly urlKind: "public" | "presigned";
  /** A new random key for a frame. */
  newKey(): string;
  /**
   * Stores a frame. A write given up on can still land later: `landedLate` is then called so the
   * caller can delete it for good; without it, one deletion is tried.
   */
  put(key: string, jpeg: Uint8Array, landedLate?: () => Promise<void>): Promise<void>;
  /** The URL Instagram fetches the object from. A presigned one is never logged or stored. */
  urlFor(key: string): string;
  /**
   * Stores an object with its type and caching, for objects read from the public URL (gallery
   * output). Uploaded through a presigned link that lasts five minutes, since Bun's client cannot
   * set Cache-Control; the link is never logged or stored. `landedLate` is as for `put`.
   */
  putObject(
    key: string,
    body: Uint8Array,
    headers: ObjectHeaders,
    landedLate?: () => Promise<void>,
  ): Promise<void>;
  delete(key: string): Promise<void>;
};

/** How an object is served: its type, and how long a browser or CDN may keep it. */
export type ObjectHeaders = { type: string; cacheControl: string };

/**
 * How long the presigned link for an object upload lasts, in seconds: used at once, but long
 * enough that a clock a little behind the bucket's does not fail every write.
 */
const UPLOAD_LINK_SECONDS = 5 * 60;

export class BucketError extends Error {
  override name = "BucketError";
  /** The request was given up on, and may still finish at the bucket. */
  timedOut = false;
}

/** The bucket through Bun's built-in S3 client (ADR 0002). */
export function createBucket(
  settings: BucketSettings,
  { timeoutMs = REQUEST_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Bucket {
  const client = new Bun.S3Client({
    endpoint: settings.endpoint,
    bucket: settings.name,
    region: settings.region,
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
  });
  const { publicBaseUrl } = settings;

  // The client's own errors are replaced, so nothing it says about the request is passed on.
  const attempt = async (what: string, run: () => Promise<unknown>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new BucketError(`The bucket did not answer in time to ${what}.`);
        error.timedOut = true;
        reject(error);
      }, timeoutMs);
    });
    try {
      await Promise.race([run(), late]);
    } catch (error) {
      if (error instanceof BucketError) throw error;
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      throw new BucketError(`The bucket refused to ${what}${/^\w+$/.test(code) ? ` (${code})` : ""}.`);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    urlKind: publicBaseUrl === undefined ? "presigned" : "public",
    newKey: () => `frames/${randomUUID()}.jpg`,
    put: async (key, jpeg, landedLate) => {
      const write = client.write(key, jpeg, { type: "image/jpeg" });
      try {
        await attempt("store the frame", () => write);
      } catch (error) {
        // A write given up on can still land later, after the caller has cleaned up: once it
        // settles, whatever it stored is deleted, so no frame is left that nothing knows about.
        if (error instanceof BucketError && error.timedOut) {
          void write.then(
            () => (landedLate?.() ?? client.delete(key)).catch(() => {}),
            () => {},
          );
        } else {
          void write.catch(() => {});
        }
        throw error;
      }
    },
    urlFor: (key) =>
      publicBaseUrl === undefined
        ? client.presign(key, { expiresIn: PRESIGNED_SECONDS, method: "GET" })
        : `${publicBaseUrl}/${key}`,
    putObject: async (key, body, headers, landedLate) => {
      // Signed for the host only: the headers ride along unsigned, as S3 allows.
      const link = client.presign(key, { method: "PUT", expiresIn: UPLOAD_LINK_SECONDS });
      let landed: Promise<unknown> | undefined;
      try {
        await attempt("store the object", async () => {
          const sent = fetch(link, {
            method: "PUT",
            body: body as Uint8Array<ArrayBuffer>,
            headers: { "content-type": headers.type, "cache-control": headers.cacheControl },
          }).then((response) => {
            if (!response.ok) throw Object.assign(new Error(), { code: response.status });
          });
          landed = sent;
          await sent;
        });
      } catch (error) {
        // As for `put`: an upload given up on may land later, and is then deleted.
        if (error instanceof BucketError && error.timedOut && landed !== undefined) {
          void landed.then(
            () => (landedLate?.() ?? client.delete(key)).catch(() => {}),
            () => {},
          );
        }
        throw error;
      }
    },
    delete: (key) => attempt("delete the object", () => client.delete(key)),
  };
}
