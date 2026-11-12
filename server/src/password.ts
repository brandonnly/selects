import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The optional single password. When set, every request needs a session cookie, which
 * `POST /login` issues for the right password. The cookie is an HMAC of the password under a
 * random key kept in the data directory, so it reveals nothing about the password, survives
 * restarts, and stops working when the password changes.
 */

const COOKIE = "selects_session";
const ONE_YEAR = 60 * 60 * 24 * 365;
const tokensCss = readFileSync(resolve(import.meta.dir, "../../brand/tokens/selects.css"), "utf8");

export type Gate = (request: Request) => Promise<Response | undefined>;

/** Returns a response that stands in for the request, or undefined to let it through. */
export function passwordGate(password: string, dataDir: string): Gate {
  const key = sessionKey(dataDir);
  const tokenFor = (value: string) => createHmac("sha256", key).update(value).digest();
  const expected = tokenFor(password);
  const expectedHex = expected.toString("hex");

  return async (request) => {
    const url = new URL(request.url);

    if (url.pathname === "/login" && request.method === "POST") {
      const form = await request.formData().catch(() => undefined);
      const submitted = form?.get("password");
      const next = safeNext(form?.get("next"));
      if (typeof submitted !== "string" || !timingSafeEqual(tokenFor(submitted), expected)) {
        return loginPage(next, 401, "Wrong password.");
      }
      const secure = url.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
      const cookie = [
        `${COOKIE}=${expectedHex}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        `Max-Age=${ONE_YEAR}`,
        ...(secure ? ["Secure"] : []),
      ].join("; ");
      return new Response(null, { status: 303, headers: { location: next, "set-cookie": cookie } });
    }

    const session = readCookie(request.headers.get("cookie"), COOKIE);
    if (session !== undefined) {
      const candidate = Buffer.from(session);
      const wanted = Buffer.from(expectedHex);
      if (candidate.length === wanted.length && timingSafeEqual(candidate, wanted)) return undefined;
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    return loginPage(safeNext(url.pathname + url.search), 401);
  };
}

function sessionKey(dataDir: string): Buffer {
  const file = join(dataDir, "session.key");
  if (!existsSync(file)) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return Buffer.from(readFileSync(file, "utf8").trim(), "hex");
}

function readCookie(header: string | null, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

/**
 * Only same-app paths: one leading slash, never `//` or `/\`, which browsers treat as a host,
 * no control characters, which browsers strip before reading the path, and never the login page
 * itself.
 */
function safeNext(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  if (value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (hasControlCharacter(value)) return "/";
  if (new URL(value, "http://selects.invalid").pathname === "/login") return "/";
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function loginPage(next: string, status: number, error?: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>Selects · Password</title>
<script>if (matchMedia("(prefers-color-scheme: dark)").matches) document.documentElement.classList.add("dark");</script>
<style>
${tokensCss}
* { box-sizing: border-box; }
html { font-family: ui-sans-serif, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 16px;
  background: var(--background); color: var(--foreground); }
form { width: 100%; max-width: 20rem; display: grid; gap: 12px; }
h1 { margin: 0 0 4px; font-size: 1.25rem; font-weight: 600; }
label { font-size: 0.875rem; color: var(--muted-foreground); }
input { font: inherit; font-size: 16px; padding: 10px 12px; border-radius: var(--radius);
  border: 1px solid var(--input); background: var(--card); color: var(--card-foreground); }
input:focus-visible, button:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
button { font: inherit; font-weight: 500; padding: 10px 12px; border: 0; border-radius: var(--radius);
  background: var(--primary); color: var(--primary-foreground); cursor: pointer; }
p[role="alert"] { margin: 0; font-size: 0.875rem; color: var(--destructive); }
</style>
</head>
<body>
<form method="post" action="/login">
<h1>Selects</h1>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
${error ? `<p role="alert">${escapeHtml(error)}</p>` : ""}
<input type="hidden" name="next" value="${escapeHtml(next)}">
<button type="submit">Continue</button>
</form>
</body>
</html>
`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
