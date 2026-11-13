/**
 * Development entry: defaults the data directory to the repo's git-ignored `data/` so
 * `bun run dev` works with no setup, then starts the server as in production. Unless
 * INSTAGRAM_API=live, the server runs the fake Instagram server and the fake bucket itself; in
 * live mode it uses only the bucket in BUCKET_*, and without one publishing is unavailable.
 */
import { resolve } from "node:path";

process.env.DATA_DIR ||= resolve(import.meta.dir, "../../data");

await import("./main");
