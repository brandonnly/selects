import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createApp } from "./app";
import { HOUR } from "./clock";
import { ConfigError, loadConfig } from "./config";
import { openDatabase } from "./db";
import { startFakes } from "./fakes";
import { createLibrary, errorKind } from "./library";
import { migrations } from "./migrations";
import { MAX_UPLOAD_BYTES } from "./upload";

/** How often the inbox is scanned for new files. */
const INBOX_SCAN_INTERVAL_MS = 2 * 60 * 1000;
/** How often due retries run. */
const RETRY_INTERVAL_MS = 30 * 1000;
/** How often the Instagram token is checked for a refresh. */
const TOKEN_CHECK_INTERVAL_MS = HOUR;

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

// Unless INSTAGRAM_API=live, Instagram and the bucket are fakes run here, and BUCKET_* is not
// used: nothing leaves the install and nothing is posted for real.
const fakes = startFakes(config.instagram, { publicUrl: config.fakePublicUrl });
const app = createApp({
  config,
  db,
  webDir,
  library,
  instagram: fakes?.instagram,
  fakeBucket: fakes?.bucket,
});
// Posts a stop left mid-attempt are taken up again, before any request can start a new one.
app.publisher.recover();

const server = Bun.serve({
  port: config.port,
  fetch: app.fetch,
  // Room for the largest upload; the upload route enforces the limit itself.
  maxRequestBodySize: MAX_UPLOAD_BYTES + 1024 * 1024,
  // The longest Bun allows, in seconds: a scan of a full inbox answers only when it is done.
  idleTimeout: 255,
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
if (config.instagram === "fake") {
  console.log(
    "Fake mode: Instagram and the bucket are fakes inside Selects, and BUCKET_* is not used. Nothing leaves this install and nothing is posted for real; set INSTAGRAM_API=live to post.",
  );
} else {
  console.log("Instagram: live. Posts go to the connected Instagram account.");
}
if (config.instagram === "live" && config.bucket.status === "missing") {
  console.log(`Publishing is unavailable until the bucket is set: ${config.bucket.missing.join(", ")}.`);
}
if (!existsSync(resolve(webDir, "index.html"))) {
  console.log("The UI has not been built; the API is running alone. Run `bun run build` to build it.");
}

const scanInbox = () =>
  library
    .scanInbox()
    .then(({ added, rejected }) => {
      if (added + rejected > 0) console.log(`Inbox: ${added} added, ${rejected} rejected.`);
    })
    .catch((error) => console.error(`Inbox scan failed (${errorKind(error)}).`));
void scanInbox();
const inboxTimer = setInterval(scanInbox, INBOX_SCAN_INTERVAL_MS);

const runDue = () =>
  app.publisher
    .runDue()
    .catch((error) => console.error(`Publishing retries failed (${errorKind(error)}).`))
    // Gallery output: retried writes, the manifest after a privacy change, and removals.
    .then(() => app.gallery.runDue());
void runDue();
const retryTimer = setInterval(runDue, RETRY_INTERVAL_MS);
const refreshToken = () => app.instagramAccount.refreshIfDue().catch(() => {});
void refreshToken();
const tokenTimer = setInterval(refreshToken, TOKEN_CHECK_INTERVAL_MS);

const shutdown = () => {
  clearInterval(inboxTimer);
  clearInterval(retryTimer);
  clearInterval(tokenTimer);
  // Let requests in flight finish, the fakes they may be using still up, before the database closes.
  server
    .stop()
    .finally(() => fakes?.stop())
    .finally(() => {
      db.close();
      process.exit(0);
    });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
