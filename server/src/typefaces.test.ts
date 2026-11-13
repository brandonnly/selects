import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_FRAME_SETTINGS } from "./frame";
import { createFontSource, FONTS_DIR, TYPEFACES } from "./typefaces";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "selects-fonts-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

/** Every character a frame can print. */
const CHARACTERS = `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,-/°'"·`;

const fontFile = (id: string) => {
  const typeface = TYPEFACES.find((t) => t.id === id);
  if (typeface === undefined) throw new Error(`No typeface ${id}`);
  return join(FONTS_DIR, typeface.file);
};

describe("the bundled typefaces", () => {
  test("are the six chosen in ADR 0001, IBM Plex Mono by default", () => {
    expect(TYPEFACES.map((t) => t.name)).toEqual([
      "IBM Plex Mono",
      "JetBrains Mono",
      "Space Mono",
      "Courier Prime",
      "Inter",
      "EB Garamond",
    ]);
    expect(TYPEFACES.find((t) => t.id === DEFAULT_FRAME_SETTINGS.typeface)?.name).toBe("IBM Plex Mono");
  });

  test("each ships with its SIL Open Font License beside it", () => {
    for (const typeface of TYPEFACES) {
      const license = join(dirname(join(FONTS_DIR, typeface.file)), "OFL.txt");

      expect(existsSync(license)).toBe(true);
      expect(readFileSync(license, "utf8")).toContain("SIL Open Font License, Version 1.1");
    }
  });

  test("each has a glyph for every character a frame prints", () => {
    const fonts = createFontSource(dataDir);
    for (const typeface of TYPEFACES) {
      const font = fonts.font(typeface.id);
      const missing = [...CHARACTERS].filter((c) => !font.hasGlyph(c));

      expect({ typeface: typeface.id, missing }).toEqual({ typeface: typeface.id, missing: [] });
    }
  });
});

describe("the font override", () => {
  const overrideDir = () => join(dataDir, "fonts");

  test("is off while the data folder holds no font file", () => {
    const fonts = createFontSource(dataDir);

    expect(fonts.override()).toBeNull();
    expect(fonts.font("ibm-plex-mono")).toBe(fonts.font("ibm-plex-mono"));
  });

  test("a font file in the data folder replaces the chosen typeface", () => {
    mkdirSync(overrideDir());
    copyFileSync(fontFile("space-mono"), join(overrideDir(), "House Mono.ttf"));
    writeFileSync(join(overrideDir(), "notes.txt"), "not a font");
    const fonts = createFontSource(dataDir);

    expect(fonts.override()).toEqual({ fileName: "House Mono.ttf", usable: true });
    expect(fonts.font("ibm-plex-mono").width("Override", 100)).toBe(
      fonts.font("space-mono").width("Override", 100),
    );
    expect(fonts.font("ibm-plex-mono").width("Override", 100)).not.toBe(
      createFontSource(join(dataDir, "elsewhere")).font("ibm-plex-mono").width("Override", 100),
    );
  });

  test("an unreadable font file is reported and the chosen typeface is used", () => {
    mkdirSync(overrideDir());
    writeFileSync(join(overrideDir(), "broken.otf"), "not really a font");
    const fonts = createFontSource(dataDir);
    const bundled = createFontSource(join(dataDir, "elsewhere")).font("inter");

    expect(fonts.override()).toEqual({ fileName: "broken.otf", usable: false });
    expect(fonts.font("inter").width("Fallback", 100)).toBe(bundled.width("Fallback", 100));
  });

  test("takes effect without a restart when the file is added or removed", () => {
    const fonts = createFontSource(dataDir);
    expect(fonts.override()).toBeNull();

    mkdirSync(overrideDir());
    copyFileSync(fontFile("courier-prime"), join(overrideDir(), "added.ttf"));
    expect(fonts.override()?.fileName).toBe("added.ttf");

    rmSync(join(overrideDir(), "added.ttf"));
    expect(fonts.override()).toBeNull();
  });
});
