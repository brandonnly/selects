import { describe, expect, test } from "bun:test";
import { createFreshness, track } from "./freshness";

describe("freshness", () => {
  test("a read with no change around it is shown", () => {
    const fresh = createFreshness();
    const read = fresh.startRead();
    expect(fresh.readIsFresh(read)).toBe(true);
  });

  test("a read that began before a change is never shown, even when it answers after it", () => {
    const fresh = createFreshness();
    const read = fresh.startRead();
    const write = fresh.startWrite();
    fresh.endWrite(write);
    expect(fresh.readIsFresh(read)).toBe(false);
  });

  test("a read that began while a change was on its way is never shown", () => {
    const fresh = createFreshness();
    const write = fresh.startWrite();
    const read = fresh.startRead();
    fresh.endWrite(write);
    expect(fresh.readIsFresh(read)).toBe(false);
    expect(fresh.readIsFresh(fresh.startRead())).toBe(true);
  });

  test("only the answer to the latest change is shown", () => {
    const fresh = createFreshness();
    const first = fresh.startWrite();
    const second = fresh.startWrite();
    expect(fresh.endWrite(second)).toBe(true);
    expect(fresh.endWrite(first)).toBe(false);
  });

  test("a change that fails still ends, so reads are shown again", async () => {
    const fresh = createFreshness();
    await expect(track(fresh, () => Promise.reject(new Error("offline")))).rejects.toThrow("offline");
    expect(fresh.readIsFresh(fresh.startRead())).toBe(true);
    expect(await track(fresh, async () => "ok")).toEqual({ answer: "ok", latest: true });
  });
});
