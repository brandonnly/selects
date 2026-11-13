import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeClock, DAY, type FakeClock, HOUR } from "./clock";
import { openDatabase } from "./db";
import { createFakeInstagram, type FakeInstagram } from "./fake-instagram";
import { createInstagramApi } from "./instagram";
import { createInstagramAccount, type InstagramAccount } from "./instagram-account";
import { migrations } from "./migrations";

const TOKEN = "IGfake-token-for-tests-0001";

let dataDir: string;
let db: Database;
let clock: FakeClock;
let fake: FakeInstagram;
let account: InstagramAccount;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "selects-account-"));
  db = openDatabase(dataDir, migrations);
  clock = createFakeClock();
  fake = createFakeInstagram({ clock });
  account = createInstagramAccount({ db, api: createInstagramApi({ baseUrl: fake.url }), clock });
});
afterEach(async () => {
  await fake.stop();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Everything printed to the console while `run` runs. */
async function printed(run: () => Promise<unknown>): Promise<string> {
  const lines: unknown[] = [];
  const spies = (["log", "error", "warn", "info", "debug"] as const).map((method) =>
    spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(...args);
    }),
  );
  try {
    await run().catch((error) => lines.push(error, (error as Error)?.message, (error as Error)?.stack));
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return lines.map((line) => Bun.inspect(line)).join("\n");
}

describe("connecting an Instagram account", () => {
  test("confirms the account a pasted token belongs to", async () => {
    fake.addAccount(TOKEN, { userId: "1784140001", username: "selects_test" });

    const view = await account.connect(TOKEN);

    expect(view).toMatchObject({ username: "selects_test", status: "connected" });
    expect(account.view()?.username).toBe("selects_test");
  });

  test("never shows the token again", async () => {
    fake.addAccount(TOKEN);

    const view = await account.connect(TOKEN);

    expect(JSON.stringify(view)).not.toContain(TOKEN);
    expect(JSON.stringify(account.view())).not.toContain(TOKEN);
    expect(Bun.inspect(account)).not.toContain(TOKEN);
  });

  test("refuses a token Instagram does not accept, and keeps nothing", async () => {
    let message = "";
    try {
      await account.connect("IGnot-a-real-token-0002");
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("Instagram did not accept the token");
    expect(message).not.toContain("IGnot-a-real-token-0002");
    expect(account.view()).toBeNull();
  });

  test("never logs the token, whether it is accepted or refused", async () => {
    fake.addAccount(TOKEN);

    const output = [
      await printed(() => account.connect(TOKEN)),
      await printed(() => account.connect("IGrefused-token-0003")),
    ].join("\n");

    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain("IGrefused-token-0003");
  });

  test("can be replaced by another account's token", async () => {
    fake.addAccount(TOKEN, { userId: "1", username: "first_account" });
    fake.addAccount("IGsecond-token-0004", { userId: "2", username: "second_account" });
    await account.connect(TOKEN);

    await account.connect("IGsecond-token-0004");

    expect(account.view()?.username).toBe("second_account");
  });

  test("can be removed", async () => {
    fake.addAccount(TOKEN);
    await account.connect(TOKEN);

    account.disconnect();

    expect(account.view()).toBeNull();
    expect(account.credentials()).toBeUndefined();
  });
});

describe("refreshing the token", () => {
  test("a token pasted the day it was made is refreshed once it is a day old", async () => {
    fake.addAccount(TOKEN);
    await account.connect(TOKEN);
    const before = account.credentials()?.token;
    // Its expiry is not guessed: it is unknown until a refresh tells it.
    expect(account.view()).toMatchObject({ expiresAt: null, refresh: "too-new" });

    await account.refreshIfDue();
    expect(account.credentials()?.token).toBe(before);

    clock.advance(DAY + HOUR);
    await account.refreshIfDue();

    const after = account.credentials()?.token;
    expect(after).not.toBe(before);
    expect(account.view()).toMatchObject({ expiresAt: clock.now() + 60 * DAY, refresh: "refreshed" });
  });

  test("a pasted token that cannot be refreshed for another reason is connected with a warning", async () => {
    fake.addAccount(TOKEN);
    fake.ageToken(TOKEN, 10 * DAY);
    fake.fail("refresh", "invalid");

    await account.connect(TOKEN);

    expect(account.view()).toMatchObject({ status: "connected", expiresAt: null, refresh: "failed" });
    // The daily refresh still runs, and clears the warning once it works.
    clock.advance(DAY + HOUR);
    await account.refreshIfDue();
    expect(account.view()).toMatchObject({ expiresAt: clock.now() + 60 * DAY, refresh: "refreshed" });
  });

  test("an older pasted token is refreshed when it is connected, learning its real expiry", async () => {
    fake.addAccount(TOKEN);
    fake.ageToken(TOKEN, 50 * DAY);

    await account.connect(TOKEN);

    expect(account.credentials()?.token).not.toBe(TOKEN);
    expect(account.view()?.expiresAt).toBe(clock.now() + 60 * DAY);
  });

  test("keeps refreshing, so a token never reaches its expiry", async () => {
    fake.addAccount(TOKEN);
    await account.connect(TOKEN);

    // Checked every hour for 120 days: twice the life of a token.
    for (let hour = 0; hour < 120 * 24; hour++) {
      clock.advance(HOUR);
      await account.refreshIfDue();
      const expiresAt = account.view()?.expiresAt ?? null;
      if (hour >= 25) expect(expiresAt ?? 0).toBeGreaterThan(clock.now());
    }
    expect(account.view()?.status).toBe("connected");
  });

  test("a refresh that fails for a while is tried again later", async () => {
    fake.addAccount(TOKEN);
    await account.connect(TOKEN);
    clock.advance(DAY + HOUR);
    fake.fail("refresh", "transient");

    const output = await printed(() => account.refreshIfDue());
    expect(account.view()?.status).toBe("connected");
    expect(output).not.toContain(TOKEN);

    await account.refreshIfDue();
    expect(account.credentials()?.token).not.toBe(TOKEN);
  });

  test("a token Instagram no longer accepts marks the account to be connected again", async () => {
    fake.addAccount(TOKEN);
    await account.connect(TOKEN);
    clock.advance(DAY + HOUR);
    fake.expireToken(TOKEN);

    const output = await printed(() => account.refreshIfDue());

    expect(account.view()?.status).toBe("invalid");
    expect(output).not.toContain(TOKEN);
  });
});
