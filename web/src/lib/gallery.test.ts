import { describe, expect, test } from "bun:test";
import { describeGallery } from "./gallery";

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
