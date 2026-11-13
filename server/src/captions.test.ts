import { describe, expect, test } from "bun:test";
import { buildCaption, type CaptionTemplates, DEFAULT_CAPTION_TEMPLATES } from "./captions";
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

const film = { name: "Film", tags: ["#film", "#35mm"] };
const night = { name: "Night", tags: ["#night", "#longexposure", "#city"] };

const templates = (change: Partial<CaptionTemplates> = {}): CaptionTemplates => ({
  ...DEFAULT_CAPTION_TEMPLATES,
  hashtagSets: [film],
  ...change,
});

describe("buildCaption", () => {
  test("the default caption is coordinates, then gear, then a hashtag set; the default alt text names the date and camera", () => {
    const built = buildCaption({ capture: full, templates: templates(), coordinateFormat: "dms" });

    expect(built.caption).toBe(
      `10°30'00"N 40°15'00"W\nFixture Optics FX-1 · Fixture 35mm F1.4\n\n#film #35mm`,
    );
    expect(built.altText).toBe("Photograph taken on 2024-05-01 with Fixture Optics FX-1");
  });

  test("a hidden location prints no coordinates and leaves no empty line", () => {
    const hidden = { ...full, latitude: null, longitude: null };
    const built = buildCaption({
      capture: hidden,
      templates: templates({ altText: "{camera} · {coordinates} · {date}" }),
      coordinateFormat: "dms",
    });

    expect(built.caption).toBe("Fixture Optics FX-1 · Fixture 35mm F1.4\n\n#film #35mm");
    expect(built.altText).toBe("Fixture Optics FX-1 · 2024-05-01");
    expect(built.caption + built.altText).not.toMatch(/°|10\.5|40\.25/);
  });

  test("a missing field takes its separator with it, at the start, middle or end of a line", () => {
    const line = (capture: CaptureData) =>
      buildCaption({
        capture,
        templates: templates({ caption: "{camera} · {lens} · {focalLength}, {aperture} | {iso}" }),
        coordinateFormat: "dms",
      }).caption;

    expect(line({ ...full, lens: null })).toBe("Fixture Optics FX-1 · 35mm, f/2.8 | ISO 400");
    expect(line({ ...full, camera: null })).toBe("Fixture 35mm F1.4 · 35mm, f/2.8 | ISO 400");
    expect(line({ ...full, iso: null })).toBe("Fixture Optics FX-1 · Fixture 35mm F1.4 · 35mm, f/2.8");
    expect(line({ ...full, lens: null, focalLength: null })).toBe("Fixture Optics FX-1 · f/2.8 | ISO 400");
    expect(line({ ...none, iso: 100 })).toBe("ISO 100");
  });

  test("a line whose every field is missing is left out, with its words and punctuation", () => {
    const built = buildCaption({
      capture: { ...none, camera: "Fixture Optics FX-1" },
      templates: templates({
        caption: "Taken at {coordinates}.\n\nShot on {camera} ({lens})\n\nISO {iso}\n\n\n{hashtags}",
      }),
      coordinateFormat: "dms",
    });

    expect(built.caption).toBe("Shot on Fixture Optics FX-1\n\n#film #35mm");
  });

  test("words in brackets are left out with a field they hold that is missing", () => {
    const build = (capture: CaptureData) =>
      buildCaption({ capture, templates: templates(), coordinateFormat: "dms" }).altText;

    expect(build({ ...full, capturedAt: null })).toBe("Photograph taken with Fixture Optics FX-1");
    expect(build({ ...full, camera: null })).toBe("Photograph taken on 2024-05-01");
    expect(build(none)).toBe("");
  });

  test("brackets without a field in them print as written", () => {
    const built = buildCaption({
      capture: full,
      templates: templates({ caption: "[sic] {iso}" }),
      coordinateFormat: "dms",
    });

    expect(built.caption).toBe("[sic] ISO 400");
  });

  test("with no capture data at all, the default caption is only the hashtags", () => {
    const built = buildCaption({ capture: none, templates: templates(), coordinateFormat: "dms" });

    expect(built.caption).toBe("#film #35mm");
  });

  test("coordinates print as decimal degrees when the frame does", () => {
    const built = buildCaption({ capture: full, templates: templates(), coordinateFormat: "decimal" });

    expect(built.caption.split("\n")[0]).toBe("10.5000, -40.2500");
  });
});
