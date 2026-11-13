import { randomUUID } from "node:crypto";
import type { BucketSettings } from "./config";

/** How long a presigned link to a frame lasts, in seconds: Meta fetches it at once. */
export const PRESIGNED_SECONDS = 60 * 60;

/**
 * The bucket frames are uploaded to, for Instagram to fetch. Keys are random IDs, never a file
 * name, and objects carry no metadata. See ADR 0003.
 */
export type Bucket = {
  /** Whether `urlFor` gives a public URL or a one-hour presigned link. */
  readonly urlKind: "public" | "presigned";
  /** A new random key for a frame. */
  newKey(): string;
  put(key: string, jpeg: Uint8Array): Promise<void>;
  /** The URL Instagram fetches the object from. A presigned one is never logged or stored. */
  urlFor(key: string): string;
  delete(key: string): Promise<void>;
};

export class BucketError extends Error {
  override name = "BucketError";
}

/** The bucket through Bun's built-in S3 client (ADR 0002). */
export function createBucket(settings: BucketSettings): Bucket {
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
    try {
      await run();
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      throw new BucketError(`The bucket refused to ${what}${/^\w+$/.test(code) ? ` (${code})` : ""}.`);
    }
  };

  return {
    urlKind: publicBaseUrl === undefined ? "presigned" : "public",
    newKey: () => `frames/${randomUUID()}.jpg`,
    put: (key, jpeg) => attempt("store the frame", () => client.write(key, jpeg, { type: "image/jpeg" })),
    urlFor: (key) =>
      publicBaseUrl === undefined
        ? client.presign(key, { expiresIn: PRESIGNED_SECONDS, method: "GET" })
        : `${publicBaseUrl}/${key}`,
    delete: (key) => attempt("delete the frame", () => client.delete(key)),
  };
}
