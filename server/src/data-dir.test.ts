import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDataDir } from "./data-dir";

let parent: string;
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "selects-data-dir-"));
});
afterEach(() => {
  chmodSync(parent, 0o755);
  rmSync(parent, { recursive: true, force: true });
});

describe("prepareDataDir", () => {
  test("creates a missing data directory", () => {
    const dataDir = join(parent, "data");

    expect(prepareDataDir(dataDir)).toBeUndefined();
    expect(existsSync(dataDir)).toBe(true);
  });

  // Root can write anywhere, so there is nothing to refuse.
  test.skipIf(process.getuid?.() === 0)(
    "names DATA_DIR and the user when the directory cannot be written",
    () => {
      chmodSync(parent, 0o555);

      const problem = prepareDataDir(join(parent, "data"));

      expect(problem).toContain("DATA_DIR");
      expect(problem).toContain(`user ${process.getuid?.()}`);
    },
  );
});
