import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Bucket, BucketError } from "./bucket";
import type { CaptionStore } from "./caption-store";
import { buildCaption, checkCaption, type LimitCheck } from "./captions";
import type { Captures, PublishedCapture } from "./capture";
import { type Clock, MINUTE } from "./clock";
import { FRAME_HEIGHT, FRAME_WIDTH, type FrameRenderer } from "./frame";
import { type InstagramApi, InstagramError } from "./instagram";
import type { InstagramAccount } from "./instagram-account";
import { errorKind, type Library } from "./library";
import type { Settings } from "./settings";

/**
 * - `publishing`: being sent now, or waiting its turn.
 * - `retrying`: an attempt failed; the next is at `nextAttemptAt`.
 * - `published`: on Instagram.
 * - `failed`: given up on. Its selects are back in the pool.
 * - `dry-run`: rendered and recorded only; nothing was uploaded or published.
 */
export type PostState = "publishing" | "retrying" | "published" | "failed" | "dry-run";

/** What a dry run did, and what it would have done. */
export type DryRunReport = {
  frame: { width: number; height: number; bytes: number };
  check: LimitCheck;
  /** The object a real publish would upload, and how Instagram would be given it; null with no bucket. */
  upload: { key: string; url: "public" | "presigned"; publicUrl: string | null } | null;
  /** The account a real publish would post to; null with none connected. */
  account: string | null;
  /** What would stop a real publish. */
  problems: string[];
};

/** A post as the API shows it. Never a token or a presigned link. */
export type Post = {
  id: string;
  state: PostState;
  /** The selects in the post, in order. One in version 1. A select deleted since is left out. */
  selectIds: string[];
  caption: string;
  altText: string;
  hashtagSet: string | null;
  attempts: number;
  nextAttemptAt: number | null;
  permalink: string | null;
  /** Why the last attempt failed. */
  error: string | null;
  createdAt: number;
  publishedAt: number | null;
  report: DryRunReport | null;
};

export type PublishRequest = {
  selectIds: string[];
  /** Default: the dry run switch in Settings. */
  dryRun?: boolean;
  /** The hashtag set, by name, in place of one chosen at random: the one the owner was shown. */
  hashtagSet?: string;
  /** What the owner confirmed. When it no longer matches what would be sent, nothing is. */
  expect?: { caption: string; altText: string };
};

export type PublishResult =
  /** Claimed: `done` settles when the first attempt has finished, or the dry run is recorded. */
  | { status: "started"; post: Post; done: Promise<Post> }
  | { status: "not-found" }
  /** Posted, being posted, or marked as already posted. */
  | { status: "not-in-pool" }
  /** No bucket, or no account to publish to. Nothing was recorded. */
  | { status: "unavailable"; problems: string[] }
  /** The caption or alt text is no longer what the owner confirmed. */
  | { status: "changed"; caption: string; altText: string };

/** What a post would send now, for the owner to confirm. */
export type PostPreview = {
  caption: string;
  altText: string;
  hashtagSet: string | null;
  check: LimitCheck;
  /** What would stop it being published. */
  problems: string[];
  dryRun: boolean;
  account: string | null;
  url: "public" | "presigned" | null;
};

export type PublisherOptions = {
  db: Database;
  dataDir: string;
  library: Library;
  captures: Captures;
  renderer: Pick<FrameRenderer, "render">;
  settings: Settings;
  captionStore: CaptionStore;
  account: InstagramAccount;
  api: InstagramApi;
  /** The bucket, or the variables it still needs. */
  bucket: Bucket | { missing: string[] };
  clock: Clock;
  /** Picks a hashtag set. Default: Math.random. */
  random?: () => number;
};

/** The wait before each retry: three retries over fifteen minutes. */
export const RETRY_DELAYS = [2 * MINUTE, 5 * MINUTE, 8 * MINUTE] as const;

/** How often a container is checked while Instagram processes it, and for how long. */
const POLL_MS = 5_000;
const MAX_POLLS = 60;

/** How often the content is built again when a select's capture data changes during an attempt. */
const MAX_ROUNDS = 3;

/**
 * A container that was asked to publish, then found unpublished, is taken for unpublished only
 * after this long: Instagram may still be publishing it.
 */
const PUBLISH_SETTLE_MS = 10 * MINUTE;

/** Dry runs kept, with their frames. */
const DRY_RUNS_KEPT = 20;

type PostRow = {
  id: string;
  state: PostState;
  caption: string;
  alt_text: string;
  hashtag_set: string | null;
  capture: string;
  attempts: number;
  next_attempt_at: number | null;
  object_key: string | null;
  container_id: string | null;
  publish_requested_at: number | null;
  media_id: string | null;
  permalink: string | null;
  error: string | null;
  report: string | null;
  created_at: number;
  published_at: number | null;
};

type Column = Exclude<keyof PostRow, "id" | "created_at">;

/** A failure that says whether it is worth another attempt. */
class PostFailure extends Error {
  override name = "PostFailure";
  constructor(
    message: string,
    readonly retry: boolean,
    /** Try again at once, and do not count this attempt: it never had a fair chance. */
    readonly again = false,
  ) {
    super(message);
  }
}

/** What a post sends: built from the published capture data, and the fingerprint of that data. */
type Content = {
  sources: { path: string; capture: PublishedCapture }[];
  /** The published capture data as JSON: when it changes, the frame and caption are built again. */
  fingerprint: string;
  caption: string;
  altText: string;
  hashtagSet: string | null;
  check: LimitCheck;
};

/**
 * Publishes posts to Instagram through the bucket (ADR 0003, ADR 0006). "Post now" and the
 * scheduler call `publish`; `runDue` runs the retries that are due and is called on a timer.
 *
 * Each attempt renders the frame from `captures.published`, uploads it under a random key,
 * creates an Instagram container from its URL, waits for it to finish and publishes it. The
 * capture data is taken again before the upload and before the publish call; when it has
 * changed (a privacy zone added, a location hidden) the frame and caption are built again.
 *
 * A post is never published twice: the container ID is recorded before Instagram is asked to
 * publish it, Instagram publishes a container once, and an attempt that finds a container that
 * may have been published checks it before doing anything else. Attempts run one at a time, and
 * a stale attempt (one from before a restart) can no longer write to its post.
 */
export function createPublisher(options: PublisherOptions) {
  const { db, library, captures, renderer, settings, captionStore, account, api, clock } = options;
  const random = options.random ?? Math.random;
  const dryRunDir = join(options.dataDir, "dry-runs");

  const row = (id: string) => db.query<PostRow, [string]>("SELECT * FROM posts WHERE id = ?").get(id);
  const selectIdsOf = (id: string) =>
    db
      .query<{ select_id: string | null }, [string]>(
        "SELECT select_id FROM post_selects WHERE post_id = ? ORDER BY position",
      )
      .all(id)
      .map((found) => found.select_id)
      .filter((selectId): selectId is string => selectId !== null);

  const toPost = (found: PostRow): Post => ({
    id: found.id,
    state: found.state,
    selectIds: selectIdsOf(found.id),
    caption: found.caption,
    altText: found.alt_text,
    hashtagSet: found.hashtag_set,
    attempts: found.attempts,
    nextAttemptAt: found.next_attempt_at,
    permalink: found.permalink,
    error: found.error,
    createdAt: found.created_at,
    publishedAt: found.published_at,
    report: found.report === null ? null : (JSON.parse(found.report) as DryRunReport),
  });

  const postOf = (id: string): Post => {
    const found = row(id);
    if (found === null) throw new Error("The post is gone");
    return toPost(found);
  };

  // One attempt at a time, so two never work on the same post or race for a select.
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  const bucketProblem = (): string | undefined => {
    if (!("missing" in options.bucket)) return undefined;
    const names = options.bucket.missing;
    const listed =
      names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
    return `The bucket is not configured: set ${listed}.`;
  };

  const accountProblem = (): string | undefined => {
    const view = account.view();
    if (view === null) return "No Instagram account is connected.";
    if (view.status === "invalid")
      return "Instagram no longer accepts the token. Paste a new token in Settings.";
    return undefined;
  };

  /** The content of a post as it would be sent now. Undefined when a select is gone. */
  function build(selectIds: string[], hashtagSet: string | null | undefined): Content | undefined {
    const sources: Content["sources"] = [];
    for (const selectId of selectIds) {
      // The only way to capture data for publishing: edits applied and location privacy kept.
      const capture = captures.published(selectId);
      const original = library.original(selectId);
      if (capture === undefined || original === undefined) return undefined;
      sources.push({ path: original.path, capture });
    }
    const [first] = sources;
    const [firstId] = selectIds;
    if (first === undefined || firstId === undefined) return undefined;
    const caption = buildCaption({
      capture: first.capture,
      templates: captionStore.templates(),
      coordinateFormat: settings.frame().coordinateFormat,
      override: captionStore.override(firstId),
      hashtagSet: hashtagSet ?? undefined,
      random,
    });
    return {
      sources,
      fingerprint: JSON.stringify(sources.map((source) => source.capture)),
      caption: caption.caption,
      altText: caption.altText,
      hashtagSet: caption.hashtagSet,
      check: checkCaption(caption),
    };
  }

  async function render(content: Content): Promise<Uint8Array> {
    const [source] = content.sources;
    if (source === undefined) throw new PostFailure("The post has no select.", false);
    return new Uint8Array(await renderer.render(source, settings.frame()));
  }

  function insertPost(id: string, selectIds: string[], content: Content, extra: Partial<PostRow>) {
    db.query(
      `INSERT INTO posts (id, state, caption, alt_text, hashtag_set, capture, report, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      extra.state ?? "publishing",
      content.caption,
      content.altText,
      content.hashtagSet,
      content.fingerprint,
      extra.report ?? null,
      clock.now(),
    );
    for (const [position, selectId] of selectIds.entries()) {
      db.query("INSERT INTO post_selects (post_id, position, select_id) VALUES (?, ?, ?)").run(
        id,
        position,
        selectId,
      );
    }
  }

  async function dryRun(selectIds: string[], content: Content): Promise<Post> {
    const jpeg = await render(content);
    const bucket = "missing" in options.bucket ? undefined : options.bucket;
    const key = bucket?.newKey();
    const report: DryRunReport = {
      frame: { width: FRAME_WIDTH, height: FRAME_HEIGHT, bytes: jpeg.byteLength },
      check: content.check,
      upload:
        bucket === undefined || key === undefined
          ? null
          : { key, url: bucket.urlKind, publicUrl: bucket.urlKind === "public" ? bucket.urlFor(key) : null },
      account: account.view()?.status === "connected" ? (account.view()?.username ?? null) : null,
      problems: [
        ...content.check.problems,
        ...[bucketProblem(), accountProblem()].filter((p): p is string => p !== undefined),
      ],
    };
    const id = randomUUID();
    mkdirSync(dryRunDir, { recursive: true });
    writeFileSync(join(dryRunDir, `${id}.jpg`), jpeg);
    insertPost(id, selectIds, content, { state: "dry-run", report: JSON.stringify(report) });
    pruneDryRuns();
    console.log(
      `Dry run ${id}: rendered ${Math.round(jpeg.byteLength / 1024)} KB, caption ${content.check.captionCharacters} characters; nothing uploaded or published.${report.problems.length > 0 ? ` A real publish would stop: ${report.problems.join(" ")}` : ""}`,
    );
    return postOf(id);
  }

  function pruneDryRuns() {
    const old = db
      .query<{ id: string }, [number]>(
        "SELECT id FROM posts WHERE state = 'dry-run' ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?",
      )
      .all(DRY_RUNS_KEPT);
    for (const { id } of old) {
      db.query("DELETE FROM posts WHERE id = ?").run(id);
      rmSync(join(dryRunDir, `${id}.jpg`), { force: true });
    }
  }

  /** One attempt at a post. Writes to the post only while it is this attempt's. */
  async function attempt(id: string): Promise<void> {
    const claimed = db
      .transaction(() => {
        const found = row(id);
        // A new post's first attempt, or a retry whose wait is over: never a retry early.
        const fresh = found?.state === "publishing" && found.attempts === 0;
        const due =
          found?.state === "retrying" &&
          found.next_attempt_at !== null &&
          found.next_attempt_at <= clock.now();
        if (found === null || !(fresh || due)) return undefined;
        db.query(
          "UPDATE posts SET state = 'publishing', attempts = attempts + 1, next_attempt_at = NULL WHERE id = ?",
        ).run(id);
        return row(id) ?? undefined;
      })
      .immediate();
    if (claimed === undefined) return;
    const number = claimed.attempts;

    const update = (fields: Partial<Record<Column, string | number | null>>) => {
      const columns = Object.keys(fields) as Column[];
      db.query(
        `UPDATE posts SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE id = ? AND attempts = ?`,
      ).run(...columns.map((c) => fields[c] ?? null), id, number);
    };
    const current = () => row(id) ?? claimed;

    // The token this attempt sends: a refusal means that token, not one pasted since.
    const used: { token?: string } = {};
    try {
      await publishPost(claimed, update, current, used);
    } catch (error) {
      const failure = asFailure(error, used.token);
      const final = !failure.retry || number > RETRY_DELAYS.length;
      if (failure.again) {
        update({
          state: "retrying",
          error: failure.message,
          next_attempt_at: clock.now(),
          attempts: number - 1,
        });
        console.error(`Post ${id} attempt ${number} is tried again at once: ${failure.message}`);
      } else if (final) {
        update({ state: "failed", error: failure.message, next_attempt_at: null });
        console.error(
          `Post ${id} failed after ${number} attempt${number === 1 ? "" : "s"}: ${failure.message}`,
        );
        await dropObject(id);
      } else {
        const delay = RETRY_DELAYS[number - 1] ?? 0;
        update({ state: "retrying", error: failure.message, next_attempt_at: clock.now() + delay });
        console.error(
          `Post ${id} attempt ${number} failed; retrying in ${delay / MINUTE} minutes: ${failure.message}`,
        );
      }
    }
  }

  async function publishPost(
    post: PostRow,
    update: (fields: Partial<Record<Column, string | number | null>>) => void,
    current: () => PostRow,
    used: { token?: string },
  ): Promise<void> {
    const bucketMissing = bucketProblem();
    if (bucketMissing !== undefined || "missing" in options.bucket) {
      throw new PostFailure(bucketMissing ?? "The bucket is not configured.", false);
    }
    const bucket = options.bucket;
    await account.refreshIfDue();
    const credentials = account.credentials();
    if (credentials === undefined)
      throw new PostFailure(accountProblem() ?? "No Instagram account is connected.", false);
    const { token, userId } = credentials;
    used.token = token;
    const selectIds = selectIdsOf(post.id);

    const recordPublished = async (mediaId: string | null, permalink: string | null) => {
      update({
        state: "published",
        media_id: mediaId,
        permalink,
        published_at: clock.now(),
        error: permalink === null ? "Published; its link could not be found." : null,
        next_attempt_at: null,
      });
      console.log(`Post ${post.id} published.`);
      await dropObject(post.id);
    };

    const publishContainer = async (containerId: string) => {
      // Recorded before asking: from here, this container is checked and never replaced unchecked.
      update({ publish_requested_at: clock.now() });
      const mediaId = await api.publish(token, userId, containerId);
      const permalink = await api.permalink(token, mediaId).catch(() => null);
      await recordPublished(mediaId, permalink);
    };

    // A container from an earlier attempt may have been published, or be about to be.
    if (post.container_id !== null) {
      const status = await api.containerStatus(token, post.container_id);
      if (status === "PUBLISHED") {
        const found = await findPublished(token, userId, current());
        await recordPublished(found?.id ?? null, found?.permalink ?? null);
        return;
      }
      if (status === "FINISHED" && post.publish_requested_at !== null) {
        const now = build(selectIds, post.hashtag_set);
        // Unchanged: publishing the same container again is safe, as Instagram publishes it once.
        if (now !== undefined && now.fingerprint === post.capture) return publishContainer(post.container_id);
        if (clock.now() - post.publish_requested_at < PUBLISH_SETTLE_MS) {
          throw new PostFailure("Waiting to learn whether the interrupted publish went through.", true);
        }
      }
      // Never published: it is left to expire, and its frame is deleted.
      update({ container_id: null, publish_requested_at: null });
      await dropObject(post.id);
    }

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const content = build(selectIds, post.hashtag_set);
      if (content === undefined) throw new PostFailure("The select was deleted.", false);
      update({ caption: content.caption, alt_text: content.altText, capture: content.fingerprint });
      if (content.check.problems.length > 0) {
        throw new PostFailure(`The caption can't be posted. ${content.check.problems.join(" ")}`, false);
      }
      const unchanged = () => build(selectIds, post.hashtag_set)?.fingerprint === content.fingerprint;

      const jpeg = await render(content);
      // Taken again before the upload: a privacy zone may have been added while it rendered.
      if (!unchanged()) continue;
      await dropObject(post.id);
      const key = bucket.newKey();
      update({ object_key: key });
      await bucket.put(key, jpeg);

      const containerId = await api.createContainer(token, userId, {
        imageUrl: bucket.urlFor(key),
        caption: content.caption,
        altText: content.altText,
      });
      update({ container_id: containerId, publish_requested_at: null });
      await waitUntilFinished(token, containerId);

      // And again before the publish call.
      if (!unchanged()) {
        update({ container_id: null });
        await dropObject(post.id);
        continue;
      }
      return publishContainer(containerId);
    }
    throw new PostFailure("The select's capture data kept changing while it was being published.", true);
  }

  async function waitUntilFinished(token: string, containerId: string): Promise<void> {
    for (let poll = 0; poll < MAX_POLLS; poll++) {
      const status = await api.containerStatus(token, containerId);
      if (status === "FINISHED") return;
      if (status !== "IN_PROGRESS")
        throw new PostFailure(`Instagram could not process the image (${status}).`, true);
      await clock.sleep(POLL_MS);
    }
    throw new PostFailure("Instagram took too long to process the image.", true);
  }

  /** The media a container became, found among the account's latest by its caption. */
  async function findPublished(token: string, userId: string, post: PostRow) {
    const recent = await api.recentMedia(token, userId);
    const since = (post.publish_requested_at ?? post.created_at) - PUBLISH_SETTLE_MS;
    return recent.find((media) => {
      const at = Date.parse(media.timestamp);
      return media.caption === post.caption && (!Number.isFinite(at) || at >= since);
    });
  }

  /** Deletes a post's frame from the bucket. One that fails is tried again by `runDue`. */
  async function dropObject(id: string): Promise<void> {
    const key = row(id)?.object_key;
    if (key === null || key === undefined || "missing" in options.bucket) return;
    try {
      await options.bucket.delete(key);
      db.query("UPDATE posts SET object_key = NULL WHERE id = ? AND object_key = ?").run(id, key);
    } catch (error) {
      console.error(
        `A frame could not be deleted from the bucket; it will be tried again (${errorKind(error)}).`,
      );
    }
  }

  function asFailure(error: unknown, usedToken: string | undefined): PostFailure {
    if (error instanceof PostFailure) return error;
    if (error instanceof InstagramError) {
      if (error.kind === "token") {
        const current = account.credentials()?.token;
        if (usedToken !== undefined && current !== undefined && current !== usedToken) {
          return new PostFailure(
            "The token was replaced during the attempt; trying again with the new one.",
            true,
            true,
          );
        }
        if (usedToken !== undefined) account.markInvalid(usedToken);
        return new PostFailure(
          "Instagram no longer accepts the token. Paste a new token in Settings.",
          false,
        );
      }
      return new PostFailure(error.message, true);
    }
    if (error instanceof BucketError) return new PostFailure(error.message, true);
    return new PostFailure(`Something went wrong (${errorKind(error)}).`, true);
  }

  let running: Promise<void> | undefined;

  async function runDueNow(): Promise<void> {
    const due = db
      .query<{ id: string }, [number]>(
        "SELECT id FROM posts WHERE state = 'retrying' AND next_attempt_at <= ? ORDER BY next_attempt_at, rowid",
      )
      .all(clock.now());
    for (const { id } of due) await serially(() => attempt(id));
    const left = db
      .query<{ id: string }, []>(
        "SELECT id FROM posts WHERE object_key IS NOT NULL AND state IN ('published', 'failed')",
      )
      .all();
    for (const { id } of left) await serially(() => dropObject(id));
  }

  const readiness = (): string[] =>
    [bucketProblem(), accountProblem()].filter((problem): problem is string => problem !== undefined);

  return {
    /** Publishes selects as one post now, or dry runs it. Version 1 posts one select. */
    async publish(request: PublishRequest): Promise<PublishResult> {
      if (request.selectIds.length !== 1) throw new Error("A post holds one select until carousels come.");
      const dry = request.dryRun ?? settings.publishing().dryRun;
      const selects = request.selectIds.map((selectId) => library.get(selectId));
      if (selects.some((select) => select === undefined)) return { status: "not-found" };
      if (selects.some((select) => !select?.inPool)) return { status: "not-in-pool" };
      const content = build(request.selectIds, request.hashtagSet);
      if (content === undefined) return { status: "not-found" };
      if (
        request.expect !== undefined &&
        (request.expect.caption !== content.caption || request.expect.altText !== content.altText)
      ) {
        return { status: "changed", caption: content.caption, altText: content.altText };
      }
      if (dry) {
        const done = dryRun(request.selectIds, content);
        const post = await done;
        return { status: "started", post, done };
      }
      const problems = readiness();
      if (problems.length > 0) return { status: "unavailable", problems };

      const id = randomUUID();
      // Claimed in one write transaction, so a select is only ever in one live post.
      const claimed = db
        .transaction(() => {
          if (request.selectIds.some((selectId) => !library.get(selectId)?.inPool)) return false;
          insertPost(id, request.selectIds, content, {});
          return true;
        })
        .immediate();
      if (!claimed) return { status: "not-in-pool" };
      const done = serially(() => attempt(id)).then(() => postOf(id));
      return { status: "started", post: postOf(id), done };
    },

    /** What publishing selects would send now, for the owner to confirm before posting. */
    preview(selectIds: string[]): PostPreview | undefined {
      const content = build(selectIds, undefined);
      if (content === undefined) return undefined;
      const view = account.view();
      return {
        caption: content.caption,
        altText: content.altText,
        hashtagSet: content.hashtagSet,
        check: content.check,
        problems: [...content.check.problems, ...readiness()],
        dryRun: settings.publishing().dryRun,
        account: view?.status === "connected" ? view.username : null,
        url: "missing" in options.bucket ? null : options.bucket.urlKind,
      };
    },

    /**
     * Takes up posts a stop left mid-attempt: the next `runDue` resumes them. Called once at
     * start, before anything is published.
     */
    recover(): void {
      db.query("UPDATE posts SET state = 'retrying', next_attempt_at = ? WHERE state = 'publishing'").run(
        clock.now(),
      );
    },

    /**
     * Runs the retries that are due, and deletes frames left in the bucket. Called on a timer; a
     * call while an earlier run is still working joins that run.
     */
    runDue(): Promise<void> {
      if (running !== undefined) return running;
      running = runDueNow().finally(() => {
        running = undefined;
      });
      return running;
    },

    /** Every post that was or is being published, newest first. Not dry runs. */
    posts(): Post[] {
      return db
        .query<PostRow, []>(
          "SELECT * FROM posts WHERE state != 'dry-run' ORDER BY created_at DESC, rowid DESC",
        )
        .all()
        .map(toPost);
    },

    /** The latest dry runs, newest first. */
    dryRuns(): Post[] {
      return db
        .query<PostRow, []>(
          "SELECT * FROM posts WHERE state = 'dry-run' ORDER BY created_at DESC, rowid DESC",
        )
        .all()
        .map(toPost);
    },

    post(id: string): Post | undefined {
      const found = row(id);
      return found === null ? undefined : toPost(found);
    },

    /** Settles once every attempt asked for so far has finished. */
    settled(): Promise<void> {
      return serially(async () => {});
    },

    /** The frame a dry run rendered, on disk. */
    dryRunFrame(id: string): string | undefined {
      if (row(id)?.state !== "dry-run") return undefined;
      const file = `${id}.jpg`;
      return readdirSync(dryRunDir, { withFileTypes: true }).some((entry) => entry.name === file)
        ? join(dryRunDir, file)
        : undefined;
    },
  };
}

export type Publisher = ReturnType<typeof createPublisher>;
