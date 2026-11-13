import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { type FixtureName, generateFixtures } from "./fixtures";
import { createFrameRenderer, DEFAULT_FRAME_SETTINGS, type FrameSettings } from "./frame";
import { inspectPhoto } from "./photo";

let dir: string;
let paths: Record<FixtureName, string>;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "selects-frame-"));
  paths = await generateFixtures(join(dir, "fixtures"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const renderer = () => createFrameRenderer({ dataDir: join(dir, "data") });

async function source(name: FixtureName) {
  const path = paths[name];
  const photo = await inspectPhoto(path);
  if (photo === undefined) throw new Error(`${name} is not a photo`);
  return { path, capture: photo };
}

const settings = (change: Partial<FrameSettings> = {}): FrameSettings => ({
  ...DEFAULT_FRAME_SETTINGS,
  ...change,
});

/** The markers of a JPEG's segments before its image data, such as 0xe0 for APP0. */
function jpegMarkers(jpeg: Uint8Array): number[] {
  const markers: number[] = [];
  let at = 2;
  while (at + 4 <= jpeg.length && jpeg[at] === 0xff) {
    const marker = jpeg[at + 1] ?? 0;
    markers.push(marker);
    if (marker === 0xda) break; // start of scan: image data follows
    at += 2 + (((jpeg[at + 2] ?? 0) << 8) | (jpeg[at + 3] ?? 0));
  }
  return markers;
}

type Pixels = { data: Buffer; width: number; height: number };

async function pixels(jpeg: Uint8Array): Promise<Pixels> {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

const LIGHT = [255, 255, 255];

/** The smallest box holding every pixel in `region` that differs clearly from `background`. */
function inkBox(image: Pixels, background: number[], region = { top: 0, bottom: image.height }) {
  let left = image.width;
  let right = -1;
  let top = image.height;
  let bottom = -1;
  for (let y = region.top; y < region.bottom; y++) {
    for (let x = 0; x < image.width; x++) {
      const at = (y * image.width + x) * 3;
      let diff = 0;
      for (let c = 0; c < 3; c++) diff += Math.abs((image.data[at + c] ?? 0) - (background[c] ?? 0));
      if (diff > 60) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }
  return { left, right, top, bottom };
}

describe("the rendered frame", () => {
  test("is a 1440 × 1800 sRGB JPEG under 8 MB with no embedded metadata", async () => {
    // The portrait carries a full EXIF block with GPS.
    const jpeg = await renderer().render(await source("portrait"), settings());
    const metadata = await sharp(jpeg).metadata();

    expect(metadata.format).toBe("jpeg");
    expect([metadata.width, metadata.height]).toEqual([1440, 1800]);
    expect(metadata.space).toBe("srgb");
    expect(metadata.channels).toBe(3);
    expect(jpeg.byteLength).toBeLessThan(8 * 1024 * 1024);

    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.iptc).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
    // Nothing but the JFIF header and the image itself: no APP1 (EXIF, XMP) or APP2 (ICC).
    const appSegments = jpegMarkers(jpeg).filter((m) => m >= 0xe1 && m <= 0xef);
    expect(appSegments).toEqual([]);
    expect(Buffer.from(jpeg).includes("Fixture Optics")).toBe(false);
  });

  test("stays under 8 MB for a photo that compresses as badly as any can", async () => {
    const noise = Buffer.alloc(1200 * 1500 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = Math.imul(i, 2654435761) >>> 24;
    const path = join(dir, "noise.png");
    await sharp(noise, { raw: { width: 1200, height: 1500, channels: 3 } })
      .png()
      .toFile(path);
    const photo = await inspectPhoto(path);
    if (photo === undefined) throw new Error("noise is not a photo");

    const jpeg = await renderer().render({ path, capture: photo }, settings({ border: 0 }));

    expect(jpeg.byteLength).toBeLessThan(8 * 1024 * 1024);
  });

  test("prints the whole line of metadata, shrunk to fit inside the border", async () => {
    // The portrait's line is longer than the frame is wide at the usual size.
    const image = await pixels(await renderer().render(await source("portrait"), settings({ border: 64 })));
    const photo = inkBox(image, LIGHT, { top: 0, bottom: 1600 });
    const text = inkBox(image, LIGHT, { top: photo.bottom + 2, bottom: image.height });

    expect(text.left).toBeGreaterThanOrEqual(64);
    expect(text.left).toBeLessThan(64 + 8);
    expect(text.right).toBeLessThanOrEqual(1440 - 64);
    expect(text.right).toBeGreaterThan(1440 - 64 - 8);
  });
});
