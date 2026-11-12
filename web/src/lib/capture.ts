import type { Select } from "@selects/server";

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

export type CaptureField = { label: string; value: string };

/** A select's capture data as labelled, readable lines. A field the select lacks is left out. */
export function captureFields(capture: Capture): CaptureField[] {
  const fields: (CaptureField | undefined)[] = [
    capture.camera === null ? undefined : { label: "Camera", value: capture.camera },
    capture.lens === null ? undefined : { label: "Lens", value: capture.lens },
    capture.focalLength === null
      ? undefined
      : { label: "Focal length", value: `${decimal(capture.focalLength)} mm` },
    capture.exposureTime === null ? undefined : { label: "Shutter", value: shutter(capture.exposureTime) },
    capture.fNumber === null ? undefined : { label: "Aperture", value: `ƒ/${decimal(capture.fNumber)}` },
    capture.iso === null ? undefined : { label: "ISO", value: String(capture.iso) },
    capture.latitude === null || capture.longitude === null
      ? undefined
      : { label: "Coordinates", value: `${capture.latitude.toFixed(5)}, ${capture.longitude.toFixed(5)}` },
    capture.capturedAt === null ? undefined : { label: "Taken", value: capture.capturedAt.replace("T", " ") },
  ];
  return fields.filter((field) => field !== undefined);
}

/** Up to one decimal place, and none when it is zero. */
function decimal(value: number) {
  return String(Math.round(value * 10) / 10);
}

/** "1/250 s" for a fraction of a second that cameras write that way, "2.5 s" otherwise. */
function shutter(seconds: number) {
  if (seconds < 1) {
    const denominator = 1 / seconds;
    const rounded = Math.round(denominator);
    if (Math.abs(denominator - rounded) < denominator * 0.05) return `1/${rounded} s`;
  }
  return `${decimal(seconds)} s`;
}
