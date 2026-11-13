# ADR 0007: A slot posts at most once a day, and never late beyond its grace period

## Status

Accepted, November 13, 2026.

## Context

[docs/PRODUCT.md](../PRODUCT.md) settles what the schedule does ("Picking" and "Schedule"). It
leaves open what a spread means, how a time is read across daylight saving changes, which rule
relaxes first, what "oldest" goes by, when a new slot first posts, what the pause switch holds
back, and how a restart is kept from posting a slot twice. As with publishing
([ADR 0006](0006-publishing-safety.md)), each leans towards posting nothing rather than twice.

## Decision

- **A slot comes round at most once a day.** Each slot on each day in the install's timezone
  is one row, keyed by the slot and the date. It is recorded up to a day ahead, with its random
  spread drawn then and stored, so a restart never draws it again.
- **A spread is a wait after the time**: a whole number of minutes from 0 to the spread, drawn
  at random. A slot never posts before its time.
- **Times are wall-clock times in one IANA timezone**, set in the UI, UTC until then. The
  server's own zone is never used. A time skipped as the clocks go forward posts as far past
  the change as it would have been (02:30 becomes 03:30); a time that happens twice as they go
  back posts the first time. These are Temporal's "compatible" choices.
- **A slot added or changed posts from its next time on**, never for a time before the change,
  even within the grace period. Changing the timezone changes every slot. Next up for a changed
  slot is chosen again.
- **Next up is chosen when a slot is recorded, a day ahead**, and stored as the select only.
  The frame and caption are built when it posts. When the slot comes, a next up no longer in
  the pool is chosen again. Next up chosen from the queue or the pool is chosen again when the
  queue changes, and next up from the pool when the pick rules change; a swap stands. Swap
  passes over each select in turn and comes round again once all have been passed. Skip leaves
  the slot empty and can be taken back until its time.
- **Missed slots never stack.** At each check, of the slots that came due, only the latest
  posts, and only within the grace period (120 minutes by default, 0 to 1,440). The others are
  recorded as missed.
- **A slot is claimed before the publisher is called**, with the select and the time. At start,
  a claimed slot whose post exists (a post of that select made since the claim) is recorded
  with it; one with no post goes back to waiting, and posts if still within the grace period.
  The publisher's own claim ([ADR 0006](0006-publishing-safety.md)) keeps a select in one live
  post.
- **Without an account or a bucket, a slot takes nothing.** It is recorded as not posted, with
  the reason, and its select stays queued or in the pool. The Queue screen says why slots
  cannot post before they come.
- **The pause switch holds back slots only.** A slot due while paused is recorded as paused and
  does not post when the switch goes off. Post now, and the retries of a post already started,
  still run.
- **Pick rules.** The queue ignores them. In the pool, spacing by capture day compares the
  calendar day the camera recorded; a select with no capture date passes it. Spacing by place
  compares the owner's view of each location, edits applied and hidden or not, since it only
  chooses and never publishes; a select with no location passes it. The latest posts are those
  out or on their way (not failed, not dry runs). When the rules leave nothing, spacing by
  place is relaxed first, then spacing by capture day, then both. Order is one of random,
  oldest first or newest first by capture time, undated last; it never leaves nothing, so it is
  never relaxed and has no off switch.
- **The scheduler posts only through the publisher**, which decides dry run, retries,
  `unconfirmed` and the return to the pool. In dry run a slot records a dry run and the select
  stays where it was. A real post takes its select out of the queue.
- **Each slot that came round is passed to a notify hook**, empty until notifications (issue
  #10) use it.

## Consequences

- A slot moved later on the day it already posted does not post again that day.
- After a stop longer than the grace period, the schedule resumes at the next slot without
  catching up.
- A day with a 25-hour or 23-hour length still posts each slot once.
