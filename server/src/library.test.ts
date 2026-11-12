import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { openDatabase } from "./db";
import { type FixtureName, fixtures as fixtureSpecs, generateFixtures, makePhoto } from "./fixtures";
import { migrations } from "./migrations";

let fixtureDir: string;
let fixtures: Record<FixtureName, string>;
beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), "selects-library-fixtures-"));
  fixtures = await generateFixtures(fixtureDir);
});
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

let dataDir: string;
let db: Database;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "selects-library-"));
  db = openDatabase(dataDir, migrations);
  app = createApp({ config: loadConfig({ DATA_DIR: dataDir }), db, webDir: join(dataDir, "no-ui") });
});
afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const request = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://selects.test${path}`, init));

const upload = (name: FixtureName, options: { alreadyPosted?: boolean; as?: string } = {}) => {
  const query = new URLSearchParams({ name: options.as ?? fixtures[name].split("/").pop() ?? name });
  if (options.alreadyPosted) query.set("alreadyPosted", "true");
  return request(`/api/uploads?${query}`, { method: "POST", body: readFileSync(fixtures[name]) });
};

// biome-ignore lint/suspicious/noExplicitAny: each test's assertions check the body's shape.
type Body = any;
const json = (response: Response): Promise<Body> => response.json();

const library = async () => (await (await request("/api/selects")).json()) as Record<string, unknown>[];

describe("uploading a photo", () => {
  test("adds it to the Library with its EXIF", async () => {
    const response = await upload("portrait");

    expect(response.status).toBe(201);
    const body = await json(response);
    expect(body.status).toBe("added");
    expect(await library()).toEqual([
      {
        id: body.select.id,
        fileName: "portrait.jpg",
        source: "upload",
        format: "jpeg",
        bytes: readFileSync(fixtures.portrait).length,
        width: 800,
        height: 1000,
        camera: "Fixture Optics FX-1",
        lens: "Fixture 35mm F1.4",
        focalLength: 35,
        exposureTime: 0.004,
        fNumber: 2.8,
        iso: 400,
        latitude: expect.closeTo(10.5, 6),
        longitude: expect.closeTo(-40.25, 6),
        capturedAt: "2024-05-01T10:20:30",
        alreadyPosted: false,
        inPool: true,
        addedAt: expect.any(String),
      },
    ]);
  });

  test("keeps the original byte for byte", async () => {
    const { select } = await json(await upload("portrait"));

    const original = await request(`/api/selects/${select.id}/original`);

    expect(original.status).toBe(200);
    expect(original.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await original.arrayBuffer()).equals(readFileSync(fixtures.portrait))).toBe(true);
  });

  test("makes a thumbnail", async () => {
    const { select } = await json(await upload("portrait"));

    const thumbnail = await request(`/api/selects/${select.id}/thumbnail`);

    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get("content-type")).toBe("image/jpeg");
    const { width, height } = await sharp(Buffer.from(await thumbnail.arrayBuffer())).metadata();
    expect({ width, height }).toEqual({ width: 512, height: 640 });
  });
});

describe("reading capture data", () => {
  const added = async (name: FixtureName) => (await json(await upload(name))).select;

  test("reads a TIFF, with coordinates south and east", async () => {
    expect(await added("landscape")).toMatchObject({
      format: "tiff",
      width: 1200,
      height: 800,
      camera: "Fixture FX-2",
      lens: "Fixture 24-70mm F2.8",
      focalLength: 24,
      exposureTime: 0.001,
      fNumber: 8,
      iso: 100,
      latitude: expect.closeTo(-35.125, 6),
      longitude: expect.closeTo(165.75, 6),
      capturedAt: "2023-11-18T07:45:12",
    });
  });

  test("reads a PNG and leaves off the coordinates it lacks", async () => {
    expect(await added("square")).toMatchObject({
      format: "png",
      width: 900,
      height: 900,
      camera: "Fixture Optics FX-1",
      iso: 3200,
      latitude: null,
      longitude: null,
      capturedAt: "2022-08-09T18:02:44",
    });
  });

  test("measures a photo upright when its orientation tag turns it", async () => {
    const select = await added("rotated");
    expect(select).toMatchObject({ width: 800, height: 1000, exposureTime: 0.5 });

    const thumbnail = await request(`/api/selects/${select.id}/thumbnail`);
    const { width, height } = await sharp(Buffer.from(await thumbnail.arrayBuffer())).metadata();
    expect({ width, height }).toEqual({ width: 512, height: 640 });
  });

  test("adds a photo with no metadata, every field left empty", async () => {
    expect(await added("noExif")).toMatchObject({
      camera: null,
      lens: null,
      focalLength: null,
      exposureTime: null,
      fNumber: null,
      iso: null,
      latitude: null,
      longitude: null,
      capturedAt: null,
    });
  });
});

describe("unsupported files", () => {
  test("are refused with a reason, and nothing is kept", async () => {
    for (const name of ["webp", "text"] as const) {
      const response = await upload(name);

      expect(response.status).toBe(415);
      expect(await json(response)).toEqual({ status: "unsupported", message: "Not a JPEG, PNG or TIFF." });
    }
    expect(await library()).toEqual([]);
    expect(readdirSync(join(dataDir, "uploads"))).toEqual([]);
  });
});

describe("duplicates", () => {
  const remove = (id: string) => request(`/api/selects/${id}`, { method: "DELETE" });
  const rejections = async () =>
    (await (await request("/api/rejections")).json()) as Record<string, unknown>[];

  test("refuses a byte-identical file, whatever its name", async () => {
    await upload("portrait");

    const response = await upload("portrait", { as: "renamed.jpg" });

    expect(response.status).toBe(409);
    expect(await json(response)).toEqual({ status: "duplicate", message: "Already added as portrait.jpg." });
    expect(await library()).toHaveLength(1);
  });

  test("holds a likely re-export for review instead of adding it", async () => {
    await upload("portrait");

    const response = await upload("portraitReexport");

    expect(response.status).toBe(202);
    const body = await json(response);
    expect(body).toEqual({
      status: "reexport",
      rejection: {
        id: expect.any(String),
        source: "upload",
        fileName: "portrait-reexport.jpg",
        reason: "reexport",
        message: "Looks like a re-export of portrait.jpg: the same picture, taken at the same moment.",
        canAccept: true,
        rejectedAt: expect.any(String),
      },
    });
    expect(await library()).toHaveLength(1);
    expect(await rejections()).toEqual([body.rejection]);
  });

  test("adds a held re-export when overridden, byte for byte", async () => {
    await upload("portrait");
    const { rejection } = await json(await upload("portraitReexport"));

    const accepted = await request(`/api/rejections/${rejection.id}/accept`, { method: "POST" });

    expect(accepted.status).toBe(201);
    const { select } = await json(accepted);
    expect(select).toMatchObject({ fileName: "portrait-reexport.jpg", source: "upload", width: 640 });
    const original = await request(`/api/selects/${select.id}/original`);
    expect(Buffer.from(await original.arrayBuffer()).equals(readFileSync(fixtures.portraitReexport))).toBe(
      true,
    );
    expect(await library()).toHaveLength(2);
    expect(await rejections()).toEqual([]);
  });

  test("drops a held re-export when dismissed", async () => {
    await upload("portrait");
    const { rejection } = await json(await upload("portraitReexport"));

    const dismissed = await request(`/api/rejections/${rejection.id}`, { method: "DELETE" });

    expect(dismissed.status).toBe(204);
    expect(await rejections()).toEqual([]);
    expect(readdirSync(join(dataDir, "held"))).toEqual([]);
    expect(await library()).toHaveLength(1);
  });

  test("does not mistake a different picture taken in the same second for a re-export", async () => {
    await upload("portrait");
    const burst = join(fixtureDir, "burst.jpg");
    await Bun.write(burst, await makePhoto({ ...fixtureSpecs.portrait.photo, scene: 7, format: "jpeg" }));

    const response = await request("/api/uploads?name=burst.jpg", {
      method: "POST",
      body: readFileSync(burst),
    });

    expect(response.status).toBe(201);
  });

  test("still refuses both after the first file is deleted", async () => {
    const { select } = await json(await upload("portrait"));

    const deleted = await remove(select.id);
    expect(deleted.status).toBe(204);
    expect(await library()).toEqual([]);
    expect((await request(`/api/selects/${select.id}/original`)).status).toBe(404);
    expect((await request(`/api/selects/${select.id}/thumbnail`)).status).toBe(404);

    const identical = await upload("portrait");
    expect(identical.status).toBe(409);
    expect((await json(identical)).message).toBe("Already added as portrait.jpg, since deleted.");

    const reexport = await upload("portraitReexport");
    expect(reexport.status).toBe(202);
    expect((await json(reexport)).rejection.message).toBe(
      "Looks like a re-export of portrait.jpg, since deleted: the same picture, taken at the same moment.",
    );
  });

  test("deleting an unknown select is a 404", async () => {
    expect((await remove("nope")).status).toBe(404);
  });
});

describe("marking uploads as already posted", () => {
  test("keeps them in the Library but out of the pool", async () => {
    await upload("portrait", { alreadyPosted: true });
    await upload("square");

    expect(
      (await library()).map(({ fileName, alreadyPosted, inPool }) => ({ fileName, alreadyPosted, inPool })),
    ).toEqual([
      { fileName: "square.png", alreadyPosted: false, inPool: true },
      { fileName: "portrait.jpg", alreadyPosted: true, inPool: false },
    ]);
    expect(await json(await request("/api/pool"))).toEqual([(await library())[0]?.id]);
  });

  test("still blocks their duplicates, as for any select", async () => {
    await upload("portrait", { alreadyPosted: true });

    expect((await upload("portrait")).status).toBe(409);
  });

  test("carries the mark through a re-export that is added anyway", async () => {
    await upload("portrait");
    const { rejection } = await json(await upload("portraitReexport", { alreadyPosted: true }));

    const { select } = await json(
      await request(`/api/rejections/${rejection.id}/accept`, { method: "POST" }),
    );

    expect(select).toMatchObject({ alreadyPosted: true, inPool: false });
  });
});

describe("upload size", () => {
  test("refuses a file over the limit and keeps nothing of it", async () => {
    app = createApp({
      config: loadConfig({ DATA_DIR: dataDir }),
      db,
      webDir: join(dataDir, "no-ui"),
      maxUploadBytes: 10 * 1024,
    });

    const response = await upload("portrait");

    expect(response.status).toBe(413);
    expect(await json(response)).toEqual({ status: "too-large", message: "Larger than the 10 KB limit." });
    expect(await library()).toEqual([]);
  });
});

describe("the inbox", () => {
  const inbox = () => join(dataDir, "inbox");
  const rejectedDir = () => join(inbox(), "rejected");
  const scan = async () => json(await request("/api/inbox/scan", { method: "POST" }));
  const rejections = async () => (await json(await request("/api/rejections"))) as Record<string, unknown>[];

  /** Copies a fixture into the inbox as a file that finished copying a minute ago. */
  const drop = (name: FixtureName, as?: string) => {
    mkdirSync(inbox(), { recursive: true });
    const target = join(inbox(), as ?? fixtures[name].split("/").pop() ?? name);
    copyFileSync(fixtures[name], target);
    const aMinuteAgo = new Date(Date.now() - 60_000);
    utimesSync(target, aMinuteAgo, aMinuteAgo);
    return target;
  };

  test("ingests a dropped file on the next scan and moves it out", async () => {
    drop("landscape");

    expect(await scan()).toEqual({ added: 1, rejected: 0 });

    const [select] = await library();
    expect(select).toMatchObject({
      fileName: "landscape.tif",
      source: "inbox",
      format: "tiff",
      inPool: true,
    });
    expect(readdirSync(inbox()).filter((name) => name !== "rejected")).toEqual([]);
    const original = await request(`/api/selects/${select?.id}/original`);
    expect(Buffer.from(await original.arrayBuffer()).equals(readFileSync(fixtures.landscape))).toBe(true);
  });

  test("moves unsupported and duplicate files to rejected, with their reasons", async () => {
    await upload("portrait");
    drop("text");
    drop("portrait", "copy.jpg");

    expect(await scan()).toEqual({ added: 0, rejected: 2 });

    expect(readdirSync(rejectedDir()).sort()).toEqual(["copy.jpg", "notes.txt"]);
    expect(readdirSync(inbox())).toEqual(["rejected"]);
    const reasons = (await rejections()).map(({ source, fileName, reason, message, canAccept }) => ({
      source,
      fileName,
      reason,
      message,
      canAccept,
    }));
    expect(reasons).toContainEqual({
      source: "inbox",
      fileName: "notes.txt",
      reason: "unsupported",
      message: "Not a JPEG, PNG or TIFF.",
      canAccept: false,
    });
    expect(reasons).toContainEqual({
      source: "inbox",
      fileName: "copy.jpg",
      reason: "duplicate",
      message: "Already added as portrait.jpg.",
      canAccept: false,
    });
  });

  test("moves a likely re-export to rejected, from where it can be added anyway", async () => {
    await upload("portrait");
    drop("portraitReexport");

    expect(await scan()).toEqual({ added: 0, rejected: 1 });
    const [rejection] = await rejections();
    expect(rejection).toMatchObject({ reason: "reexport", canAccept: true });

    const accepted = await request(`/api/rejections/${rejection?.id}/accept`, { method: "POST" });

    expect(accepted.status).toBe(201);
    expect((await json(accepted)).select).toMatchObject({
      fileName: "portrait-reexport.jpg",
      source: "inbox",
    });
    expect(readdirSync(rejectedDir())).toEqual([]);
    expect(await rejections()).toEqual([]);
  });

  test("a held re-export added since by another route turns into a duplicate", async () => {
    await upload("portrait");
    const { rejection: held } = await json(await upload("portraitReexport"));
    drop("portraitReexport");
    await scan();
    await request(`/api/rejections/${held.id}/accept`, { method: "POST" });
    const [fromInbox] = await rejections();

    const accepted = await request(`/api/rejections/${fromInbox?.id}/accept`, { method: "POST" });

    expect(accepted.status).toBe(409);
    expect(await json(accepted)).toEqual({
      status: "duplicate",
      message: "Already added as portrait-reexport.jpg.",
    });
    expect(await rejections()).toMatchObject([
      {
        fileName: "portrait-reexport.jpg",
        reason: "duplicate",
        message: "Already added as portrait-reexport.jpg.",
        canAccept: false,
      },
    ]);
  });

  test("dismissing an inbox rejection leaves the file in the rejected folder", async () => {
    drop("text");
    await scan();
    const [rejection] = await rejections();

    expect((await request(`/api/rejections/${rejection?.id}`, { method: "DELETE" })).status).toBe(204);

    expect(await rejections()).toEqual([]);
    expect(readdirSync(rejectedDir())).toEqual(["notes.txt"]);
  });

  test("never overwrites a file already in the rejected folder", async () => {
    drop("text");
    await scan();
    drop("text");
    await scan();

    expect(readdirSync(rejectedDir()).sort()).toEqual(["notes (2).txt", "notes.txt"]);
  });

  test("leaves a file that is still being written for a later scan", async () => {
    const path = drop("square");
    const now = new Date();
    utimesSync(path, now, now);

    expect(await scan()).toEqual({ added: 0, rejected: 0 });
    expect(existsSync(path)).toBe(true);
  });

  test("ignores hidden files and folders", async () => {
    drop("text", ".notes.txt");
    mkdirSync(join(inbox(), "later"));

    expect(await scan()).toEqual({ added: 0, rejected: 0 });
    expect(readdirSync(inbox()).sort()).toEqual([".notes.txt", "later", "rejected"]);
  });
});
