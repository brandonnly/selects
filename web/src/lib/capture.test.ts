import { describe, expect, test } from "bun:test";
import { captureFields } from "./capture";

const empty = {
  camera: null,
  lens: null,
  focalLength: null,
  exposureTime: null,
  fNumber: null,
  iso: null,
  latitude: null,
  longitude: null,
  capturedAt: null,
};

describe("captureFields", () => {
  test("labels and formats every field a select has", () => {
    expect(
      captureFields({
        camera: "Fixture Optics FX-1",
        lens: "Fixture 35mm F1.4",
        focalLength: 35,
        exposureTime: 0.004,
        fNumber: 2.8,
        iso: 400,
        latitude: 10.5,
        longitude: -40.25,
        capturedAt: "2024-05-01T10:20:30",
      }),
    ).toEqual([
      { label: "Camera", value: "Fixture Optics FX-1" },
      { label: "Lens", value: "Fixture 35mm F1.4" },
      { label: "Focal length", value: "35 mm" },
      { label: "Shutter", value: "1/250 s" },
      { label: "Aperture", value: "ƒ/2.8" },
      { label: "ISO", value: "400" },
      { label: "Coordinates", value: "10.50000, -40.25000" },
      { label: "Taken", value: "2024-05-01 10:20:30" },
    ]);
  });

  test("leaves out the fields a select lacks", () => {
    expect(captureFields({ ...empty, iso: 100 })).toEqual([{ label: "ISO", value: "100" }]);
    expect(captureFields(empty)).toEqual([]);
  });

  test("writes long and odd exposures the way cameras do", () => {
    const shutter = (exposureTime: number) => captureFields({ ...empty, exposureTime })[0]?.value;

    expect(shutter(1 / 3)).toBe("1/3 s");
    expect(shutter(0.5)).toBe("1/2 s");
    expect(shutter(1)).toBe("1 s");
    expect(shutter(2.5)).toBe("2.5 s");
    expect(shutter(30)).toBe("30 s");
    expect(shutter(1 / 8000)).toBe("1/8000 s");
  });

  test("drops needless decimals from focal length and aperture", () => {
    const fields = captureFields({ ...empty, focalLength: 23.5, fNumber: 8 });

    expect(fields).toEqual([
      { label: "Focal length", value: "23.5 mm" },
      { label: "Aperture", value: "ƒ/8" },
    ]);
  });
});
