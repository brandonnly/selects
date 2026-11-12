/**
 * Generates the fixture photos that tests, development and screenshots use, so no real
 * photograph is ever in the repo. Every picture is a synthetic scene, and every coordinate is
 * invented open ocean.
 *
 * Run `bun run fixtures [dir]` to write them to a folder (default `.tmp/fixtures`).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";

export type Exif = {
  make?: string;
  model?: string;
  lens?: string;
  /** Millimetres. */
  focalLength?: number;
  /** Seconds, as a fraction: `[1, 250]` is 1/250 s. */
  exposureTime?: [number, number];
  fNumber?: number;
  iso?: number;
  /** As the camera writes it: `YYYY:MM:DD HH:MM:SS`. */
  capturedAt?: string;
  latitude?: number;
  longitude?: number;
  /** EXIF orientation, 1 to 8. */
  orientation?: number;
};

export type PhotoOptions = {
  /** Picks the scene. The same scene at any size is the same picture. */
  scene: number;
  /** Pixel size as stored in the file, before any orientation tag. */
  width: number;
  height: number;
  format: "jpeg" | "png" | "tiff" | "webp";
  /** JPEG quality. Default 90. */
  quality?: number;
  exif?: Exif;
};

/** Renders a synthetic photo with the given EXIF and returns the file's bytes. */
export async function makePhoto({ scene, width, height, format, quality = 90, exif }: PhotoOptions) {
  const pixels = paintScene(scene, width, height);
  const image = sharp(pixels, { raw: { width, height, channels: 3 } });
  const block = exif === undefined ? undefined : exifTiff(exif);

  switch (format) {
    case "jpeg": {
      const jpeg = await image.jpeg({ quality }).toBuffer();
      return block === undefined ? jpeg : insertJpegExif(jpeg, block);
    }
    case "png": {
      const png = await image.png().toBuffer();
      return block === undefined ? png : insertPngExif(png, block);
    }
    case "tiff":
      return exifTiff(exif ?? {}, { width, height, pixels });
    case "webp":
      return image.webp().toBuffer();
  }
}

const portraitExif: Exif = {
  make: "Fixture Optics",
  model: "FX-1",
  lens: "Fixture 35mm F1.4",
  focalLength: 35,
  exposureTime: [1, 250],
  fNumber: 2.8,
  iso: 400,
  capturedAt: "2024:05:01 10:20:30",
  latitude: 10.5,
  longitude: -40.25,
};

/** Every fixture, by name. */
export const fixtures = {
  /** JPEG, 800 × 1000, full EXIF with GPS. */
  portrait: {
    file: "portrait.jpg",
    photo: { scene: 1, width: 800, height: 1000, format: "jpeg", exif: portraitExif },
  },
  /** The portrait exported again: smaller, lower quality, same capture time. */
  portraitReexport: {
    file: "portrait-reexport.jpg",
    photo: { scene: 1, width: 640, height: 800, format: "jpeg", quality: 72, exif: portraitExif },
  },
  /** TIFF, 1200 × 800, full EXIF with GPS in the southern and eastern hemispheres. */
  landscape: {
    file: "landscape.tif",
    photo: {
      scene: 2,
      width: 1200,
      height: 800,
      format: "tiff",
      exif: {
        make: "Fixture Optics",
        model: "Fixture FX-2",
        lens: "Fixture 24-70mm F2.8",
        focalLength: 24,
        exposureTime: [1, 1000],
        fNumber: 8,
        iso: 100,
        capturedAt: "2023:11:18 07:45:12",
        latitude: -35.125,
        longitude: 165.75,
      },
    },
  },
  /** PNG, 900 × 900, EXIF without GPS. */
  square: {
    file: "square.png",
    photo: {
      scene: 3,
      width: 900,
      height: 900,
      format: "png",
      exif: {
        make: "Fixture Optics",
        model: "FX-1",
        lens: "Fixture 50mm F2",
        focalLength: 50,
        exposureTime: [1, 60],
        fNumber: 2,
        iso: 3200,
        capturedAt: "2022:08:09 18:02:44",
      },
    },
  },
  /** JPEG stored as 1000 × 800 with orientation 6, so it shows as an 800 × 1000 portrait. */
  rotated: {
    file: "rotated.jpg",
    photo: {
      scene: 4,
      width: 1000,
      height: 800,
      format: "jpeg",
      exif: {
        make: "Fixture Optics",
        model: "FX-1",
        exposureTime: [1, 2],
        fNumber: 16,
        iso: 64,
        capturedAt: "2021:02:14 21:30:05",
        orientation: 6,
      },
    },
  },
  /** JPEG with no metadata at all. */
  noExif: { file: "no-exif.jpg", photo: { scene: 5, width: 700, height: 700, format: "jpeg" } },
  /** An image in a format Selects does not accept. */
  webp: { file: "unsupported.webp", photo: { scene: 6, width: 400, height: 300, format: "webp" } },
  /** Not an image at all. */
  text: { file: "notes.txt", text: "Not a photo.\n" },
} satisfies Record<string, { file: string; photo: PhotoOptions } | { file: string; text: string }>;

export type FixtureName = keyof typeof fixtures;

/** Writes every fixture into `dir` and returns each one's path. */
export async function generateFixtures(dir: string): Promise<Record<FixtureName, string>> {
  mkdirSync(dir, { recursive: true });
  const entries = await Promise.all(
    Object.entries(fixtures).map(async ([name, fixture]) => {
      const path = join(dir, fixture.file);
      writeFileSync(path, "text" in fixture ? fixture.text : await makePhoto(fixture.photo as PhotoOptions));
      return [name, path] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<FixtureName, string>;
}

// ---------------------------------------------------------------------------------------------
// Scenes: a sky, a sun and two ridges of hills, laid out in relative units so a scene keeps its
// look at any size. The seed varies the colors and the layout.

function paintScene(seed: number, width: number, height: number): Buffer {
  const random = mulberry32(seed);
  const pick = () => random();
  const skyTop = [40 + pick() * 60, 70 + pick() * 80, 140 + pick() * 100];
  const skyBottom = [200 + pick() * 55, 150 + pick() * 80, 100 + pick() * 90];
  const sun = { x: 0.2 + pick() * 0.6, y: 0.15 + pick() * 0.3, r: 0.06 + pick() * 0.08 };
  const ridges = [0, 1].map((i) => ({
    base: 0.55 + i * 0.15 + pick() * 0.05,
    amplitude: 0.05 + pick() * 0.08,
    frequency: 1.5 + pick() * 4,
    phase: pick() * Math.PI * 2,
    color: [30 + pick() * 60 - i * 20, 60 + pick() * 70 - i * 30, 30 + pick() * 50 - i * 20],
  }));

  const pixels = Buffer.alloc(width * height * 3);
  const aspect = width / height;
  for (let y = 0; y < height; y++) {
    const v = y / height;
    for (let x = 0; x < width; x++) {
      const u = x / width;
      let color = skyTop.map((top, c) => top + ((skyBottom[c] ?? 0) - top) * v);
      const dx = (u - sun.x) * aspect;
      const dy = v - sun.y;
      if (dx * dx + dy * dy < sun.r * sun.r) color = [255, 236, 190];
      for (const ridge of ridges) {
        const top = ridge.base - ridge.amplitude * Math.sin(u * ridge.frequency * Math.PI + ridge.phase);
        if (v > top) color = ridge.color.map((c) => c * (1 - (v - top) * 0.6));
      }
      const offset = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) pixels[offset + c] = Math.max(0, Math.min(255, Math.round(color[c] ?? 0)));
    }
  }
  return pixels;
}

function mulberry32(seed: number) {
  let state = seed * 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// A small EXIF writer. sharp cannot write EXIF into a TIFF or set the orientation tag freely,
// so the fixtures carry a TIFF-structured EXIF block written here: as an APP1 segment in a
// JPEG, an eXIf chunk in a PNG, and as the TIFF file itself.

type Entry =
  | { tag: number; type: "ascii"; value: string }
  | { tag: number; type: "short" | "long"; value: number[] }
  | { tag: number; type: "rational"; value: [number, number][] };

const TYPE_CODE = { ascii: 2, short: 3, long: 4, rational: 5 } as const;
const TYPE_SIZE = { ascii: 1, short: 2, long: 4, rational: 8 } as const;

function exifEntries(exif: Exif) {
  const ifd0: Entry[] = [];
  const sub: Entry[] = [];
  const gps: Entry[] = [];
  if (exif.make !== undefined) ifd0.push({ tag: 0x010f, type: "ascii", value: exif.make });
  if (exif.model !== undefined) ifd0.push({ tag: 0x0110, type: "ascii", value: exif.model });
  if (exif.orientation !== undefined) ifd0.push({ tag: 0x0112, type: "short", value: [exif.orientation] });
  if (exif.exposureTime !== undefined)
    sub.push({ tag: 0x829a, type: "rational", value: [exif.exposureTime] });
  if (exif.fNumber !== undefined)
    sub.push({ tag: 0x829d, type: "rational", value: [fraction(exif.fNumber)] });
  if (exif.iso !== undefined) sub.push({ tag: 0x8827, type: "short", value: [exif.iso] });
  if (exif.capturedAt !== undefined) sub.push({ tag: 0x9003, type: "ascii", value: exif.capturedAt });
  if (exif.focalLength !== undefined)
    sub.push({ tag: 0x920a, type: "rational", value: [fraction(exif.focalLength)] });
  if (exif.lens !== undefined) sub.push({ tag: 0xa434, type: "ascii", value: exif.lens });
  if (exif.latitude !== undefined && exif.longitude !== undefined) {
    gps.push(
      { tag: 0x0001, type: "ascii", value: exif.latitude < 0 ? "S" : "N" },
      { tag: 0x0002, type: "rational", value: degreesMinutesSeconds(exif.latitude) },
      { tag: 0x0003, type: "ascii", value: exif.longitude < 0 ? "W" : "E" },
      { tag: 0x0004, type: "rational", value: degreesMinutesSeconds(exif.longitude) },
    );
  }
  return { ifd0, sub, gps };
}

function fraction(value: number): [number, number] {
  return [Math.round(value * 1000), 1000];
}

function degreesMinutesSeconds(decimal: number): [number, number][] {
  const abs = Math.abs(decimal);
  const degrees = Math.floor(abs);
  const minutes = Math.floor((abs - degrees) * 60);
  const seconds = (abs - degrees - minutes / 60) * 3600;
  return [
    [degrees, 1],
    [minutes, 1],
    [Math.round(seconds * 1000), 1000],
  ];
}

/**
 * A little-endian TIFF structure holding the EXIF. With `image`, it is a whole uncompressed RGB
 * TIFF file; without, it is the block that goes inside a JPEG or PNG.
 */
function exifTiff(exif: Exif, image?: { width: number; height: number; pixels: Buffer }): Buffer {
  const { ifd0, sub, gps } = exifEntries(exif);
  if (image !== undefined) {
    ifd0.push(
      { tag: 0x0100, type: "long", value: [image.width] },
      { tag: 0x0101, type: "long", value: [image.height] },
      { tag: 0x0102, type: "short", value: [8, 8, 8] },
      { tag: 0x0103, type: "short", value: [1] },
      { tag: 0x0106, type: "short", value: [2] },
      { tag: 0x0111, type: "long", value: [0] }, // strip offset, set once the layout is known
      { tag: 0x0115, type: "short", value: [3] },
      { tag: 0x0116, type: "long", value: [image.height] },
      { tag: 0x0117, type: "long", value: [image.pixels.length] },
      { tag: 0x011c, type: "short", value: [1] },
    );
  }
  if (sub.length > 0) ifd0.push({ tag: 0x8769, type: "long", value: [0] });
  if (gps.length > 0) ifd0.push({ tag: 0x8825, type: "long", value: [0] });

  const ifds = [ifd0, sub, gps].filter((ifd) => ifd.length > 0);
  for (const ifd of ifds) ifd.sort((a, b) => a.tag - b.tag);

  // Values over four bytes live after the IFDs, each padded to an even offset.
  const outOfLine = (entry: Entry) => {
    const size = valueBytes(entry).length;
    return size > 4 ? size + (size % 2) : 0;
  };
  const ifdOffsets: number[] = [];
  let cursor = 8;
  for (const ifd of ifds) {
    ifdOffsets.push(cursor);
    cursor += 2 + ifd.length * 12 + 4;
  }
  const dataStart = cursor;
  for (const entry of ifds.flat()) cursor += outOfLine(entry);
  const stripOffset = cursor;

  const setPointer = (tag: number, value: number) => {
    const entry = ifd0.find((e) => e.tag === tag);
    if (entry !== undefined && entry.type === "long") entry.value = [value];
  };
  const subIndex = ifds.indexOf(sub);
  const gpsIndex = ifds.indexOf(gps);
  if (subIndex >= 0) setPointer(0x8769, ifdOffsets[subIndex] ?? 0);
  if (gpsIndex >= 0) setPointer(0x8825, ifdOffsets[gpsIndex] ?? 0);
  setPointer(0x0111, stripOffset);

  const out = Buffer.alloc(stripOffset + (image?.pixels.length ?? 0));
  out.write("II", 0, "ascii");
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(8, 4);
  let data = dataStart;
  ifds.forEach((ifd, index) => {
    let at = ifdOffsets[index] ?? 0;
    out.writeUInt16LE(ifd.length, at);
    at += 2;
    for (const entry of ifd) {
      const bytes = valueBytes(entry);
      out.writeUInt16LE(entry.tag, at);
      out.writeUInt16LE(TYPE_CODE[entry.type], at + 2);
      out.writeUInt32LE(bytes.length / TYPE_SIZE[entry.type], at + 4);
      if (bytes.length <= 4) bytes.copy(out, at + 8);
      else {
        out.writeUInt32LE(data, at + 8);
        bytes.copy(out, data);
        data += bytes.length + (bytes.length % 2);
      }
      at += 12;
    }
    out.writeUInt32LE(0, at); // no next IFD
  });
  image?.pixels.copy(out, stripOffset);
  return out;
}

function valueBytes(entry: Entry): Buffer {
  switch (entry.type) {
    case "ascii":
      return Buffer.from(`${entry.value}\0`, "latin1");
    case "short": {
      const bytes = Buffer.alloc(entry.value.length * 2);
      entry.value.forEach((v, i) => {
        bytes.writeUInt16LE(v, i * 2);
      });
      return bytes;
    }
    case "long": {
      const bytes = Buffer.alloc(entry.value.length * 4);
      entry.value.forEach((v, i) => {
        bytes.writeUInt32LE(v, i * 4);
      });
      return bytes;
    }
    case "rational": {
      const bytes = Buffer.alloc(entry.value.length * 8);
      entry.value.forEach(([numerator, denominator], i) => {
        bytes.writeUInt32LE(numerator, i * 8);
        bytes.writeUInt32LE(denominator, i * 8 + 4);
      });
      return bytes;
    }
  }
}

/** Puts the EXIF block in an APP1 segment straight after the JPEG's start-of-image marker. */
function insertJpegExif(jpeg: Buffer, block: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), block]);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)]);
}

/** Puts the EXIF block in an eXIf chunk straight after the PNG's IHDR chunk. */
function insertPngExif(png: Buffer, block: Buffer): Buffer {
  const ihdrEnd = 8 + 4 + 4 + png.readUInt32BE(8) + 4;
  const type = Buffer.from("eXIf", "latin1");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(block.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(Bun.hash.crc32(Buffer.concat([type, block])), 0);
  return Buffer.concat([png.subarray(0, ihdrEnd), length, type, block, crc, png.subarray(ihdrEnd)]);
}

if (import.meta.main) {
  const dir = resolve(process.argv[2] ?? ".tmp/fixtures");
  const written = await generateFixtures(dir);
  for (const path of Object.values(written)) console.log(path);
}
