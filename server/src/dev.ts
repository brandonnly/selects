/**
 * Development entry: defaults the data directory to the repo's git-ignored `data/` so
 * `bun run dev` works with no setup, then starts the server as in production. With no bucket
 * set, it runs the fake bucket and points the server at it, so publishing can be tried end to
 * end against the fake Instagram server. Instagram stays the fake unless INSTAGRAM_API=live.
 */
import { resolve } from "node:path";
import { createFakeBucket, FAKE_BUCKET_KEYS } from "./fake-bucket";

process.env.DATA_DIR ||= resolve(import.meta.dir, "../../data");

const BUCKET_VARIABLES = [
  "BUCKET_ENDPOINT",
  "BUCKET_NAME",
  "BUCKET_ACCESS_KEY_ID",
  "BUCKET_SECRET_ACCESS_KEY",
];
if (BUCKET_VARIABLES.every((name) => !process.env[name])) {
  const bucket = createFakeBucket();
  Object.assign(process.env, {
    BUCKET_ENDPOINT: bucket.endpoint,
    BUCKET_NAME: bucket.name,
    BUCKET_ACCESS_KEY_ID: FAKE_BUCKET_KEYS.accessKeyId,
    BUCKET_SECRET_ACCESS_KEY: FAKE_BUCKET_KEYS.secretAccessKey,
  });
  console.log("Bucket: the fake bucket inside the dev server, with presigned links.");
}

await import("./main");
