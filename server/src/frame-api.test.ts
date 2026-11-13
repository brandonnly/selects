import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import sharp from "sharp";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { openDatabase } from "./db";
import { type FixtureName, generateFixtures } from "./fixtures";
import { DEFAULT_FRAME_SETTINGS, type FrameSettings } from "./frame";
import { migrations } from "./migrations";
import { FONTS_DIR } from "./typefaces";

let fixtureDir: string;
let fixtures: Record<FixtureName, string>;
beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), "selects-frame-api-fixtures-"));
  fixtures = await generateFixtures(fixtureDir);
});
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

let dataDir: string;
let db: Database;
const appFor = () =>
  createApp({ config: loadConfig({ DATA_DIR: dataDir }), db, webDir: join(dataDir, "no-ui") });
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "selects-frame-api-"));
  db = openDatabase(dataDir, migrations);
  app = appFor();
});
afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// biome-ignore lint/suspicious/noExplicitAny: each test's assertions check the body's shape.
type Body = any;
const json = (response: Response): Promise<Body> => response.json();

const request = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://selects.test${path}`, init));

const putSettings = (settings: unknown, headers: Record<string, string> = {}) =>
  request("/api/frame", {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(settings),
  });

async function addSelect(name: FixtureName): Promise<string> {
  const response = await request(`/api/uploads?name=${basename(fixtures[name])}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: readFileSync(fixtures[name]),
  });
  const body = (await response.json()) as { select: { id: string } };
  return body.select.id;
}

const custom: FrameSettings = {
  border: 120,
  color: "dark",
  typeface: "eb-garamond",
  fields: { ...DEFAULT_FRAME_SETTINGS.fields, lens: false, coordinates: false },
  coordinateFormat: "decimal",
};

describe("frame settings", () => {
  test("start at the defaults, with the six typefaces to choose from and no override", async () => {
    const response = await request("/api/frame");

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.settings).toEqual(DEFAULT_FRAME_SETTINGS);
    expect(body.typefaces.map((t: { name: string }) => t.name)).toEqual([
      "IBM Plex Mono",
      "JetBrains Mono",
      "Space Mono",
      "Courier Prime",
      "Inter",
      "EB Garamond",
    ]);
    expect(body.fontOverride).toBeNull();
    expect(body.maxBorder).toBe(240);
  });

  test("are saved, and kept across a restart", async () => {
    const saved = await putSettings(custom);

    expect(saved.status).toBe(200);
    expect(await json(saved)).toEqual(custom);
    app = appFor();
    expect((await json(await request("/api/frame"))).settings).toEqual(custom);
  });

  test("refuse values out of range and keep what was saved", async () => {
    for (const bad of [
      { ...custom, border: 999 },
      { ...custom, border: -1 },
      { ...custom, typeface: "comic-sans" },
      { ...custom, color: "sepia" },
      { ...custom, coordinateFormat: "utm" },
      { ...custom, fields: { camera: true } },
    ]) {
      expect((await putSettings(bad)).status).toBe(422);
    }
    expect((await json(await request("/api/frame"))).settings).toEqual(DEFAULT_FRAME_SETTINGS);
  });

  test("cannot be changed from another site", async () => {
    const response = await putSettings(custom, { "sec-fetch-site": "cross-site" });

    expect(response.status).toBe(403);
    expect((await json(await request("/api/frame"))).settings).toEqual(DEFAULT_FRAME_SETTINGS);
  });

  test("report a font file in the data folder that overrides the typeface", async () => {
    mkdirSync(join(dataDir, "fonts"));
    copyFileSync(join(FONTS_DIR, "inter", "Inter-Regular.ttf"), join(dataDir, "fonts", "House.ttf"));

    const body = await json(await request("/api/frame"));

    expect(body.fontOverride).toEqual({ fileName: "House.ttf", usable: true });
  });
});

describe("a select's frame", () => {
  const decode = async (response: Response) => {
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    const { data, info } = await sharp(Buffer.from(await response.arrayBuffer()))
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  };

  test("renders at full size with the saved settings", async () => {
    const id = await addSelect("landscape");
    await putSettings(custom);

    const response = await request(`/api/selects/${id}/frame`);

    expect(response.status).toBe(200);
    const image = await decode(response);
    expect([image.width, image.height]).toEqual([1440, 1800]);
    // A dark frame.
    expect((image.data[0] ?? 0) + (image.data[1] ?? 0) + (image.data[2] ?? 0)).toBeLessThan(90);
  });

  test("previews unsaved settings at reduced size through the same renderer, without saving them", async () => {
    const id = await addSelect("portrait");
    const query = new URLSearchParams({
      width: "480",
      border: "120",
      color: "dark",
      typeface: "eb-garamond",
      fields: "camera,focalLength,shutter,aperture,iso,date",
      coordinateFormat: "decimal",
    });

    const preview = await decode(await request(`/api/selects/${id}/frame?${query}`));

    expect([preview.width, preview.height]).toEqual([480, 600]);
    expect((await json(await request("/api/frame"))).settings).toEqual(DEFAULT_FRAME_SETTINGS);

    // The same settings, saved and rendered at full size, then scaled down the same way.
    await putSettings(custom);
    const full = Buffer.from(await (await request(`/api/selects/${id}/frame`)).arrayBuffer());
    const scaled = await sharp(full).resize(480).raw().toBuffer();
    let diff = 0;
    for (let i = 0; i < scaled.length; i++) diff += Math.abs((scaled[i] ?? 0) - (preview.data[i] ?? 0));
    expect(diff / scaled.length).toBeLessThan(1.5);
  });

  test("a preview with no fields listed prints none", async () => {
    const id = await addSelect("portrait");
    const withText = await decode(await request(`/api/selects/${id}/frame?width=480`));
    const without = await decode(await request(`/api/selects/${id}/frame?width=480&fields=`));

    let diff = 0;
    for (let i = 0; i < without.data.length; i++)
      diff += Math.abs((withText.data[i] ?? 0) - (without.data[i] ?? 0));
    expect(diff).toBeGreaterThan(0);
  });

  test("refuses a preview setting out of range", async () => {
    const id = await addSelect("portrait");

    for (const query of ["width=10", "width=5000", "border=999", "typeface=comic-sans", "fields=lens,mood"]) {
      expect((await request(`/api/selects/${id}/frame?${query}`)).status).toBe(422);
    }
  });

  test("is 404 for a select that does not exist", async () => {
    expect((await request("/api/selects/nope/frame")).status).toBe(404);
  });
});
