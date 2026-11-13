import { describe, expect, test } from "bun:test";
import type { FrameSettings } from "@selects/server";
import { debounce, previewUrl } from "./frame";

const settings: FrameSettings = {
  border: 96,
  color: "dark",
  typeface: "space-mono",
  fields: {
    camera: true,
    lens: false,
    focalLength: true,
    shutter: true,
    aperture: false,
    iso: true,
    coordinates: true,
    date: false,
  },
  coordinateFormat: "decimal",
};

describe("previewUrl", () => {
  test("asks for the select's frame at the given width with every setting spelled out", () => {
    const url = new URL(previewUrl("abc-123", settings, 600), "http://selects.test");

    expect(url.pathname).toBe("/api/selects/abc-123/frame");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      width: "600",
      border: "96",
      color: "dark",
      typeface: "space-mono",
      fields: "camera,focalLength,shutter,iso,coordinates",
      coordinateFormat: "decimal",
    });
  });

  test("sends an empty field list when every field is off", () => {
    const none = Object.fromEntries(Object.keys(settings.fields).map((f) => [f, false]));
    const url = new URL(
      previewUrl("abc", { ...settings, fields: none as FrameSettings["fields"] }, 600),
      "http://selects.test",
    );

    expect(url.searchParams.get("fields")).toBe("");
  });
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("debounce", () => {
  test("runs once, with the last arguments, after the calls stop", async () => {
    const calls: number[] = [];
    const debounced = debounce((value: number) => calls.push(value), 30);

    debounced(1);
    await wait(10);
    debounced(2);
    await wait(10);
    debounced(3);
    expect(calls).toEqual([]);

    await wait(60);
    expect(calls).toEqual([3]);
  });

  test("runs again for calls after a quiet period", async () => {
    const calls: number[] = [];
    const debounced = debounce((value: number) => calls.push(value), 20);

    debounced(1);
    await wait(50);
    debounced(2);
    await wait(50);

    expect(calls).toEqual([1, 2]);
  });

  test("a cancelled call never runs", async () => {
    const calls: number[] = [];
    const debounced = debounce((value: number) => calls.push(value), 20);

    debounced(1);
    debounced.cancel();
    await wait(50);

    expect(calls).toEqual([]);
  });
});
