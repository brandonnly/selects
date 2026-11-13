/** The small part of opentype.js the frame uses. The package ships no types. */
declare module "opentype.js" {
  export type PathCommand =
    | { type: "M" | "L"; x: number; y: number }
    | { type: "Q"; x1: number; y1: number; x: number; y: number }
    | { type: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
    | { type: "Z" };

  /** Outlines in y-down coordinates, as SVG draws them. */
  export interface Path {
    commands: PathCommand[];
  }

  export interface Glyph {
    index: number;
    /** In font units. */
    advanceWidth?: number;
    getPath(x: number, y: number, fontSize: number): Path;
  }

  export interface Font {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    glyphs: { get(index: number): Glyph | undefined };
    /** 0 when the font has no glyph for the character. */
    charToGlyphIndex(character: string): number;
    /** The kerning between two glyphs, in font units. */
    getKerningValue(left: Glyph, right: Glyph): number;
  }

  /** Parses a TrueType, OpenType or WOFF file. Throws when the file is not one. */
  export function parse(buffer: ArrayBuffer | Uint8Array): Font;
}
