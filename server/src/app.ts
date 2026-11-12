import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Elysia, t } from "elysia";
import rootPackage from "../../package.json";
import type { Config } from "./config";
import { databaseStatus } from "./db";
import { createLibrary, duplicateMessage, type Library } from "./library";
import { passwordGate } from "./password";
import { serveUi } from "./ui";
import { MAX_UPLOAD_BYTES, receiveUpload } from "./upload";

export type { Rejection, ScanResult, Select, UploadResult } from "./library";

export type AppOptions = {
  config: Config;
  db: Database;
  /** Directory holding the built UI. */
  webDir: string;
  /** Defaults to the Library in the configured data directory. */
  library?: Library;
  /** Defaults to MAX_UPLOAD_BYTES. */
  maxUploadBytes?: number;
};

const notFound = { error: "Not found" } as const;

function createRoutes({ config, db, webDir, library, maxUploadBytes = MAX_UPLOAD_BYTES }: AppOptions) {
  const lib = library ?? createLibrary({ db, dataDir: config.dataDir });
  const uploadDir = join(config.dataDir, "uploads");

  return new Elysia()
    .get("/api/health", ({ status }) => {
      const database = databaseStatus(db);
      if (database.status === "ok") return { version: rootPackage.version, database };
      return status(503, { version: rootPackage.version, database });
    })
    .get("/api/selects", () => lib.list())
    .get("/api/pool", () => lib.pool())
    .get("/api/selects/:id/original", ({ params, status }) => {
      const original = lib.original(params.id);
      if (original === undefined) return status(404, notFound);
      return new Response(Bun.file(original.path), {
        headers: { "content-type": original.type, "cache-control": "private, no-cache" },
      });
    })
    .get("/api/selects/:id/thumbnail", ({ params, status }) => {
      const thumbnail = lib.thumbnail(params.id);
      if (thumbnail === undefined) return status(404, notFound);
      return new Response(Bun.file(thumbnail), {
        headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=31536000, immutable" },
      });
    })
    .delete("/api/selects/:id", ({ params, status }) =>
      lib.remove(params.id) ? status(204) : status(404, notFound),
    )
    .get("/api/rejections", () => lib.rejections())
    .post("/api/inbox/scan", () => lib.scanInbox())
    .post("/api/rejections/:id/accept", async ({ params, status }) => {
      const result = await lib.acceptRejection(params.id);
      switch (result.status) {
        case "added":
          return status(201, result);
        case "not-found":
          return status(404, notFound);
        case "gone":
          return status(410, { status: "gone" as const, message: "The file is no longer there." });
        case "duplicate":
          return status(409, { status: "duplicate" as const, message: duplicateMessage(result.match) });
        case "unsupported":
        case "reexport":
          return status(409, { status: result.status, message: "Could not be added." });
      }
    })
    .delete("/api/rejections/:id", ({ params, status }) =>
      lib.dismissRejection(params.id) ? status(204) : status(404, notFound),
    )
    .post(
      "/api/uploads",
      async ({ request, query, status }) => {
        const received = await receiveUpload(request, uploadDir, maxUploadBytes);
        if (received.status === "too-large") {
          return status(413, {
            status: "too-large" as const,
            message: `Larger than the ${formatSize(maxUploadBytes)} limit.`,
          });
        }
        if (received.status === "empty") {
          return status(400, { status: "empty" as const, message: "The file is empty." });
        }
        try {
          const result = await lib.addUpload(received.path, {
            fileName: query.name,
            alreadyPosted: query.alreadyPosted === true,
          });
          switch (result.status) {
            case "added":
              return status(201, result);
            case "reexport":
              return status(202, result);
            case "duplicate":
              return status(409, result);
            case "unsupported":
              return status(415, result);
          }
        } finally {
          // An added or held file has been moved away; whatever is left here was refused.
          rmSync(received.path, { force: true });
        }
      },
      {
        parse: "none",
        query: t.Object({
          name: t.String({ minLength: 1, maxLength: 255 }),
          alreadyPosted: t.Optional(t.BooleanString()),
        }),
      },
    )
    .all("/*", ({ path, request }) => {
      if (path === "/api" || path.startsWith("/api/")) {
        return Response.json(notFound, { status: 404 });
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      return serveUi(webDir, path);
    });
}

function formatSize(bytes: number) {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${Math.round(mb)} MB` : `${Math.round(bytes / 1024)} KB`;
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
