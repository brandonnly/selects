import { describe, expect, test } from "bun:test";
import { distanceMetres, insideZone } from "./zones";

/** One degree of a great circle on the mean Earth sphere (radius 6,371,008.8 m). */
const ONE_DEGREE = 111_195.08;

describe("distanceMetres", () => {
  test("is the great-circle distance", () => {
    expect(distanceMetres({ latitude: 0, longitude: -30 }, { latitude: 0, longitude: -29 })).toBeCloseTo(
      ONE_DEGREE,
      0,
    );
    expect(distanceMetres({ latitude: -20, longitude: -30 }, { latitude: -19, longitude: -30 })).toBeCloseTo(
      ONE_DEGREE,
      0,
    );
    expect(distanceMetres({ latitude: 10.5, longitude: -40.25 }, { latitude: 10.5, longitude: -40.25 })).toBe(
      0,
    );
  });

  test("takes the short way across the antimeridian", () => {
    expect(distanceMetres({ latitude: 0, longitude: 179.9 }, { latitude: 0, longitude: -179.9 })).toBeCloseTo(
      0.2 * ONE_DEGREE,
      0,
    );
  });

  test("goes over the pole, where every longitude meets", () => {
    expect(distanceMetres({ latitude: 89.9, longitude: 0 }, { latitude: 89.9, longitude: 180 })).toBeCloseTo(
      0.2 * ONE_DEGREE,
      0,
    );
    expect(distanceMetres({ latitude: 90, longitude: -150 }, { latitude: 90, longitude: 45 })).toBeCloseTo(
      0,
      6,
    );
  });

  test("is half the world between antipodes", () => {
    expect(distanceMetres({ latitude: 10, longitude: -40 }, { latitude: -10, longitude: 140 })).toBeCloseTo(
      180 * ONE_DEGREE,
      -1,
    );
  });
});

describe("insideZone", () => {
  const zone = { latitude: 0, longitude: -30, radiusMetres: ONE_DEGREE };

  test("counts a point on the edge as inside", () => {
    const edge = distanceMetres({ latitude: 0, longitude: -30 }, { latitude: 0, longitude: -29 });
    expect(insideZone({ latitude: 0, longitude: -29 }, { ...zone, radiusMetres: edge })).toBe(true);
    expect(insideZone({ latitude: 0, longitude: -29 }, { ...zone, radiusMetres: ONE_DEGREE + 1 })).toBe(true);
    expect(insideZone({ latitude: 0, longitude: -29 }, { ...zone, radiusMetres: ONE_DEGREE - 1 })).toBe(
      false,
    );
  });

  test("covers its centre and nothing far away", () => {
    expect(insideZone({ latitude: 0, longitude: -30 }, zone)).toBe(true);
    expect(insideZone({ latitude: 0.5, longitude: -30.5 }, zone)).toBe(true);
    expect(insideZone({ latitude: 5, longitude: -30 }, zone)).toBe(false);
  });

  test("reaches across the antimeridian", () => {
    const pacific = { latitude: -5, longitude: 179.95, radiusMetres: 20_000 };
    expect(insideZone({ latitude: -5, longitude: -179.95 }, pacific)).toBe(true);
    expect(insideZone({ latitude: -5, longitude: -179.7 }, pacific)).toBe(false);
  });

  test("reaches over the pole", () => {
    const arctic = { latitude: 89.95, longitude: 10, radiusMetres: 20_000 };
    expect(insideZone({ latitude: 89.95, longitude: -170 }, arctic)).toBe(true);
    expect(insideZone({ latitude: 90, longitude: 123 }, arctic)).toBe(true);
    expect(insideZone({ latitude: 89.7, longitude: -170 }, arctic)).toBe(false);
  });
});
