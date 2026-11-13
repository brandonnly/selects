import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Font, parse } from "opentype.js";

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

/** Parsed fonts, kept for the life of the process: each file is read once. */
const parsed = new Map<string, Font>();

/** The font a frame is set in. */
export function loadTypeface(id: TypefaceId): Font {
  const typeface = TYPEFACES.find((t) => t.id === id) ?? TYPEFACES[0];
  const path = join(FONTS_DIR, typeface.file);
  let font = parsed.get(path);
  if (font === undefined) {
    font = parse(readFileSync(path));
    parsed.set(path, font);
  }
  return font;
}
