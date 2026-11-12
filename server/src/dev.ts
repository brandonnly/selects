/**
 * Development entry: defaults the data directory to the repo's git-ignored `data/` so
 * `bun run dev` works with no setup, then starts the server as in production.
 */
import { resolve } from "node:path";

process.env.DATA_DIR ||= resolve(import.meta.dir, "../../data");

await import("./main");
