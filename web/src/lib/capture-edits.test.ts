import { describe, expect, test } from "bun:test";
import { draftOf, editsFrom } from "./capture-edits";

const file = {
  camera: "Fixture Optics FX-1",
  lens: "Fixture 35mm F1.4",
  focalLength: 35,
  exposureTime: 0.004,
  fNumber: 2.8,
  iso: 400,
  latitude: 10.5,
  longitude: -40.25,
  capturedAt: "2024-05-01T10:20:30",
};

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

describe("draftOf", () => {
  test("writes each field as it is typed", () => {
    expect(draftOf(file)).toEqual({
      camera: "Fixture Optics FX-1",
      lens: "Fixture 35mm F1.4",
      focalLength: "35",
      exposureTime: "1/250",
      fNumber: "2.8",
      iso: "400",
      latitude: "10.5",
      longitude: "-40.25",
      capturedAt: "2024-05-01T10:20:30",
    });
  });

  test("leaves a field the select lacks empty, and writes long exposures in seconds", () => {
    expect(draftOf({ ...empty, exposureTime: 2.5 })).toEqual({
      camera: "",
      lens: "",
      focalLength: "",
      exposureTime: "2.5",
      fNumber: "",
      iso: "",
      latitude: "",
      longitude: "",
      capturedAt: "",
    });
    expect(draftOf({ ...empty, exposureTime: 0.4 }).exposureTime).toBe("1/2.5");
  });
});

describe("editsFrom", () => {
  test("is no edits when nothing differs from the file", () => {
    expect(editsFrom(draftOf(file), file, {})).toEqual({ edits: {}, errors: {} });
  });

  test("is an edit for each changed field", () => {
    const draft = {
      ...draftOf(file),
      camera: "  Edited Camera ",
      focalLength: "85",
      exposureTime: "1/2.5",
      fNumber: "1,8",
      iso: "1600",
      latitude: "-12.5",
      longitude: "-25.75",
      capturedAt: "2020-01-02T03:04",
    };

    expect(editsFrom(draft, file, {})).toEqual({
      edits: {
        camera: "Edited Camera",
        focalLength: 85,
        exposureTime: 0.4,
        fNumber: 1.8,
        iso: 1600,
        coordinates: { latitude: -12.5, longitude: -25.75 },
        capturedAt: "2020-01-02T03:04:00",
      },
      errors: {},
    });
  });

  test("clears a field emptied, and both coordinates when both are emptied", () => {
    const draft = { ...draftOf(file), lens: " ", iso: "", latitude: "", longitude: "" };

    expect(editsFrom(draft, file, {}).edits).toEqual({ lens: null, iso: null, coordinates: null });
  });

  test("reads shutter speeds as fractions or seconds", () => {
    const shutter = (exposureTime: string) => editsFrom({ ...draftOf(file), exposureTime }, file, {});
    expect(shutter("1/1000").edits).toEqual({ exposureTime: 0.001 });
    expect(shutter("2").edits).toEqual({ exposureTime: 2 });
    expect(shutter("0.5s").edits).toEqual({ exposureTime: 0.5 });
    expect(shutter("1/0").errors).toHaveProperty("exposureTime");
    expect(shutter("fast").errors).toHaveProperty("exposureTime");
  });

  test("keeps the last saved edit for a field typed wrong, and says what is wrong", () => {
    const saved = { iso: 800, capturedAt: "2021-01-01T00:00:00" };
    const draft = {
      ...draftOf(file),
      iso: "12.5",
      focalLength: "-3",
      capturedAt: "2024-02-30T10:00",
      latitude: "91",
    };

    const { edits, errors } = editsFrom(draft, file, saved);

    expect(edits).toEqual({ iso: 800, capturedAt: "2021-01-01T00:00:00" });
    expect(Object.keys(errors).sort()).toEqual(["capturedAt", "coordinates", "focalLength", "iso"]);
  });

  test("needs both coordinates or neither", () => {
    const { edits, errors } = editsFrom({ ...draftOf(file), longitude: "" }, file, {});

    expect(edits).toEqual({});
    expect(errors).toHaveProperty("coordinates");
  });
});
