import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import exifr from "exifr";
import sharp from "sharp";
import { type FixtureName, generateFixtures } from "./fixtures";

let dir: string;
let files: Record<FixtureName, string>;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "selects-fixtures-"));
  files = await generateFixtures(dir);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const readExif = (name: FixtureName) =>
  exifr.parse(files[name], { tiff: true, exif: true, gps: true, reviveValues: false });

describe("generateFixtures", () => {
  test("writes a JPEG, a PNG and a TIFF in portrait, square and landscape", async () => {
    const shapes = await Promise.all(
      (["portrait", "square", "landscape"] as const).map(async (name) => {
        const { format, autoOrient } = await sharp(files[name]).metadata();
        return { name, format, ...autoOrient };
      }),
    );

    expect(shapes).toEqual([
      { name: "portrait", format: "jpeg", width: 800, height: 1000 },
      { name: "square", format: "png", width: 900, height: 900 },
      { name: "landscape", format: "tiff", width: 1200, height: 800 },
    ]);
  });

  test("gives each photo full EXIF, with invented coordinates where it has GPS", async () => {
    const portrait = await readExif("portrait");
    expect(portrait).toMatchObject({
      Make: "Fixture Optics",
      Model: "FX-1",
      LensModel: "Fixture 35mm F1.4",
      FocalLength: 35,
      ExposureTime: 0.004,
      FNumber: 2.8,
      ISO: 400,
      DateTimeOriginal: "2024:05:01 10:20:30",
    });
    expect(portrait.latitude).toBeCloseTo(10.5, 6);
    expect(portrait.longitude).toBeCloseTo(-40.25, 6);

    const landscape = await readExif("landscape");
    expect(landscape).toMatchObject({ Model: "Fixture FX-2", DateTimeOriginal: "2023:11:18 07:45:12" });
    expect(landscape.latitude).toBeCloseTo(-35.125, 6);
    expect(landscape.longitude).toBeCloseTo(165.75, 6);

    const square = await readExif("square");
    expect(square).toMatchObject({ Model: "FX-1", DateTimeOriginal: "2022:08:09 18:02:44" });
    expect(square.latitude).toBeUndefined();
  });

  test("includes a re-export: the portrait at another size and quality with the same capture time", async () => {
    const original = readFileSync(files.portrait);
    const reexport = readFileSync(files.portraitReexport);
    const { width, height } = await sharp(reexport).metadata();

    expect(reexport.equals(original)).toBe(false);
    expect({ width, height }).toEqual({ width: 640, height: 800 });
    expect((await readExif("portraitReexport")).DateTimeOriginal).toBe("2024:05:01 10:20:30");
  });

  test("includes a photo stored on its side with an orientation tag", async () => {
    const { width, height, autoOrient } = await sharp(files.rotated).metadata();

    expect({ width, height }).toEqual({ width: 1000, height: 800 });
    expect(autoOrient).toEqual({ width: 800, height: 1000 });
  });

  test("includes a photo with no metadata and files that are not JPEG, PNG or TIFF", async () => {
    expect(await exifr.parse(files.noExif)).toBeUndefined();
    expect((await sharp(files.webp).metadata()).format).toBe("webp");
    expect(readFileSync(files.text, "utf8")).not.toBe("");
  });

  test("includes the landscape's scene stored in Display P3, tagged with its profile", async () => {
    const { icc, width, height } = await sharp(files.wideGamut).metadata();
    // Read without converting, the stored values are not the sRGB landscape's.
    const stored = await sharp(files.wideGamut).keepIccProfile().raw().toBuffer();
    const srgb = await sharp(files.landscape).raw().toBuffer();
    let diff = 0;
    for (let i = 0; i < srgb.length; i++) diff += Math.abs((stored[i] ?? 0) - (srgb[i] ?? 0));

    expect({ width, height }).toEqual({ width: 1200, height: 800 });
    // The profile names itself in big-endian UTF-16.
    expect(icc?.includes(Buffer.from("P3", "utf16le").swap16())).toBe(true);
    expect(diff / srgb.length).toBeGreaterThan(5);
  });
});
