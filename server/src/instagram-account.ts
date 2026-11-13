import type { Database } from "bun:sqlite";
import { type Clock, DAY } from "./clock";
import type { InstagramMode } from "./config";
import { type InstagramApi, InstagramError } from "./instagram";

/** The connected account as the API shows it. Never the token. */
export type AccountView = {
  username: string;
  /** `invalid`: Instagram no longer accepts the token, and a new one must be pasted. */
  status: "connected" | "invalid";
  connectedAt: number;
  /**
   * When the token in use expires, in milliseconds since the epoch. Null until a refresh has
   * told it: the expiry of a pasted token is never guessed.
   */
  expiresAt: number | null;
  /**
   * How the last refresh went: `too-new` when the token was too new to refresh when pasted (it is
   * refreshed once a day old), `failed` when it could not be refreshed for another reason.
   */
  refresh: RefreshState;
};

export type RefreshState = "refreshed" | "too-new" | "failed";

/** A token is refreshed once it is this old: Meta refreshes a token only from a day old. */
const REFRESH_AFTER_MS = DAY;

type Row = {
  token: string;
  user_id: string;
  username: string;
  status: "connected" | "invalid";
  connected_at: number;
  refreshed_at: number;
  expires_at: number | null;
  refresh: RefreshState;
};

/**
 * The Instagram account: its long-lived token, pasted once in Settings and kept in the database.
 * The token is refreshed once a day, long before its 60 days run out. It is never returned by
 * `view`, never logged and never put in an error.
 */
export function createInstagramAccount({
  db,
  api,
  clock,
  mode = "fake",
}: {
  db: Database;
  api: InstagramApi;
  clock: Clock;
  /**
   * Which Instagram the account belongs to. Each mode keeps its own account, so a run against
   * the fake never reads, refreshes or replaces the real account's token.
   */
  mode?: InstagramMode;
}) {
  const table = mode === "live" ? "instagram_account" : "instagram_account_fake";
  let turns = 0;
  const row = () => db.query<Row, []>(`SELECT * FROM ${table} WHERE id = 1`).get();

  const save = (values: Row) => {
    db.query(
      `INSERT INTO ${table} (id, token, user_id, username, status, connected_at, refreshed_at, expires_at, refresh)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET token = excluded.token, user_id = excluded.user_id,
         username = excluded.username, status = excluded.status, connected_at = excluded.connected_at,
         refreshed_at = excluded.refreshed_at, expires_at = excluded.expires_at, refresh = excluded.refresh`,
    ).run(
      values.token,
      values.user_id,
      values.username,
      values.status,
      values.connected_at,
      values.refreshed_at,
      values.expires_at,
      values.refresh,
    );
  };

  const toView = (found: Row): AccountView => ({
    username: found.username,
    status: found.status,
    connectedAt: found.connected_at,
    expiresAt: found.expires_at,
    refresh: found.refresh,
  });

  /** Only one refresh at a time, so two never trade the same token in. */
  let refreshing: Promise<void> | undefined;

  async function refreshNow(found: Row): Promise<void> {
    try {
      const fresh = await api.refresh(found.token);
      // Only if the token is still the one refreshed: it may have been replaced meanwhile.
      db.query(
        `UPDATE ${table} SET token = ?, refreshed_at = ?, expires_at = ?, refresh = 'refreshed', status = 'connected' WHERE id = 1 AND token = ?`,
      ).run(fresh.token, clock.now(), clock.now() + fresh.expiresInSeconds * 1000, found.token);
    } catch (error) {
      db.query(`UPDATE ${table} SET refresh = 'failed' WHERE id = 1 AND token = ?`).run(found.token);
      if (error instanceof InstagramError && error.kind === "token") {
        db.query(`UPDATE ${table} SET status = 'invalid' WHERE id = 1 AND token = ?`).run(found.token);
        console.error("Instagram no longer accepts the token. Paste a new one in Settings.");
        return;
      }
      console.error(`The Instagram token could not be refreshed; it will be tried again (${kindOf(error)}).`);
    }
  }

  return {
    view(): AccountView | null {
      const found = row();
      return found === null ? null : toView(found);
    },

    /**
     * Connects the account a pasted token belongs to, replacing any other. The token is refreshed
     * at once when Meta allows, which also gives its real expiry.
     */
    async connect(token: string): Promise<AccountView> {
      // Only the newest connect or disconnect decides what is kept: a slower, older one is dropped.
      const turn = ++turns;
      let owner: { userId: string; username: string };
      try {
        owner = await api.me(token);
      } catch (error) {
        if (
          error instanceof InstagramError &&
          (error.kind === "token" || error.kind === "refused" || error.kind === "permission")
        ) {
          throw new InstagramError(
            "token",
            "Instagram did not accept the token. Check it and paste it again.",
          );
        }
        throw new InstagramError(
          "transient",
          "Instagram could not be reached to check the token. Try again.",
        );
      }
      // Refreshed at once when Meta allows, which tells its real expiry. Otherwise its expiry is
      // unknown, and the daily refresh tries again once a day has passed.
      let current: { token: string; expiresAt: number | null; refresh: RefreshState } = {
        token,
        expiresAt: null,
        refresh: "failed",
      };
      try {
        const fresh = await api.refresh(token);
        current = {
          token: fresh.token,
          expiresAt: clock.now() + fresh.expiresInSeconds * 1000,
          refresh: "refreshed",
        };
      } catch (error) {
        if (error instanceof InstagramError && error.kind === "too-new") current.refresh = "too-new";
        else console.error(`The pasted Instagram token could not be refreshed (${kindOf(error)}).`);
      }
      if (turn !== turns) {
        throw new InstagramError("transient", "The account was changed again while this token was checked.");
      }
      save({
        token: current.token,
        user_id: owner.userId,
        username: owner.username,
        status: "connected",
        connected_at: clock.now(),
        refreshed_at: clock.now(),
        expires_at: current.expiresAt,
        refresh: current.refresh,
      });
      return toView(row() as Row);
    },

    disconnect(): void {
      turns++;
      db.query(`DELETE FROM ${table} WHERE id = 1`).run();
    },

    /** The token and account to publish with, or undefined when none is connected and accepted. */
    credentials(): { token: string; userId: string } | undefined {
      const found = row();
      if (found === null || found.status !== "connected") return undefined;
      return { token: found.token, userId: found.user_id };
    },

    /** Records that Instagram refused the token while publishing. */
    markInvalid(token: string): void {
      db.query(`UPDATE ${table} SET status = 'invalid' WHERE id = 1 AND token = ?`).run(token);
    },

    /** Refreshes the token once it is a day old. Run every hour, and before each publish. */
    async refreshIfDue(): Promise<void> {
      if (refreshing !== undefined) return refreshing;
      const found = row();
      if (found === null || found.status !== "connected") return;
      if (clock.now() - found.refreshed_at < REFRESH_AFTER_MS) return;
      refreshing = refreshNow(found).finally(() => {
        refreshing = undefined;
      });
      return refreshing;
    },
  };
}

export type InstagramAccount = ReturnType<typeof createInstagramAccount>;

function kindOf(error: unknown): string {
  return error instanceof InstagramError ? error.kind : "unexpected error";
}
