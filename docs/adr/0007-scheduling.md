# ADR 0007: A slot posts at most once a day, on time while Selects runs, and never late beyond its grace period

## Status

Accepted, November 13, 2026.

## Context

[docs/PRODUCT.md](../PRODUCT.md) settles what the schedule does ("Picking" and "Schedule"). It
leaves open what a spread means, how a time is read across daylight saving changes, which rule
relaxes first, what "oldest" goes by, when a new slot first posts, how running late is told
apart from downtime, what the pause switch holds back, what happens to a select that cannot be
posted or whose post fails for good, and how a restart is kept from posting a slot twice. As with publishing
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
  even within the grace period. Changing the timezone changes every slot. That day's run takes
  the new time, keeping the spread already drawn when the spread is unchanged; if the new time
  has already passed, that day's run is dropped whatever its spread, so a slot moved earlier
  never posts later that day through its old spread. A slot moved to a later time on a day it
  was missed, paused, empty or not posted comes round again at the new time.
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
  screen as needing attention, with why. It stays listed, and passed over, until it is postable
  again or leaves the pool: each plan checks again up to 20 of those listed, the longest
  unchecked first. A slot with nothing else left is recorded as empty.
- **A select Instagram refused is held back for 7 days.** When a select's latest post
  (dry runs aside), scheduled or by Post now, has failed for good because Instagram refused the
  select itself (its image or its caption), slots pass it over, in the
  queue and the pool, for 7 days from when Selects saw the failure (within a tick), or until its
  owner presses Try again on the Queue screen, which clears the hold at once. It keeps its place
  in the queue, out of the head's way, and is listed as needing attention with the failure's
  reason and when it will be tried again. Post now still posts it. A later post of it replaces
  the hold: published ends it, a newer failure starts a new one. Failures are recorded in
  `post_failures`; one made before that table existed counts from when its post was made.
- **Planning is bounded.** A plan works out each select's eligibility and checks what would be
  sent at most once, works the pick rules out once per step of relaxing them rather than once
  per select passed over, and checks at most 50 selects (rechecks included), in pick order. A
  select past that is taken as postable until its turn: when a slot is about to post, next up
  is checked, and if it cannot be posted the slot plans again (up to 20 times) before it is
  recorded as empty. Reading the schedule makes one plan, and one more check for what would stop
  any post (the account and the bucket); listing what needs attention checks nothing.
- **The timer checks every 30 seconds, and a slot found within a minute of its due time is on
  time.** The minute is the tolerance: one timer interval, and as much again for a tick that runs
  late. A slot found later than that is late, whatever the cause.
- **Late is told apart from downtime by the last tick.** Each tick records when it started and
  when it ended. A slot found late when the last tick was within 5 minutes (10 intervals) is
  recorded as found late: Selects was running but checked late, held up by a long post or the
  machine. After a longer gap in ticks it is recorded as missed: Selects was not running.
- **Every due slot found on time posts**, one after another, two at the same minute included;
  the publisher runs attempts one at a time. As each awaits its post, each slot after it is read
  again before it is claimed: one paused meanwhile is recorded as paused, and one skipped, moved
  later or otherwise settled meanwhile does not post now. Dry run is read when the slot is
  claimed, not before the tick.
- **Late slots never stack.** Of the slots found late, only the latest posts, only within the
  grace period plus the tolerance (120 minutes by default, 0 to 1,440), and only if no slot on
  time posts at that check. The others are recorded as missed or found late. A grace period of 0
  means a slot found late never posts; it still posts on time. After a stop, the slots that came
  round while it lasted are recorded as missed, as far back as history is kept (30 days).
- **A slot is claimed before the publisher is called**, with the select and the time. At start,
  a claimed slot whose post exists (a post of that select made since the claim) is recorded
  with it; one with no post goes back to waiting, and posts if still within the grace period.
  The publisher's own claim ([ADR 0006](0006-publishing-safety.md)) keeps a select in one live
  post.
- **Without an account or a bucket, a slot takes nothing.** It is recorded as not posted, with
  the reason, and its select stays queued or in the pool. The Queue screen says why slots
  cannot post before they come, and in dry run what a real post would lack.
- **The pause switch holds back scheduled slots only.** A slot due while paused is recorded as
  paused (or missed or found late, if it was already past grace when found) and does not post
  when the switch goes off. It is checked again before each slot in a tick, so pausing while one
  posts holds back the rest. Post now, and the retries of a post already started, still run. The Queue screen
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
  whose post fails for good, or is marked as not posted, keeps its place there, held back as
  above. A slot's history
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
- A slot found more than a minute late while Selects runs (a tick held up, the machine asleep)
  is late: it posts only within the grace period, and only the latest. It is recorded as found
  late when this process's last tick was recent, and as missed after a longer gap or a restart.
- A select Instagram refuses for good no longer takes every slot: it is tried again a week
  later, or when its owner says so, and the queue and pool behind it keep posting meanwhile. A
  failure that was not the select's (a refused token, Instagram not answering through every
  retry, an edit made while it retried, a post marked as not posted by hand) holds nothing: the
  next slot tries that select again.
- An edit to a slot's days or spread after its time has passed, while it waits on its spread,
  leaves that day's post as drawn. Only moving its time to one already past drops that day.
- With thousands of selects, a plan stays quick: at most 50 checks, and one pass of the pick
  rules per step. A select fixed after it was listed as needing attention may wait a few plans
  before it is checked again and picked.
- A caption that grows past a limit after its select was queued holds that select back, not the
  queue behind it.
- A day with a 25-hour or 23-hour length still posts each slot once.
