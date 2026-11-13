import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatRadius, TILES } from "./map";

const serverSource = join(import.meta.dir, "../../../server/src");

describe("map tiles", () => {
  test("come straight from OpenStreetMap's tile server, over HTTPS, with its attribution", () => {
    const sample = new URL(TILES.url.replace("{z}", "3").replace("{x}", "4").replace("{y}", "2"));

    expect(sample.protocol).toBe("https:");
    expect(sample.host).toBe("tile.openstreetmap.org");
    expect(sample.pathname).toBe("/3/4/2.png");
    expect(TILES.attribution).toContain("https://www.openstreetmap.org/copyright");
    expect(TILES.attribution).toContain("OpenStreetMap");
    expect(TILES.maxZoom).toBeLessThanOrEqual(19);
  });

  test("are never fetched or proxied by the server: no server module names a tile source", () => {
    const files = readdirSync(serverSource, { recursive: true, encoding: "utf8" }).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
    );
    expect(files.length).toBeGreaterThan(0);
    const host = new URL(TILES.url.replace(/\{[a-z]\}/g, "0")).host;

    for (const file of files) {
      const source = readFileSync(join(serverSource, file), "utf8");
      expect({ file, namesTiles: source.includes(host) || source.includes("{z}") }).toEqual({
        file,
        namesTiles: false,
      });
    }
  });
});

describe("formatRadius", () => {
  test("is metres under a kilometre, then kilometres", () => {
    expect([850, 999.6, 1000, 1500, 9_960, 12_400].map(formatRadius)).toEqual([
      "850 m",
      "1 km",
      "1 km",
      "1.5 km",
      "10 km",
      "12 km",
    ]);
  });
});
