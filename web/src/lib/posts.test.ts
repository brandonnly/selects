import { describe, expect, test } from "bun:test";
import { describePost } from "./posts";

const post = { error: null, nextAttemptAt: null, attempts: 1 } as const;

describe("describePost", () => {
  test("says a post made in fake mode went to the fake Instagram, not Instagram", () => {
    expect(describePost({ ...post, state: "published", mode: "fake" }).label).toBe("Fake post");
    expect(describePost({ ...post, state: "published", mode: "fake" }).detail).toContain(
      "nothing was posted",
    );
    expect(describePost({ ...post, state: "published", mode: "live" }).label).toBe("Posted");
  });
});
