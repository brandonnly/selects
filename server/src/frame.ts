import type { CaptureData } from "./photo";
import type { TypefaceId } from "./typefaces";

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
  const values: Record<FrameField, string | null> = {
    camera: capture.camera,
    lens: capture.lens,
    focalLength: capture.focalLength === null ? null : `${decimals(capture.focalLength, 1)}mm`,
    shutter: capture.exposureTime === null ? null : shutterSpeed(capture.exposureTime),
    aperture: capture.fNumber === null ? null : `f/${decimals(capture.fNumber, 1)}`,
    iso: capture.iso === null ? null : `ISO ${Math.round(capture.iso)}`,
    coordinates:
      capture.latitude === null || capture.longitude === null
        ? null
        : coordinates(capture.latitude, capture.longitude, settings.coordinateFormat),
    date: capture.capturedAt?.slice(0, 10) ?? null,
  };
  return FRAME_FIELDS.filter((field) => settings.fields[field])
    .map((field) => values[field])
    .filter((value): value is string => value !== null && value !== "")
    .join(SEPARATOR);
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
