import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import sharp from "sharp";
import { REFERENCES, type Reference, referencePath, renderReferences } from "./frame-references";

/**
 * How far a render may drift from its reference: enough for a different CPU's rounding in
 * decoding and resampling, not enough for a moved photo, another color or other lettering. The
 * worst tile catches a change confined to a small area, such as the line of metadata.
 */
const MAX_MEAN_DIFFERENCE = 1;
const MAX_TILE_DIFFERENCE = 5;
const TILE = 8;

let rendered: Map<Reference, Buffer>;
beforeAll(async () => {
  rendered = await renderReferences();
});

async function raw(png: Buffer | string) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

type Raw = Awaited<ReturnType<typeof raw>>;

/** The mean difference per channel over the image, and over its most different tile. */
function compare(expected: Raw, actual: Raw) {
  const { width, height } = expected;
  let sum = 0;
  let worstTile = 0;
  for (let tileY = 0; tileY < height; tileY += TILE) {
    for (let tileX = 0; tileX < width; tileX += TILE) {
      let tileSum = 0;
      let count = 0;
      for (let y = tileY; y < Math.min(height, tileY + TILE); y++) {
        for (let x = tileX; x < Math.min(width, tileX + TILE); x++) {
          for (let c = 0; c < 3; c++) {
            const at = (y * width + x) * 3 + c;
            tileSum += Math.abs((expected.data[at] ?? 0) - (actual.data[at] ?? 0));
            count++;
          }
        }
      }
      sum += tileSum;
      worstTile = Math.max(worstTile, tileSum / count);
    }
  }
  return { mean: sum / expected.data.length, worstTile };
}

describe("the frame matches its reference image", () => {
  for (const reference of REFERENCES) {
    test(`${reference.fixture} on a ${reference.color} frame`, async () => {
      const path = referencePath(reference);
      if (!existsSync(path))
        throw new Error(`No reference image; run \`bun run references\` to write ${path}`);
      const expected = await raw(path);
      const actual = await raw(rendered.get(reference) ?? Buffer.alloc(0));

      expect([actual.width, actual.height]).toEqual([expected.width, expected.height]);
      const { mean, worstTile } = compare(expected, actual);
      expect(mean).toBeLessThanOrEqual(MAX_MEAN_DIFFERENCE);
      expect(worstTile).toBeLessThanOrEqual(MAX_TILE_DIFFERENCE);
    });
  }
});
