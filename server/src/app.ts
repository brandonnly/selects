import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import rootPackage from "../../package.json";
import type { Config } from "./config";
import { databaseStatus } from "./db";
import { passwordGate } from "./password";
import { serveUi } from "./ui";

export type AppOptions = {
  config: Config;
  db: Database;
  /** Directory holding the built UI. */
  webDir: string;
};

function createRoutes({ db, webDir }: AppOptions) {
  return new Elysia()
    .get("/api/health", ({ status }) => {
      const database = databaseStatus(db);
      if (database.status === "ok") return { version: rootPackage.version, database };
      return status(503, { version: rootPackage.version, database });
    })
    .all("/*", ({ path, request }) => {
      if (path === "/api" || path.startsWith("/api/")) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      return serveUi(webDir, path);
    });
}

/** The routes, as the UI's Eden client sees them. */
export type App = ReturnType<typeof createRoutes>;

/**
 * The whole HTTP surface: the API under `/api` and the built UI everywhere else, behind the
 * optional password. The gate sits outside the routes so it never widens their Eden types.
 */
export function createApp(options: AppOptions) {
  const routes = createRoutes(options);
  const { password, dataDir } = options.config;
  const gate = password === undefined ? undefined : passwordGate(password, dataDir);

  return {
    fetch: async (request: Request): Promise<Response> => (await gate?.(request)) ?? routes.handle(request),
  };
}
