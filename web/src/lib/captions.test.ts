import { describe, expect, test } from "bun:test";
import { insertToken, parseTags } from "./captions";

describe("parseTags", () => {
  test("splits on spaces, commas and new lines, adding the # where it was left off", () => {
    expect(parseTags("#film 35mm,  #night\nstreet,")).toEqual(["#film", "#35mm", "#night", "#street"]);
  });

  test("keeps a tag once, and nothing typed is no tags", () => {
    expect(parseTags("#film film #Film")).toEqual(["#film", "#Film"]);
    expect(parseTags("  , ")).toEqual([]);
  });
});

describe("insertToken", () => {
  test("puts the token where the cursor is, replacing a selection, and moves the cursor after it", () => {
    expect(insertToken("Shot on ", { start: 8, end: 8 }, "camera")).toEqual({
      text: "Shot on {camera}",
      cursor: 16,
    });
    expect(insertToken("Shot on X today", { start: 8, end: 9 }, "camera")).toEqual({
      text: "Shot on {camera} today",
      cursor: 16,
    });
  });
});
