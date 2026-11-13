import type { Run, Select } from "@selects/server";
import { Plus, RotateCcw, Shuffle, SkipForward, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "@/api";
import { PickRulesEditor } from "@/components/pick-rules";
import { QueueList } from "@/components/queue-list";
import { ScheduleEditor } from "@/components/schedule-editor";
import { Button } from "@/components/ui/button";
import { problemsIn } from "@/lib/autosave";
import { createFreshness, type Freshness, track } from "@/lib/freshness";
import { describeRun, move, slotTime } from "@/lib/schedule";
import { Screen } from "./screen";

/** How often next up and recent slots are checked again: the schedule runs every half minute. */
const POLL_MS = 30_000;

type ScheduleView = NonNullable<Awaited<ReturnType<typeof api.schedule.get>>["data"]>;
type QueueView = { queue: Select[]; pool: Select[] };

export function QueueScreen() {
  const [view, setView] = useState<ScheduleView | undefined>();
  const [queue, setQueue] = useState<QueueView | undefined>();
  const [loadError, setLoadError] = useState({ schedule: false, queue: false });
  const [queueError, setQueueError] = useState(false);
  // Every change to what the schedule read shows goes through this: a read that began before a
  // change, or while one was on its way, never puts an older schedule back on screen.
  const [fresh] = useState(createFreshness);

  const loadSchedule = useCallback(async () => {
    const read = fresh.startRead();
    let failed = true;
    try {
      const { data, error } = await api.schedule.get();
      if (data && read !== undefined && fresh.readIsFresh(read)) {
        fresh.showRead(read);
        setView(data);
      }
      failed = error !== null;
    } catch {}
    // A failure of a read that a change has since overtaken says nothing about now.
    if (!failed || fresh.readIsFresh(read)) setLoadError((current) => ({ ...current, schedule: failed }));
  }, [fresh]);
  /** Shows a change's answer when it is the latest; otherwise the latest one's answer shows. */
  const showAnswer = useCallback(
    (latest: boolean, data: ScheduleView | null | undefined) => {
      // An answer that is not the latest may still be the last to arrive: what the server
      // holds is read again (and shown only once no change is on its way).
      if (!latest || !data) void loadSchedule();
      else setView(data);
    },
    [loadSchedule],
  );

  // Queue changes go one after another; only the answer to the latest is shown. A read is shown
  // only if no change was started or waiting while it ran: an older read never replaces a newer queue.
  const sending = useRef<Promise<unknown>>(Promise.resolve());
  const sent = useRef(0);
  const waiting = useRef(0);
  const loadQueue = useCallback(async () => {
    const mine = sent.current;
    const quiet = () => mine === sent.current && waiting.current === 0;
    if (!quiet()) return;
    let failed = true;
    try {
      const { data, error } = await api.queue.get();
      if (data && quiet()) setQueue(data);
      failed = error !== null;
    } catch {}
    setLoadError((current) => ({ ...current, queue: failed }));
  }, []);
  const retry = () => {
    void loadSchedule();
    void loadQueue();
  };

  useEffect(() => {
    void loadSchedule();
    void loadQueue();
    const timer = setInterval(() => {
      void loadSchedule();
      void loadQueue();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [loadSchedule, loadQueue]);

  const changeQueue = (next: QueueView) => {
    setQueue(next);
    const mine = ++sent.current;
    waiting.current++;
    const selectIds = next.queue.map((select) => select.id);
    sending.current = sending.current
      // Next up changes with the queue: a schedule read overlapping it is not shown.
      .then(() => track(fresh, () => api.queue.put({ selectIds })))
      .then(({ answer: { data, error } }) => {
        if (mine !== sent.current) return;
        setQueueError(error !== null);
        if (data) setQueue(data);
        void loadSchedule();
      })
      .catch(() => {
        if (mine === sent.current) setQueueError(true);
      })
      .finally(() => {
        waiting.current--;
      });
  };

  const nextUp = useMemo(
    () =>
      new Set(
        (view?.upcoming ?? [])
          .filter((run) => run.state === "planned" && run.selectId !== null)
          .map((run) => run.selectId as string),
      ),
    [view],
  );

  return (
    <Screen title="Queue">
      {(loadError.schedule || loadError.queue) && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
          {view === undefined || queue === undefined
            ? "Couldn't load the queue and the schedule."
            : "Couldn't reach the server: what shows may be out of date."}
          <Button variant="outline" size="sm" onClick={retry}>
            Try again
          </Button>
        </div>
      )}
      {view !== undefined && (
        <Status view={view} queued={queue?.queue.length ?? 0} fresh={fresh} onAnswer={showAnswer} />
      )}

      {view !== undefined && view.attention.length > 0 && (
        <Attention view={view} fresh={fresh} onAnswer={showAnswer} />
      )}

      {view !== undefined && (
        <section aria-labelledby="next-up" className="flex flex-col gap-3">
          <h2 id="next-up" className="text-sm font-medium text-muted-foreground">
            Next up
          </h2>
          <NextUp view={view} fresh={fresh} onAnswer={showAnswer} />
        </section>
      )}

      <section aria-labelledby="queued" className="flex flex-col gap-3">
        <h2 id="queued" className="text-sm font-medium text-muted-foreground">
          {queue === undefined ? "Queued" : `Queued: ${queue.queue.length}`}
        </h2>
        <p className="text-sm text-muted-foreground">
          The queue posts first, in this order, before anything from the pool. Drag a handle, or focus it and
          use the arrow keys.
        </p>
        {queueError && <p className="text-sm text-destructive">Couldn't save the queue. Try again.</p>}
        {queue !== undefined && queue.queue.length === 0 && (
          <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            Nothing queued: slots pick from the pool under the pick rules.
          </p>
        )}
        {queue !== undefined && queue.queue.length > 0 && (
          <QueueList
            selects={queue.queue}
            nextUp={nextUp}
            onMove={(from, to) => changeQueue({ ...queue, queue: move(queue.queue, from, to) })}
            onRemove={(id) => {
              const removed = queue.queue.find((select) => select.id === id);
              changeQueue({
                queue: queue.queue.filter((select) => select.id !== id),
                pool: removed === undefined ? queue.pool : [removed, ...queue.pool],
              });
            }}
          />
        )}
        {queue !== undefined && (
          <Pool
            pool={queue.pool}
            onAdd={(select) =>
              changeQueue({
                queue: [...queue.queue, select],
                pool: queue.pool.filter((other) => other.id !== select.id),
              })
            }
          />
        )}
      </section>

      {view !== undefined && (
        <section aria-labelledby="schedule" className="flex flex-col gap-3">
          <h2 id="schedule" className="text-sm font-medium text-muted-foreground">
            Schedule
          </h2>
          <ScheduleEditor
            schedule={view.schedule}
            fresh={fresh}
            // The answer is the whole view, with next up for the new slots.
            onSaved={showAnswer}
          />
        </section>
      )}

      {view !== undefined && (
        <section aria-labelledby="pick-rules" className="flex flex-col gap-3">
          <h2 id="pick-rules" className="text-sm font-medium text-muted-foreground">
            Pick rules
          </h2>
          <PickRulesEditor rules={view.rules} fresh={fresh} onSaved={() => void loadSchedule()} />
        </section>
      )}

      {view !== undefined && view.history.length > 0 && (
        <section aria-labelledby="recent-slots" className="flex flex-col gap-3">
          <h2 id="recent-slots" className="text-sm font-medium text-muted-foreground">
            Recent slots
          </h2>
          <ul className="flex flex-col gap-2 text-sm">
            {view.history.slice(0, 8).map((run) => {
              const { label, detail } = describeRun(run);
              return (
                <li key={run.id} className="flex flex-col gap-0.5 rounded-lg border bg-card p-3">
                  <span className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">{slotTime(run.dueAt, view.schedule.timeZone)}</span>
                    <span
                      className={
                        label === "Failed" || label === "Needs checking"
                          ? "text-destructive"
                          : run.state === "posted" || run.state === "dry-run"
                            ? ""
                            : "text-muted-foreground"
                      }
                    >
                      {label}
                    </span>
                  </span>
                  {run.fileName !== null && (
                    <span className="truncate text-muted-foreground">{run.fileName}</span>
                  )}
                  {detail !== null && <span className="text-muted-foreground">{detail}</span>}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </Screen>
  );
}

/** The pause switch, and what the schedule will do next, in words. */
type OnAnswer = (latest: boolean, data: ScheduleView | null | undefined) => void;

function Status({
  view,
  queued,
  fresh,
  onAnswer,
}: {
  view: ScheduleView;
  queued: number;
  fresh: Freshness;
  onAnswer: OnAnswer;
}) {
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const setPaused = async (paused: boolean) => {
    setState("saving");
    try {
      const {
        answer: { data, error },
        latest,
      } = await track(fresh, () => api.schedule.paused.put({ paused }));
      if (error || !data) throw error;
      onAnswer(latest, data);
      setState("idle");
    } catch {
      setState("failed");
    }
  };

  const notes: { text: string; alert?: boolean; link?: boolean }[] = [];
  const zone = `${view.schedule.timeZone.replaceAll("_", " ")} time`;
  if (view.schedule.slots.length === 0)
    notes.push({ text: "No slots yet: nothing posts. Add one under Schedule." });
  else if (view.paused)
    notes.push({
      text: "Paused: no slot posts while this is on. A slot whose time passes meanwhile does not post later.",
    });
  else if (view.nextSlotAt !== null)
    notes.push({ text: `Next post due ${slotTime(view.nextSlotAt, view.schedule.timeZone)}, ${zone}.` });
  else if (view.upcoming.length > 0) notes.push({ text: "No slot in the next day has anything to post." });
  if (view.dryRun) {
    notes.push({ text: "Dry run is on: each slot records a dry run, and the select stays where it was." });
    if (view.problems.length > 0)
      notes.push({
        text: `With dry run off, slots couldn't post yet: ${view.problems.join(" ")}`,
        link: true,
      });
  } else if (!view.paused && view.problems.length > 0) {
    notes.push({
      text: `Slots can't post: ${view.problems.join(" ")} Until then each slot takes nothing from the queue or the pool.`,
      alert: true,
      link: true,
    });
  }
  if (view.poolSize === 0 && queued === 0)
    notes.push({ text: "Nothing to post: add selects in the Library." });

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4 text-sm text-card-foreground">
      <label className="flex items-center gap-2 font-medium">
        <input
          type="checkbox"
          checked={view.paused}
          disabled={state === "saving"}
          onChange={(event) => setPaused(event.currentTarget.checked)}
          className="size-4 accent-primary"
        />
        Pause posting
      </label>
      <p className="text-muted-foreground">
        Stops scheduled slots only. Post now, from the Library, still posts, and a post already started still
        retries.
      </p>
      {state === "failed" && <p className="text-destructive">Couldn't save. Try again.</p>}
      {notes.map((note) => (
        <p
          key={note.text}
          role={note.alert ? "alert" : undefined}
          className={note.alert ? "text-destructive" : ""}
        >
          {note.text}
          {note.link && (
            <>
              {" "}
              <Link to="/settings" className="underline underline-offset-4">
                Settings
              </Link>
            </>
          )}
        </p>
      ))}
    </div>
  );
}

/** The slots to come within a day, each with its next up, to swap or skip. */
function NextUp({ view, fresh, onAnswer }: { view: ScheduleView; fresh: Freshness; onAnswer: OnAnswer }) {
  const [problem, setProblem] = useState<{ key: string; text: string } | undefined>();
  // Each run's own pending action: one starting on another run never frees this one's controls.
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());

  if (view.upcoming.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
        {view.schedule.slots.length === 0
          ? "Next up shows here once there is a slot."
          : "Next up is chosen a day before each slot."}
      </p>
    );
  }

  const act = async (run: Run, action: "swap" | "skip" | "unskip") => {
    const key = run.id;
    setBusy((current) => new Set(current).add(key));
    setProblem((current) => (current?.key === key ? undefined : current));
    try {
      const {
        answer: { data, error },
        latest,
      } = await track(fresh, () => api.schedule.runs({ id: run.id })[action].post());
      if (data) onAnswer(latest, data);
      if (error) {
        const problems = problemsIn(error.value);
        setProblem({
          key,
          text: problems.length > 0 ? problems.join(" ") : "Couldn't change it. Try again.",
        });
      }
    } catch {
      setProblem({ key, text: "Couldn't change it. Try again." });
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  return (
    <ul className="flex flex-col gap-3">
      {view.upcoming.map((run) => {
        const key = run.id;
        const skipped = run.state === "skipped";
        const time = slotTime(run.dueAt, view.schedule.timeZone);
        // Names the slot for a screen reader: its time, and its next up for two slots at one time.
        const slot = `the slot at ${time}${run.fileName === null ? "" : `, ${run.fileName}`}`;
        return (
          <li
            key={key}
            className={
              skipped
                ? "flex flex-col gap-3 rounded-lg border border-dashed p-3 text-sm"
                : "flex flex-col gap-3 rounded-lg border border-l-4 border-l-brand bg-card p-3 text-sm text-card-foreground"
            }
          >
            <div className="flex items-center gap-3">
              {run.selectId !== null && !skipped ? (
                <img
                  src={`/api/selects/${run.selectId}/thumbnail`}
                  alt=""
                  className="size-16 shrink-0 rounded-md bg-muted object-cover"
                />
              ) : (
                <span aria-hidden className="size-16 shrink-0 rounded-md border border-dashed" />
              )}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-medium">{time}</span>
                <span className="truncate">
                  {skipped
                    ? "Skipped: nothing posts in this slot."
                    : run.state === "posting"
                      ? "Posting…"
                      : (run.fileName ?? "Nothing to post")}
                </span>
                {view.paused && !skipped && run.state === "planned" && (
                  <span className="text-xs text-destructive">
                    Paused: this posts only if posting is switched back on before its time.
                  </span>
                )}
                {!skipped && run.picked !== null && (
                  <span className="text-xs text-muted-foreground">
                    {run.picked === "queue"
                      ? "From the queue"
                      : run.picked === "pool"
                        ? "From the pool"
                        : "Swapped in"}
                    {run.dueAt !== run.slotAt &&
                      ` · spread from ${slotTime(run.slotAt, view.schedule.timeZone).split(", ")[1]}`}
                  </span>
                )}
              </span>
            </div>
            {run.state !== "posting" && (
              <div className="flex flex-wrap gap-2">
                {skipped ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy.has(key)}
                    aria-label={`Don't skip the slot at ${time}`}
                    onClick={() => act(run, "unskip")}
                  >
                    <Undo2 aria-hidden className="size-4" />
                    Don't skip
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy.has(key) || run.selectId === null}
                      aria-label={`Swap next up for ${slot}`}
                      onClick={() => act(run, "swap")}
                    >
                      <Shuffle aria-hidden className="size-4" />
                      Swap
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy.has(key)}
                      aria-label={`Skip ${slot}`}
                      onClick={() => act(run, "skip")}
                    >
                      <SkipForward aria-hidden className="size-4" />
                      Skip
                    </Button>
                  </>
                )}
              </div>
            )}
            {problem?.key === key && <p className="text-muted-foreground">{problem.text}</p>}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Selects slots pass over: those that can't be posted as they stand, until fixed, and those held
 * back after a failed post, until they are tried again.
 */
function Attention({ view, fresh, onAnswer }: { view: ScheduleView; fresh: Freshness; onAnswer: OnAnswer }) {
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [problem, setProblem] = useState<string | undefined>();

  const tryAgain = async (selectId: string) => {
    setBusy((current) => new Set(current).add(selectId));
    setProblem((current) => (current === selectId ? undefined : current));
    try {
      const {
        answer: { data },
        latest,
      } = await track(fresh, () => api.schedule.holds({ id: selectId }).delete());
      if (!data) setProblem(selectId);
      onAnswer(latest, data);
    } catch {
      setProblem(selectId);
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(selectId);
        return next;
      });
    }
  };

  return (
    <section aria-labelledby="attention" className="flex flex-col gap-3">
      <h2 id="attention" className="text-sm font-medium text-destructive">
        Needs attention
      </h2>
      <p className="text-sm text-muted-foreground">
        Slots pass these over and they keep their place. One that can't be posted as it stands waits until
        it's fixed in the{" "}
        <Link to="/library" className="underline underline-offset-4">
          Library
        </Link>
        ; one whose post failed is tried again after a week, or now with Try again. Post now still posts any
        of them.
      </p>
      <ul className="flex flex-col gap-2 text-sm">
        {view.attention.map((item) => (
          <li key={item.selectId} className="flex flex-col gap-2 rounded-lg border border-destructive p-3">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate font-medium">{item.fileName}</span>
              <span className="text-muted-foreground">{item.problems.join(" ")}</span>
              {item.heldUntil !== null && (
                <span className="text-muted-foreground">
                  Slots try it again from {slotTime(item.heldUntil, view.schedule.timeZone)}.
                </span>
              )}
            </span>
            {item.heldUntil !== null && (
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                disabled={busy.has(item.selectId)}
                aria-label={`Try ${item.fileName} again`}
                onClick={() => tryAgain(item.selectId)}
              >
                <RotateCcw aria-hidden className="size-4" />
                Try again
              </Button>
            )}
            {problem === item.selectId && <p className="text-destructive">Couldn't change it. Try again.</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Selects in the pool, to add to the end of the queue. */
function Pool({ pool, onAdd }: { pool: Select[]; onAdd: (select: Select) => void }) {
  if (pool.length === 0) return null;
  return (
    <details className="group rounded-lg border bg-card text-sm text-card-foreground">
      <summary className="flex h-11 cursor-pointer items-center gap-2 px-3 font-medium">
        <Plus aria-hidden className="size-4" />
        Add from the pool ({pool.length})
      </summary>
      <ul className="grid grid-cols-1 gap-2 border-t p-3 sm:grid-cols-2">
        {pool.map((select) => (
          <li key={select.id} className="flex items-center gap-3">
            <img
              src={`/api/selects/${select.id}/thumbnail`}
              alt=""
              loading="lazy"
              className="size-12 shrink-0 rounded-md bg-muted object-cover"
            />
            <span className="min-w-0 flex-1 truncate">{select.fileName}</span>
            <Button
              variant="outline"
              size="sm"
              aria-label={`Add ${select.fileName} to the queue`}
              onClick={() => onAdd(select)}
            >
              Add
            </Button>
          </li>
        ))}
      </ul>
    </details>
  );
}
