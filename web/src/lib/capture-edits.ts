import type { CaptureEdits, Select } from "@selects/server";

type Capture = Pick<
  Select,
  | "camera"
  | "lens"
  | "focalLength"
  | "exposureTime"
  | "fNumber"
  | "iso"
  | "latitude"
  | "longitude"
  | "capturedAt"
>;

/** Capture data as typed in the form: one string per input. */
export type Draft = Record<keyof Capture, string>;

export type EditField = keyof CaptureEdits;

/** Capture data written for the form's inputs. A field the select lacks is empty. */
export function draftOf(capture: Capture): Draft {
  const number = (value: number | null) => (value === null ? "" : String(value));
  return {
    camera: capture.camera ?? "",
    lens: capture.lens ?? "",
    focalLength: number(capture.focalLength),
    exposureTime: capture.exposureTime === null ? "" : shutterText(capture.exposureTime),
    fNumber: number(capture.fNumber),
    iso: number(capture.iso),
    latitude: number(capture.latitude),
    longitude: number(capture.longitude),
    capturedAt: capture.capturedAt ?? "",
  };
}

/** 0.004 → "1/250", 0.4 → "1/2.5", 0.3 → "0.3", 2.5 → "2.5". */
function shutterText(seconds: number): string {
  if (seconds < 1) {
    const denominator = Number((1 / seconds).toFixed(1));
    if (Math.abs(1 / denominator - seconds) <= seconds * 1e-9) return `1/${denominator}`;
  }
  return String(seconds);
}

type Parsed<T> = { ok: true; value: T | null } | { ok: false; error: string };

const fail = (error: string) => ({ ok: false, error }) as const;
const ok = <T>(value: T | null) => ({ ok: true, value }) as const;

function parseText(text: string): Parsed<string> {
  const trimmed = text.trim();
  return ok(trimmed === "" ? null : trimmed);
}

function parseDecimal(text: string): number | undefined {
  const cleaned = text.trim().replace(",", ".");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(cleaned)) return undefined;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
}

function parsePositive(text: string, error: string): Parsed<number> {
  if (text.trim() === "") return ok(null);
  const value = parseDecimal(text);
  return value !== undefined && value > 0 ? ok(value) : fail(error);
}

function parseShutter(text: string): Parsed<number> {
  const trimmed = text.trim().replace(/\s*s$/i, "");
  if (trimmed === "") return ok(null);
  const error = "A shutter speed like 1/250 or 2.5.";
  const fraction = /^1\s*\/\s*(.+)$/.exec(trimmed);
  const value = fraction ? parseDecimal(fraction[1] ?? "") : parseDecimal(trimmed);
  if (value === undefined || value <= 0) return fail(error);
  return ok(fraction ? 1 / value : value);
}

function parseIso(text: string): Parsed<number> {
  if (text.trim() === "") return ok(null);
  const value = parseDecimal(text);
  return value !== undefined && Number.isInteger(value) && value >= 1 ? ok(value) : fail("A whole number.");
}

function parseCoordinates(
  latitude: string,
  longitude: string,
): Parsed<{ latitude: number; longitude: number }> {
  if (latitude.trim() === "" && longitude.trim() === "") return ok(null);
  const lat = parseDecimal(latitude);
  const lon = parseDecimal(longitude);
  if (lat === undefined || lon === undefined)
    return fail("Both a latitude and a longitude, in decimal degrees.");
  if (Math.abs(lat) > 90) return fail("Latitude goes from -90 to 90.");
  if (Math.abs(lon) > 180) return fail("Longitude goes from -180 to 180.");
  return ok({ latitude: lat, longitude: lon });
}

function parseCaptureTime(text: string): Parsed<string> {
  const trimmed = text.trim();
  if (trimmed === "") return ok(null);
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/.exec(trimmed);
  const value = match ? `${match[1]}T${match[2]}${match[3] ?? ":00"}` : undefined;
  if (value === undefined || value.startsWith("0000")) return fail("A date and time.");
  const date = new Date(`${value}Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 19) !== value)
    return fail("A date and time.");
  return ok(value);
}

/**
 * The edits a draft makes to the file's capture data: one for each field that reads differently
 * from the file. A field typed wrong keeps its last saved edit, and its error is given.
 */
export function editsFrom(
  draft: Draft,
  file: Capture,
  saved: CaptureEdits,
): { edits: CaptureEdits; errors: Partial<Record<EditField, string>> } {
  const original = draftOf(file);
  const edits: CaptureEdits = {};
  const errors: Partial<Record<EditField, string>> = {};

  const take = <F extends EditField>(field: F, changed: boolean, parsed: Parsed<CaptureEdits[F]>) => {
    if (!parsed.ok) {
      errors[field] = parsed.error;
      if (saved[field] !== undefined) edits[field] = saved[field];
    } else if (changed) {
      edits[field] = parsed.value as CaptureEdits[F];
    }
  };
  const changed = (field: keyof Draft) => draft[field].trim() !== original[field];

  take("camera", changed("camera"), parseText(draft.camera));
  take("lens", changed("lens"), parseText(draft.lens));
  take("focalLength", changed("focalLength"), parsePositive(draft.focalLength, "Millimetres, above 0."));
  take("exposureTime", changed("exposureTime"), parseShutter(draft.exposureTime));
  take("fNumber", changed("fNumber"), parsePositive(draft.fNumber, "An f-number, above 0."));
  take("iso", changed("iso"), parseIso(draft.iso));
  take(
    "coordinates",
    changed("latitude") || changed("longitude"),
    parseCoordinates(draft.latitude, draft.longitude),
  );
  take("capturedAt", changed("capturedAt"), parseCaptureTime(draft.capturedAt));
  return { edits, errors };
}
