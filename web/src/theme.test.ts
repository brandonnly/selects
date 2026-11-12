import { describe, expect, test } from "bun:test";
import { followDeviceTheme } from "./theme";

/** A stand-in for `matchMedia("(prefers-color-scheme: dark)")` that the test can flip. */
function fakeDarkQuery(matches: boolean) {
  const listeners = new Set<() => void>();
  return {
    get matches() {
      return matches;
    },
    addEventListener: (_type: "change", listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: "change", listener: () => void) => listeners.delete(listener),
    flip(next: boolean) {
      matches = next;
      for (const listener of listeners) listener();
    },
  };
}

const fakeRoot = () => {
  const classes = new Set<string>();
  return {
    classes,
    classList: {
      toggle(name: string, on: boolean) {
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    },
  };
};

describe("followDeviceTheme", () => {
  test("starts dark on a device set to dark", () => {
    const root = fakeRoot();
    followDeviceTheme(root, fakeDarkQuery(true));

    expect(root.classes.has("dark")).toBe(true);
  });

  test("starts light on a device set to light", () => {
    const root = fakeRoot();
    followDeviceTheme(root, fakeDarkQuery(false));

    expect(root.classes.has("dark")).toBe(false);
  });

  test("switches when the device setting changes", () => {
    const root = fakeRoot();
    const query = fakeDarkQuery(false);
    followDeviceTheme(root, query);

    query.flip(true);
    expect(root.classes.has("dark")).toBe(true);
    query.flip(false);
    expect(root.classes.has("dark")).toBe(false);
  });

  test("stops following once released", () => {
    const root = fakeRoot();
    const query = fakeDarkQuery(false);
    const release = followDeviceTheme(root, query);

    release();
    query.flip(true);
    expect(root.classes.has("dark")).toBe(false);
  });
});
