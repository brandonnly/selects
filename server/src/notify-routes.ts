import { Elysia, t } from "elysia";
import type { Backups } from "./backup";
import { type ChannelId, type Notifier, POOL_THRESHOLD_LIMITS } from "./notify";

const notFound = { error: "Not found" } as const;

const eventsSchema = t.Object(
  {
    events: t.Object(
      { posted: t.Boolean(), failed: t.Boolean(), token: t.Boolean(), pool: t.Boolean() },
      { additionalProperties: false },
    ),
    poolThreshold: t.Integer({ minimum: POOL_THRESHOLD_LIMITS.min, maximum: POOL_THRESHOLD_LIMITS.max }),
  },
  { additionalProperties: false },
);

const channelParam = t.Object({ channel: t.Union([t.Literal("ntfy"), t.Literal("webhook")]) });

/**
 * Notifications and backups in Settings. A channel's topic, token and URL are taken in and never
 * given back whole.
 */
export function notifyRoutes({ notifier, backups }: { notifier: Notifier; backups: Backups }) {
  const view = () => ({ ...notifier.view(), ...notifier.events(), recent: notifier.recent() });
  return new Elysia()
    .get("/api/notifications", view)
    .put(
      "/api/notifications/events",
      ({ body }) => {
        notifier.setEvents(body);
        // A threshold raised past the pool tells it now, not at the next check.
        notifier.check();
        return view();
      },
      { body: eventsSchema },
    )
    .put(
      "/api/notifications/ntfy",
      ({ body, status }) => {
        const token = body.token?.trim() ?? "";
        const saved = notifier.setNtfy({
          server: body.server.trim(),
          topic: body.topic.trim(),
          token: token === "" ? null : token,
        });
        return saved.ok ? view() : status(422, { problems: saved.problems });
      },
      {
        body: t.Object(
          {
            server: t.String({ maxLength: 2048 }),
            topic: t.String({ maxLength: 64 }),
            token: t.Optional(t.Union([t.String({ maxLength: 512 }), t.Null()])),
          },
          { additionalProperties: false },
        ),
      },
    )
    .put(
      "/api/notifications/webhook",
      ({ body, status }) => {
        const saved = notifier.setWebhook({ url: body.url.trim() });
        return saved.ok ? view() : status(422, { problems: saved.problems });
      },
      { body: t.Object({ url: t.String({ maxLength: 2048 }) }, { additionalProperties: false }) },
    )
    .delete(
      "/api/notifications/:channel",
      ({ params, status }) => {
        if (params.channel === "ntfy") notifier.setNtfy(null);
        else notifier.setWebhook(null);
        return status(204);
      },
      { params: channelParam },
    )
    .post(
      "/api/notifications/:channel/test",
      async ({ params, status }) => {
        const result = await notifier.test(params.channel as ChannelId);
        if (result.status === "not-configured") return status(404, notFound);
        return result;
      },
      { params: channelParam },
    )
    .get("/api/backups", () => backups.status());
}
