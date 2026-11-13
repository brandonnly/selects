# ADR 0006: Publishing runs against a fake until told otherwise, and never twice

## Status

Accepted, November 13, 2026.

## Context

[ADR 0003](0003-instagram-publishing.md) settles how a post reaches Instagram. It leaves open how
development is kept off the real API, what a failed publish retries, how a crash part way is
recovered without posting twice, and how location privacy holds while a post is in flight. A
post cannot be taken back from Selects, so each of these leans towards sending nothing.

## Decision

- **Fake mode is the default, and makes no outside request.** `INSTAGRAM_API` is `fake` unless
  set to `live`. In fake mode Selects runs the fake Instagram server and a fake bucket inside
  itself and does not use the bucket in `BUCKET_*`. Each post records which mode made it; a
  banner on every screen, the Post now confirmation and the Posted screen say when nothing is
  posted for real. In live mode no fake runs: without a bucket, publishing is unavailable.
- **The token is checked against `/me` when pasted and refreshed once a day.** A refresh when it
  is pasted tells its real expiry; until one works the expiry shows as unknown, and Settings
  warns when a refresh fails for any reason but the token being too new. The token lives in its
  own table and goes in the Authorization header (in the query only for refresh, as Meta
  documents). Every URL and the token are taken out of Meta's messages before they are stored,
  logged or shown, so a presigned link never is.
- **Instagram's errors are sorted.** Network errors, 5xx, rate limits and a frame Instagram could
  not fetch are retried after 2, 5 and 8 minutes. A refused image, a missing permission (which
  asks for a token with the right permissions), a spam restriction and any other 4xx fail at
  once, as do a caption over a limit, a token Instagram refuses and a deleted select. A refusal
  of a token that was replaced meanwhile is retried at once with the new one. A retry runs only
  once due, however often the timer fires.
- **A post is never published twice.** The container ID is stored before Instagram is asked to
  publish it, and the time of that request too. An attempt that finds a container checks its
  status first: `PUBLISHED` is recorded as published (its link is looked up, best effort),
  `FINISHED` is published again (Instagram publishes a container once), and anything else is
  dropped for a new one. Containers are polled once a minute for at most five minutes.
- **Once publishing was asked for, a post leaves the pool only on a confirmed status.** If the
  retries end without one, the post is `unconfirmed`: its select stays out of the pool, its
  container is checked every ten minutes while the token allows, and the Posted screen asks the
  owner to say "It was posted" (with an optional link) or "It was not posted", which returns the
  select to the pool. A container Instagram shows unpublished ten minutes after the request
  also returns it.
- **Privacy is checked three times per attempt.** The frame and caption are built from
  `published(id)`, and the published capture data is taken again before the upload and before
  the publish call. A change builds both again; a container made under the old rules is never
  published, and its frame is deleted from the bucket.
- **The hashtag set is chosen once and stored with the post.**
- **"Post now" confirms what it shows.** The POST carries the caption, alt text, dry run, mode,
  account and a fingerprint of the frame's inputs, and the server refuses it if any changed. A
  confirmed dry run never becomes a real post.
- **A post is sent only as it was confirmed.** It stores the account it was confirmed for, the
  mode it was made in, and a fingerprint of everything it is built from.
  An attempt that finds another account, the other mode, or edited templates, settings or
  capture data fails the post without sending it. A location withheld since then still builds
  the caption and frame again; one shown or moved since then is a change like any other. A post made in the other mode that Instagram may already have
  published waits as unconfirmed.
- **Frames leave the bucket.** The framed image is deleted once published (until gallery output,
  issue #9). A deletion that fails is kept in a cleanup record and tried again by the timer.
  Bucket requests time out after a minute.
- **A dry run makes no outside request.** It renders, builds and measures the caption, and
  records what it would send with the frame. The latest 20 are kept. It leaves the select in
  the pool.

## Consequences

- A fresh install posts nothing until `INSTAGRAM_API=live` is set.
- A post marked `unconfirmed` waits for Instagram or the owner. Selects never guesses.
- If Instagram publishes a container more than ten minutes after it was asked to, after the
  select's capture data changed, a second post is possible. This is accepted as remote.
- The fake follows Meta's documentation, but these are unverified against Meta until the first
  live run: the Graph API version in use (v26.0), the Bearer header on GET calls,
  `/me?fields=user_id,username`, what a second `media_publish` on the same container returns,
  the error for refreshing a token that is too new (Selects goes by the words "too new"), and
  whether a presigned link works for a real publish.
