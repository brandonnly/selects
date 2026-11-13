import { BucketSettings, type InstagramMode } from "./config";
import { createFakeBucket, FAKE_BUCKET_KEYS } from "./fake-bucket";
import { createFakeInstagram } from "./fake-instagram";
import { createInstagramApi, type InstagramApi } from "./instagram";

/**
 * The fake Instagram server and the fake bucket, run inside Selects in fake mode (ADR 0006). In
 * fake mode these are all Selects talks to: the bucket in `BUCKET_*` is not used, so nothing
 * leaves the install. In live mode none is started.
 */
export function startFakes(
  mode: InstagramMode,
  /** Serve the fake bucket's objects under a public base URL, as a bucket set up with one. */
  { publicUrl = false }: { publicUrl?: boolean } = {},
): { instagram: InstagramApi; bucket: BucketSettings; stop(): Promise<void> } | undefined {
  if (mode === "live") return undefined;
  const instagram = createFakeInstagram({ acceptAnyToken: true });
  const bucket = createFakeBucket();
  return {
    instagram: createInstagramApi({ baseUrl: instagram.url }),
    bucket: new BucketSettings(
      bucket.endpoint,
      bucket.name,
      "auto",
      publicUrl ? bucket.publicBaseUrl : undefined,
      FAKE_BUCKET_KEYS,
    ),
    async stop() {
      await Promise.all([instagram.stop(), bucket.stop()]);
    },
  };
}
