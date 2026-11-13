import { describe, expect, test } from "bun:test";
import { describeGallery, galleryPolling, gallerySwitch, postName } from "./gallery";

describe("a post's gallery state in words", () => {
  test("says when it is listed, and offers removal", () => {
    expect(describeGallery({ state: "listed", error: null }, "fake")).toEqual({
      label: "In the gallery",
      detail: null,
      removable: true,
    });
  });

  test("gives the reason a write is being retried", () => {
    expect(
      describeGallery({ state: "writing", error: "The bucket refused to store the object." }, "fake"),
    ).toEqual({
      label: "Writing to the gallery…",
      detail: "The bucket refused to store the object. Selects tries again.",
      removable: true,
    });
  });

  test("offers no removal once it is gone or going", () => {
    expect(describeGallery({ state: "removing", error: null }, "fake").removable).toBe(false);
    expect(describeGallery({ state: "removed", error: null }, "fake")).toEqual({
      label: "Removed from the gallery",
      detail: null,
      removable: false,
    });
  });

  test("offers no removal of a post whose files are in the other mode's bucket", () => {
    const described = describeGallery({ state: "listed", error: null, mode: "live" }, "fake");
    expect(described.removable).toBe(false);
    expect(described.detail).toContain("live mode");
  });
});

describe("the gallery switch", () => {
  test("is on and can be turned on or off while gallery output is available", () => {
    expect(gallerySwitch({ enabled: true, availability: { available: true, manifestUrl: "x" } })).toEqual({
      checked: true,
      disabled: false,
    });
    expect(gallerySwitch({ enabled: false, availability: { available: true, manifestUrl: "x" } })).toEqual({
      checked: false,
      disabled: false,
    });
  });

  test("shows a saved on while unavailable, and lets it be turned off", () => {
    expect(gallerySwitch({ enabled: true, availability: { available: false, reason: "No URL." } })).toEqual({
      checked: true,
      disabled: false,
    });
  });

  test("cannot be turned on while unavailable", () => {
    expect(gallerySwitch({ enabled: false, availability: { available: false, reason: "No URL." } })).toEqual({
      checked: false,
      disabled: true,
    });
  });
});

describe("how soon the Posted screen checks the gallery again", () => {
  test("soon while a write or a removal is under way, as it finishes in seconds", () => {
    expect(galleryPolling([{ state: "removing", error: null }])).toBe("soon");
    expect(
      galleryPolling([
        { state: "listed", error: null },
        { state: "writing", error: null },
      ]),
    ).toBe("soon");
  });

  test("later while one is being retried, and not at all once everything is settled", () => {
    expect(galleryPolling([{ state: "removing", error: "The bucket refused." }])).toBe("later");
    expect(
      galleryPolling([
        { state: "listed", error: null },
        { state: "removed", error: null },
      ]),
    ).toBeUndefined();
    expect(galleryPolling([])).toBeUndefined();
  });
});

describe("a post's name for a screen reader", () => {
  test("gives its time and the start of its caption, so posts of the same minute differ", () => {
    expect(postName("Nov 13, 9:00 AM", "Fixture Optics FX-1 · Fixture 35mm F1.4\n#film")).toBe(
      "post of Nov 13, 9:00 AM, “Fixture Optics FX-1 · Fixture 35mm F1.4”",
    );
    expect(postName("Nov 13, 9:00 AM", `${"A long first line ".repeat(5)}`)).toBe(
      "post of Nov 13, 9:00 AM, “A long first line A long first line A lo…”",
    );
  });

  test("gives its time alone for a post with no caption", () => {
    expect(postName("Nov 13, 9:00 AM", "  \n")).toBe("post of Nov 13, 9:00 AM");
  });
});
