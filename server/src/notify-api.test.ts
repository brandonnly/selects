import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { createFakeClock } from "./clock";
import { loadConfig } from "./config";
import { openDatabase } from "./db";
import { migrations } from "./migrations";

const TOPIC = "selects-api-topic-0001";
const NTFY_TOKEN = "tk_fake_api_token_0001";
const HOOK_SECRET = "api-hook-secret-0001";

let dataDir: string;
let db: Database;
let app: ReturnType<typeof createApp>;
let received: number;
let receiver: ReturnType<typeof Bun.serve>;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "selects-notify-api-"));
  db = openDatabase(dataDir, migrations);
  received = 0;
  receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      received++;
      return new Response("ok");
    },
  });
  // Fake mode, the default.
  app = createApp({
    config: loadConfig({ DATA_DIR: dataDir }),
    db,
    webDir: join(dataDir, "no-ui"),
    clock: createFakeClock(),
  });
});
afterEach(async () => {
  await receiver.stop(true);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const send = (method: string, path: string, body?: unknown) =>
  app.fetch(
    new Request(`http://selects.test${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

describe("notification settings", () => {
  test("an ntfy topic and a webhook are saved, shown without their secrets, and tested", async () => {
    const ntfy = await send("PUT", "/api/notifications/ntfy", {
      server: `http://127.0.0.1:${receiver.port}`,
      topic: TOPIC,
      token: NTFY_TOKEN,
    });
    expect(ntfy.status).toBe(200);
    const hook = await send("PUT", "/api/notifications/webhook", {
      url: `http://127.0.0.1:${receiver.port}/hooks/${HOOK_SECRET}`,
    });
    expect(hook.status).toBe(200);

    const view = await (await send("GET", "/api/notifications")).json();
    expect(view).toMatchObject({
      mode: "fake",
      ntfy: { topic: "sel…", token: true, lastError: null },
      webhook: { url: `http://127.0.0.1:${receiver.port}/…` },
      events: { posted: true, failed: true, token: true, pool: true },
      poolThreshold: 10,
      recent: [],
    });
    for (const secret of [TOPIC, NTFY_TOKEN, HOOK_SECRET]) expect(JSON.stringify(view)).not.toContain(secret);

    for (const channel of ["ntfy", "webhook"]) {
      const tested = await send("POST", `/api/notifications/${channel}/test`);
      expect(tested.status).toBe(200);
      expect(await tested.json()).toMatchObject({ status: "would-send" });
    }
    // Fake mode: nothing left the process.
    expect(received).toBe(0);
  });

  test("a URL that is not http or https is refused with the reason", async () => {
    const response = await send("PUT", "/api/notifications/webhook", { url: "file:///etc/passwd" });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ problems: ["The webhook URL must be an http or https URL."] });
  });

  test("a channel is removed", async () => {
    await send("PUT", "/api/notifications/webhook", { url: "https://hooks.invalid/x" });

    expect((await send("DELETE", "/api/notifications/webhook")).status).toBe(204);

    expect(
      ((await (await send("GET", "/api/notifications")).json()) as { webhook: unknown }).webhook,
    ).toBeNull();
    expect((await send("POST", "/api/notifications/webhook/test")).status).toBe(404);
  });

  test("each event's switch and the pool threshold are saved", async () => {
    const saved = await send("PUT", "/api/notifications/events", {
      events: { posted: false, failed: true, token: true, pool: false },
      poolThreshold: 25,
    });

    expect(saved.status).toBe(200);
    expect(await (await send("GET", "/api/notifications")).json()).toMatchObject({
      events: { posted: false, failed: true, token: true, pool: false },
      poolThreshold: 25,
    });
    const bad = await send("PUT", "/api/notifications/events", {
      events: { posted: true, failed: true, token: true, pool: true },
      poolThreshold: 0,
    });
    expect(bad.status).toBe(422);
  });
});

describe("backups", () => {
  test("show the last copy and the copies kept", async () => {
    const response = await send("GET", "/api/backups");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      lastAt: null,
      lastError: null,
      copies: [],
      kept: 7,
      time: "03:30",
      timeZone: "UTC",
    });
  });
});
