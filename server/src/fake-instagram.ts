/**
 * A fake of the Instagram API with Instagram Login, served over real HTTP inside the process. It
 * backs development and every test (ADR 0003): nothing here can reach Instagram.
 *
 * It answers the requests Selects makes, with the shapes Meta documents: the account behind a
 * token, token refresh, media containers that fetch their image from the URL they are given and
 * are polled until they finish, publishing a container once, a media's permalink and the
 * account's recent media. Errors come back as Graph API errors, and tests can queue failures:
 * a transient error, a rate limit, a response lost after the work was done, or no response.
 */
import sharp from "sharp";
import { type Clock, DAY, systemClock } from "./clock";
import { GRAPH_VERSION } from "./instagram";

export type FakeAccount = { userId: string; username: string };

export type FakeMedia = {
  id: string;
  containerId: string;
  userId: string;
  caption: string;
  altText: string | null;
  /** The image as the fake fetched it from the URL it was given. */
  image: Uint8Array;
  imageUrl: string;
  permalink: string;
  timestamp: string;
};

type ContainerStatus = "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED" | "PUBLISHED";

type Container = {
  id: string;
  userId: string;
  caption: string;
  altText: string | null;
  image: Uint8Array;
  imageUrl: string;
  status: ContainerStatus;
  pollsLeft: number;
};

type Token = FakeAccount & { issuedAt: number; expired: boolean };

/** Something to go wrong on the next request to an operation. */
export type FakeFailure =
  /** A 500 that says to try again later. */
  | "transient"
  /** Meta's application request limit. */
  | "rate-limit"
  /** The account's 24-hour publishing limit. */
  | "publish-limit"
  /** The work is done, then the answer is lost: a 500 as if the connection dropped. */
  | "lost"
  /** The work is done and no answer ever comes. */
  | "hang";

export type FakeOperation = "me" | "refresh" | "container" | "status" | "publish" | "permalink" | "media";

const LONG_LIVED_SECONDS = 60 * 24 * 60 * 60;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function createFakeInstagram({
  clock = systemClock,
  acceptAnyToken = false,
  port = 0,
}: {
  /** Tells a token's age, for refresh. */
  clock?: Clock;
  /** Development: any token is taken for a fake account, so a developer can paste anything. */
  acceptAnyToken?: boolean;
  port?: number;
} = {}) {
  const tokens = new Map<string, Token>();
  const containers = new Map<string, Container>();
  const media: FakeMedia[] = [];
  const failures = new Map<FakeOperation, FakeFailure[]>();
  /** Requests answered: method and path only, never a token. */
  const requests: { method: string; path: string; operation: FakeOperation | "unknown" }[] = [];
  /** Image fetches the fake made, by the URL it was given. */
  const fetches: { url: string; status: number }[] = [];
  const hanging: (() => void)[] = [];
  let processingPolls = 1;
  let nextId = 17_841_400_000_000;
  const newId = () => String(nextId++);

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: (request) => handle(request),
  });

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const operation = operationOf(request.method, parts, url.searchParams);
    requests.push({ method: request.method, path: url.pathname, operation });
    if (operation === "unknown") return graphError(400, 100, "Unsupported request");

    const token =
      request.headers.get("authorization")?.replace(/^Bearer /, "") ?? url.searchParams.get("access_token");
    const account = tokenAccount(token);
    if (account === undefined)
      return graphError(400, 190, "Invalid OAuth access token - Cannot parse access token");
    if (account.expired) {
      return graphError(400, 190, "Error validating access token: Session has expired.", {
        error_subcode: 463,
      });
    }

    const failure = failures.get(operation)?.shift();
    if (failure === "transient")
      return graphError(500, 2, "Service temporarily unavailable", { is_transient: true });
    if (failure === "rate-limit")
      return graphError(400, 4, "Application request limit reached", { is_transient: true });
    if (failure === "publish-limit") {
      return graphError(400, 9, "The account has reached its publishing limit.", { error_subcode: 2207042 });
    }

    const response = await answer(operation, request, url, parts, account, token ?? "");
    if (failure === "lost") return graphError(500, 1, "An unknown error occurred", { is_transient: true });
    if (failure === "hang")
      return new Promise((resolve) => hanging.push(() => resolve(new Response(null, { status: 504 }))));
    return response;
  }

  async function answer(
    operation: FakeOperation,
    request: Request,
    url: URL,
    parts: string[],
    account: Token,
    token: string,
  ): Promise<Response> {
    switch (operation) {
      case "me":
        return Response.json({ user_id: account.userId, username: account.username, id: account.userId });
      case "refresh": {
        if (url.searchParams.get("grant_type") !== "ig_refresh_token")
          return graphError(400, 100, "Invalid grant_type");
        // Meta refreshes a long-lived token only once it is a day old.
        if (clock.now() - account.issuedAt < DAY) {
          return graphError(400, 190, "The access token is too new to be refreshed.", {
            error_subcode: 2207051,
          });
        }
        const fresh = `${token.split("~")[0]}~${newId()}`;
        tokens.set(fresh, { ...account, issuedAt: clock.now(), expired: false });
        return Response.json({ access_token: fresh, token_type: "bearer", expires_in: LONG_LIVED_SECONDS });
      }
      case "container": {
        if (parts[1] !== account.userId) return graphError(400, 100, "Unsupported post request");
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const imageUrl = typeof body.image_url === "string" ? body.image_url : "";
        const caption = typeof body.caption === "string" ? body.caption : "";
        if (caption.length > 2200) return graphError(400, 100, "The caption is too long.");
        const image = await download(imageUrl);
        if (!(image instanceof Uint8Array)) return image;
        const id = newId();
        containers.set(id, {
          id,
          userId: account.userId,
          caption,
          altText: typeof body.alt_text === "string" ? body.alt_text : null,
          image,
          imageUrl,
          status: "IN_PROGRESS",
          pollsLeft: processingPolls,
        });
        return Response.json({ id });
      }
      case "status": {
        const container = containers.get(parts[1] ?? "");
        if (container === undefined || container.userId !== account.userId) {
          return graphError(400, 100, "Object does not exist");
        }
        if (container.status === "IN_PROGRESS") {
          if (container.pollsLeft <= 0) container.status = "FINISHED";
          else container.pollsLeft--;
        }
        return Response.json({ id: container.id, status_code: container.status });
      }
      case "permalink": {
        const found = media.find((item) => item.id === parts[1] && item.userId === account.userId);
        if (found === undefined) return graphError(400, 100, "Object does not exist");
        return Response.json({ id: found.id, permalink: found.permalink });
      }
      case "publish": {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const container = containers.get(String(body.creation_id ?? ""));
        if (container === undefined || container.userId !== account.userId || parts[1] !== account.userId) {
          return graphError(400, 100, "Media ID is not available", { error_subcode: 2207027 });
        }
        if (container.status === "PUBLISHED") {
          return graphError(400, 9007, "The media has already been published", { error_subcode: 2207027 });
        }
        if (container.status !== "FINISHED") {
          return graphError(400, 9007, "Media ID is not available", { error_subcode: 2207027 });
        }
        container.status = "PUBLISHED";
        const id = newId();
        media.push({
          id,
          containerId: container.id,
          userId: account.userId,
          caption: container.caption,
          altText: container.altText,
          image: container.image,
          imageUrl: container.imageUrl,
          permalink: `https://fake-instagram.invalid/p/${id.slice(-11)}/`,
          timestamp: new Date(clock.now()).toISOString(),
        });
        return Response.json({ id });
      }
      case "media": {
        const data = media
          .filter((item) => item.userId === account.userId)
          .reverse()
          .map(({ id, caption, permalink, timestamp }) => ({ id, caption, permalink, timestamp }));
        return Response.json({ data });
      }
    }
  }

  function tokenAccount(token: string | null): Token | undefined {
    if (token === null || token === "") return undefined;
    const found = tokens.get(token);
    if (found !== undefined || !acceptAnyToken) return found;
    const account: Token = {
      userId: newId(),
      username: "fake_account",
      issuedAt: clock.now(),
      expired: false,
    };
    tokens.set(token, account);
    return account;
  }

  /**
   * Fetches an image as Meta does: a JPEG of at most 8 MB, 4:5 to 1.91:1. A refusal is Meta's
   * documented error for it, with the URI in the message where Meta puts it there.
   */
  async function download(imageUrl: string): Promise<Uint8Array | Response> {
    const unfetched = () =>
      graphError(400, 9004, `The media could not be fetched from this uri: ${imageUrl}`, {
        error_subcode: 2207052,
        error_user_msg: `The media could not be fetched from this uri: ${imageUrl}`,
      });
    let response: Response;
    try {
      response = await fetch(imageUrl, { signal: AbortSignal.timeout(10_000) });
    } catch {
      fetches.push({ url: imageUrl, status: 0 });
      return unfetched();
    }
    fetches.push({ url: imageUrl, status: response.status });
    if (!response.ok) return unfetched();
    const image = new Uint8Array(await response.arrayBuffer());
    if (image.byteLength > MAX_IMAGE_BYTES) {
      return graphError(400, 36000, "The image is too large to download. It should be less than 8 MiB.", {
        error_subcode: 2207004,
      });
    }
    const meta = await sharp(image)
      .metadata()
      .catch(() => undefined);
    if (meta?.format !== "jpeg") {
      return graphError(
        400,
        36001,
        `The image format ${meta?.format ?? "unknown"} is not supported. Supported formats are: JPEG.`,
        { error_subcode: 2207005 },
      );
    }
    const ratio = meta.width / meta.height;
    if (ratio < 0.8 - 1e-3 || ratio > 1.91) {
      return graphError(
        400,
        36003,
        `The submitted image with aspect ratio ${ratio.toFixed(2)} cannot be published. Please submit an image with a valid aspect ratio.`,
        { error_subcode: 2207009 },
      );
    }
    return image;
  }

  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    /** Adds an account that the token belongs to, issued now. */
    addAccount(token: string, account: FakeAccount = { userId: newId(), username: "selects_test" }) {
      tokens.set(token, { ...account, issuedAt: clock.now(), expired: false });
      return account;
    },
    /** Ages a token, as if it had been issued `ms` earlier. */
    ageToken(token: string, ms: number) {
      const found = tokens.get(token);
      if (found !== undefined) found.issuedAt -= ms;
    },
    expireToken(token: string) {
      const found = tokens.get(token);
      if (found !== undefined) found.expired = true;
    },
    /** Queues failures for the next requests to an operation, in order. */
    fail(operation: FakeOperation, ...kinds: FakeFailure[]) {
      failures.set(operation, [...(failures.get(operation) ?? []), ...kinds]);
    },
    /** How many status polls answer IN_PROGRESS before a new container finishes. */
    setProcessingPolls(polls: number) {
      processingPolls = polls;
    },
    /** Makes the next container report this status instead of finishing. */
    setContainerStatus(id: string, status: ContainerStatus) {
      const found = containers.get(id);
      if (found !== undefined) found.status = status;
    },
    containers: () => [...containers.values()],
    media,
    requests,
    fetches,
    stop() {
      for (const release of hanging.splice(0)) release();
      return server.stop(true);
    },
  };
}

export type FakeInstagram = ReturnType<typeof createFakeInstagram>;

function operationOf(method: string, parts: string[], query: URLSearchParams): FakeOperation | "unknown" {
  if (method === "GET" && parts.length === 1 && parts[0] === "refresh_access_token") return "refresh";
  if (parts[0] !== GRAPH_VERSION) return "unknown";
  const [, id, edge] = parts;
  if (method === "GET" && id === "me" && edge === undefined) return "me";
  if (method === "POST" && edge === "media") return "container";
  if (method === "POST" && edge === "media_publish") return "publish";
  if (method === "GET" && edge === "media") return "media";
  if (method === "GET" && id !== undefined && edge === undefined) {
    return query.get("fields")?.includes("permalink") ? "permalink" : "status";
  }
  return "unknown";
}

function graphError(status: number, code: number, message: string, extra: Record<string, unknown> = {}) {
  return Response.json(
    {
      error: {
        message,
        type: code === 190 ? "OAuthException" : "IGApiException",
        code,
        ...extra,
        fbtrace_id: "AfakeTrace",
      },
    },
    { status },
  );
}
