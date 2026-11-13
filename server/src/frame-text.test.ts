import { describe, expect, test } from "bun:test";
import { DEFAULT_FRAME_SETTINGS, type FrameSettings, frameText } from "./frame";
import type { CaptureData } from "./photo";

const full: CaptureData = {
  camera: "Fixture Optics FX-1",
  lens: "Fixture 35mm F1.4",
  focalLength: 35,
  exposureTime: 1 / 250,
  fNumber: 2.8,
  iso: 400,
  latitude: 10.5,
  longitude: -40.25,
  capturedAt: "2024-05-01T10:20:30",
};

const none: CaptureData = {
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

const settings = (change: Partial<FrameSettings> = {}): FrameSettings => ({
  ...DEFAULT_FRAME_SETTINGS,
  ...change,
});

describe("frameText", () => {
  test("prints every field by default, in one line", () => {
    expect(frameText(full, settings())).toBe(
      `Fixture Optics FX-1 · Fixture 35mm F1.4 · 35mm · 1/250s · f/2.8 · ISO 400 · 10°30'00"N 40°15'00"W · 2024-05-01`,
    );
  });

  test("a field missing from the file leaves no gap", () => {
    expect(frameText({ ...full, lens: null, iso: null }, settings())).toBe(
      `Fixture Optics FX-1 · 35mm · 1/250s · f/2.8 · 10°30'00"N 40°15'00"W · 2024-05-01`,
    );
    expect(frameText({ ...none, fNumber: 8 }, settings())).toBe("f/8");
    expect(frameText(none, settings())).toBe("");
  });

  test("a field switched off leaves no gap", () => {
    const fields = { ...DEFAULT_FRAME_SETTINGS.fields, camera: false, shutter: false, date: false };
    expect(frameText(full, settings({ fields }))).toBe(
      `Fixture 35mm F1.4 · 35mm · f/2.8 · ISO 400 · 10°30'00"N 40°15'00"W`,
    );
  });

  test("coordinates print as degrees, minutes and seconds with their hemispheres", () => {
    const only = { ...none, latitude: -35.125, longitude: 165.75 };
    expect(frameText(only, settings())).toBe(`35°07'30"S 165°45'00"E`);
  });

  test("seconds that round up to a minute carry over", () => {
    const only = { ...none, latitude: 10.99999, longitude: 0.0001 };
    expect(frameText(only, settings())).toBe(`11°00'00"N 0°00'00"E`);
  });

  test("coordinates print as decimal degrees when set", () => {
    const only = { ...none, latitude: -35.125, longitude: 165.75 };
    expect(frameText(only, settings({ coordinateFormat: "decimal" }))).toBe("-35.1250, 165.7500");
  });

  test("a coordinate needs both halves", () => {
    expect(frameText({ ...none, latitude: 10.5 }, settings())).toBe("");
  });

  test("shutter speeds read as a photographer writes them", () => {
    const shutter = (exposureTime: number) => frameText({ ...none, exposureTime }, settings());
    expect(shutter(1 / 8000)).toBe("1/8000s");
    expect(shutter(1 / 60)).toBe("1/60s");
    expect(shutter(0.5)).toBe("1/2s");
    expect(shutter(0.4)).toBe("1/2.5s");
    expect(shutter(1)).toBe("1s");
    expect(shutter(2.5)).toBe("2.5s");
    expect(shutter(30)).toBe("30s");
  });

  test("focal length and aperture drop needless decimals", () => {
    expect(frameText({ ...none, focalLength: 24, fNumber: 8 }, settings())).toBe("24mm · f/8");
    expect(frameText({ ...none, focalLength: 4.25, fNumber: 1.4 }, settings())).toBe("4.3mm · f/1.4");
  });
});
