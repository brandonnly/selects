import { describe, expect, test } from "bun:test";
import { startFakes } from "./fakes";

describe("the fakes Selects runs in fake mode", () => {
  test("never start when Instagram is live", () => {
    expect(startFakes("live")).toBeUndefined();
  });

  test("are a fake Instagram and a fake bucket inside the process", async () => {
    const fakes = startFakes("fake");
    try {
      expect(fakes).toBeDefined();
      expect(new URL(fakes?.bucket.endpoint ?? "http://missing").hostname).toBe("127.0.0.1");
      // Any token connects a fake account.
      expect(await fakes?.instagram.me("anything")).toMatchObject({ username: "fake_account" });
    } finally {
      await fakes?.stop();
    }
  });
});

describe("the fake bucket", () => {
  test("serves its objects publicly only when asked to, as a bucket with a public base URL", async () => {
    const plain = startFakes("fake");
    const open = startFakes("fake", { publicUrl: true });
    try {
      expect(plain?.bucket.publicBaseUrl).toBeUndefined();
      const base = new URL(open?.bucket.publicBaseUrl ?? "http://missing");
      expect(base.hostname).toBe("127.0.0.1");
      expect(base.origin).toBe(new URL(open?.bucket.endpoint ?? "http://other").origin);
    } finally {
      await plain?.stop();
      await open?.stop();
    }
  });
});
