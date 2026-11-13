import sharp, { type OverlayOptions } from "sharp";
import type { CaptureData } from "./photo";
import { createFontSource, type PathCommand, type Typeface, type TypefaceId } from "./typefaces";

/** The fields that can print on a frame, in the order they print. */
export const FRAME_FIELDS = [
  "camera",
  "lens",
  "focalLength",
  "shutter",
  "aperture",
  "iso",
  "coordinates",
  "date",
] as const;
export type FrameField = (typeof FRAME_FIELDS)[number];

export type FrameSettings = {
  /** Border around the photo, in pixels of the 1440 × 1800 frame. */
  border: number;
  color: "light" | "dark";
  typeface: TypefaceId;
  /** Which fields print. A field the select lacks is left off either way. */
  fields: Record<FrameField, boolean>;
  coordinateFormat: "dms" | "decimal";
};

export const DEFAULT_FRAME_SETTINGS: FrameSettings = {
  border: 64,
  color: "light",
  typeface: "ibm-plex-mono",
  fields: {
    camera: true,
    lens: true,
    focalLength: true,
    shutter: true,
    aperture: true,
    iso: true,
    coordinates: true,
    date: true,
  },
  coordinateFormat: "dms",
};

const SEPARATOR = " · ";

/** The line of metadata a frame prints: each shown field the select has, with nothing for the rest. */
export function frameText(capture: CaptureData, settings: FrameSettings): string {
  const values = fieldValues(capture, settings.coordinateFormat);
  return FRAME_FIELDS.filter((field) => settings.fields[field])
    .map((field) => values[field])
    .filter((value): value is string => value !== null && value !== "")
    .join(SEPARATOR);
}

/**
 * Each field as the frame prints it, or null when the select lacks it. Captions print fields
 * the same way.
 */
export function fieldValues(
  capture: CaptureData,
  coordinateFormat: FrameSettings["coordinateFormat"],
): Record<FrameField, string | null> {
  return {
    camera: clip(capture.camera),
    lens: clip(capture.lens),
    focalLength: capture.focalLength === null ? null : `${decimals(capture.focalLength, 1)}mm`,
    shutter: capture.exposureTime === null ? null : shutterSpeed(capture.exposureTime),
    aperture: capture.fNumber === null ? null : `f/${decimals(capture.fNumber, 1)}`,
    iso: capture.iso === null ? null : `ISO ${Math.round(capture.iso)}`,
    coordinates:
      capture.latitude === null || capture.longitude === null
        ? null
        : coordinates(capture.latitude, capture.longitude, coordinateFormat),
    date: capture.capturedAt?.slice(0, 10) ?? null,
  };
}

/** The longest camera or lens name a frame prints: a longer one would shrink the line too far to read. */
const MAX_NAME = 48;

function clip(name: string | null): string | null {
  return name === null ? null : [...name].slice(0, MAX_NAME).join("").trim();
}

/** Up to `places` decimals, without trailing zeros: 8 → "8", 2.80 → "2.8". */
function decimals(value: number, places: number): string {
  return String(Number(value.toFixed(places)));
}

/** 1/250s under a second, with a decimal below 1/3 s (1/2.5s); whole or decimal seconds above. */
function shutterSpeed(seconds: number): string {
  if (seconds >= 1) return `${decimals(seconds, 1)}s`;
  const denominator = 1 / seconds;
  return `1/${denominator >= 3 ? Math.round(denominator) : decimals(denominator, 1)}s`;
}

function coordinates(latitude: number, longitude: number, format: FrameSettings["coordinateFormat"]) {
  if (format === "decimal") return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
  return `${dms(latitude, "N", "S")} ${dms(longitude, "E", "W")}`;
}

/** 10.5 → 10°30'00"N. Rounded to the second, carrying into minutes and degrees. */
function dms(value: number, positive: string, negative: string): string {
  const total = Math.round(Math.abs(value) * 3600);
  const degrees = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${degrees}°${pad(minutes)}'${pad(seconds)}"${value < 0 ? negative : positive}`;
}

/** The frame's size: the largest and tallest image Instagram keeps, 4:5. */
export const FRAME_WIDTH = 1440;
export const FRAME_HEIGHT = 1800;

/** The thickest border the settings allow, in pixels of the frame. */
export const MAX_BORDER = 240;

/** The band under the photo that holds the line of metadata. */
const TEXT_BAND = 80;
const TEXT_SIZE = 26;
/** The least room either side of the line, when the border is thinner than this. */
const TEXT_MARGIN = 32;
/**
 * Where a photo shorter than its space sits: this share of the spare height goes above it, the
 * rest below, so a landscape photo rests slightly above centre.
 */
const SPARE_ABOVE = 0.4;
const JPEG_QUALITY = 92;
/** Renders at once. Each decodes a whole original, so more would stack up memory. */
const MAX_RENDERS = 2;

const COLORS = {
  light: { background: "#ffffff", text: "#444444" },
  dark: { background: "#121212", text: "#c8c8c8" },
} as const;

/** The select to frame: its original and the capture data to print. */
export type FrameSource = { path: string; capture: CaptureData };

export type RenderOptions = {
  /** Scales the finished frame down to this width, for a preview. Default: full size. */
  width?: number;
  /** Aborted when nobody wants the frame any more: a render still waiting its turn is skipped. */
  signal?: AbortSignal;
};

type Box = { left: number; top: number; width: number; height: number };

/** Where the photo and the line of metadata go on the frame. */
function layout(photo: { width: number; height: number }, border: number) {
  const space = {
    width: FRAME_WIDTH - 2 * border,
    height: FRAME_HEIGHT - 2 * border - TEXT_BAND,
  };
  const scale = Math.min(space.width / photo.width, space.height / photo.height);
  // At least a pixel each way, so a sliver of a photo still renders.
  const width = Math.max(1, Math.round(photo.width * scale));
  const height = Math.max(1, Math.round(photo.height * scale));
  const box: Box = {
    left: Math.round((FRAME_WIDTH - width) / 2),
    top: border + Math.round((space.height - height) * SPARE_ABOVE),
    width,
    height,
  };
  return { photo: box, textTop: box.top + box.height };
}

/** The line of metadata as filled outlines, so it renders the same on any machine. */
function textSvg(text: string, font: Typeface, color: string, border: number): string {
  const room = FRAME_WIDTH - 2 * Math.max(border, TEXT_MARGIN);
  const natural = font.width(text, TEXT_SIZE);
  const size = natural > room ? (TEXT_SIZE * room) / natural : TEXT_SIZE;
  const width = font.width(text, size);
  const scale = size / font.unitsPerEm;
  // The baseline that centres the font's ascender-to-descender height in the band.
  const baseline = TEXT_BAND / 2 + ((font.ascender + font.descender) / 2) * scale;
  const outline = font.outline(text, (FRAME_WIDTH - width) / 2, baseline, size);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${FRAME_WIDTH}" height="${TEXT_BAND}"><path d="${pathData(outline)}" fill="${color}"/></svg>`;
}

/**
 * SVG path data for outlines. Written here because opentype.js's own `toPathData` prints NaN
 * for some coordinates, which ends the path there and drops the rest of the line.
 */
function pathData(commands: PathCommand[]): string {
  const n = (value: number) => String(Math.round(value * 100) / 100);
  return commands
    .map((c) => {
      if (c.type === "M" || c.type === "L") return `${c.type}${n(c.x)} ${n(c.y)}`;
      if (c.type === "Q") return `Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`;
      if (c.type === "C") return `C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`;
      return "Z";
    })
    .join("");
}

/**
 * Renders frames: a select's photo on a 1440 × 1800 canvas with a border and its line of
 * metadata, as an sRGB JPEG with no embedded metadata. The scheduler, the publisher and the
 * Frame screen's preview all render through this.
 */
export function createFrameRenderer({ dataDir }: { dataDir: string }) {
  const fonts = createFontSource(dataDir);
  const turn = turns(MAX_RENDERS);
  return {
    /** The font file in the data folder that overrides the typeface setting, if there is one. */
    fontOverride: () => fonts.override(),

    async render(source: FrameSource, settings: FrameSettings, options: RenderOptions = {}): Promise<Buffer> {
      await turn.take();
      try {
        if (options.signal?.aborted) throw new Error("The frame was given up on before its turn");
        return await renderFrame(source, settings, options);
      } finally {
        turn.give();
      }
    },
  };

  async function renderFrame(
    source: FrameSource,
    settings: FrameSettings,
    options: RenderOptions,
  ): Promise<Buffer> {
    const colors = COLORS[settings.color];
    const border = Math.max(0, Math.min(MAX_BORDER, Math.round(settings.border)));

    const original = sharp(source.path).rotate();
    const { autoOrient } = await original.metadata();
    const place = layout(autoOrient, border);
    const photo = await original
      .resize(place.photo.width, place.photo.height, { fit: "fill" })
      // Converts from the original's own profile, so wide-gamut colors survive. Naming the
      // sRGB profile is what converts a 16-bit original; the finished frame carries no profile.
      .toColourspace("srgb")
      .withIccProfile("srgb")
      .flatten({ background: colors.background })
      .png({ compressionLevel: 0 })
      .toBuffer();

    const layers: OverlayOptions[] = [{ input: photo, left: place.photo.left, top: place.photo.top }];
    const line = frameText(source.capture, settings);
    const font = fonts.font(settings.typeface, line);
    // A character the font lacks is left out, where it would print as an empty box.
    const text = [...line]
      .filter((character) => font.hasGlyph(character))
      .join("")
      .replace(/ {2,}/g, " ")
      .trim();
    if (text !== "") {
      const svg = textSvg(text, font, colors.text, border);
      layers.push({ input: Buffer.from(svg), left: 0, top: place.textTop });
    }

    const frame = sharp({
      create: { width: FRAME_WIDTH, height: FRAME_HEIGHT, channels: 3, background: colors.background },
    }).composite(layers);

    if (options.width === undefined || options.width >= FRAME_WIDTH) {
      return frame.jpeg({ quality: JPEG_QUALITY }).toBuffer();
    }
    const full = await frame.raw().toBuffer({ resolveWithObject: true });
    return sharp(full.data, { raw: full.info })
      .resize(Math.max(1, Math.round(options.width)))
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
  }
}

/** Lets `limit` holders through at a time; the rest wait their turn in order. */
function turns(limit: number) {
  let free = limit;
  const waiting: (() => void)[] = [];
  return {
    take(): Promise<void> {
      if (free > 0) {
        free--;
        return Promise.resolve();
      }
      return new Promise((resolve) => waiting.push(resolve));
    },
    give() {
      const next = waiting.shift();
      if (next) next();
      else free++;
    },
  };
}

export type FrameRenderer = ReturnType<typeof createFrameRenderer>;
