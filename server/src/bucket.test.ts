import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createBucket } from "./bucket";
import { BucketSettings } from "./config";
import { createFakeBucket, FAKE_BUCKET_KEYS, type FakeBucket } from "./fake-bucket";

let fake: FakeBucket;
beforeEach(() => {
  fake = createFakeBucket();
});
afterEach(() => fake.stop());

const settings = (publicBaseUrl?: string) =>
  new BucketSettings(fake.endpoint, fake.name, "auto", publicBaseUrl, FAKE_BUCKET_KEYS);

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

describe("the bucket", () => {
  test("stores a frame under a random key, never a file name", async () => {
    const bucket = createBucket(settings());

    const first = bucket.newKey();
    const second = bucket.newKey();
    await bucket.put(first, JPEG);

    expect(first).toMatch(/^frames\/[0-9a-f-]{36}\.jpg$/);
    expect(second).not.toBe(first);
    expect(fake.objects.get(first)?.bytes).toEqual(JPEG);
    expect(fake.objects.get(first)?.contentType).toBe("image/jpeg");
  });

  test("gives up on a bucket that takes a request and never answers", async () => {
    const bucket = createBucket(settings(), { timeoutMs: 200 });
    fake.hang(true);

    const started = Date.now();
    const [put, deleted] = await Promise.allSettled([
      bucket.put(bucket.newKey(), JPEG),
      bucket.delete(bucket.newKey()),
    ]);

    for (const result of [put, deleted]) {
      expect(result.status).toBe("rejected");
      expect(String((result as PromiseRejectedResult).reason)).toContain("did not answer in time");
    }
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("adds no metadata to the object it stores", async () => {
    const bucket = createBucket(settings());
    const key = bucket.newKey();

    await bucket.put(key, JPEG);

    expect(fake.objects.get(key)?.headers).toEqual({});
  });

  test("gives the public URL when the bucket has a public base URL", async () => {
    const bucket = createBucket(settings(fake.publicBaseUrl));
    const key = bucket.newKey();
    await bucket.put(key, JPEG);

    const url = bucket.urlFor(key);

    expect(bucket.urlKind).toBe("public");
    expect(url).toBe(`${fake.publicBaseUrl}/${key}`);
    const fetched = await fetch(url);
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(JPEG);
  });

  test("gives a presigned link that lasts one hour when there is no public base URL", async () => {
    const bucket = createBucket(settings());
    const key = bucket.newKey();
    await bucket.put(key, JPEG);

    const url = new URL(bucket.urlFor(key));

    expect(bucket.urlKind).toBe("presigned");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    const fetched = await fetch(url);
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(JPEG);
    // An unsigned link to the same object is refused: the bucket is private.
    expect((await fetch(`${fake.endpoint}/${fake.name}/${key}`)).status).toBe(403);
  });

  test("deletes an object", async () => {
    const bucket = createBucket(settings());
    const key = bucket.newKey();
    await bucket.put(key, JPEG);

    await bucket.delete(key);

    expect(fake.objects.has(key)).toBe(false);
  });

  test("reports a failed upload without the keys in its message", async () => {
    const bucket = createBucket(settings());
    fake.failNext();

    let message = "";
    try {
      await bucket.put(bucket.newKey(), JPEG);
    } catch (error) {
      message = String(error);
    }

    expect(message).not.toBe("");
    expect(message).not.toContain(FAKE_BUCKET_KEYS.accessKeyId);
    expect(message).not.toContain(FAKE_BUCKET_KEYS.secretAccessKey);
  });
});
