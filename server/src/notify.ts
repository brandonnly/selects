import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { type Clock, DAY } from "./clock";
import type { InstagramMode } from "./config";
import type { AccountView } from "./instagram-account";

/** Where notifications go. */
export type ChannelId = "ntfy" | "webhook";
export const CHANNEL_IDS: readonly ChannelId[] = ["ntfy", "webhook"];

/** What is sent: a title and one or two plain sentences. Never a location, file name, caption or link. */
export type Notice = { event: NotifyEvent | "test"; title: string; message: string };

export type NotifyEvent = "posted" | "failed" | "token" | "pool";
export const NOTIFY_EVENTS: readonly NotifyEvent[] = ["posted", "failed", "token", "pool"];

/** Which events notify, and the pool size below which the pool is running low. */
export type EventSettings = { events: Record<NotifyEvent, boolean>; poolThreshold: number };

export const DEFAULT_EVENTS: EventSettings = {
  events: { posted: true, failed: true, token: true, pool: true },
  poolThreshold: 10,
};

export const POOL_THRESHOLD_LIMITS = { min: 1, max: 10_000 } as const;

/**
 * A notice as it was handled: sent to every channel, not to every one, recorded only (fake mode),
 * or with no channel set.
 */
export type SentNotice = Omit<Notice, "event"> & {
  at: number;
  event: NotifyEvent;
  outcome: "sent" | "failed" | "would-send" | "no-channel";
};

/** How a post settled, as the publisher tells it. */
export type PostOutcome = "published" | "failed" | "unconfirmed";

/** An ntfy topic: the server's URL, the topic, and an access token when the topic needs one. */
export type NtfyConfig = { server: string; topic: string; token: string | null };
/** A URL the server POSTs JSON to. */
export type WebhookConfig = { url: string };

/** How one channel delivers a notice. Throws a `DeliveryError` when it could not. */
export type Channel = { id: ChannelId; send(notice: Notice): Promise<void> };

/** Why a notice did not arrive, in words that never carry the channel's URL or secrets. */
export class DeliveryError extends Error {
  override name = "DeliveryError";
  constructor(
    message: string,
    /** Worth another attempt: no answer, a timeout, a 5xx or a 429. */
    readonly retry: boolean,
  ) {
    super(message);
  }
}

type Stored = { ntfy: NtfyConfig | null; webhook: WebhookConfig | null };

/** How a channel last went: kept per channel, in words without its URL or secrets. */
type ChannelStatus = { lastError: { at: number; reason: string } | null; lastSentAt: number | null };

/** A channel as Settings shows it: never its topic, token or the secret parts of its URL. */
export type ChannelView<T> = T & ChannelStatus;

export type NotificationsView = {
  mode: InstagramMode;
  ntfy: ChannelView<{ server: string; topic: string; token: boolean }> | null;
  webhook: ChannelView<{ url: string }> | null;
};

export type SaveResult = { ok: true } | { ok: false; problems: string[] };

/** An ntfy topic name, as ntfy takes it. */
export const TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type TestResult =
  | { status: "sent" }
  | { status: "would-send"; message: string }
  | { status: "failed"; reason: string }
  | { status: "not-configured" };

export type NotifierOptions = {
  db: Database;
  clock: Clock;
  /** In fake mode nothing leaves the install: notices are recorded as what would have been sent. */
  mode: InstagramMode;
  /** How many selects are in the pool. */
  poolSize: () => number;
  /** The connected Instagram account, for its token's expiry. */
  account: () => AccountView | null;
  /** How the channels are made from what is saved. Default: HTTP requests. Tests swap them. */
  channels?: (stored: Stored, http: HttpOptions) => Channel[];
  /** How long one request may take. Default: 10 seconds. */
  timeoutMs?: number;
};

type HttpOptions = { timeoutMs: number };

const DEFAULT_TIMEOUT_MS = 10 * 1000;
/** The waits before the two retries of a delivery. */
const RETRY_DELAYS_MS = [2 * 1000, 10 * 1000] as const;
/** Notices kept for Settings to show. */
const RECENT_KEPT = 20;
const EVENTS_KEY = "notification-events";
const LOG_KEY = "notification-log";
const STATE_KEY = "notification-state";

/** A token this close to its expiry is about to expire. */
export const TOKEN_WARNING_MS = 7 * DAY;
/** How often a token about to expire is told again until it is fixed. */
const TOKEN_REPEAT_MS = DAY;

/** What the checks remember: whether the pool was last seen low, and when the token was last told. */
type CheckState = { poolLow: boolean; tokenWarnedAt: number | null };

const KEY = "notifications";
const STATUS_KEY = "notification-status";

/** The problem with a channel URL, if any: http or https, and no user name or password in it. */
export function urlProblem(value: string, what: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${what} must be a full http or https URL.`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return `${what} must be an http or https URL.`;
  if (url.username !== "" || url.password !== "") return `${what} must not hold a user name or password.`;
  if (value.length > 2048) return `${what} must be at most 2048 characters.`;
  return undefined;
}

/** The scheme and host of a URL, and "/…" when anything follows: its path may be a secret. */
function shownUrl(value: string): string {
  const url = new URL(value);
  const rest = `${url.pathname}${url.search}${url.hash}`;
  return rest === "/" || rest === "" ? url.origin : `${url.origin}/…`;
}

const seconds = (ms: number) => {
  const whole = Math.max(1, Math.ceil(ms / 1000));
  return `${whole} second${whole === 1 ? "" : "s"}`;
};

/** The channels a saved configuration makes, sending over HTTP. */
export function httpChannels(stored: Stored, http: HttpOptions): Channel[] {
  const channels: Channel[] = [];
  const { ntfy, webhook } = stored;
  if (ntfy !== null) {
    channels.push({
      id: "ntfy",
      send: (notice) =>
        post(
          ntfy.server,
          { topic: ntfy.topic, title: notice.title, message: notice.message, tags: [notice.event] },
          ntfy.token === null ? {} : { authorization: `Bearer ${ntfy.token}` },
          http,
        ),
    });
  }
  if (webhook !== null) {
    channels.push({
      id: "webhook",
      send: (notice) =>
        post(webhook.url, { event: notice.event, title: notice.title, message: notice.message }, {}, http),
    });
  }
  return channels;
}

/**
 * POSTs JSON. Redirects are not followed, the answer's body is never read, and every failure
 * is told in words without the URL.
 */
/** Marks a request as a notice from Selects, so Selects refuses one aimed at itself. */
export const NOTICE_HEADER = "x-selects-notice";

async function post(url: string, body: unknown, headers: Record<string, string>, http: HttpOptions) {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", [NOTICE_HEADER]: "1", ...headers },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(http.timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new DeliveryError(`No answer within ${seconds(http.timeoutMs)}.`, true);
    }
    throw new DeliveryError("The server could not be reached.", true);
  }
  await response.body?.cancel().catch(() => {});
  if (response.ok) return;
  const { status } = response;
  if (status >= 300 && status < 400) {
    throw new DeliveryError(
      `The server answered ${status}, a redirect: Selects does not follow redirects.`,
      false,
    );
  }
  throw new DeliveryError(`The server answered ${status}.`, status >= 500 || status === 429);
}

const TEST_NOTICE: Notice = {
  event: "test",
  title: "Selects test",
  message: "A test notice from Selects: notifications arrive here.",
};

// An unexpected error is told without its message, which may hold the URL, and tried again.
const asDeliveryError = (error: unknown) =>
  error instanceof DeliveryError ? error : new DeliveryError("Something went wrong.", true);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Notifications (docs/PRODUCT.md, "Notifications"; ADR 0009): an ntfy topic and a webhook, and
 * four events, each switchable.
 */
export function createNotifier(options: NotifierOptions) {
  const { db } = options;
  const http: HttpOptions = { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS };
  const makeChannels = options.channels ?? httpChannels;

  const readKey = <T>(key: string): Partial<T> => {
    const row = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key);
    return row === null ? {} : (JSON.parse(row.value) as Partial<T>);
  };
  const writeKey = (key: string, value: unknown) => {
    db.query(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ).run(key, JSON.stringify(value));
  };
  const hasChannel = () => {
    const { ntfy, webhook } = read();
    return ntfy !== null || webhook !== null;
  };
  const read = (): Stored => {
    const saved = readKey<Stored>(KEY);
    return { ntfy: saved.ntfy ?? null, webhook: saved.webhook ?? null };
  };
  const write = (value: Stored) => writeKey(KEY, value);

  const statuses = () => readKey<Record<ChannelId, ChannelStatus>>(STATUS_KEY);
  const statusOf = (id: ChannelId): ChannelStatus => statuses()[id] ?? { lastError: null, lastSentAt: null };
  const setStatus = (id: ChannelId, status: ChannelStatus) =>
    writeKey(STATUS_KEY, { ...statuses(), [id]: status });
  /** Records how a delivery went, as the channel's last error or its last success. */
  const recordDelivery = (id: ChannelId, error: DeliveryError | undefined) => {
    const status = statusOf(id);
    setStatus(
      id,
      error === undefined
        ? { lastError: null, lastSentAt: options.clock.now() }
        : { ...status, lastError: { at: options.clock.now(), reason: error.message } },
    );
  };

  const channel = (id: ChannelId) => makeChannels(read(), http).find((found) => found.id === id);

  const events = (): EventSettings => {
    const saved = readKey<EventSettings>(EVENTS_KEY);
    return {
      events: { ...DEFAULT_EVENTS.events, ...saved.events },
      poolThreshold: saved.poolThreshold ?? DEFAULT_EVENTS.poolThreshold,
    };
  };

  type Logged = SentNotice & { id: string };
  const logged = (): Logged[] => {
    const row = db
      .query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?")
      .get(LOG_KEY);
    return row === null ? [] : (JSON.parse(row.value) as Logged[]);
  };
  const recent = (): SentNotice[] => logged().map(({ id: _, ...entry }) => entry);
  const log = (entry: Logged) => writeKey(LOG_KEY, [entry, ...logged()].slice(0, RECENT_KEPT));
  const settle = (id: string, outcome: SentNotice["outcome"]) =>
    writeKey(
      LOG_KEY,
      logged().map((entry) => (entry.id === id ? { ...entry, outcome } : entry)),
    );

  const checkState = (): CheckState => ({
    poolLow: false,
    tokenWarnedAt: null,
    ...readKey<CheckState>(STATE_KEY),
  });
  const setCheckState = (state: CheckState) => writeKey(STATE_KEY, state);

  /** Deliveries on their way, so `idle` can wait for them. */
  const pending = new Set<Promise<void>>();

  /** One channel, with two retries for a failure worth retrying. Never throws. */
  async function deliver(target: Channel, notice: Notice): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      try {
        await target.send(notice);
        recordDelivery(target.id, undefined);
        return true;
      } catch (error) {
        const failure = asDeliveryError(error);
        const wait = RETRY_DELAYS_MS[attempt];
        if (!failure.retry || wait === undefined) {
          recordDelivery(target.id, failure);
          console.error(`A notification could not be sent to the ${target.id} channel: ${failure.message}`);
          return false;
        }
        await options.clock.sleep(wait);
      }
    }
  }

  /**
   * Sends a notice for an event that is switched on, in the background: it never blocks or
   * throws into its caller. In fake mode it is recorded only.
   */
  function send(notice: Notice & { event: NotifyEvent }) {
    try {
      if (!events().events[notice.event]) return;
      const targets = makeChannels(read(), http);
      const id = randomUUID();
      const outcome = targets.length === 0 ? "no-channel" : options.mode === "fake" ? "would-send" : "sent";
      log({ id, at: options.clock.now(), ...notice, outcome });
      if (outcome !== "sent") return;
      const delivery = Promise.all(targets.map((target) => deliver(target, notice)))
        .then((results) => {
          if (results.some((ok) => !ok)) settle(id, "failed");
        })
        .catch((error) => console.error(`A notification could not be sent (${errorName(error)}).`));
      pending.add(delivery);
      void delivery.finally(() => pending.delete(delivery));
    } catch (error) {
      console.error(`A notification could not be sent (${errorName(error)}).`);
    }
  }

  return {
    /** Told by the publisher as each post settles. A post resolved by hand is not told. */
    postSettled(outcome: PostOutcome): void {
      if (outcome === "published") {
        let pool: number | undefined;
        try {
          pool = options.poolSize();
        } catch {}
        send({
          event: "posted",
          title: "Posted to Instagram",
          message: `A select was posted.${pool === undefined ? "" : ` ${plural(pool, "select is", "selects are")} left in the pool.`}`,
        });
      } else if (outcome === "failed") {
        send({
          event: "failed",
          title: "A post failed",
          message: "A post failed for good. The Posted screen says why.",
        });
      } else {
        send({
          event: "failed",
          title: "A post needs checking",
          message:
            "Instagram was asked to publish a post and has not said whether it did. Say what happened on the Posted screen.",
        });
      }
    },

    /**
     * Checks the token and the pool, and notifies what needs telling. Run on a timer and after
     * each slot; never throws.
     */
    check(): void {
      try {
        const state = checkState();
        const now = options.clock.now();
        const token = tokenNotice(options.account(), now);
        if (token === undefined) state.tokenWarnedAt = null;
        else if (
          events().events.token &&
          (state.tokenWarnedAt === null || now - state.tokenWarnedAt >= TOKEN_REPEAT_MS)
        ) {
          send(token);
          state.tokenWarnedAt = now;
        }
        const pool = options.poolSize();
        const { poolThreshold } = events();
        if (pool >= poolThreshold) state.poolLow = false;
        else if (!state.poolLow && hasChannel()) {
          // Marked only once there is a channel to tell: a crossing before one is set is told then.
          state.poolLow = true;
          send({
            event: "pool",
            title: "The pool is running low",
            message: `${plural(pool, "select is", "selects are")} left in the pool, below the ${poolThreshold} you set. Upload more to keep posting.`,
          });
        }
        setCheckState(state);
      } catch (error) {
        console.error(`Notifications could not be checked (${errorName(error)}).`);
      }
    },

    events,

    setEvents(settings: EventSettings): EventSettings {
      writeKey(EVENTS_KEY, settings);
      return settings;
    },

    /** The latest notices, newest first. */
    recent,

    /** Settles once every delivery on its way has finished. */
    async idle(): Promise<void> {
      while (pending.size > 0) await Promise.all([...pending]);
    },

    view(): NotificationsView {
      const { ntfy, webhook } = read();
      return {
        mode: options.mode,
        ntfy:
          ntfy === null
            ? null
            : {
                server: shownUrl(ntfy.server),
                topic: ntfy.topic.length > 6 ? `${ntfy.topic.slice(0, 3)}…` : "…",
                token: ntfy.token !== null,
                ...statusOf("ntfy"),
              },
        webhook: webhook === null ? null : { url: shownUrl(webhook.url), ...statusOf("webhook") },
      };
    },

    /** Saves the ntfy topic, or removes it with null. A new topic starts with no last error. */
    setNtfy(config: NtfyConfig | null): SaveResult {
      if (config !== null) {
        const problems = [
          urlProblem(config.server, "The server"),
          TOPIC_PATTERN.test(config.topic) ? undefined : "The topic must be 1 to 64 letters, digits, - or _.",
          config.token !== null && (config.token.length > 512 || /\s/.test(config.token))
            ? "The access token must be at most 512 characters, without spaces."
            : undefined,
        ].filter((problem): problem is string => problem !== undefined);
        if (problems.length > 0) return { ok: false, problems };
      }
      const server = config?.server.replace(/\/+$/, "");
      write({ ...read(), ntfy: config === null ? null : { ...config, server: server ?? config.server } });
      setStatus("ntfy", { lastError: null, lastSentAt: null });
      return { ok: true };
    },

    /** Saves the webhook, or removes it with null. */
    setWebhook(config: WebhookConfig | null): SaveResult {
      if (config !== null) {
        const problem = urlProblem(config.url, "The webhook URL");
        if (problem !== undefined) return { ok: false, problems: [problem] };
      }
      write({ ...read(), webhook: config });
      setStatus("webhook", { lastError: null, lastSentAt: null });
      return { ok: true };
    },

    /**
     * Sends a test notice through one channel and says how it went. In fake mode nothing is
     * sent: it says what would have been.
     */
    async test(id: ChannelId): Promise<TestResult> {
      const found = channel(id);
      if (found === undefined) return { status: "not-configured" };
      if (options.mode === "fake") {
        return {
          status: "would-send",
          message: `Fake mode: nothing was sent. With INSTAGRAM_API=live, a test notice would be sent to this ${id === "ntfy" ? "topic" : "webhook"}.`,
        };
      }
      try {
        await found.send(TEST_NOTICE);
        recordDelivery(id, undefined);
        return { status: "sent" };
      } catch (error) {
        const failure = asDeliveryError(error);
        recordDelivery(id, failure);
        return { status: "failed", reason: failure.message };
      }
    },
  };
}

export type Notifier = ReturnType<typeof createNotifier>;

/** What to tell about the token, or undefined when nothing needs telling. */
function tokenNotice(account: AccountView | null, now: number): (Notice & { event: "token" }) | undefined {
  if (account === null) return undefined;
  if (account.status === "invalid") {
    return {
      event: "token",
      title: "The Instagram token no longer works",
      message:
        "Instagram no longer accepts the token. Nothing posts until a new token is pasted in Settings.",
    };
  }
  if (account.expiresAt === null || account.expiresAt - now > TOKEN_WARNING_MS) return undefined;
  const days = Math.ceil((account.expiresAt - now) / DAY);
  const unrefreshed = account.refresh === "failed" ? " and could not be refreshed" : "";
  return {
    event: "token",
    title: "The Instagram token expires soon",
    message:
      days <= 0
        ? "The Instagram token has expired. Paste a new token in Settings."
        : `The Instagram token expires in ${plural(days, "day", "days")}${unrefreshed}. Paste a new token in Settings before then.`,
  };
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown error");
