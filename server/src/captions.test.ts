import { describe, expect, test } from "bun:test";
import {
  buildCaption,
  type CaptionTemplates,
  checkCaption,
  checkTemplates,
  DEFAULT_CAPTION_TEMPLATES,
} from "./captions";
import type { PublishedCapture } from "./capture";

const full = {
  camera: "Fixture Optics FX-1",
  lens: "Fixture 35mm F1.4",
  focalLength: 35,
  exposureTime: 1 / 250,
  fNumber: 2.8,
  iso: 400,
  latitude: 10.5,
  longitude: -40.25,
  capturedAt: "2024-05-01T10:20:30",
} as PublishedCapture;

const none = {
  camera: null,
  lens: null,
  focalLength: null,
  exposureTime: null,
  fNumber: null,
  iso: null,
  latitude: null,
  longitude: null,
  capturedAt: null,
} as PublishedCapture;

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
    const line = (capture: PublishedCapture) =>
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

  test("a field in brackets that is present keeps its line when the fields outside are missing", () => {
    const built = buildCaption({
      capture: { ...full, latitude: null, longitude: null },
      templates: templates({ caption: "{coordinates} [shot on {camera}]" }),
      coordinateFormat: "dms",
    });
    expect(built.caption).toBe("shot on Fixture Optics FX-1");
  });

  test("brackets left to open a line drop the separator they began with", () => {
    const built = buildCaption({
      capture: { ...full, camera: null },
      templates: templates({ caption: "{camera}[ · {iso}]" }),
      coordinateFormat: "dms",
    });
    expect(built.caption).toBe("ISO 400");
  });

  test("hashtags can be in the caption once", () => {
    expect(checkTemplates(templates({ caption: "{hashtags} {hashtags}" })).problems).toEqual([
      "The caption can have {hashtags} once.",
    ]);
  });

  test("a mark that opens a line goes with a missing first field", () => {
    const caption = (capture: PublishedCapture) =>
      buildCaption({
        capture,
        templates: templates({ caption: "\u{1f4cd} {coordinates} · {camera}" }),
        coordinateFormat: "dms",
      }).caption;

    expect(caption({ ...full, latitude: null, longitude: null })).toBe("Fixture Optics FX-1");
    expect(caption(full)).toStartWith("\u{1f4cd} 10");
  });

  test("words in brackets are left out with a field they hold that is missing", () => {
    const build = (capture: PublishedCapture) =>
      buildCaption({ capture, templates: templates(), coordinateFormat: "dms" }).altText;

    expect(build({ ...full, capturedAt: null })).toBe("Photograph taken with Fixture Optics FX-1");
    expect(build({ ...full, camera: null })).toBe("Photograph taken on 2024-05-01");
    expect(build(none)).toBe("Photograph taken");
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

  test("one hashtag set is chosen at random for each caption", () => {
    const withSets = templates({ hashtagSets: [film, night] });
    const build = (random: () => number) =>
      buildCaption({ capture: none, templates: withSets, coordinateFormat: "dms", random });

    expect(build(() => 0)).toMatchObject({ caption: "#film #35mm", hashtagSet: "Film" });
    expect(build(() => 0.49)).toMatchObject({ caption: "#film #35mm", hashtagSet: "Film" });
    expect(build(() => 0.5)).toMatchObject({ caption: "#night #longexposure #city", hashtagSet: "Night" });
    expect(build(() => 0.999)).toMatchObject({ hashtagSet: "Night" });
  });

  test("by default the choice is random, and reaches every set", () => {
    const chosen = new Set(
      Array.from(
        { length: 200 },
        () =>
          buildCaption({
            capture: none,
            templates: templates({ hashtagSets: [film, night] }),
            coordinateFormat: "dms",
          }).hashtagSet,
      ),
    );

    expect(chosen).toEqual(new Set(["Film", "Night"]));
  });

  test("a named set can be asked for, as a preview does", () => {
    const built = buildCaption({
      capture: none,
      templates: templates({ hashtagSets: [film, night] }),
      coordinateFormat: "dms",
      hashtagSet: "Night",
      random: () => 0,
    });

    expect(built).toMatchObject({ caption: "#night #longexposure #city", hashtagSet: "Night" });
  });

  test("with no hashtag sets, the hashtags line is left out", () => {
    const built = buildCaption({
      capture: full,
      templates: templates({ hashtagSets: [] }),
      coordinateFormat: "dms",
    });

    expect(built).toMatchObject({
      caption: `10°30'00"N 40°15'00"W\nFixture Optics FX-1 · Fixture 35mm F1.4`,
      hashtagSet: null,
    });
  });

  test("a caption or alt text written for a select replaces the template for it, as written", () => {
    const build = (override: { caption: string | null; altText: string | null }) =>
      buildCaption({ capture: full, templates: templates(), coordinateFormat: "dms", override });

    expect(build({ caption: "Low tide, {camera}.\n#sea", altText: null })).toMatchObject({
      caption: "Low tide, {camera}.\n#sea",
      altText: "Photograph taken on 2024-05-01 with Fixture Optics FX-1",
      hashtagSet: null,
    });
    expect(build({ caption: null, altText: "A pier at dusk." })).toMatchObject({
      caption: `10°30'00"N 40°15'00"W\nFixture Optics FX-1 · Fixture 35mm F1.4\n\n#film #35mm`,
      altText: "A pier at dusk.",
      hashtagSet: "Film",
    });
  });

  test("no hashtag set is reported as chosen when the caption has no hashtags token", () => {
    const built = buildCaption({
      capture: full,
      templates: templates({ caption: "{camera}" }),
      coordinateFormat: "dms",
    });

    expect(built).toMatchObject({ caption: "Fixture Optics FX-1", hashtagSet: null });
  });
});

const tags = (count: number) => Array.from({ length: count }, (_, i) => `#tag${i}`);

describe("checkCaption", () => {
  test("counts characters, hashtags and @ tags, and finds nothing wrong well within the limits", () => {
    expect(checkCaption({ caption: "Dawn. #film #35mm @fixture", altText: "A pier." })).toEqual({
      captionCharacters: 26,
      hashtags: 2,
      mentions: 1,
      altTextCharacters: 7,
      warnings: [],
      problems: [],
    });
  });

  test("counts characters as UTF-16 units, as JavaScript does, so an emoji counts twice", () => {
    expect(checkCaption({ caption: "🌊é", altText: "" }).captionCharacters).toBe(3);
  });

  test("warns from 90% of a limit and refuses past it", () => {
    const at = (caption: string, altText = "") => checkCaption({ caption, altText });

    expect(at("a".repeat(1979)).warnings).toEqual([]);
    expect(at("a".repeat(1980)).warnings).toEqual([
      "The caption is 1,980 characters, near Instagram's limit of 2,200.",
    ]);
    expect(at("a".repeat(2200)).problems).toEqual([]);
    expect(at("a".repeat(2201)).problems).toEqual([
      "The caption is 2,201 characters, over Instagram's limit of 2,200.",
    ]);

    expect(at(tags(26).join(" ")).warnings).toEqual([]);
    expect(at(tags(27).join(" ")).warnings).toEqual([
      "The caption has 27 hashtags, near Instagram's limit of 30.",
    ]);
    expect(at(tags(30).join(" ")).problems).toEqual([]);
    expect(at(tags(31).join(" ")).problems).toEqual([
      "The caption has 31 hashtags, over Instagram's limit of 30.",
    ]);

    expect(at("@a ".repeat(21)).problems).toEqual([
      "The caption has 21 @ tags, over Instagram's limit of 20.",
    ]);
    expect(at("", "a".repeat(1001)).problems).toEqual([
      "The alt text is 1,001 characters, over Instagram's limit of 1,000.",
    ]);
  });
});

describe("checkTemplates", () => {
  test("the defaults are fine", () => {
    expect(checkTemplates(DEFAULT_CAPTION_TEMPLATES)).toEqual({ problems: [], warnings: [] });
  });

  test("measures the longest caption the templates can make: the longest values and the biggest set", () => {
    const big = { name: "Big", tags: tags(28) };
    const check = checkTemplates(templates({ hashtagSets: [film, big] }));

    expect(check.warnings).toEqual(["The caption can have up to 28 hashtags, near Instagram's limit of 30."]);
    const over = checkTemplates(
      templates({ caption: `${"a".repeat(2110)} {camera} {lens}`, hashtagSets: [] }),
    );
    expect(over.problems).toEqual([
      "The caption can be up to 2,304 characters, over Instagram's limit of 2,200.",
    ]);
  });

  test("refuses a token that does not exist, and hashtags in alt text", () => {
    expect(
      checkTemplates(templates({ caption: "{camera} {flash}", altText: "{hashtags}" })).problems,
    ).toEqual(["{flash} in the caption isn't a token.", "{hashtags} in the alt text isn't a token."]);
  });

  test("refuses a hashtag set without a name, with a name used twice, or with a tag Instagram won't link", () => {
    const check = checkTemplates(
      templates({
        hashtagSets: [
          { name: " ", tags: ["#a"] },
          { name: "Film", tags: ["#a"] },
          { name: "Film", tags: ["#b"] },
          { name: "Bad", tags: ["#two words", "nohash", "#ok_1", "#é"] },
        ],
      }),
    );

    expect(check.problems).toEqual([
      "A hashtag set needs a name.",
      "There are two hashtag sets named Film.",
      "#two words in Bad isn't a hashtag.",
      "nohash in Bad isn't a hashtag.",
    ]);
  });
});
