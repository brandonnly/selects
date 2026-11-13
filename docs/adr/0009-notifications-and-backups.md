# ADR 0009: Notices say only what happened, fake mode sends none, and backups are snapshots

## Status

Accepted, November 13, 2026.

## Context

[docs/PRODUCT.md](../PRODUCT.md) settles the two channels (an ntfy topic and a webhook), the four
switchable events and the nightly backup with seven copies. It leaves open what a notice
carries, whether fake mode sends one, how often the token and pool events repeat, what a failed
delivery does, and how a copy of a live database is made safely. A notice leaves the install and
a copy holds the Instagram token, so each choice leans towards sending and keeping less.

## Decision

- **A notice says what happened, and nothing about the photo.** It never carries coordinates, a
  file name, a caption or a link. Posted: that a select was posted, and how many are left in the
  pool. Failed: that a post failed for good, or that Instagram has not
  said whether it published one. Token: that the token expires in so many days (and could not be
  refreshed), or that Instagram no longer accepts it. Pool: how many selects are left, below the
  threshold. ntfy gets `topic`, `title`, `message` and the event as a tag, as JSON to the server's
  URL; the webhook gets `event`, `title` and `message` as a JSON POST.
- **Fake mode sends nothing.** As with Instagram and the bucket ([ADR 0006](0006-publishing-safety.md)),
  fake mode makes no outside request: each notice is recorded and shown in Settings as one that
  would have been sent, and Send test says so. Only `INSTAGRAM_API=live` sends.
- **The publisher tells how each post settles** (published, failed for good, or left needing a
  check), whether a slot or Post now made it, and whenever Instagram decides it later. Dry runs
  and what the owner says by hand on the Posted screen are not told. The scheduler's notify hook
  ([ADR 0007](0007-scheduling.md)) runs the token and pool checks after each slot; a timer runs
  them every minute too.
- **The token event repeats once a day until fixed.** It fires while the known expiry is within
  7 days, or once Instagram refuses the token. A token whose expiry is unknown (never refreshed)
  is told only once refused: its expiry is never guessed.
- **The pool event fires once per crossing.** It fires when the pool drops below the threshold
  (10 by default, 1 to 10,000), and again only after the pool has been back at or above it. A
  crossing while the event is off is not sent later.
- **Delivery is best effort and never holds up a post.** Each channel gets up to three tries
  (waits of 2 and 10 seconds) for no answer, a timeout of 10 seconds, a 5xx or a 429; any other
  answer fails at once. Sending runs in the background and never throws into the publisher or
  the scheduler. Redirects are not followed and the answer's body is never read. Each channel's
  last error is shown in Settings in words without its URL; the latest 20 notices are kept.
- **Channel secrets are written, never read back.** URLs must be http or https with no user name
  or password. Settings shows the ntfy server, the first three characters of the topic, whether
  an access token is set, and only the scheme and host of the webhook URL. They are kept in the
  settings table with everything else the UI sets, so no migration was needed.
- **A backup is a snapshot made by `VACUUM INTO`** from the app's own connection: a read
  transaction, so the copy is consistent while Selects runs and holds everything committed,
  WAL included. It is written into an empty owner-only temporary file in `backups` in the data
  volume and renamed to `selects-YYYY-MM-DD.db`, by its date in the install's timezone (the
  schedule's); a second copy that day replaces the first. Seven are kept.
- **A backup runs whenever the latest 03:30 in the install's timezone has none**: nightly, and at
  start after a stop. A failure is shown in Settings with its kind only and tried again an hour
  later. One runs at a time. The last copy's time is read from the files, not the database, so a
  restored database never misreports it.

- **A restored copy starts paused.** `SELECTS_START_PAUSED=true` starts Selects with posting
  paused and holds every post that was under way as needing a check, so nothing in a restored
  copy is posted or sent again before its owner has compared it with Instagram.
- **A notice is never taken by Selects itself.** Each carries a header that Selects refuses, so
  a webhook set to the app's own address cannot call it in a loop.

## Consequences

- Nobody learns of a fake-mode post through a notification, and a channel can only be proven
  against its real server with `INSTAGRAM_API=live`.
- A notice tells the owner to open Selects; it never shows which photo.
- A channel that fails all three tries (about 12 seconds of waits between them) misses that notice.
- A restored copy brings back the state of that night: a select posted since is back in the pool.
  The README says to pause posting and check before the next slot.
- Notification settings and backups add no environment variable.
