import { Elysia, t } from "elysia";
import type { BucketConfig, InstagramMode } from "./config";
import { InstagramError } from "./instagram";
import type { InstagramAccount } from "./instagram-account";
import type { Publisher } from "./publisher";
import type { Settings } from "./settings";

const notFound = { error: "Not found" } as const;

/** Far longer than any Instagram token, and short enough to refuse a pasted page. */
const MAX_TOKEN = 2000;
const MAX_TEXT = 10_000;

export type PublishRoutesOptions = {
  publisher: Publisher;
  account: InstagramAccount;
  settings: Settings;
  bucket: BucketConfig;
  instagram: InstagramMode;
};

/** The Instagram account, publishing settings, "Post now" and the posts. No route returns the token. */
export function publishRoutes({ publisher, account, settings, bucket, instagram }: PublishRoutesOptions) {
  const publishing = () => ({
    dryRun: settings.publishing().dryRun,
    instagram: { mode: instagram, account: account.view() },
    bucket:
      bucket.status === "configured"
        ? {
            configured: true as const,
            missing: [] as string[],
            url: bucket.publicBaseUrl === undefined ? ("presigned" as const) : ("public" as const),
          }
        : { configured: false as const, missing: bucket.missing, url: null },
  });

  return (
    new Elysia()
      .get("/api/publishing", publishing)
      .put(
        "/api/publishing",
        ({ body }) => {
          settings.setPublishing({ dryRun: body.dryRun });
          return publishing();
        },
        { body: t.Object({ dryRun: t.Boolean() }, { additionalProperties: false }) },
      )
      // No body schema: the token is checked here, as a schema's error could echo it back.
      .put("/api/instagram/token", async ({ body, status }) => {
        const given = typeof body === "object" && body !== null && "token" in body ? body.token : undefined;
        const token = typeof given === "string" ? given.trim() : "";
        if (token === "" || token.length > MAX_TOKEN || /\s/.test(token)) {
          return status(422, { problems: ["Paste the long-lived token, on its own."] });
        }
        try {
          return { account: await account.connect(token) };
        } catch (error) {
          if (error instanceof InstagramError && error.kind === "token") {
            return status(422, { problems: [error.message] });
          }
          return status(503, { problems: ["Instagram could not be reached to check the token. Try again."] });
        }
      })
      .delete("/api/instagram/token", ({ status }) => {
        account.disconnect();
        return status(204);
      })
      .get("/api/selects/:id/publish", ({ params, status }) => {
        const preview = publisher.preview([params.id]);
        return preview === undefined ? status(404, notFound) : preview;
      })
      .post(
        "/api/selects/:id/publish",
        async ({ params, body, status }) => {
          const result = await publisher.publish({
            selectIds: [params.id],
            hashtagSet: body.hashtagSet,
            expect: { caption: body.caption, altText: body.altText },
          });
          switch (result.status) {
            case "started":
              // Published in the background; the post shows how it goes.
              result.done.catch(() => {});
              return status(202, { post: result.post });
            case "not-found":
              return status(404, notFound);
            case "not-in-pool":
              return status(409, {
                status: result.status,
                problems: ["The select is posted, being posted, or marked as already posted."],
              });
            case "unavailable":
              return status(409, { status: result.status, problems: result.problems });
            case "changed":
              return status(409, {
                status: result.status,
                problems: ["The caption or alt text changed. Check it again before posting."],
              });
          }
        },
        {
          body: t.Object(
            {
              /** The caption and alt text the owner was shown and confirmed. */
              caption: t.String({ maxLength: MAX_TEXT }),
              altText: t.String({ maxLength: MAX_TEXT }),
              /** The hashtag set the owner was shown. */
              hashtagSet: t.Optional(t.String({ maxLength: 60 })),
            },
            { additionalProperties: false },
          ),
        },
      )
      .get("/api/posts", () => ({ posts: publisher.posts(), dryRuns: publisher.dryRuns() }))
      .get("/api/posts/:id", ({ params, status }) => publisher.post(params.id) ?? status(404, notFound))
      .get("/api/posts/:id/frame", ({ params, status }) => {
        const frame = publisher.dryRunFrame(params.id);
        if (frame === undefined) return status(404, notFound);
        return new Response(Bun.file(frame), {
          headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=31536000, immutable" },
        });
      })
  );
}
