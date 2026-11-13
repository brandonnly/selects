import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeClock, DAY, type FakeClock, HOUR } from "./clock";
import { openDatabase } from "./db";
import type { AccountView } from "./instagram-account";
import { migrations } from "./migrations";
import {
  CHANNEL_IDS,
  type ChannelId,
  createNotifier,
  DEFAULT_EVENTS,
  DeliveryError,
  type Notice,
  type Notifier,
  type NotifierOptions,
} from "./notify";

const TOPIC = "selects-test-topic-0001";
const NTFY_TOKEN = "tk_fake_access_token_0001";
const HOOK_SECRET = "hook-secret-0001";

type Received = { method: string; path: string; headers: Headers; body: string };

/** A stand-in for an ntfy server or a webhook receiver, on 127.0.0.1. Answers with `answer`. */
function fakeReceiver(answer: (request: Request) => Response | Promise<Response> = () => new Response("ok")) {
  const received: Received[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      received.push({
        method: request.method,
        path: new URL(request.url).pathname,
        headers: request.headers,
        body: await request.text(),
      });
      return answer(request);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, received, stop: () => server.stop(true) };
}

let dataDir: string;
let db: Database;
let clock: FakeClock;
let stops: (() => unknown)[];
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "selects-notify-"));
  db = openDatabase(dataDir, migrations);
  clock = createFakeClock();
  stops = [];
});
afterEach(async () => {
  for (const stop of stops) await stop();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function receiver(answer?: Parameters<typeof fakeReceiver>[0]) {
  const found = fakeReceiver(answer);
  stops.push(found.stop);
  return found;
}

function notifierWith(options: Partial<NotifierOptions> = {}) {
  return createNotifier({
    db,
    clock,
    mode: "live",
    poolSize: () => 50,
    account: () => null,
    timeoutMs: 2000,
    ...options,
  });
}

describe("ntfy", () => {
  test("Send test publishes to the topic, with the access token, and reports success", async () => {
    const ntfy = receiver();
    const notifier = notifierWith();
    expect(notifier.setNtfy({ server: ntfy.url, topic: TOPIC, token: NTFY_TOKEN })).toEqual({ ok: true });

    const result = await notifier.test("ntfy");

    expect(result).toEqual({ status: "sent" });
    expect(ntfy.received).toHaveLength(1);
    const [request] = ntfy.received;
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("authorization")).toBe(`Bearer ${NTFY_TOKEN}`);
    expect(JSON.parse(request?.body ?? "")).toMatchObject({
      topic: TOPIC,
      title: "Selects test",
      message: "A test notice from Selects: notifications arrive here.",
    });
  });
});

describe("the webhook", () => {
  test("Send test POSTs JSON to the URL and reports success", async () => {
    const hook = receiver();
    const notifier = notifierWith();
    expect(notifier.setWebhook({ url: `${hook.url}/hooks/${HOOK_SECRET}` })).toEqual({ ok: true });

    expect(await notifier.test("webhook")).toEqual({ status: "sent" });

    const [request] = hook.received;
    expect(request?.path).toBe(`/hooks/${HOOK_SECRET}`);
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(request?.body ?? "")).toMatchObject({ event: "test", title: "Selects test" });
  });

  test("Send test reports why it failed, and Settings keeps it as the channel's last error, without the URL", async () => {
    const hook = receiver(() => new Response("no", { status: 403 }));
    const notifier = notifierWith();
    notifier.setWebhook({ url: `${hook.url}/hooks/${HOOK_SECRET}` });

    const result = await notifier.test("webhook");

    expect(result).toEqual({ status: "failed", reason: "The server answered 403." });
    const view = notifier.view();
    expect(view.webhook?.lastError).toEqual({ at: clock.now(), reason: "The server answered 403." });
    expect(JSON.stringify(view)).not.toContain(HOOK_SECRET);
    expect(JSON.stringify(view)).not.toContain("/hooks/");
  });

  test("a redirect is not followed", async () => {
    const elsewhere = receiver();
    const hook = receiver(() => Response.redirect(`${elsewhere.url}/caught`, 307));
    const notifier = notifierWith();
    notifier.setWebhook({ url: `${hook.url}/hooks/${HOOK_SECRET}` });

    const result = await notifier.test("webhook");

    expect(result.status).toBe("failed");
    expect(elsewhere.received).toHaveLength(0);
  });

  test("an unreachable URL fails within the timeout, with a reason", async () => {
    const hook = receiver(() => new Promise<Response>(() => {}));
    const notifier = notifierWith({ timeoutMs: 100 });
    notifier.setWebhook({ url: `${hook.url}/slow` });

    expect(await notifier.test("webhook")).toEqual({
      status: "failed",
      reason: "No answer within 1 second.",
    });
  });
});

describe("channel settings", () => {
  test("only http and https URLs without a user name or password are taken", () => {
    const notifier = notifierWith();
    for (const url of [
      "ftp://127.0.0.1/x",
      "file:///etc/hosts",
      "not a url",
      "http://user:pass@127.0.0.1/x",
    ]) {
      expect(notifier.setWebhook({ url })).toMatchObject({ ok: false });
      expect(notifier.setNtfy({ server: url, topic: TOPIC, token: null })).toMatchObject({ ok: false });
    }
    expect(notifier.view().webhook).toBeNull();
    expect(notifier.view().ntfy).toBeNull();
  });

  test("a topic is 1 to 64 letters, digits, - or _", () => {
    const notifier = notifierWith();
    for (const topic of ["", "has space", "slash/topic", "x".repeat(65)]) {
      expect(notifier.setNtfy({ server: "https://ntfy.invalid", topic, token: null })).toMatchObject({
        ok: false,
      });
    }
  });

  test("Settings shows a saved channel without its topic, token or the secret parts of its URL", () => {
    const notifier = notifierWith();
    notifier.setNtfy({ server: "https://ntfy.invalid/", topic: TOPIC, token: NTFY_TOKEN });
    notifier.setWebhook({ url: `https://hooks.invalid/api/${HOOK_SECRET}?key=${HOOK_SECRET}` });

    const view = notifier.view();

    expect(view.ntfy).toMatchObject({ server: "https://ntfy.invalid", topic: "sel…", token: true });
    expect(view.webhook).toMatchObject({ url: "https://hooks.invalid/…" });
    const json = JSON.stringify(view);
    for (const secret of [TOPIC, NTFY_TOKEN, HOOK_SECRET]) expect(json).not.toContain(secret);
  });
});

describe("fake mode", () => {
  test("Send test sends nothing and says what would have been sent", async () => {
    const ntfy = receiver();
    const notifier = notifierWith({ mode: "fake" });
    notifier.setNtfy({ server: ntfy.url, topic: TOPIC, token: null });

    const result = await notifier.test("ntfy");

    expect(result.status).toBe("would-send");
    expect(ntfy.received).toHaveLength(0);
  });
});

/** Channels that record what they are given; `fail` decides each attempt's error. */
function recordingChannels(fail: (attempt: number) => Error | undefined = () => undefined) {
  const sent: { channel: ChannelId; notice: Notice }[] = [];
  let attempts = 0;
  const channels: NotifierOptions["channels"] = (stored) =>
    CHANNEL_IDS.filter((id) => stored[id] !== null).map((id) => ({
      id,
      send: async (notice: Notice) => {
        attempts++;
        const error = fail(attempts);
        if (error !== undefined) throw error;
        sent.push({ channel: id, notice });
      },
    }));
  return { sent, channels, attempts: () => attempts };
}

function configured(notifier: Notifier) {
  notifier.setNtfy({ server: "https://ntfy.invalid", topic: TOPIC, token: null });
  notifier.setWebhook({ url: `https://hooks.invalid/${HOOK_SECRET}` });
}

describe("events", () => {
  test("a published post notifies through every channel, saying only that a select was posted", async () => {
    const recorded = recordingChannels();
    const notifier = notifierWith({ channels: recorded.channels, poolSize: () => 12 });
    configured(notifier);

    notifier.postSettled("published");
    await notifier.idle();

    expect(recorded.sent.map(({ channel }) => channel)).toEqual(["ntfy", "webhook"]);
    expect(recorded.sent[0]?.notice).toEqual({
      event: "posted",
      title: "Posted to Instagram",
      message: "A select was posted. 12 selects are left in the pool.",
    });
  });

  test("a post that failed for good, and one left needing a check, notify as failed", async () => {
    const recorded = recordingChannels();
    const notifier = notifierWith({ channels: recorded.channels });
    configured(notifier);

    notifier.postSettled("failed");
    notifier.postSettled("unconfirmed");
    await notifier.idle();

    const notices = recorded.sent.filter(({ channel }) => channel === "ntfy").map(({ notice }) => notice);
    expect(notices).toEqual([
      {
        event: "failed",
        title: "A post failed",
        message: "A post failed and its select is back in the pool. The Posted screen says why.",
      },
      {
        event: "failed",
        title: "A post needs checking",
        message:
          "Instagram was asked to publish a post and has not said whether it did. Say what happened on the Posted screen.",
      },
    ]);
  });

  test("each event can be switched off", async () => {
    const recorded = recordingChannels();
    const notifier = notifierWith({ channels: recorded.channels });
    configured(notifier);
    expect(notifier.events()).toEqual({
      events: { posted: true, failed: true, token: true, pool: true },
      poolThreshold: 10,
    });

    notifier.setEvents({
      events: { posted: false, failed: true, token: true, pool: true },
      poolThreshold: 10,
    });
    notifier.postSettled("published");
    notifier.postSettled("failed");
    await notifier.idle();

    expect(recorded.sent.map(({ notice }) => notice.event)).toEqual(["failed", "failed"]);
  });

  test("a delivery that fails is tried twice more, and the channel's last error clears once one arrives", async () => {
    const recorded = recordingChannels((attempt) =>
      attempt <= 2 ? new DeliveryError("The server answered 503.", true) : undefined,
    );
    const notifier = notifierWith({ channels: recorded.channels });
    notifier.setNtfy({ server: "https://ntfy.invalid", topic: TOPIC, token: null });

    notifier.postSettled("published");
    await notifier.idle();

    expect(recorded.sent).toHaveLength(1);
    expect(notifier.view().ntfy).toMatchObject({ lastError: null, lastSentAt: clock.now() });
  });

  test("a delivery that keeps failing is given up on, recorded as the channel's last error, and never throws", async () => {
    const recorded = recordingChannels(() => new Error(`refused at https://hooks.invalid/${HOOK_SECRET}`));
    const notifier = notifierWith({ channels: recorded.channels });
    notifier.setWebhook({ url: `https://hooks.invalid/${HOOK_SECRET}` });

    expect(() => notifier.postSettled("failed")).not.toThrow();
    await notifier.idle();

    expect(recorded.attempts()).toBe(3);
    expect(notifier.view().webhook?.lastError).toEqual({ at: clock.now(), reason: "Something went wrong." });
    expect(notifier.recent()[0]).toMatchObject({ event: "failed", outcome: "failed" });
  });

  test("in fake mode an event is recorded as what would have been sent, and nothing is sent", async () => {
    const recorded = recordingChannels();
    const notifier = notifierWith({ mode: "fake", channels: recorded.channels });
    configured(notifier);

    notifier.postSettled("published");
    await notifier.idle();

    expect(recorded.attempts()).toBe(0);
    expect(notifier.recent()).toEqual([
      {
        at: clock.now(),
        event: "posted",
        title: "Posted to Instagram",
        message: "A select was posted. 50 selects are left in the pool.",
        outcome: "would-send",
      },
    ]);
  });
});

const account = (fields: Partial<AccountView>): AccountView => ({
  username: "selects_test",
  status: "connected",
  connectedAt: Date.parse("2026-09-01T00:00:00Z"),
  expiresAt: null,
  refresh: "refreshed",
  ...fields,
});

describe("token about to expire", () => {
  test("notifies once a day while the token expires within 7 days, and stops once it is fixed", async () => {
    const recorded = recordingChannels();
    let current = account({ expiresAt: clock.now() + 6 * DAY, refresh: "failed" });
    const notifier = notifierWith({ channels: recorded.channels, account: () => current });
    notifier.setNtfy({ server: "https://ntfy.invalid", topic: TOPIC, token: null });
    const notices = async () => {
      await notifier.idle();
      return recorded.sent.map(({ notice }) => notice);
    };

    notifier.check();
    expect(await notices()).toEqual([
      {
        event: "token",
        title: "The Instagram token expires soon",
        message:
          "The Instagram token expires in 6 days and could not be refreshed. Paste a new token in Settings before then.",
      },
    ]);

    clock.advance(23 * HOUR);
    notifier.check();
    expect(await notices()).toHaveLength(1);

    clock.advance(HOUR);
    notifier.check();
    expect(await notices()).toHaveLength(2);

    // A new token: fixed.
    current = account({ expiresAt: clock.now() + 60 * DAY });
    clock.advance(DAY);
    notifier.check();
    expect(await notices()).toHaveLength(2);
  });

  test("a token Instagram no longer accepts notifies", async () => {
    const recorded = recordingChannels();
    const notifier = notifierWith({
      channels: recorded.channels,
      account: () => account({ status: "invalid" }),
    });
    notifier.setNtfy({ server: "https://ntfy.invalid", topic: TOPIC, token: null });

    notifier.check();
    await notifier.idle();

    expect(recorded.sent.map(({ notice }) => notice)).toEqual([
      {
        event: "token",
        title: "The Instagram token no longer works",
        message:
          "Instagram no longer accepts the token. Nothing posts until a new token is pasted in Settings.",
      },
    ]);
  });

  test("a token far from expiry, or with no account, notifies nothing", async () => {
    const recorded = recordingChannels();
    let current: AccountView | null = account({ expiresAt: clock.now() + 8 * DAY });
    const notifier = notifierWith({ channels: recorded.channels, account: () => current });
    notifier.setNtfy({ server: "https://ntfy.invalid", topic: TOPIC, token: null });

    notifier.check();
    current = null;
    notifier.check();
    await notifier.idle();

    expect(recorded.sent).toHaveLength(0);
  });
});

describe("pool running low", () => {
  test("notifies once when the pool drops below the threshold, and again only after it has gone back up", async () => {
    const recorded = recordingChannels();
    let pool = 11;
    const notifier = notifierWith({ channels: recorded.channels, poolSize: () => pool });
    notifier.setNtfy({ server: "https://ntfy.invalid", topic: TOPIC, token: null });
    const count = async () => {
      await notifier.idle();
      return recorded.sent.length;
    };

    notifier.check();
    pool = 10;
    notifier.check();
    expect(await count()).toBe(0);

    pool = 9;
    notifier.check();
    expect(recorded.sent[0]?.notice).toEqual({
      event: "pool",
      title: "The pool is running low",
      message: "9 selects are left in the pool, below the 10 you set. Upload more to keep posting.",
    });
    pool = 3;
    notifier.check();
    expect(await count()).toBe(1);

    pool = 10;
    notifier.check();
    pool = 9;
    notifier.check();
    expect(await count()).toBe(2);
  });

  test("a crossing while the event is off is not sent later", async () => {
    const recorded = recordingChannels();
    let pool = 20;
    const notifier = notifierWith({ channels: recorded.channels, poolSize: () => pool });
    notifier.setNtfy({ server: "https://ntfy.invalid", topic: TOPIC, token: null });
    notifier.setEvents({ ...DEFAULT_EVENTS, events: { ...DEFAULT_EVENTS.events, pool: false } });

    notifier.check();
    pool = 2;
    notifier.check();
    notifier.setEvents(DEFAULT_EVENTS);
    notifier.check();
    await notifier.idle();

    expect(recorded.sent).toHaveLength(0);
  });
});
