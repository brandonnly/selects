import exifr from "exifr";
import sharp, { type Metadata } from "sharp";

/** The formats Selects accepts. Everything else is rejected at ingest. */
export const FORMATS = ["jpeg", "png", "tiff"] as const;
export type Format = (typeof FORMATS)[number];

export const EXTENSIONS: Record<Format, string> = { jpeg: "jpg", png: "png", tiff: "tif" };
export const MIME_TYPES: Record<Format, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  tiff: "image/tiff",
};

/** Capture data read from the file. A field the file lacks is null. */
export type CaptureData = {
  camera: string | null;
  lens: string | null;
  /** Millimetres. */
  focalLength: number | null;
  /** Seconds. */
  exposureTime: number | null;
  fNumber: number | null;
  iso: number | null;
  latitude: number | null;
  longitude: number | null;
  /** Local time as the camera recorded it, with no zone: `YYYY-MM-DDTHH:MM:SS`. */
  capturedAt: string | null;
};

export type Photo = CaptureData & {
  format: Format;
  /** As displayed, after the orientation tag. */
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  /** Perceptual hash of the picture as displayed, 16 hex digits. */
  phash: string;
};

/** Reads a photo file, or returns undefined when it is not a readable JPEG, PNG or TIFF. */
export async function inspectPhoto(path: string): Promise<Photo | undefined> {
  let metadata: Metadata;
  try {
    metadata = await sharp(path).metadata();
  } catch {
    return undefined;
  }
  const format = FORMATS.find((f) => f === metadata.format);
  if (format === undefined) return undefined;

  let phash: string;
  try {
    phash = await perceptualHash(path);
  } catch {
    // The header parsed but the pixels do not decode: a truncated or corrupt file.
    return undefined;
  }

  const file = Bun.file(path);
  return {
    format,
    width: metadata.autoOrient.width,
    height: metadata.autoOrient.height,
    bytes: file.size,
    sha256: await sha256(path),
    phash,
    ...(await readCaptureData(path)),
  };
}

/** Writes a JPEG thumbnail, upright and in sRGB, no larger than 640 px on its long side. */
export async function writeThumbnail(source: string, target: string): Promise<void> {
  await sharp(source)
    .rotate()
    .resize(640, 640, { fit: "inside", withoutEnlargement: true })
    .toColourspace("srgb")
    .jpeg({ quality: 80 })
    .toFile(target);
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

/**
 * A DCT perceptual hash: the low frequencies of a 32 × 32 greyscale copy, each bit set when its
 * coefficient is above the median. Re-exports of one picture at another size or quality land a
 * few bits apart; different pictures land about half the bits apart.
 */
async function perceptualHash(path: string): Promise<string> {
  const size = 32;
  const pixels = await sharp(path)
    .rotate()
    .flatten({ background: "#ffffff" })
    .greyscale()
    .resize(size, size, { fit: "fill" })
    .extractChannel(0)
    .raw()
    .toBuffer();

  const cosines = Array.from({ length: 8 }, (_, u) =>
    Array.from({ length: size }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / (2 * size))),
  );
  const coefficients: number[] = [];
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let y = 0; y < size; y++) {
        const cy = cosines[v]?.[y] ?? 0;
        for (let x = 0; x < size; x++) sum += (pixels[y * size + x] ?? 0) * (cosines[u]?.[x] ?? 0) * cy;
      }
      coefficients.push(sum);
    }
  }
  // The first coefficient is the average brightness: left out of the median, as is usual.
  const sorted = coefficients.slice(1).sort((a, b) => a - b);
  const median = ((sorted[31] ?? 0) + (sorted[32] ?? 0)) / 2;
  let bits = 0n;
  for (const c of coefficients) bits = (bits << 1n) | (c > median ? 1n : 0n);
  return bits.toString(16).padStart(16, "0");
}

/** How many of the 64 bits differ between two perceptual hashes. */
export function hashDistance(a: string, b: string): number {
  let diff = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (diff > 0n) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }
  return count;
}

async function readCaptureData(path: string): Promise<CaptureData> {
  let tags: Record<string, unknown> = {};
  try {
    tags = (await exifr.parse(path, { tiff: true, exif: true, gps: true, reviveValues: false })) ?? {};
  } catch {
    // Unreadable EXIF is the same as none: every field is left off.
  }

  const latitude = finite(tags.latitude);
  const longitude = finite(tags.longitude);
  const hasPosition =
    latitude !== null && longitude !== null && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;

  return {
    camera: cameraName(text(tags.Make), text(tags.Model)),
    lens: text(tags.LensModel),
    focalLength: positive(tags.FocalLength),
    exposureTime: positive(tags.ExposureTime),
    fNumber: positive(tags.FNumber),
    iso: positive(Array.isArray(tags.ISO) ? tags.ISO[0] : tags.ISO),
    latitude: hasPosition ? latitude : null,
    longitude: hasPosition ? longitude : null,
    capturedAt: captureTime(tags.DateTimeOriginal ?? tags.CreateDate),
  };
}

/** "Canon" and "Canon EOS R5" make "Canon EOS R5"; "SONY" and "ILCE-7M3" make "SONY ILCE-7M3". */
function cameraName(make: string | null, model: string | null): string | null {
  if (model === null) return make;
  if (make === null) return model;
  const brand = make.split(/\s+/)[0]?.toLowerCase() ?? "";
  return model.toLowerCase().startsWith(brand) ? model : `${make} ${model}`;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: EXIF strings are padded with NULs.
  const trimmed = value.replace(/\u0000/g, "").trim();
  return trimmed === "" ? null : trimmed;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positive(value: unknown): number | null {
  const number = finite(value);
  return number !== null && number > 0 ? number : null;
}

function captureTime(value: unknown): string | null {
  const match =
    typeof value === "string" && /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  if (year === "0000" || month === "00" || day === "00") return null;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}
