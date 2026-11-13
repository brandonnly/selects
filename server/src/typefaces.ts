/// <reference path="./opentype.d.ts" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { type Font, type Glyph, type PathCommand, parse } from "opentype.js";
import { errorKind } from "./library";

/** The six typefaces bundled in `server/fonts`, each beside its license. See ADR 0001. */
export const TYPEFACES = [
  { id: "ibm-plex-mono", name: "IBM Plex Mono", file: "ibm-plex-mono/IBMPlexMono-Regular.ttf" },
  { id: "jetbrains-mono", name: "JetBrains Mono", file: "jetbrains-mono/JetBrainsMono-Regular.ttf" },
  { id: "space-mono", name: "Space Mono", file: "space-mono/SpaceMono-Regular.ttf" },
  { id: "courier-prime", name: "Courier Prime", file: "courier-prime/CourierPrime-Regular.ttf" },
  { id: "inter", name: "Inter", file: "inter/Inter-Regular.ttf" },
  { id: "eb-garamond", name: "EB Garamond", file: "eb-garamond/EBGaramond-Regular.ttf" },
] as const;

export type TypefaceId = (typeof TYPEFACES)[number]["id"];

export const TYPEFACE_IDS = TYPEFACES.map((t) => t.id) as [TypefaceId, ...TypefaceId[]];

/** Where the bundled fonts live. */
export const FONTS_DIR = resolve(import.meta.dir, "../fonts");

/** The folder in the data directory where a font file overrides the chosen typeface. */
export const OVERRIDE_DIR = "fonts";
const FONT_EXTENSIONS = [".ttf", ".otf", ".woff"];

/** The override font found in the data folder, and whether it could be read. */
export type FontOverride = { fileName: string; usable: boolean };

/** A font, as the frame lays text out in it. Sizes and positions are in pixels. */
export type Typeface = {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  hasGlyph(character: string): boolean;
  /** The advance width of `text` at `size`. */
  width(text: string, size: number): number;
  /** The outlines of `text` set at `size` from the baseline point `x`, `y`, y pointing down. */
  outline(text: string, x: number, y: number, size: number): PathCommand[];
};

/** Every character a frame can print, which a font must lay out to be used. */
const SAMPLE = `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,-/°'"·`;

/**
 * Sets text one glyph after another, with the font's pair kerning and no substitutions: the
 * line is plain metadata with no use for ligatures, and opentype.js's own text layout throws on
 * substitution lookups that common fonts carry.
 */
function typeface(font: Font): Typeface {
  const notdef = font.glyphs.get(0);
  const glyphs = (text: string) =>
    [...text].map((character) => font.glyphs.get(font.charToGlyphIndex(character)) ?? notdef);

  /** Each glyph with its pen position, in font units from the start of the line. */
  function place(text: string) {
    let pen = 0;
    let previous: Glyph | undefined;
    const placed: { glyph: Glyph; at: number }[] = [];
    for (const glyph of glyphs(text)) {
      if (glyph === undefined) continue;
      if (previous !== undefined) pen += font.getKerningValue(previous, glyph);
      placed.push({ glyph, at: pen });
      pen += glyph.advanceWidth ?? 0;
      previous = glyph;
    }
    return { placed, advance: pen };
  }

  return {
    unitsPerEm: font.unitsPerEm,
    ascender: font.ascender,
    descender: font.descender,
    hasGlyph: (character) => font.charToGlyphIndex(character) !== 0,
    width: (text, size) => (place(text).advance * size) / font.unitsPerEm,
    outline: (text, x, y, size) =>
      place(text).placed.flatMap(
        ({ glyph, at }) => glyph.getPath(x + (at * size) / font.unitsPerEm, y, size).commands,
      ),
  };
}

/** The parsed font for each path, with the size and modified time it was parsed at. */
const parsed = new Map<string, { version: string; font: Typeface | null }>();

function load(path: string): Typeface | null {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (stats === undefined) {
    parsed.delete(path);
    return null;
  }
  const version = `${stats.size}\0${stats.mtimeMs}`;
  const known = parsed.get(path);
  if (known?.version === version) return known.font;
  let loaded: Typeface | null = null;
  try {
    loaded = typeface(parse(readFileSync(path)));
    loaded.outline(SAMPLE, 0, 0, 10);
  } catch (error) {
    loaded = null;
    // Logged once per version of the file. Its name is the user's own, so it stays out.
    console.error(`A font file could not be read or laid out (${errorKind(error)}).`);
  }
  parsed.set(path, { version, font: loaded });
  return loaded;
}

/**
 * The fonts frames are set in: the bundled typeface chosen in the frame settings, unless a font
 * file sits in the data folder's `fonts/`, which then overrides it. The folder is looked at on
 * every call, so adding or removing the file takes effect without a restart. With several files
 * there, the first by name is used.
 */
export function createFontSource(dataDir: string) {
  const overrideDir = join(dataDir, OVERRIDE_DIR);

  function overridePath(): string | undefined {
    let names: string[];
    try {
      names = readdirSync(overrideDir);
    } catch {
      return undefined;
    }
    const name = names
      .filter((n) => !n.startsWith(".") && FONT_EXTENSIONS.includes(extname(n).toLowerCase()))
      .sort()[0];
    return name === undefined ? undefined : join(overrideDir, name);
  }

  return {
    override(): FontOverride | null {
      const path = overridePath();
      return path === undefined ? null : { fileName: basename(path), usable: load(path) !== null };
    },

    /**
     * The font to set `text` in. An override that lacks one of its characters is passed over
     * for the chosen typeface, so a line never prints the override's missing-glyph boxes.
     */
    font(id: TypefaceId, text = ""): Typeface {
      const override = overridePath();
      const font = override === undefined ? null : load(override);
      if (font !== null && [...text].every((character) => font.hasGlyph(character))) return font;
      const chosen = TYPEFACES.find((t) => t.id === id) ?? TYPEFACES[0];
      const bundled = load(join(FONTS_DIR, chosen.file));
      if (bundled === null) throw new Error(`The bundled font ${chosen.file} could not be read`);
      return bundled;
    },
  };
}

export type FontSource = ReturnType<typeof createFontSource>;
export type { PathCommand };
