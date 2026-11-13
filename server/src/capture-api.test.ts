import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { openDatabase } from "./db";
import { type FixtureName, generateFixtures } from "./fixtures";
import { migrations } from "./migrations";

let fixtureDir: string;
let fixtures: Record<FixtureName, string>;
beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), "selects-capture-api-fixtures-"));
  fixtures = await generateFixtures(fixtureDir);
});
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

let dataDir: string;
let db: Database;
const appFor = () =>
  createApp({ config: loadConfig({ DATA_DIR: dataDir }), db, webDir: join(dataDir, "no-ui") });
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "selects-capture-api-"));
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

const send = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  request(path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
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

const capture = async (id: string) => json(await request(`/api/selects/${id}/capture`));
const putCapture = (id: string, body: unknown, headers?: Record<string, string>) =>
  send("PUT", `/api/selects/${id}/capture`, body, headers);

/** The frame as the Frame screen previews it, small to keep the tests quick. */
const frame = async (id: string, query = "") =>
  new Uint8Array(await (await request(`/api/selects/${id}/frame?width=360${query}`)).arrayBuffer());

/** The portrait fixture's capture data, as read from its file. */
const portraitFile = {
  camera: "Fixture Optics FX-1",
  lens: "Fixture 35mm F1.4",
  focalLength: 35,
  exposureTime: 0.004,
  fNumber: 2.8,
  iso: 400,
  latitude: 10.5,
  longitude: -40.25,
  capturedAt: "2024-05-01T10:20:30",
};

const everyFieldEdited = {
  camera: "Edited Camera",
  lens: "Edited 85mm",
  focalLength: 85,
  exposureTime: 0.5,
  fNumber: 1.8,
  iso: 1600,
  coordinates: { latitude: -12.5, longitude: -25.75 },
  capturedAt: "2020-01-02T03:04:05",
};

describe("editing a select's capture data", () => {
  test("starts with no edits: what is published is what the file holds", async () => {
    const id = await addSelect("portrait");

    const body = await capture(id);

    expect(body.file).toEqual(portraitFile);
    expect(body.edits).toEqual({});
    expect(body.locationHidden).toBe(false);
    expect(body.published).toEqual(portraitFile);
    expect(body.withheld).toBeNull();
  });

  test("changes every field, kept across a restart, while the file's own data stays", async () => {
    const id = await addSelect("portrait");

    const response = await putCapture(id, { edits: everyFieldEdited, locationHidden: false });

    expect(response.status).toBe(200);
    const edited = {
      camera: "Edited Camera",
      lens: "Edited 85mm",
      focalLength: 85,
      exposureTime: 0.5,
      fNumber: 1.8,
      iso: 1600,
      latitude: -12.5,
      longitude: -25.75,
      capturedAt: "2020-01-02T03:04:05",
    };
    expect((await json(response)).published).toEqual(edited);
    app = appFor();
    const body = await capture(id);
    expect(body.edits).toEqual(everyFieldEdited);
    expect(body.edited).toEqual(edited);
    expect(body.published).toEqual(edited);
    expect(body.file).toEqual(portraitFile);
  });

  test("shows the edits in the Library", async () => {
    const id = await addSelect("portrait");
    await putCapture(id, { edits: { camera: "Edited Camera", coordinates: null }, locationHidden: false });

    const [select] = await json(await request("/api/selects"));

    expect(select).toMatchObject({ id, camera: "Edited Camera", lens: "Fixture 35mm F1.4", latitude: null });
  });

  test("shows on the frame", async () => {
    const id = await addSelect("portrait");
    const before = await frame(id);

    await putCapture(id, { edits: { camera: "Edited Camera" }, locationHidden: false });
    expect(await frame(id)).not.toEqual(before);

    // A field edited to nothing is left off, as one missing from the file is.
    const nothing = Object.fromEntries(Object.keys(everyFieldEdited).map((field) => [field, null]));
    await putCapture(id, { edits: nothing, locationHidden: false });
    expect(await frame(id)).toEqual(await frame(id, "&fields="));

    // With no edits, the frame is the file's again.
    await putCapture(id, { edits: {}, locationHidden: false });
    expect(await frame(id)).toEqual(before);
  });

  test("never touches the original file", async () => {
    const id = await addSelect("portrait");
    await putCapture(id, { edits: everyFieldEdited, locationHidden: true });

    const original = new Uint8Array(await (await request(`/api/selects/${id}/original`)).arrayBuffer());

    expect(original).toEqual(new Uint8Array(readFileSync(fixtures.portrait)));
  });

  test("adds a field the file lacks", async () => {
    const id = await addSelect("noExif");

    await putCapture(id, { edits: { camera: "Edited Camera", iso: 200 }, locationHidden: false });

    expect((await capture(id)).published).toMatchObject({ camera: "Edited Camera", iso: 200, lens: null });
  });

  test("refuses values out of range and keeps what was saved", async () => {
    const id = await addSelect("portrait");
    await putCapture(id, { edits: { iso: 800 }, locationHidden: false });

    for (const edits of [
      { iso: 0 },
      { iso: 12.5 },
      { focalLength: -35 },
      { exposureTime: 0 },
      { fNumber: "2.8" },
      { camera: "" },
      { camera: "   " },
      { camera: "x".repeat(201) },
      { coordinates: { latitude: 91, longitude: 0 } },
      { coordinates: { latitude: 0, longitude: -180.5 } },
      { coordinates: { latitude: 0 } },
      { capturedAt: "2024-02-30T10:00:00" },
      { capturedAt: "yesterday" },
    ]) {
      const response = await putCapture(id, { edits, locationHidden: false });
      expect({ edits, status: response.status }).toEqual({ edits, status: 422 });
    }
    expect((await capture(id)).edits).toEqual({ iso: 800 });
  });

  test("is not found for a select that does not exist", async () => {
    expect((await request("/api/selects/missing/capture")).status).toBe(404);
    expect((await putCapture("missing", { edits: {}, locationHidden: false })).status).toBe(404);
  });

  test("cannot be changed from another site", async () => {
    const id = await addSelect("portrait");

    const response = await putCapture(
      id,
      { edits: { camera: "Edited Camera" }, locationHidden: false },
      { "sec-fetch-site": "cross-site" },
    );

    expect(response.status).toBe(403);
    expect((await capture(id)).edits).toEqual({});
  });
});

const addZone = (zone: unknown, headers?: Record<string, string>) =>
  send("POST", "/api/zones", zone, headers);
const zones = async () => json(await request("/api/zones"));
const withoutCoordinates = "&fields=camera,lens,focalLength,shutter,aperture,iso,date";

/** About 5.5 km east of the portrait fixture's invented position in the open Atlantic. */
const nearPortrait = { latitude: 10.5, longitude: -40.2 };

describe("privacy zones", () => {
  test("are made by typing coordinates and a radius, listed, and deleted", async () => {
    const response = await addZone({ ...nearPortrait, radiusMetres: 10_000 });

    expect(response.status).toBe(201);
    const zone = await json(response);
    expect(zone).toMatchObject({ ...nearPortrait, radiusMetres: 10_000 });
    expect(await zones()).toEqual([zone]);

    expect((await request(`/api/zones/${zone.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await zones()).toEqual([]);
    expect((await request(`/api/zones/${zone.id}`, { method: "DELETE" })).status).toBe(404);
  });

  test("are made from a select's own location", async () => {
    const id = await addSelect("portrait");

    const response = await addZone({ selectId: id, radiusMetres: 500 });

    expect(response.status).toBe(201);
    expect(await json(response)).toMatchObject({ latitude: 10.5, longitude: -40.25, radiusMetres: 500 });
  });

  test("from a select's location use its edited coordinates", async () => {
    const id = await addSelect("portrait");
    await putCapture(id, {
      edits: { coordinates: { latitude: -12.5, longitude: -25.75 } },
      locationHidden: false,
    });

    const zone = await json(await addZone({ selectId: id, radiusMetres: 500 }));

    expect(zone).toMatchObject({ latitude: -12.5, longitude: -25.75 });
  });

  test("cannot be made from a select with no location, or one that does not exist", async () => {
    const id = await addSelect("square");

    expect((await addZone({ selectId: id, radiusMetres: 500 })).status).toBe(409);
    expect((await addZone({ selectId: "missing", radiusMetres: 500 })).status).toBe(404);
    expect(await zones()).toEqual([]);
  });

  test("refuse a point off the globe or a radius that is not positive", async () => {
    for (const zone of [
      { latitude: 90.5, longitude: 0, radiusMetres: 100 },
      { latitude: 0, longitude: 181, radiusMetres: 100 },
      { latitude: 0, longitude: 0, radiusMetres: 0 },
      { latitude: 0, longitude: 0, radiusMetres: -5 },
      { latitude: 0, longitude: 0 },
      { radiusMetres: 100 },
    ]) {
      expect((await addZone(zone)).status).toBe(422);
    }
    expect(await zones()).toEqual([]);
  });

  test("cannot be changed from another site", async () => {
    expect(
      (await addZone({ ...nearPortrait, radiusMetres: 100 }, { "sec-fetch-site": "cross-site" })).status,
    ).toBe(403);
    const zone = await json(await addZone({ ...nearPortrait, radiusMetres: 100 }));
    const deleted = await request(`/api/zones/${zone.id}`, {
      method: "DELETE",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(deleted.status).toBe(403);
    expect(await zones()).toHaveLength(1);
  });
});

describe("a select's location", () => {
  test("is withheld when the select is inside any zone", async () => {
    const id = await addSelect("portrait");
    const withCoordinates = await frame(id);
    await addZone({ latitude: -60, longitude: -150, radiusMetres: 1000 });

    await addZone({ ...nearPortrait, radiusMetres: 10_000 });

    const body = await capture(id);
    expect(body.withheld).toBe("privacy-zone");
    expect(body.edited).toEqual(portraitFile);
    expect(body.published).toEqual({ ...portraitFile, latitude: null, longitude: null });
    expect(await frame(id)).toEqual(await frame(id, withoutCoordinates));
    expect(await frame(id)).not.toEqual(withCoordinates);
  });

  test("is published when the select is outside every zone", async () => {
    const id = await addSelect("portrait");

    await addZone({ ...nearPortrait, radiusMetres: 5_000 });

    const body = await capture(id);
    expect(body.withheld).toBeNull();
    expect(body.published).toEqual(portraitFile);
    expect(await frame(id)).not.toEqual(await frame(id, withoutCoordinates));
  });

  test("comes back when its zone is deleted", async () => {
    const id = await addSelect("portrait");
    const withCoordinates = await frame(id);
    const zone = await json(await addZone({ ...nearPortrait, radiusMetres: 10_000 }));

    await request(`/api/zones/${zone.id}`, { method: "DELETE" });

    expect((await capture(id)).withheld).toBeNull();
    expect(await frame(id)).toEqual(withCoordinates);
  });

  test("is checked where edited coordinates put it", async () => {
    const id = await addSelect("portrait");
    await addZone({ latitude: -12.5, longitude: -25.75, radiusMetres: 1_000 });

    await putCapture(id, {
      edits: { coordinates: { latitude: -12.5, longitude: -25.75 } },
      locationHidden: false,
    });

    expect((await capture(id)).withheld).toBe("privacy-zone");
    expect(await frame(id)).toEqual(await frame(id, withoutCoordinates));
  });

  test("stays withheld when an edit moves a select taken inside a zone out of it", async () => {
    const id = await addSelect("portrait");
    // The portrait fixture's own location.
    await addZone({ latitude: 10.5, longitude: -40.25, radiusMetres: 1_000 });

    await putCapture(id, {
      edits: { coordinates: { latitude: -12.5, longitude: -25.75 } },
      locationHidden: false,
    });

    const body = await capture(id);
    expect(body.withheld).toBe("privacy-zone");
    expect(body.published).toMatchObject({ latitude: null, longitude: null });
  });

  test("is withheld when the select has no GPS data", async () => {
    const id = await addSelect("square");

    const body = await capture(id);

    expect(body.withheld).toBe("no-coordinates");
    expect(body.published).toMatchObject({ latitude: null, longitude: null });
  });

  test("can be hidden for one select, leaving the others", async () => {
    const id = await addSelect("portrait");
    const other = await addSelect("landscape");
    const otherFrame = await frame(other);

    const response = await putCapture(id, { edits: {}, locationHidden: true });

    expect(response.status).toBe(200);
    const body = await capture(id);
    expect(body.locationHidden).toBe(true);
    expect(body.withheld).toBe("hidden");
    expect(body.published).toEqual({ ...portraitFile, latitude: null, longitude: null });
    expect(await frame(id)).toEqual(await frame(id, withoutCoordinates));
    expect((await capture(other)).withheld).toBeNull();
    expect(await frame(other)).toEqual(otherFrame);
  });

  test("can be shown again once hidden", async () => {
    const id = await addSelect("portrait");
    const withCoordinates = await frame(id);
    await putCapture(id, { edits: {}, locationHidden: true });

    await putCapture(id, { edits: {}, locationHidden: false });

    expect((await capture(id)).withheld).toBeNull();
    expect(await frame(id)).toEqual(withCoordinates);
  });

  test("still shows in the Library, where only the install's owner sees it", async () => {
    const id = await addSelect("portrait");
    await addZone({ ...nearPortrait, radiusMetres: 10_000 });

    const [select] = await json(await request("/api/selects"));

    expect(select).toMatchObject({ id, latitude: 10.5, longitude: -40.25 });
  });
});
