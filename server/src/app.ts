import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Elysia, t } from "elysia";
import rootPackage from "../../package.json";
import { createCaptures } from "./capture";
import { captureRoutes } from "./capture-routes";
import type { Config } from "./config";
import { databaseStatus } from "./db";
import {
  createFrameRenderer,
  FRAME_FIELDS,
  FRAME_WIDTH,
  type FrameField,
  type FrameSettings,
  MAX_BORDER,
} from "./frame";
import { createLibrary, duplicateMessage, errorKind, type Library } from "./library";
import { passwordGate } from "./password";
import { createSettings } from "./settings";
import { TYPEFACE_IDS, TYPEFACES, type TypefaceId } from "./typefaces";
import { serveUi } from "./ui";
import { MAX_UPLOAD_BYTES, receiveUpload } from "./upload";
import { createZones } from "./zones";

export type { CaptureEdits, CaptureView, Withheld } from "./capture";
export type { FrameField, FrameSettings } from "./frame";
export type { Rejection, ScanResult, Select, UploadResult } from "./library";
export type { FontOverride } from "./typefaces";
export type { PrivacyZone } from "./zones";

export type AppOptions = {
  config: Config;
  db: Database;
  /** Directory holding the built UI. */
  webDir: string;
  /** Defaults to the Library in the configured data directory. */
  library?: Library;
  /** Defaults to MAX_UPLOAD_BYTES. */
  maxUploadBytes?: number;
  /** How long an inbox file must have gone unchanged before a scan takes it. */
  inboxSettleMs?: number;
};

const notFound = { error: "Not found" } as const;

// Unions of literals, not `t.UnionEnum`: Elysia fills a UnionEnum left out of a query with its
// first value.
const frameColor = t.Union([t.Literal("light"), t.Literal("dark")]);
// Typed as one literal of every ID: an array built by `map` would leave the union's type empty.
const typeface = t.Union(
  TYPEFACE_IDS.map((id) => t.Literal(id)) as [ReturnType<typeof t.Literal<TypefaceId>>],
);
const coordinateFormat = t.Union([t.Literal("dms"), t.Literal("decimal")]);

const frameSettingsSchema = t.Object(
  {
    border: t.Integer({ minimum: 0, maximum: MAX_BORDER }),
    color: frameColor,
    typeface,
    fields: t.Object(
      {
        camera: t.Boolean(),
        lens: t.Boolean(),
        focalLength: t.Boolean(),
        shutter: t.Boolean(),
        aperture: t.Boolean(),
        iso: t.Boolean(),
        coordinates: t.Boolean(),
        date: t.Boolean(),
      },
      { additionalProperties: false },
    ),
    coordinateFormat,
  },
  { additionalProperties: false },
);

/** A comma-separated list of frame fields, possibly empty. */
const FIELD_LIST = `^(?:(?:${FRAME_FIELDS.join("|")})(?:,(?:${FRAME_FIELDS.join("|")}))*)?$`;

/** Settings to preview instead of the saved ones, and the preview's width. */
const framePreviewQuery = t.Object({
  width: t.Optional(t.Integer({ minimum: 120, maximum: FRAME_WIDTH })),
  border: t.Optional(t.Integer({ minimum: 0, maximum: MAX_BORDER })),
  color: t.Optional(frameColor),
  typeface: t.Optional(typeface),
  /** The fields to show, comma-separated. Empty shows none. */
  fields: t.Optional(t.String({ pattern: FIELD_LIST })),
  coordinateFormat: t.Optional(coordinateFormat),
});

export type FramePreviewQuery = (typeof framePreviewQuery)["static"];

function createRoutes({
  config,
  db,
  webDir,
  library,
  maxUploadBytes = MAX_UPLOAD_BYTES,
  inboxSettleMs,
}: AppOptions) {
  const lib = library ?? createLibrary({ db, dataDir: config.dataDir, inboxSettleMs });
  const uploadDir = join(config.dataDir, "uploads");
  const settings = createSettings(db);
  const renderer = createFrameRenderer({ dataDir: config.dataDir });
  const zones = createZones(db);
  const captures = createCaptures({ db, library: lib, zones });

  return new Elysia()
    .get("/api/health", ({ status }) => {
      const database = databaseStatus(db);
      if (database.status === "ok") return { version: rootPackage.version, database };
      return status(503, { version: rootPackage.version, database });
    })
    .get("/api/selects", () => lib.list().map(captures.withEdits))
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
    .get(
      "/api/selects/:id/frame",
      async ({ params, query, status, request }) => {
        // Through `published`, so edits and location privacy apply to every frame.
        const capture = captures.published(params.id);
        const original = lib.original(params.id);
        if (capture === undefined || original === undefined) return status(404, notFound);
        const { width, fields, ...preview } = query;
        const saved = settings.frame();
        // A setting left out of the query is sent as undefined: the saved one stands.
        const given = Object.fromEntries(Object.entries(preview).filter(([, value]) => value !== undefined));
        const frame: FrameSettings = {
          ...saved,
          ...given,
          fields: fields === undefined ? saved.fields : fieldSwitches(fields),
        };
        let jpeg: Buffer;
        try {
          jpeg = await renderer.render({ path: original.path, capture }, frame, {
            width,
            signal: request.signal,
          });
        } catch (error) {
          // The error's message can carry the photo's path, so only its kind is logged.
          // A preview dropped for a newer one is no failure.
          if (!request.signal.aborted) console.error(`A frame could not be rendered (${errorKind(error)}).`);
          return status(404, notFound);
        }
        return new Response(new Uint8Array(jpeg), {
          headers: { "content-type": "image/jpeg", "cache-control": "private, no-cache" },
        });
      },
      { query: framePreviewQuery },
    )
    .use(captureRoutes({ captures, zones }))
    .get("/api/frame", () => ({
      settings: settings.frame(),
      typefaces: TYPEFACES.map(({ id, name }) => ({ id, name })),
      fontOverride: renderer.fontOverride(),
      maxBorder: MAX_BORDER,
    }))
    .put("/api/frame", ({ body }) => settings.setFrame(body), { body: frameSettingsSchema })
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
        // A browser sends this type across sites only after asking, and nothing here says yes.
        if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== UPLOAD_TYPE) {
          return status(415, {
            status: "unsupported" as const,
            message: `Send the file as ${UPLOAD_TYPE}.`,
          });
        }
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
            fileName: lastPathPart(query.name),
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

const UPLOAD_TYPE = "application/octet-stream";

/** `"lens,iso"` turns on those two fields and every other one off. */
function fieldSwitches(list: string): Record<FrameField, boolean> {
  const on = new Set(list.split(","));
  return Object.fromEntries(FRAME_FIELDS.map((field) => [field, on.has(field)])) as Record<
    FrameField,
    boolean
  >;
}

/**
 * A browser or tool may send a whole path as the name; only its last part is kept, without
 * control characters. The name is shown and never used as a path.
 */
function lastPathPart(name: string) {
  const last = name.split(/[/\\]/).filter(Boolean).pop() ?? "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed.
  return last.replace(/[\u0000-\u001f\u007f]/g, "").trim() || "upload";
}

/**
 * True when a request that changes something was sent by a page on another origin. Browsers
 * say so in `Sec-Fetch-Site`, or in `Origin` where that header is not sent (plain HTTP on a
 * LAN). Tools that send neither are let through. A proxy that ends TLS in front of the app
 * names the outside scheme and host in the forwarded headers.
 */
function isCrossOrigin(request: Request): boolean {
  if (request.method === "GET" || request.method === "HEAD") return false;
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site !== "same-origin" && site !== "none";
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
  const scheme =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ??
    new URL(request.url).protocol.slice(0, -1);
  try {
    return new URL(origin).origin !== new URL(`${scheme}://${host}`).origin;
  } catch {
    return true;
  }
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
    fetch: async (request: Request): Promise<Response> => {
      if (isCrossOrigin(request)) return Response.json({ error: "Forbidden" }, { status: 403 });
      return (await gate?.(request)) ?? routes.handle(request);
    },
  };
}
