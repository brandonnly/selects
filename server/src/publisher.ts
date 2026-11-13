import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Bucket, BucketError } from "./bucket";
import type { CaptionStore } from "./caption-store";
import { buildCaption, checkCaption, type LimitCheck } from "./captions";
import type { Captures, PublishedCapture } from "./capture";
import { type Clock, MINUTE } from "./clock";
import type { InstagramMode } from "./config";
import { FRAME_HEIGHT, FRAME_WIDTH, type FrameRenderer } from "./frame";
import { type InstagramApi, InstagramError } from "./instagram";
import type { InstagramAccount } from "./instagram-account";
import { errorKind, type Library } from "./library";
import type { Settings } from "./settings";

/**
 * - `publishing`: being sent now, or waiting its turn.
 * - `retrying`: an attempt failed; the next is at `nextAttemptAt`.
 * - `unconfirmed`: Instagram was asked to publish it and has not said whether it did. Its selects
 *   stay out of the pool; its container is checked again at `nextAttemptAt`, and the owner can
 *   say what happened.
 * - `published`: on Instagram.
 * - `failed`: given up on. Its selects are back in the pool.
 * - `dry-run`: rendered and recorded only; nothing was uploaded or published.
 */
export type PostState = "publishing" | "retrying" | "unconfirmed" | "published" | "failed" | "dry-run";

/** What the owner says happened to a post Instagram has not confirmed. */
export type Resolution = { posted: true; permalink?: string | null } | { posted: false };

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
  /** Which Instagram made it: the fake server inside Selects, or the real one. Null if unknown. */
  mode: InstagramMode | null;
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
  /** What the owner was shown and confirmed. When any of it no longer holds, nothing is sent. */
  expect?: Confirmation;
};

export type PublishResult =
  /** Claimed: `done` settles when the first attempt has finished, or the dry run is recorded. */
  | { status: "started"; post: Post; done: Promise<Post> }
  | { status: "not-found" }
  /** Posted, being posted, or marked as already posted. */
  | { status: "not-in-pool" }
  /** No bucket, or no account to publish to. Nothing was recorded. */
  | { status: "unavailable"; problems: string[] }
  /** What would be sent is no longer what the owner confirmed: each change, in words. */
  | { status: "changed"; changes: string[] };

/** Everything the owner is shown before a post, which the post must still match. */
export type Confirmation = {
  caption: string;
  altText: string;
  dryRun: boolean;
  instagram: InstagramMode;
  account: string | null;
  /** The preview's `frame`. */
  frame: string;
};

/** What a post would send now, for the owner to confirm. */
export type PostPreview = {
  caption: string;
  altText: string;
  hashtagSet: string | null;
  check: LimitCheck;
  /** What would stop it being published. */
  problems: string[];
  dryRun: boolean;
  /** Which Instagram it would go to: the fake server inside Selects, or the real one. */
  instagram: InstagramMode;
  account: string | null;
  url: "public" | "presigned" | null;
  /** A short fingerprint of what the frame is rendered from: settings, typeface and capture data. */
  frame: string;
};

export type PublisherOptions = {
  db: Database;
  dataDir: string;
  library: Library;
  captures: Captures;
  renderer: Pick<FrameRenderer, "render"> & Partial<Pick<FrameRenderer, "fontOverride">>;
  settings: Settings;
  captionStore: CaptionStore;
  account: InstagramAccount;
  api: InstagramApi;
  /** The bucket, or the variables it still needs. */
  bucket: Bucket | { missing: string[] };
  clock: Clock;
  /** Which Instagram the API talks to; recorded on each post. */
  mode: InstagramMode;
  /** How a container is checked while it is processed. Default: Meta's advice. */
  containerPolling?: { intervalMs: number; limitMs: number };
  /** Picks a hashtag set. Default: Math.random. */
  random?: () => number;
  /**
   * Told of each post once it is recorded as published, before its frame is deleted: gallery
   * output takes the frame from here. It must not throw, and nothing it does touches the post.
   */
  onPublished?: (postId: string) => void;
};

/** The wait before each retry: three retries over fifteen minutes. */
export const RETRY_DELAYS = [2 * MINUTE, 5 * MINUTE, 8 * MINUTE] as const;

/**
 * How often a container is checked while Instagram processes it, and for how long: about once a
 * minute for at most five minutes, as Meta advises for the real API.
 */
export const META_CONTAINER_POLLING = { intervalMs: MINUTE, limitMs: 5 * MINUTE } as const;

/** How often the content is built again when a select's capture data changes during an attempt. */
const MAX_ROUNDS = 3;

/**
 * A container that was asked to publish, then found unpublished, is taken for unpublished only
 * after this long: Instagram may still be publishing it.
 */
const PUBLISH_SETTLE_MS = 10 * MINUTE;

/** How often the container of an unconfirmed post is checked again. */
export const UNCONFIRMED_CHECK_MS = 10 * MINUTE;

const UNCONFIRMED_MESSAGE =
  "Instagram was asked to publish it and has not said whether it did. Check Instagram, then say whether it was posted.";

/** Dry runs kept, with their frames. */
const DRY_RUNS_KEPT = 20;

type PostRow = {
  id: string;
  state: PostState;
  caption: string;
  alt_text: string;
  /** The caption and alt text as they read with the location withheld. Null before version 8. */
  withheld_caption: string | null;
  withheld_alt_text: string | null;
  hashtag_set: string | null;
  /** The published capture data the post was built from, as JSON: one per select. */
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
  mode: InstagramMode | null;
  /** The Instagram account the post was confirmed for. Null before version 7 and for a dry run with none. */
  account_id: string | null;
  /** A fingerprint of what the post was confirmed with, location aside. Null before version 7. */
  confirmed: string | null;
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
  /** The caption and alt text as they read with the location withheld; empty when written by hand. */
  withheldCaption: string;
  withheldAltText: string;
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
    mode: found.mode,
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
    if (names.length === 0) return "No bucket is available.";
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
    const override = captionStore.override(firstId);
    // One pick of the hashtag set for both, so the withheld text has the same one.
    let pick: number | undefined;
    const input = {
      templates: captionStore.templates(),
      coordinateFormat: settings.frame().coordinateFormat,
      override,
      hashtagSet: hashtagSet ?? undefined,
      random: () => {
        pick ??= random();
        return pick;
      },
    };
    const caption = buildCaption({ capture: first.capture, ...input });
    // Text written by hand cannot be scrubbed of coordinates safely: it is withheld whole.
    const withheld = buildCaption({
      capture: { ...first.capture, latitude: null, longitude: null },
      ...input,
      override: undefined,
    });
    return {
      sources,
      fingerprint: JSON.stringify(sources.map((source) => source.capture)),
      caption: caption.caption,
      altText: caption.altText,
      withheldCaption: (override?.caption ?? null) === null ? withheld.caption : "",
      withheldAltText: (override?.altText ?? null) === null ? withheld.altText : "",
      hashtagSet: caption.hashtagSet,
      check: checkCaption(caption),
    };
  }

  /** The override font and the size and time of its file, so another file of the same name counts as a change. */
  function fontVersion() {
    const font = renderer.fontOverride?.() ?? null;
    if (font === null) return null;
    const stats = statSync(join(options.dataDir, "fonts", font.fileName), { throwIfNoEntry: false });
    return { ...font, bytes: stats?.size ?? null, changed: stats?.mtimeMs ?? null };
  }

  /**
   * A fingerprint of everything a post is built from except where it was taken: the templates,
   * the select's own caption, the hashtag set, the frame settings and font, and the capture
   * data, once as shown and once with its coordinates left out. A post is sent only while it is
   * what it was confirmed with, or that with its location since withheld.
   */
  function confirmedFingerprint(
    selectIds: string[],
    content: Content,
  ): { asShown: string; withheld: string } {
    const hash = (captures: unknown) =>
      createHash("sha256")
        .update(
          JSON.stringify({
            templates: captionStore.templates(),
            own: selectIds.map((selectId) => captionStore.override(selectId)),
            hashtagSet: content.hashtagSet,
            frame: settings.frame(),
            font: fontVersion(),
            captures,
          }),
        )
        .digest("hex")
        .slice(0, 32);
    return {
      asShown: hash(content.sources.map(({ capture }) => capture)),
      withheld: hash(content.sources.map(({ capture }) => ({ ...capture, latitude: null, longitude: null }))),
    };
  }

  /**
   * Whether what would be sent now is what the post was confirmed with: the same, or the same
   * with its location since withheld. A location shown or moved since then is a change.
   */
  function stillConfirmed(stored: string, selectIds: string[], content: Content): boolean {
    const [asShown, withheld] = stored.split(":");
    const now = confirmedFingerprint(selectIds, content);
    return now.asShown === asShown || now.asShown === withheld;
  }

  /** A short fingerprint of everything the frame is rendered from. */
  function frameFingerprint(content: Content): string {
    const inputs = {
      settings: settings.frame(),
      font: fontVersion(),
      sources: content.sources,
    };
    return createHash("sha256").update(JSON.stringify(inputs)).digest("hex").slice(0, 16);
  }

  /** The connected account's name, when it can be published to. */
  const accountName = () => {
    const view = account.view();
    return view?.status === "connected" ? view.username : null;
  };

  async function render(content: Content): Promise<Uint8Array> {
    const [source] = content.sources;
    if (source === undefined) throw new PostFailure("The post has no select.", false);
    return new Uint8Array(await renderer.render(source, settings.frame()));
  }

  function insertPost(id: string, selectIds: string[], content: Content, extra: Partial<PostRow>) {
    db.query(
      `INSERT INTO posts (id, state, mode, account_id, confirmed, caption, alt_text, withheld_caption,
         withheld_alt_text, hashtag_set, capture, report, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      extra.state ?? "publishing",
      options.mode,
      account.credentials()?.userId ?? null,
      Object.values(confirmedFingerprint(selectIds, content)).join(":"),
      content.caption,
      content.altText,
      content.withheldCaption,
      content.withheldAltText,
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
        `UPDATE posts SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE id = ? AND attempts = ? AND state = 'publishing'`,
      ).run(...columns.map((c) => fields[c] ?? null), id, number);
    };
    const current = () => row(id) ?? claimed;

    // A post made under the other Instagram is never sent to this one: a fake post must not
    // become a real one because the mode changed while it waited. It fails and its select returns.
    if (claimed.mode !== null && claimed.mode !== options.mode) {
      const message = `This post was made in ${claimed.mode} mode and Selects is now in ${options.mode} mode.`;
      if (claimed.publish_requested_at !== null) {
        // That Instagram may have published it: it waits, out of the pool, until Selects is back
        // in that mode or its owner says what happened.
        update({
          state: "unconfirmed",
          error: `${message} ${UNCONFIRMED_MESSAGE}`,
          next_attempt_at: clock.now() + UNCONFIRMED_CHECK_MS,
        });
      } else {
        update({ state: "failed", error: `${message} Post it again.`, next_attempt_at: null });
      }
      console.error(`Post ${id} was made in another Instagram mode; it was not sent.`);
      return;
    }

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
      } else if (final && current().publish_requested_at !== null) {
        // Instagram may have published it: never back to the pool without knowing.
        update({
          state: "unconfirmed",
          error: `${failure.message} ${UNCONFIRMED_MESSAGE}`,
          next_attempt_at: clock.now() + UNCONFIRMED_CHECK_MS,
        });
        console.error(`Post ${id} needs checking after ${number} attempts: ${failure.message}`);
        // Instagram fetched the frame when the container was made: it need not stay in the bucket.
        await dropObject(id);
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
    // The post goes to the account it was confirmed for, or nowhere. A new token for the same
    // account is fine.
    if (post.account_id !== null && post.account_id !== userId) {
      throw new PostFailure(
        "The connected Instagram account changed since this post was confirmed. Post it again.",
        false,
      );
    }
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
      options.onPublished?.(post.id);
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
        if (
          now !== undefined &&
          now.fingerprint === post.capture &&
          (post.confirmed === null || stillConfirmed(post.confirmed, selectIds, now))
        ) {
          return publishContainer(post.container_id);
        }
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
      // Templates, settings or the select's data edited since the post was confirmed: it is
      // not sent as something its owner never saw.
      if (post.confirmed !== null && !stillConfirmed(post.confirmed, selectIds, content)) {
        throw new PostFailure(
          "The caption, frame or capture data changed since this post was confirmed. Post it again.",
          false,
        );
      }
      // What it sends, and what the gallery lists once its location is withheld: stored together.
      update({
        caption: content.caption,
        alt_text: content.altText,
        withheld_caption: content.withheldCaption,
        withheld_alt_text: content.withheldAltText,
        capture: content.fingerprint,
      });
      if (content.check.problems.length > 0) {
        throw new PostFailure(`The caption can't be posted. ${content.check.problems.join(" ")}`, false);
      }
      // Nothing a privacy rule or an edit changed since this attempt built its content, and still
      // what the post was confirmed with.
      const unchanged = () => {
        const now = build(selectIds, post.hashtag_set);
        return (
          now !== undefined &&
          now.fingerprint === content.fingerprint &&
          (post.confirmed === null || stillConfirmed(post.confirmed, selectIds, now))
        );
      };

      const jpeg = await render(content);
      // Taken again before the upload: a privacy zone may have been added while it rendered.
      if (!unchanged()) continue;
      await dropObject(post.id);
      const key = bucket.newKey();
      update({ object_key: key });
      await bucket.put(key, jpeg, async () => {
        // An upload given up on that landed anyway: it goes on the cleanup record, so its
        // deletion is tried again by the timer if it fails now.
        db.query("INSERT OR IGNORE INTO bucket_cleanup (key, added_at, mode) VALUES (?, ?, ?)").run(
          key,
          clock.now(),
          options.mode,
        );
        await deleteObject(key);
      });

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
    const { intervalMs, limitMs } = options.containerPolling ?? META_CONTAINER_POLLING;
    const started = clock.now();
    for (;;) {
      const status = await api.containerStatus(token, containerId);
      if (status === "FINISHED") return;
      if (status !== "IN_PROGRESS")
        throw new PostFailure(`Instagram could not process the image (${status}).`, true);
      if (clock.now() - started + intervalMs > limitMs) break;
      await clock.sleep(intervalMs);
    }
    throw new PostFailure("Instagram took too long to process the image.", true);
  }

  /**
   * The media a container became, found among the account's latest by its caption. Best effort:
   * undefined when it cannot be looked up.
   */
  async function findPublished(token: string, userId: string, post: PostRow) {
    const recent = await api.recentMedia(token, userId).catch(() => []);
    const since = (post.publish_requested_at ?? post.created_at) - PUBLISH_SETTLE_MS;
    const matches = recent.filter((media) => {
      const at = Date.parse(media.timestamp);
      return media.caption === post.caption && (!Number.isFinite(at) || at >= since);
    });
    // Two posts can share a caption: with more than one match the link is left unset, not guessed.
    return matches.length === 1 ? matches[0] : undefined;
  }

  /**
   * Deletes a post's frame from the bucket. Its key moves from the post to the cleanup record
   * first, so a deletion that fails is never lost when the post is given a new frame: `runDue`
   * tries it again.
   */
  async function dropObject(id: string): Promise<void> {
    if ("missing" in options.bucket) return;
    // A frame in the other mode's bucket is left for a run in that mode to delete.
    const mode = row(id)?.mode ?? null;
    if (mode !== null && mode !== options.mode) return;
    const key = db
      .transaction(() => {
        const found = row(id)?.object_key;
        if (found === null || found === undefined) return undefined;
        db.query("INSERT OR IGNORE INTO bucket_cleanup (key, added_at, mode) VALUES (?, ?, ?)").run(
          found,
          clock.now(),
          options.mode,
        );
        db.query("UPDATE posts SET object_key = NULL WHERE id = ? AND object_key = ?").run(id, found);
        return found;
      })
      .immediate();
    if (key !== undefined) await deleteObject(key);
  }

  /** Deletes an object in the cleanup record, and takes it off the record once it is gone. */
  async function deleteObject(key: string): Promise<void> {
    if ("missing" in options.bucket) return;
    try {
      await options.bucket.delete(key);
      db.query("DELETE FROM bucket_cleanup WHERE key = ?").run(key);
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
      if (error.kind === "permission") {
        return new PostFailure(
          "Instagram refused: the token lacks a permission publishing needs. Paste a token in Settings made with the instagram_business_basic and instagram_business_content_publish permissions.",
          false,
        );
      }
      if (error.kind === "refused") return new PostFailure(error.message, false);
      return new PostFailure(error.message, true);
    }
    if (error instanceof BucketError) return new PostFailure(error.message, true);
    return new PostFailure(`Something went wrong (${errorKind(error)}).`, true);
  }

  /**
   * Checks the container of a post Instagram has not confirmed, with the token in use now. It is
   * recorded as published when Instagram says so, and returned to the pool only when Instagram
   * shows it was never published, a while after it was asked to.
   */
  async function checkUnconfirmed(id: string): Promise<void> {
    const found = row(id);
    if (found === null || found.state !== "unconfirmed") return;
    const later = () =>
      db
        .query("UPDATE posts SET next_attempt_at = ? WHERE id = ? AND state = 'unconfirmed'")
        .run(clock.now() + UNCONFIRMED_CHECK_MS, id);
    const credentials = account.credentials();
    if (credentials === undefined || found.container_id === null) return void later();
    // Only the Instagram and the account that were asked can say what became of it.
    if (found.mode !== null && found.mode !== options.mode) return void later();
    if (found.account_id !== null && found.account_id !== credentials.userId) return void later();
    let status: Awaited<ReturnType<InstagramApi["containerStatus"]>>;
    try {
      status = await api.containerStatus(credentials.token, found.container_id);
    } catch (error) {
      if (error instanceof InstagramError && error.kind === "token") account.markInvalid(credentials.token);
      return void later();
    }
    if (status === "PUBLISHED") {
      const media = await findPublished(credentials.token, credentials.userId, found);
      db.query(
        `UPDATE posts SET state = 'published', media_id = ?, permalink = ?, published_at = ?, error = ?,
           next_attempt_at = NULL WHERE id = ? AND state = 'unconfirmed'`,
      ).run(
        media?.id ?? null,
        media?.permalink ?? null,
        clock.now(),
        media?.permalink ? null : "Published; its link could not be found.",
        id,
      );
      console.log(`Post ${id} was published, Instagram says.`);
      options.onPublished?.(id);
      return dropObject(id);
    }
    const settled = clock.now() - (found.publish_requested_at ?? 0) >= PUBLISH_SETTLE_MS;
    if (status === "IN_PROGRESS" || !settled) return void later();
    db.query(
      "UPDATE posts SET state = 'failed', error = ?, next_attempt_at = NULL WHERE id = ? AND state = 'unconfirmed'",
    ).run(`Instagram shows it was not published (${status}).`, id);
    console.error(`Post ${id} was not published, Instagram says; its select is back in the pool.`);
    return dropObject(id);
  }

  let running: Promise<void> | undefined;

  async function runDueNow(): Promise<void> {
    const due = db
      .query<{ id: string }, [number]>(
        "SELECT id FROM posts WHERE state = 'retrying' AND next_attempt_at <= ? ORDER BY next_attempt_at, rowid",
      )
      .all(clock.now());
    for (const { id } of due) await serially(() => attempt(id));
    const unconfirmed = db
      .query<{ id: string }, [number]>(
        "SELECT id FROM posts WHERE state = 'unconfirmed' AND next_attempt_at <= ? ORDER BY next_attempt_at, rowid",
      )
      .all(clock.now());
    for (const { id } of unconfirmed) await serially(() => checkUnconfirmed(id));
    const left = db
      .query<{ id: string }, []>(
        "SELECT id FROM posts WHERE object_key IS NOT NULL AND state IN ('published', 'failed')",
      )
      .all();
    for (const { id } of left) await serially(() => dropObject(id));
    const discarded = db
      .query<{ key: string }, [string]>(
        "SELECT key FROM bucket_cleanup WHERE mode IS NULL OR mode = ? ORDER BY added_at, key",
      )
      .all(options.mode);
    for (const { key } of discarded) await serially(() => deleteObject(key));
  }

  /** How what would be sent now differs from what the owner confirmed. */
  function changesFrom(confirmed: Confirmation, content: Content, dry: boolean): string[] {
    const changes: string[] = [];
    if (confirmed.dryRun !== dry) {
      changes.push(dry ? "Dry run was switched on." : "Dry run was switched off: this would be a real post.");
    }
    if (confirmed.instagram !== options.mode) changes.push("Selects now talks to a different Instagram.");
    if (!dry && confirmed.account !== accountName()) changes.push("The connected Instagram account changed.");
    if (confirmed.caption !== content.caption || confirmed.altText !== content.altText) {
      changes.push("The caption or alt text changed.");
    }
    if (confirmed.frame !== frameFingerprint(content)) changes.push("The frame changed.");
    return changes;
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
      if (request.expect !== undefined) {
        const changes = changesFrom(request.expect, content, dry);
        if (changes.length > 0) return { status: "changed", changes };
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
      return {
        caption: content.caption,
        altText: content.altText,
        hashtagSet: content.hashtagSet,
        check: content.check,
        problems: [...content.check.problems, ...readiness()],
        dryRun: settings.publishing().dryRun,
        instagram: options.mode,
        account: accountName(),
        url: "missing" in options.bucket ? null : options.bucket.urlKind,
        frame: frameFingerprint(content),
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

    /**
     * Records what the owner says happened to a post Instagram has not confirmed: published,
     * with the link if they give one, or not posted, which returns its selects to the pool.
     */
    resolve(id: string, resolution: Resolution): Promise<Post | "not-found" | "not-unconfirmed"> {
      return serially(async () => {
        const found = row(id);
        if (found === null) return "not-found" as const;
        if (found.state !== "unconfirmed") return "not-unconfirmed" as const;
        if (resolution.posted) {
          db.query(
            `UPDATE posts SET state = 'published', permalink = ?, published_at = ?, next_attempt_at = NULL,
               error = 'Marked as posted by hand.' WHERE id = ? AND state = 'unconfirmed'`,
          ).run(resolution.permalink ?? null, clock.now(), id);
          options.onPublished?.(id);
        } else {
          db.query(
            `UPDATE posts SET state = 'failed', next_attempt_at = NULL,
               error = 'Marked as not posted by hand.' WHERE id = ? AND state = 'unconfirmed'`,
          ).run(id);
        }
        await dropObject(id);
        return postOf(id);
      });
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
