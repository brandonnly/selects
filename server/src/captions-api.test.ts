import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createApp } from "./app";
import { type CaptionTemplates, DEFAULT_CAPTION_TEMPLATES } from "./captions";
import { loadConfig } from "./config";
import { openDatabase } from "./db";
import { type FixtureName, generateFixtures } from "./fixtures";
import { migrations } from "./migrations";

let fixtureDir: string;
let fixtures: Record<FixtureName, string>;
beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), "selects-captions-api-fixtures-"));
  fixtures = await generateFixtures(fixtureDir);
});
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

let dataDir: string;
let db: Database;
const appFor = () =>
  createApp({ config: loadConfig({ DATA_DIR: dataDir }), db, webDir: join(dataDir, "no-ui") });
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "selects-captions-api-"));
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

const send = (method: string, path: string, body: unknown) =>
  request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function addSelect(name: FixtureName): Promise<string> {
  const response = await request(`/api/uploads?name=${basename(fixtures[name])}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: readFileSync(fixtures[name]),
  });
  const body = (await response.json()) as { select: { id: string } };
  return body.select.id;
}

const custom: CaptionTemplates = {
  caption: "{camera} · {iso}\n\n{hashtags}",
  altText: "A photograph[ from {date}]",
  hashtagSets: [
    { name: "Film", tags: ["#film", "#35mm"] },
    { name: "Night", tags: ["#night"] },
  ],
};

describe("caption templates", () => {
  test("start at the defaults, with the tokens they can use", async () => {
    const response = await request("/api/captions");

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.templates).toEqual(DEFAULT_CAPTION_TEMPLATES);
    expect(body.tokens).toEqual([
      "coordinates",
      "date",
      "camera",
      "lens",
      "focalLength",
      "shutter",
      "aperture",
      "iso",
      "hashtags",
    ]);
    expect(body.check).toEqual({ problems: [], warnings: [] });
  });

  test("are saved with their hashtag sets, and kept across a restart", async () => {
    const saved = await send("PUT", "/api/captions", custom);

    expect(saved.status).toBe(200);
    expect((await json(saved)).templates).toEqual(custom);
    db.close();
    db = openDatabase(dataDir, migrations);
    app = appFor();
    expect((await json(await request("/api/captions"))).templates).toEqual(custom);
  });

  test("refuse an unknown token, a bad hashtag or a caption over Instagram's limits, and keep what was saved", async () => {
    for (const [bad, problem] of [
      [{ ...custom, caption: "{flash}" }, "{flash} in the caption isn't a token."],
      [
        { ...custom, hashtagSets: [{ name: "Bad", tags: ["#two words"] }] },
        "#two words in Bad isn't a hashtag.",
      ],
      [
        { ...custom, hashtagSets: [{ name: "Many", tags: Array.from({ length: 31 }, (_, i) => `#t${i}`) }] },
        "The caption can have up to 31 hashtags, over Instagram's limit of 30.",
      ],
    ] as const) {
      const response = await send("PUT", "/api/captions", bad);
      expect(response.status).toBe(422);
      expect((await json(response)).problems).toEqual([problem]);
    }
    expect((await json(await request("/api/captions"))).templates).toEqual(DEFAULT_CAPTION_TEMPLATES);
  });

  test("save near a limit, with a warning", async () => {
    const near = {
      ...custom,
      hashtagSets: [{ name: "Many", tags: Array.from({ length: 28 }, (_, i) => `#t${i}`) }],
    };
    const response = await send("PUT", "/api/captions", near);

    expect(response.status).toBe(200);
    expect((await json(response)).check.warnings).toEqual([
      "The caption can have up to 28 hashtags, near Instagram's limit of 30.",
    ]);
  });
});

describe("caption preview", () => {
  test("builds unsaved templates against a real select, with the hashtag set asked for", async () => {
    const id = await addSelect("portrait");
    const response = await send("POST", "/api/captions/preview", {
      selectId: id,
      templates: custom,
      hashtagSet: "Night",
    });

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.caption).toEqual({
      caption: "Fixture Optics FX-1 · ISO 400\n\n#night",
      altText: "A photograph from 2024-05-01",
      hashtagSet: "Night",
    });
    expect(body.check).toEqual({ problems: [], warnings: [] });
    expect((await json(await request("/api/captions"))).templates).toEqual(DEFAULT_CAPTION_TEMPLATES);
  });

  test("prints a select's coordinates as the frame does, and none for a select without them", async () => {
    const withGps = await addSelect("portrait");
    const withoutGps = await addSelect("square");
    const preview = async (selectId: string) =>
      (
        await json(
          await send("POST", "/api/captions/preview", { selectId, templates: DEFAULT_CAPTION_TEMPLATES }),
        )
      ).caption.caption;

    expect(await preview(withGps)).toBe(`10°30'00"N 40°15'00"W\nFixture Optics FX-1 · Fixture 35mm F1.4`);
    expect(await preview(withoutGps)).toBe("Fixture Optics FX-1 · Fixture 50mm F2");
  });

  test("without a select, reports only the templates' problems", async () => {
    const response = await send("POST", "/api/captions/preview", {
      templates: { ...custom, caption: "{flash}" },
    });

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.caption).toBeNull();
    expect(body.check.problems).toEqual(["{flash} in the caption isn't a token."]);
  });

  test("of a select that does not exist is not found", async () => {
    const response = await send("POST", "/api/captions/preview", { selectId: "missing", templates: custom });

    expect(response.status).toBe(404);
  });
});

describe("a select's own caption", () => {
  test("replaces the template for that select only, and can be cleared", async () => {
    await send("PUT", "/api/captions", custom);
    const mine = await addSelect("portrait");
    const other = await addSelect("square");

    const saved = await send("PUT", `/api/selects/${mine}/caption`, {
      caption: "  Low tide.\n#sea  ",
      altText: "A pier at dusk.",
    });

    expect(saved.status).toBe(200);
    const body = await json(saved);
    expect(body.own).toEqual({ caption: "Low tide.\n#sea", altText: "A pier at dusk." });
    expect(body.caption).toEqual({
      caption: "Low tide.\n#sea",
      altText: "A pier at dusk.",
      hashtagSet: null,
    });
    expect((await json(await request(`/api/selects/${mine}/caption`))).caption.caption).toBe(
      "Low tide.\n#sea",
    );
    const others = await json(await request(`/api/selects/${other}/caption`));
    expect(others.own).toEqual({ caption: null, altText: null });
    expect(others.caption.caption).toMatch(/^Fixture Optics FX-1 · ISO 3200\n\n#/);

    const cleared = await json(
      await send("PUT", `/api/selects/${mine}/caption`, { caption: null, altText: " " }),
    );
    expect(cleared.own).toEqual({ caption: null, altText: null });
    expect(cleared.caption.altText).toBe("A photograph from 2024-05-01");
  });

  test("is refused over Instagram's limits, with a warning near them", async () => {
    const id = await addSelect("portrait");

    const over = await send("PUT", `/api/selects/${id}/caption`, {
      caption: "a".repeat(2201),
      altText: null,
    });
    expect(over.status).toBe(422);
    expect((await json(over)).problems).toEqual([
      "The caption is 2,201 characters, over Instagram's limit of 2,200.",
    ]);
    expect((await json(await request(`/api/selects/${id}/caption`))).own.caption).toBeNull();

    const near = await send("PUT", `/api/selects/${id}/caption`, {
      caption: "a".repeat(2000),
      altText: null,
    });
    expect(near.status).toBe(200);
    expect((await json(near)).check.warnings).toEqual([
      "The caption is 2,000 characters, near Instagram's limit of 2,200.",
    ]);
  });

  test("is not found for a select that does not exist", async () => {
    expect((await request("/api/selects/missing/caption")).status).toBe(404);
    expect((await send("PUT", "/api/selects/missing/caption", { caption: "x", altText: null })).status).toBe(
      404,
    );
  });

  test("goes with its select when the select is deleted", async () => {
    const id = await addSelect("portrait");
    await send("PUT", `/api/selects/${id}/caption`, { caption: "Mine.", altText: null });

    expect(db.query("SELECT count(*) AS n FROM select_captions").get()).toEqual({ n: 1 });

    expect((await request(`/api/selects/${id}`, { method: "DELETE" })).status).toBe(204);
    expect(db.query("SELECT count(*) AS n FROM select_captions").get()).toEqual({ n: 0 });
  });
});

describe("a preview of a template with problems", () => {
  test("is not built, so a template of repeated hashtags is never expanded", async () => {
    const id = await addSelect("portrait");
    const response = await send("POST", "/api/captions/preview", {
      selectId: id,
      templates: { ...custom, caption: "{hashtags}".repeat(1000) },
    });

    const body = await json(response);
    expect(body.caption).toBeNull();
    expect(body.check.problems).toEqual(["The caption can have {hashtags} once."]);
  });
});

describe("a select whose location is withheld", () => {
  const coordinates = "10°30'00\"N";

  test("has no coordinates in its caption inside a privacy zone, hidden on its own, or after either is undone", async () => {
    const id = await addSelect("portrait");
    const caption = async () => (await json(await request(`/api/selects/${id}/caption`))).caption.caption;
    expect(await caption()).toContain(coordinates);

    const zone = await json(
      await send("POST", "/api/zones", { latitude: 10.5, longitude: -40.25, radiusMetres: 1000 }),
    );
    expect(await caption()).not.toContain("10°");
    expect(await caption()).toStartWith("Fixture Optics FX-1");

    await request(`/api/zones/${zone.id}`, { method: "DELETE" });
    expect(await caption()).toContain(coordinates);

    await send("PUT", `/api/selects/${id}/capture`, { edits: {}, locationHidden: true });
    expect(await caption()).not.toContain("10°");
  });

  test("has none in a preview either", async () => {
    const id = await addSelect("portrait");
    await send("PUT", `/api/selects/${id}/capture`, { edits: {}, locationHidden: true });

    const preview = await json(
      await send("POST", "/api/captions/preview", {
        selectId: id,
        templates: (await json(await request("/api/captions"))).templates,
      }),
    );

    expect(preview.caption.caption).not.toContain("10°");
  });

  test("builds its caption from edited capture data", async () => {
    const id = await addSelect("portrait");
    await send("PUT", `/api/selects/${id}/capture`, {
      edits: { camera: "Edited Camera" },
      locationHidden: false,
    });

    expect((await json(await request(`/api/selects/${id}/caption`))).caption.caption).toContain(
      "Edited Camera",
    );
  });
});

describe("caption check", () => {
  test("measures text being written against Instagram's limits without saving it", async () => {
    const response = await send("POST", "/api/captions/check", {
      caption: `${"a".repeat(1990)} #one @two`,
      altText: "A pier.",
    });

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      captionCharacters: 2000,
      hashtags: 1,
      mentions: 1,
      altTextCharacters: 7,
      warnings: ["The caption is 2,000 characters, near Instagram's limit of 2,200."],
      problems: [],
    });
  });
});
