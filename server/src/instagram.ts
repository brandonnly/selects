/**
 * The Instagram API with Instagram Login, as Selects uses it (ADR 0003). The base URL is the real
 * API only when `INSTAGRAM_API=live`; otherwise it is the fake server in this repo.
 *
 * The token goes in the Authorization header, or in the query where Meta documents only that
 * (refresh). A request URL is never logged, and an error never carries the token.
 */

export const LIVE_INSTAGRAM_URL = "https://graph.instagram.com";
export const GRAPH_VERSION = "v24.0";

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
 * - `rate-limit`: a request or publishing limit; worth trying later.
 * - `transient`: Instagram or the network failed; worth trying again.
 * - `refused`: Instagram refused the request itself.
 */
export type InstagramErrorKind = "token" | "rate-limit" | "transient" | "refused";

export class InstagramError extends Error {
  override name = "InstagramError";
  constructor(
    readonly kind: InstagramErrorKind,
    message: string,
  ) {
    super(message);
  }
}

const RATE_LIMIT_CODES = new Set([4, 9, 17, 32, 613]);
const TRANSIENT_CODES = new Set([1, 2]);

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
    const error = body?.error as { message?: unknown; code?: unknown; is_transient?: unknown } | undefined;
    if (response.ok && body !== undefined && error === undefined) return body;

    const code = typeof error?.code === "number" ? error.code : undefined;
    const said = typeof error?.message === "string" ? clean(error.message, token) : `HTTP ${response.status}`;
    const message = `Instagram: ${said}${code === undefined ? "" : ` (code ${code})`}`;
    if (code === 190 || code === 102 || response.status === 401) throw new InstagramError("token", message);
    if ((code !== undefined && RATE_LIMIT_CODES.has(code)) || response.status === 429) {
      throw new InstagramError("rate-limit", message);
    }
    if (
      response.status >= 500 ||
      error?.is_transient === true ||
      (code !== undefined && TRANSIENT_CODES.has(code))
    ) {
      throw new InstagramError("transient", message);
    }
    throw new InstagramError("refused", message);
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
      });
      const expiresIn = Number(body.expires_in);
      return {
        token: text(body.access_token, "token"),
        expiresInSeconds: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 60 * 24 * 60 * 60,
      };
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

/** Meta's message, short and on one line, with the token taken out should it ever be echoed. */
function clean(message: string, token: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  const redacted = token === "" ? oneLine : oneLine.split(token).join("[token]");
  return redacted.length > 300 ? `${redacted.slice(0, 300)}…` : redacted;
}
