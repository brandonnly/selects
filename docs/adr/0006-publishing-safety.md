# ADR 0006: Publishing runs against a fake until told otherwise, and never twice

## Status

Accepted, November 13, 2026.

## Context

[ADR 0003](0003-instagram-publishing.md) settles how a post reaches Instagram. It leaves open how
development is kept off the real API, what a failed publish retries, how a crash part way is
recovered without posting twice, and how location privacy holds while a post is in flight. A
post cannot be taken back from Selects, so each of these leans towards sending nothing.

## Decision

- **The fake Instagram server is the default everywhere.** `INSTAGRAM_API` is `fake` unless set
  to `live`; the fake runs inside the server, and tests run the same fake over real HTTP. With
  no bucket set, `bun run dev` also runs a fake bucket. Bucket variables are optional: without
  them Selects runs and publishing is unavailable.
- **The token is checked against `/me` when pasted and refreshed once a day**, and once at once
  when Meta allows it, to learn its real expiry. It lives in its own table, is sent in the
  Authorization header (in the query only for refresh, as Meta documents), and no route,
  log line or stored error carries it. A presigned link is never stored or shown either.
- **Retries wait 2, 5 and 8 minutes**, three retries over fifteen minutes. A caption over a
  limit, a token Instagram refuses and a deleted select fail at once. A missing bucket or
  account refuses before any post is recorded.
- **A post is never published twice.** The container ID is stored before Instagram is asked to
  publish it, and the time of that request too. An attempt that finds a container checks its
  status first: `PUBLISHED` is recorded from the account's recent media, `FINISHED` is published
  again (Instagram publishes a container once), and anything else is dropped for a new one. A
  container asked to publish is replaced only after ten minutes unpublished. Attempts run one at
  a time, a stop leaves its post to be taken up at start, and an attempt writes to its post only
  while its attempt number is the latest.
- **A select is in the pool** unless it is marked as already posted or is in a post that is
  publishing, retrying or published. A post that fails for good returns it.
- **Privacy is checked three times per attempt.** The frame and caption are built from
  `published(id)`, and the published capture data is taken again before the upload and before
  the publish call. A change builds both again; a container made under the old rules is never
  published, and its frame is deleted from the bucket.
- **The hashtag set is chosen once and stored with the post.** Each attempt builds the caption
  again from it, so a retry sends the same caption unless the templates or capture data changed.
- **"Post now" shows the frame, caption and alt text first**, and the server refuses the post if
  the caption or alt text is no longer what was shown.
- **The framed image is deleted from the bucket once published**, until gallery output (issue #9)
  keeps it when its switch is on.
- **A dry run makes no outside request.** It renders, builds and measures the caption, names the
  key it would upload to and how Instagram would be given it, and records all of it with the
  frame. The latest 20 are kept and shown on the Posted screen. A dry run leaves the select in
  the pool.

## Consequences

- A fresh install posts nothing until `INSTAGRAM_API=live` is set, which the README and
  `.env.example` say.
- A post found `PUBLISHED` whose media cannot be matched by caption is recorded as published
  without a link.
- If Instagram publishes a container more than ten minutes after it was asked to, after the
  select's capture data changed, a second post is possible. This is accepted as remote.
