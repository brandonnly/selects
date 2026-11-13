/**
 * The Instagram API with Instagram Login, as Selects uses it (ADR 0003). The base URL is the real
 * API only when `INSTAGRAM_API=live`; otherwise it is the fake server in this repo.
 *
 * The token goes in the Authorization header, or in the query where Meta documents only that
 * (refresh). A request URL is never logged, and an error never carries the token or a URL.
 */

export const LIVE_INSTAGRAM_URL = "https://graph.instagram.com";
/** A Graph API version Meta supports; checked against its changelog in November 2026. */
export const GRAPH_VERSION = "v26.0";

/** How long one request may take before it counts as a transient failure. */
const REQUEST_TIMEOUT_MS = 30_000;

export type ContainerStatus = "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED" | "PUBLISHED";

export type RecentMedia = { id: string; caption: string; permalink: string | null; timestamp: string };

export type InstagramApi = {
  /** The account a token belongs to. */
  me(token: string): Promise<{ userId: string; username: string }>;
  /** A new long-lived token for one at least a day old, and how long it lasts. */
  refresh(token: string): Promise<{ token: string; expiresInSeconds: number }>;
  /** Creates a media container; Instagram fetches the image from `imageUrl`. Returns its ID. */
  createContainer(
    token: string,
    userId: string,
    post: { imageUrl: string; caption: string; altText: string },
  ): Promise<string>;
  containerStatus(token: string, containerId: string): Promise<ContainerStatus>;
  /** Publishes a finished container. Returns the media ID. */
  publish(token: string, userId: string, containerId: string): Promise<string>;
  permalink(token: string, mediaId: string): Promise<string | null>;
  /** The account's latest media, newest first. */
  recentMedia(token: string, userId: string): Promise<RecentMedia[]>;
};

/**
 * Why a request failed:
 * - `token`: the token is invalid or expired; nothing works until a new one is pasted.
 * - `permission`: the token lacks a permission the request needs; a new token must be made.
 * - `rate-limit`: a request or publishing limit; worth trying later.
 * - `transient`: Instagram or the network failed; worth trying again.
 * - `refused`: Instagram refused the request itself (the image, the account, spam, anything
 *   else it answered with a 4xx); trying the same again will not help.
 * - `too-new`: refresh only; the token is too new to be refreshed, as Meta refreshes a token
 *   only once it is a day old. Recognised by its message, which is unverified against Meta.
 */
export type InstagramErrorKind =
  | "token"
  | "permission"
  | "rate-limit"
  | "transient"
  /** Instagram refused this request for what it holds: the image or the caption. */
  | "refused"
  /** Instagram refuses the account for now, whatever is posted: its daily limit, or a restriction. */
  | "account"
  | "too-new";

export class InstagramError extends Error {
  override name = "InstagramError";
  constructor(
    readonly kind: InstagramErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** Request limits, which Meta says to wait out. 341 is the application's own limit. */
const RATE_LIMIT_CODES = new Set([4, 9, 17, 32, 341, 613]);
/** Server errors and download timeouts Meta says to retry. */
const TRANSIENT_CODES = new Set([-2, -1, 1, 2]);
/**
 * Subcodes Meta says to retry: the image could not be fetched (a new link is made next time),
 * the container is not ready or not found yet.
 */
const TRANSIENT_SUBCODES = new Set([2207052, 2207027, 2207008, 2207003, 2207001, 2207032]);
/** Instagram restricts the action as possible spam. Sent with code 4, but no rate limit. */
const SPAM_SUBCODE = 2207051;
/**
 * The account's posts for 24 hours are used up. Sent with code 9, but no wait of minutes clears
 * it: the post fails at once and its select goes back to the pool for another day.
 */
const DAILY_LIMIT_SUBCODE = 2207042;

/** Sorts Meta's answer into what Selects does about it. */
export function errorKindOf(
  status: number,
  code: number | undefined,
  subcode: number | undefined,
  isTransient: boolean,
): InstagramErrorKind {
  if (code === 190 || code === 102 || status === 401) return "token";
  if (subcode === SPAM_SUBCODE || subcode === DAILY_LIMIT_SUBCODE) return "account";
  if (code === 10 || (code !== undefined && code >= 200 && code <= 299)) return "permission";
  if ((code !== undefined && RATE_LIMIT_CODES.has(code)) || status === 429) return "rate-limit";
  if (
    status >= 500 ||
    status === 408 ||
    isTransient ||
    (code !== undefined && TRANSIENT_CODES.has(code)) ||
    (subcode !== undefined && TRANSIENT_SUBCODES.has(subcode))
  ) {
    return "transient";
  }
  return "refused";
}

export function createInstagramApi({ baseUrl }: { baseUrl: string }): InstagramApi {
  const versioned = (path: string) => `${baseUrl}/${GRAPH_VERSION}/${path}`;

  async function call(
    token: string,
    url: string,
    init: { method?: "GET" | "POST"; body?: Record<string, string>; tokenInQuery?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const target = new URL(url);
    if (init.tokenInQuery) target.searchParams.set("access_token", token);
    let response: Response;
    try {
      response = await fetch(target, {
        method: init.method ?? "GET",
        headers: {
          ...(init.tokenInQuery ? {} : { authorization: `Bearer ${token}` }),
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: "error",
      });
    } catch {
      throw new InstagramError("transient", "Instagram could not be reached.");
    }
    const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    const error = body?.error as
      | { message?: unknown; code?: unknown; error_subcode?: unknown; is_transient?: unknown }
      | undefined;
    if (response.ok && body !== undefined && error === undefined) return body;
    // An answer that says it worked and cannot be read was cut off on the way: worth another try.
    if (response.ok && body === undefined) {
      throw new InstagramError("transient", "Instagram's answer could not be read.");
    }

    const code = typeof error?.code === "number" ? error.code : undefined;
    const subcode = typeof error?.error_subcode === "number" ? error.error_subcode : undefined;
    const said = typeof error?.message === "string" ? clean(error.message, token) : `HTTP ${response.status}`;
    const message = `Instagram: ${said}${code === undefined ? "" : ` (code ${code}${subcode === undefined ? "" : `/${subcode}`})`}`;
    throw new InstagramError(
      errorKindOf(response.status, code, subcode, error?.is_transient === true),
      message,
    );
  }

  const text = (value: unknown, what: string): string => {
    if (typeof value === "string" && value !== "") return value;
    if (typeof value === "number") return String(value);
    throw new InstagramError("transient", `Instagram's answer had no ${what}.`);
  };

  return {
    async me(token) {
      const body = await call(token, `${versioned("me")}?fields=user_id,username`);
      return {
        userId: text(body.user_id ?? body.id, "account ID"),
        username: text(body.username, "username"),
      };
    },

    async refresh(token) {
      const body = await call(token, `${baseUrl}/refresh_access_token?grant_type=ig_refresh_token`, {
        tokenInQuery: true,
      }).catch((error: unknown) => {
        if (error instanceof InstagramError && /too new/i.test(error.message)) {
          throw new InstagramError("too-new", error.message);
        }
        throw error;
      });
      const expiresIn = Number(body.expires_in);
      if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
        throw new InstagramError("transient", "Instagram's answer had no expiry.");
      }
      return { token: text(body.access_token, "token"), expiresInSeconds: expiresIn };
    },

    async createContainer(token, userId, post) {
      const body = await call(token, versioned(`${encodeURIComponent(userId)}/media`), {
        method: "POST",
        body: { image_url: post.imageUrl, caption: post.caption, alt_text: post.altText },
      });
      return text(body.id, "container ID");
    },

    async containerStatus(token, containerId) {
      const body = await call(token, `${versioned(encodeURIComponent(containerId))}?fields=status_code`);
      const status = body.status_code;
      if (
        status === "IN_PROGRESS" ||
        status === "FINISHED" ||
        status === "ERROR" ||
        status === "EXPIRED" ||
        status === "PUBLISHED"
      ) {
        return status;
      }
      throw new InstagramError("transient", "Instagram's answer had no container status.");
    },

    async publish(token, userId, containerId) {
      const body = await call(token, versioned(`${encodeURIComponent(userId)}/media_publish`), {
        method: "POST",
        body: { creation_id: containerId },
      });
      return text(body.id, "media ID");
    },

    async permalink(token, mediaId) {
      const body = await call(token, `${versioned(encodeURIComponent(mediaId))}?fields=permalink`);
      return typeof body.permalink === "string" ? body.permalink : null;
    },

    async recentMedia(token, userId) {
      const body = await call(
        token,
        `${versioned(`${encodeURIComponent(userId)}/media`)}?fields=id,caption,permalink,timestamp&limit=25`,
      );
      const data = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : [];
      return data.map((item) => ({
        id: String(item.id),
        caption: typeof item.caption === "string" ? item.caption : "",
        permalink: typeof item.permalink === "string" ? item.permalink : null,
        timestamp: typeof item.timestamp === "string" ? item.timestamp : "",
      }));
    },
  };
}

/** A URL, or the start of one, anywhere in a message. */
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/\S*|\bwww\.\S+/gi;

/**
 * Meta's message, short and on one line, with every URL and the token taken out. Meta names the
 * URI it could not fetch, which may be a presigned link.
 */
export function clean(message: string, token: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  const withoutToken = token === "" ? oneLine : oneLine.split(token).join("[token]");
  const redacted = withoutToken.replace(URL_IN_TEXT, "[link]");
  return redacted.length > 300 ? `${redacted.slice(0, 300)}…` : redacted;
}
