# ADR 0007: A slot posts at most once a day, on time while Selects runs, and never late beyond its grace period

## Status

Accepted, November 13, 2026.

## Context

[docs/PRODUCT.md](../PRODUCT.md) settles what the schedule does ("Picking" and "Schedule"). It
leaves open what a spread means, how a time is read across daylight saving changes, which rule
relaxes first, what "oldest" goes by, when a new slot first posts, how running late is told
apart from downtime, what the pause switch holds back, what happens to a select that cannot be
posted, and how a restart is kept from posting a slot twice. As with publishing
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
  even within the grace period. Changing the timezone changes every slot. A slot moved to a later
  time on a day it was missed, paused, empty or not posted comes round again at the new time.
- **A skip belongs to the slot's day.** Editing the slot's spread, days or time, the timezone or
  the grace period keeps it, as long as that day is still one of the slot's days; if the time or
  the timezone moves the slot, the skip moves with it on that local date. Skip can be taken back
  until the slot's time.
- **Next up is chosen when a slot is recorded, a day ahead**, and stored as the select only.
  The frame and caption are built when it posts. It is planned again, for every slot still to
  come and soonest first, before a slot posts, after every change to who is free (skip, undo
  skip, swap, a queue change, pause, the pick rules, a post settling) and whenever next up is
  shown, so what shows is what will post.
- **The queue's head always goes first.** At the moment a slot posts, and whenever next up is
  shown, a slot takes the head of the queue while the queue holds a free select, whatever left
  it free (a slot skipped, paused, missed, empty, unavailable or a dry run): planned pool picks
  give way to it. A swap is the owner's and stands while its select is free. Swap passes over
  each select in turn and comes round again once all have been passed; a select passed over
  still posts when nothing else is left.
- **Pool picks count the slots before them.** Planning a slot counts the picks of earlier slots
  that have not posted yet as posted, for spacing by capture day and by place. A planned pool
  pick is kept while the rules still allow it and picked again when they no longer do, so the
  rules are checked again as the slot posts.
- **A select that cannot be posted as it stands is passed over.** Before a slot takes a select,
  what would be sent is checked: one whose caption or alt text is over a limit, or that is gone,
  is passed over for the next candidate, stays queued or in the pool, and is listed on the Queue
  screen as needing attention, with why. A slot with nothing else left is recorded as empty.
- **The timer checks every 30 seconds, and a slot found within a minute of its due time is on
  time.** The minute is the tolerance: one timer interval, and as much again for a tick that runs
  late. Lateness past it is downtime (Selects or its timer was not running at the slot's time).
- **While Selects runs, every due slot posts**, one after another, two at the same minute
  included; the publisher runs attempts one at a time.
- **Missed slots never stack.** Of the slots found past the tolerance, only the latest posts,
  only within the grace period plus the tolerance (120 minutes by default, 0 to 1,440), and only
  if no slot on time posts at that check. The others are recorded as missed. A grace period of 0
  means a slot never posts after downtime; it still posts on time. After a stop, the slots that
  came round while it lasted are recorded as missed, as far back as history is kept (30 days).
- **A slot is claimed before the publisher is called**, with the select and the time. At start,
  a claimed slot whose post exists (a post of that select made since the claim) is recorded
  with it; one with no post goes back to waiting, and posts if still within the grace period.
  The publisher's own claim ([ADR 0006](0006-publishing-safety.md)) keeps a select in one live
  post.
- **Without an account or a bucket, a slot takes nothing.** It is recorded as not posted, with
  the reason, and its select stays queued or in the pool. The Queue screen says why slots
  cannot post before they come, and in dry run what a real post would lack.
- **The pause switch holds back scheduled slots only.** A slot due while paused is recorded as
  paused (or missed, if it was already past grace when found) and does not post when the switch
  goes off. Post now, and the retries of a post already started, still run. The Queue screen
  says so beside the switch, and shows each slot to come as paused.
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
  stays where it was. A queued select stays in the queue until its post is published, so one
  whose post fails for good, or is marked as not posted, is back at the head. A slot's history
  follows its post's state to the end: posting, retrying, needs checking, published or failed.
- **Slot IDs are 1 to 64 letters, digits, `-` or `_`**, unique in the schedule: they name a
  slot's day in a URL. Logs name a run by its date and the slot's place in the schedule, never
  its ID.
- **Each slot that came round is passed to a notify hook**, empty until notifications (issue
  #10) use it.

## Consequences

- A slot moved later on the day it already posted, or recorded a dry run, does not come round
  again that day.
- After a stop longer than the grace period, the schedule resumes at the next slot without
  catching up.
- A slot found more than a minute late while Selects runs (the machine asleep, a tick held up)
  counts as downtime.
- A caption that grows past a limit after its select was queued holds that select back, not the
  queue behind it.
- A day with a 25-hour or 23-hour length still posts each slot once.
