/**
 * A fake S3-compatible bucket served over real HTTP inside the process, for tests and
 * `bun run dev`. It speaks the path-style requests Bun's S3 client sends, checks that each is
 * signed with the expected key ID (never the signature itself), and serves objects back either
 * through a presigned link or under a public base URL, as a real bucket would.
 */

export type StoredObject = {
  bytes: Uint8Array;
  contentType: string | null;
  /** Every request header that was stored with the object: metadata, disposition and the like. */
  headers: Record<string, string>;
};

/** Headers a client sends with every request, which are not stored with an object. */
const TRANSPORT_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "authorization",
  "connection",
  "content-length",
  "content-type",
  "host",
  "user-agent",
  "x-amz-content-sha256",
  "x-amz-date",
]);

export const FAKE_BUCKET_KEYS = { accessKeyId: "FAKEACCESSKEY", secretAccessKey: "fake-secret-not-real" };

export function createFakeBucket({
  name = "selects",
  accessKeyId = FAKE_BUCKET_KEYS.accessKeyId,
  port = 0,
}: {
  name?: string;
  accessKeyId?: string;
  port?: number;
} = {}) {
  const objects = new Map<string, StoredObject>();
  /** Requests answered, without their query or headers. */
  const requests: { method: string; path: string }[] = [];
  let failures = 0;
  let readsFail = false;
  let hanging = false;
  let slowWrites = 0;
  /** How far the bucket's clock runs ahead of this one, in milliseconds. */
  let ahead = 0;
  const held: (() => void)[] = [];

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const path = decodeURIComponent(url.pathname);
      requests.push({ method: request.method, path });

      const publicPrefix = "/public/";
      if (readsFail && (request.method === "GET" || request.method === "HEAD")) return error(503, "SlowDown");
      if (path.startsWith(publicPrefix)) {
        if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
        return serve(path.slice(publicPrefix.length));
      }

      const prefix = `/${name}/`;
      if (!path.startsWith(prefix)) return error(404, "NoSuchBucket");
      const key = path.slice(prefix.length);

      if (request.method === "GET" || request.method === "HEAD") {
        if (!presignedFor(url)) return error(403, "AccessDenied");
        return serve(key);
      }

      // A write is signed in its header, or through a presigned link for an object with headers.
      if (!signedFor(request) && !(request.method === "PUT" && presignedFor(url))) {
        return error(403, "SignatureDoesNotMatch");
      }
      if (hanging) {
        return new Promise<Response>((resolve) =>
          held.push(() => resolve(new Response(null, { status: 504 }))),
        );
      }
      if (slowWrites > 0 && request.method === "PUT") await Bun.sleep(slowWrites);
      if (failures > 0) {
        failures--;
        return error(503, "SlowDown");
      }
      if (request.method === "PUT") {
        const headers: Record<string, string> = {};
        for (const [header, value] of request.headers) {
          if (!TRANSPORT_HEADERS.has(header)) headers[header] = value;
        }
        objects.set(key, {
          bytes: new Uint8Array(await request.arrayBuffer()),
          contentType: request.headers.get("content-type"),
          headers,
        });
        return new Response(null, { status: 200, headers: { etag: `"${objects.size}"` } });
      }
      if (request.method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405 });
    },
  });

  function signedFor(request: Request): boolean {
    const authorization = request.headers.get("authorization") ?? "";
    return authorization.startsWith(`AWS4-HMAC-SHA256 Credential=${accessKeyId}/`);
  }

  /** A presigned link: signed for this key ID, and not yet expired. */
  function presignedFor(url: URL): boolean {
    const query = url.searchParams;
    const credential = query.get("X-Amz-Credential") ?? "";
    const date = query.get("X-Amz-Date") ?? "";
    const expires = Number(query.get("X-Amz-Expires"));
    if (!credential.startsWith(`${accessKeyId}/`) || query.get("X-Amz-Signature") === null) return false;
    const signedAt = Date.parse(
      date.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"),
    );
    return (
      Number.isFinite(signedAt) && Number.isFinite(expires) && Date.now() + ahead <= signedAt + expires * 1000
    );
  }

  function serve(key: string): Response {
    const object = objects.get(key);
    if (object === undefined) return error(404, "NoSuchKey");
    const cacheControl = object.headers["cache-control"];
    return new Response(object.bytes, {
      headers: {
        "content-type": object.contentType ?? "binary/octet-stream",
        ...(cacheControl === undefined ? {} : { "cache-control": cacheControl }),
      },
    });
  }

  const endpoint = `http://127.0.0.1:${server.port}`;
  return {
    name,
    endpoint,
    /** A public base URL that serves the bucket's objects, for a bucket set up with one. */
    publicBaseUrl: `${endpoint}/public`,
    objects,
    requests,
    /** The next `count` writes or deletes fail as a busy bucket's would. */
    failNext(count = 1) {
      failures = count;
    },
    /** While on, every read of an object fails, as an unreachable bucket's would. */
    failReads(on: boolean) {
      readsFail = on;
    },
    /** Makes each write take this long before it is stored and answered. */
    slow(ms: number) {
      slowWrites = ms;
    },
    /** Runs the bucket's clock this far ahead, as a bucket whose clock differs from Selects'. */
    clockAhead(ms: number) {
      ahead = ms;
    },
    /** While on, writes and deletes are taken and never answered. */
    hang(on: boolean) {
      hanging = on;
    },
    stop() {
      for (const release of held.splice(0)) release();
      return server.stop(true);
    },
  };
}

export type FakeBucket = ReturnType<typeof createFakeBucket>;

function error(status: number, code: string) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code></Error>`, {
    status,
    headers: { "content-type": "application/xml" },
  });
}
