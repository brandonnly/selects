import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createApp } from "./app";
import { ConfigError, loadConfig } from "./config";
import { openDatabase } from "./db";
import { createLibrary } from "./library";
import { migrations } from "./migrations";
import { MAX_UPLOAD_BYTES } from "./upload";

/** How often the inbox is scanned for new files. */
const INBOX_SCAN_INTERVAL_MS = 2 * 60 * 1000;

const webDir = resolve(import.meta.dir, "../../web/dist");

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  console.error("See .env.example for every variable.");
  process.exit(1);
}

const db = openDatabase(config.dataDir, migrations);
const library = createLibrary({ db, dataDir: config.dataDir });
// Partial uploads left by a stop mid-upload.
rmSync(join(config.dataDir, "uploads"), { recursive: true, force: true });
mkdirSync(library.inboxDir, { recursive: true });

const server = Bun.serve({
  port: config.port,
  fetch: createApp({ config, db, webDir, library }).fetch,
  // Room for the largest upload; the upload route enforces the limit itself.
  maxRequestBodySize: MAX_UPLOAD_BYTES + 1024 * 1024,
  // Never Bun's development error page: it prints the stack and source to the client.
  development: false,
  error: (error) => {
    console.error(error);
    return new Response("Internal server error", { status: 500 });
  },
});

console.log(`Selects is listening on port ${server.port}.`);
if (config.password === undefined)
  console.log("No password is set: the app is open to anyone who can reach it.");
if (!existsSync(resolve(webDir, "index.html"))) {
  console.log("The UI has not been built; the API is running alone. Run `bun run build` to build it.");
}

const scanInbox = () =>
  library
    .scanInbox()
    .then(({ added, rejected }) => {
      if (added + rejected > 0) console.log(`Inbox: ${added} added, ${rejected} rejected.`);
    })
    .catch((error) => console.error("Inbox scan failed:", error));
void scanInbox();
const inboxTimer = setInterval(scanInbox, INBOX_SCAN_INTERVAL_MS);

const shutdown = () => {
  clearInterval(inboxTimer);
  // Let requests in flight finish before the database closes.
  server.stop().finally(() => {
    db.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
