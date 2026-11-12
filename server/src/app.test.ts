import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { openDatabase } from "./db";

const rootPackage = await Bun.file(join(import.meta.dir, "../../package.json")).json();

let dataDir: string;
let db: Database;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "selects-app-"));
  db = openDatabase(dataDir, ["CREATE TABLE t (id INTEGER PRIMARY KEY)"]);
});
afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const appWith = (env: Record<string, string> = {}, webDir = join(dataDir, "no-ui")) =>
  createApp({ config: loadConfig({ DATA_DIR: dataDir, ...env }), db, webDir });

const get = (app: ReturnType<typeof createApp>, path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://selects.test${path}`, init));

describe("GET /api/health", () => {
  test("returns the app version and database status", async () => {
    const response = await get(appWith(), "/api/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: rootPackage.version,
      database: { status: "ok", schemaVersion: 1 },
    });
  });

  test("reports an unreachable database as unavailable", async () => {
    const app = appWith();
    db.close();

    const response = await get(app, "/api/health");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      version: rootPackage.version,
      database: { status: "error" },
    });
  });
});

describe("unknown API routes", () => {
  test("return a JSON 404 rather than the UI", async () => {
    const response = await get(appWith(), "/api/nope");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});

describe("the built UI", () => {
  let webDir: string;
  beforeEach(() => {
    webDir = join(dataDir, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Selects</title>");
    writeFileSync(join(webDir, "assets", "index-abc123.js"), "console.log('ui')");
    writeFileSync(join(webDir, "site.webmanifest"), "{}");
    writeFileSync(join(dataDir, "outside.txt"), "not for the browser");
  });

  test("serves index.html at the root", async () => {
    const response = await get(appWith({}, webDir), "/");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith("text/html");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.text()).toContain("<title>Selects</title>");
  });

  test("serves index.html for a screen route so the client router can take over", async () => {
    const response = await get(appWith({}, webDir), "/queue");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>Selects</title>");
  });

  test("serves hashed assets with a long cache lifetime", async () => {
    const response = await get(appWith({}, webDir), "/assets/index-abc123.js");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await response.text()).toBe("console.log('ui')");
  });

  test("serves other public files", async () => {
    const response = await get(appWith({}, webDir), "/site.webmanifest");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("{}");
  });

  test("returns 404 for a missing file instead of the page", async () => {
    const response = await get(appWith({}, webDir), "/assets/missing.js");

    expect(response.status).toBe(404);
  });

  test("never serves a file outside the UI directory", async () => {
    for (const path of ["/..%2foutside.txt", "/%2e%2e/outside.txt", "/assets/..%2f..%2foutside.txt"]) {
      const response = await get(appWith({}, webDir), path);

      expect(await response.text()).not.toContain("not for the browser");
    }
  });

  test("explains how to build the UI when it is missing", async () => {
    const response = await get(appWith(), "/");

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("bun run build");
  });
});

describe("the optional password", () => {
  let webDir: string;
  beforeEach(() => {
    webDir = join(dataDir, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Selects</title>");
    writeFileSync(join(webDir, "assets", "index-abc123.js"), "console.log('ui')");
  });

  const locked = () => appWith({ SELECTS_PASSWORD: "correct horse" }, webDir);

  const logIn = (app: ReturnType<typeof createApp>, password: string, next?: string) => {
    const form = new URLSearchParams({ password });
    if (next !== undefined) form.set("next", next);
    return get(app, "/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
  };

  const sessionCookie = (response: Response) => {
    const header = response.headers.get("set-cookie") ?? "";
    return header.split(";")[0] ?? "";
  };

  test("leaves the whole app open when unset", async () => {
    const app = appWith({}, webDir);

    expect((await get(app, "/api/health")).status).toBe(200);
    expect(await (await get(app, "/library")).text()).toContain("<title>Selects</title>");
  });

  test("refuses API calls without a session", async () => {
    const response = await get(locked(), "/api/health");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  test("shows a password form in place of any page", async () => {
    for (const path of ["/", "/queue", "/assets/index-abc123.js"]) {
      const response = await get(locked(), path);
      const body = await response.text();

      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toStartWith("text/html");
      expect(body).toContain('name="password"');
      expect(body).not.toContain("<title>Selects</title>");
      expect(body).not.toContain("console.log('ui')");
    }
  });

  test("rejects a wrong password without starting a session", async () => {
    const response = await logIn(locked(), "wrong");

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toContain("Wrong password");
  });

  test("a correct password starts a session that opens the API and the UI", async () => {
    const app = locked();
    const login = await logIn(app, "correct horse");

    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe("/");
    const setCookie = login.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("correct horse");

    const cookie = sessionCookie(login);
    expect((await get(app, "/api/health", { headers: { cookie } })).status).toBe(200);
    const page = await get(app, "/queue", { headers: { cookie } });
    expect(await page.text()).toContain("<title>Selects</title>");
  });

  test("returns to the page that asked for the password", async () => {
    const login = await logIn(locked(), "correct horse", "/queue");

    expect(login.headers.get("location")).toBe("/queue");
  });

  test("never redirects off the app after logging in", async () => {
    for (const next of ["//elsewhere.test/", "https://elsewhere.test/", "/\\elsewhere.test"]) {
      const login = await logIn(locked(), "correct horse", next);

      expect(login.headers.get("location")).toBe("/");
    }
  });

  test("goes home after logging in from a reloaded login page", async () => {
    const page = await get(locked(), "/login");
    expect(await page.text()).toContain('name="next" value="/"');

    const login = await logIn(locked(), "correct horse", "/login");
    expect(login.headers.get("location")).toBe("/");
  });

  test("changing the password ends existing sessions", async () => {
    const cookie = sessionCookie(await logIn(locked(), "correct horse"));
    const changed = appWith({ SELECTS_PASSWORD: "new password" }, webDir);

    expect((await get(changed, "/api/health", { headers: { cookie } })).status).toBe(401);
  });

  test("ignores a forged session cookie", async () => {
    const cookie = "selects_session=forged";

    expect((await get(locked(), "/api/health", { headers: { cookie } })).status).toBe(401);
  });
});
