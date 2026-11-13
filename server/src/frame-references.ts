/**
 * Reference images of the frame: each orientation in each frame color, rendered from the
 * generated fixtures with the default settings. The frame tests compare fresh renders against
 * them, so any change to how a frame looks shows up as a failing test.
 *
 * After an intended change to the frame, run `bun run references` to write them again, look at
 * every image, and commit them with the change.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { publishCapture } from "./capture";
import { type FixtureName, generateFixtures } from "./fixtures";
import { createFrameRenderer, DEFAULT_FRAME_SETTINGS, type FrameSettings } from "./frame";
import { inspectPhoto } from "./photo";

export const REFERENCE_DIR = resolve(import.meta.dir, "../references");

/** References are kept at half size, which is enough to see layout, color and lettering. */
export const REFERENCE_WIDTH = 720;

export const REFERENCES = [
  { name: "portrait-light", fixture: "portrait", color: "light" },
  { name: "portrait-dark", fixture: "portrait", color: "dark" },
  { name: "square-light", fixture: "square", color: "light" },
  { name: "square-dark", fixture: "square", color: "dark" },
  { name: "landscape-light", fixture: "landscape", color: "light" },
  { name: "landscape-dark", fixture: "landscape", color: "dark" },
] as const satisfies readonly { name: string; fixture: FixtureName; color: FrameSettings["color"] }[];

export type Reference = (typeof REFERENCES)[number];

export const referencePath = (reference: Reference) => join(REFERENCE_DIR, `frame-${reference.name}.png`);

/**
 * Renders each reference as a PNG, from fixtures written to a scratch folder. The data folder
 * is a scratch one too, so no font override applies.
 */
export async function renderReferences(): Promise<Map<Reference, Buffer>> {
  const scratch = mkdtempSync(join(tmpdir(), "selects-references-"));
  try {
    const fixtures = await generateFixtures(join(scratch, "fixtures"));
    const renderer = createFrameRenderer({ dataDir: join(scratch, "data") });
    const rendered = new Map<Reference, Buffer>();
    for (const reference of REFERENCES) {
      const path = fixtures[reference.fixture];
      const capture = await inspectPhoto(path);
      if (capture === undefined) throw new Error(`The ${reference.fixture} fixture is not a photo`);
      const jpeg = await renderer.render(
        { path, capture: publishCapture(capture, {}, { locationHidden: false, zones: [] }) },
        { ...DEFAULT_FRAME_SETTINGS, color: reference.color },
        { width: REFERENCE_WIDTH },
      );
      rendered.set(reference, await sharp(jpeg).png({ compressionLevel: 9 }).toBuffer());
    }
    return rendered;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  mkdirSync(REFERENCE_DIR, { recursive: true });
  for (const [reference, png] of await renderReferences()) {
    await Bun.write(referencePath(reference), png);
    console.log(`frame-${reference.name}.png`);
  }
}
