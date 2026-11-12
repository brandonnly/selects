import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "./app";
import { ConfigError, loadConfig } from "./config";
import { openDatabase } from "./db";
import { migrations } from "./migrations";

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
const server = Bun.serve({
  port: config.port,
  fetch: createApp({ config, db, webDir }).fetch,
  // Never Bun's development error page: it prints the stack and source to the client.
  development: false,
  error: () => new Response("Internal server error", { status: 500 }),
});

console.log(`Selects is listening on port ${server.port}.`);
if (config.password === undefined)
  console.log("No password is set: the app is open to anyone who can reach it.");
if (!existsSync(resolve(webDir, "index.html"))) {
  console.log("The UI has not been built; the API is running alone. Run `bun run build` to build it.");
}

const shutdown = () => {
  server.stop();
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
