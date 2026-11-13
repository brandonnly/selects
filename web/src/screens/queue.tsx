import type { Run, Select } from "@selects/server";
import { Plus, Shuffle, SkipForward, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "@/api";
import { PickRulesEditor } from "@/components/pick-rules";
import { QueueList } from "@/components/queue-list";
import { ScheduleEditor } from "@/components/schedule-editor";
import { Button } from "@/components/ui/button";
import { problemsIn } from "@/lib/autosave";
import { describeRun, move, slotTime } from "@/lib/schedule";
import { Screen } from "./screen";

/** How often next up and recent slots are checked again: the schedule runs every half minute. */
const POLL_MS = 30_000;

type ScheduleView = NonNullable<Awaited<ReturnType<typeof api.schedule.get>>["data"]>;
type QueueView = { queue: Select[]; pool: Select[] };

export function QueueScreen() {
  const [view, setView] = useState<ScheduleView | undefined>();
  const [queue, setQueue] = useState<QueueView | undefined>();
  const [loadError, setLoadError] = useState(false);
  const [queueError, setQueueError] = useState(false);

  const loadSchedule = useCallback(async () => {
    try {
      const { data, error } = await api.schedule.get();
      if (data) setView(data);
      setLoadError(error !== null);
    } catch {
      setLoadError(true);
    }
  }, []);

  // Queue changes go one after another; only the answer to the latest is shown.
  const sending = useRef<Promise<unknown>>(Promise.resolve());
  const sent = useRef(0);
  const loadQueue = useCallback(async () => {
    const mine = sent.current;
    try {
      const { data } = await api.queue.get();
      if (data && mine === sent.current) setQueue(data);
    } catch {}
  }, []);

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
    const selectIds = next.queue.map((select) => select.id);
    sending.current = sending.current
      .then(() => api.queue.put({ selectIds }))
      .then(({ data, error }) => {
        if (mine !== sent.current) return;
        setQueueError(error !== null);
        if (data) setQueue(data);
        void loadSchedule();
      })
      .catch(() => {
        if (mine === sent.current) setQueueError(true);
      });
  };

  const selects = useMemo(() => {
    const all = new Map<string, Select>();
    for (const select of [...(queue?.queue ?? []), ...(queue?.pool ?? [])]) all.set(select.id, select);
    return all;
  }, [queue]);
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
      {loadError && <p className="text-sm text-destructive">Can't reach the server.</p>}
      {view !== undefined && <Status view={view} queued={queue?.queue.length ?? 0} onChange={setView} />}

      {view !== undefined && (
        <section aria-labelledby="next-up" className="flex flex-col gap-3">
          <h2 id="next-up" className="text-sm font-medium text-muted-foreground">
            Next up
          </h2>
          <NextUp view={view} selects={selects} onChange={setView} />
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
            // The answer is the whole view, with next up for the new slots.
            onSaved={setView}
          />
        </section>
      )}

      {view !== undefined && (
        <section aria-labelledby="pick-rules" className="flex flex-col gap-3">
          <h2 id="pick-rules" className="text-sm font-medium text-muted-foreground">
            Pick rules
          </h2>
          <PickRulesEditor rules={view.rules} onSaved={() => void loadSchedule()} />
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
                        run.state === "posted" || run.state === "dry-run" ? "" : "text-muted-foreground"
                      }
                    >
                      {label}
                    </span>
                  </span>
                  {run.selectId !== null && selects.get(run.selectId) && (
                    <span className="truncate text-muted-foreground">
                      {selects.get(run.selectId)?.fileName}
                    </span>
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
function Status({
  view,
  queued,
  onChange,
}: {
  view: ScheduleView;
  queued: number;
  onChange: (view: ScheduleView) => void;
}) {
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const setPaused = async (paused: boolean) => {
    setState("saving");
    try {
      const { data, error } = await api.schedule.paused.put({ paused });
      if (error || !data) throw error;
      onChange(data);
      setState("idle");
    } catch {
      setState("failed");
    }
  };

  const notes: { text: string; alert?: boolean; link?: boolean }[] = [];
  if (view.schedule.slots.length === 0)
    notes.push({ text: "No slots yet: nothing posts. Add one under Schedule." });
  else if (view.paused) notes.push({ text: "Paused: no slot posts until this is switched off." });
  else if (view.nextSlotAt !== null) {
    notes.push({
      text: `Next slot ${slotTime(view.nextSlotAt, view.schedule.timeZone)}, ${view.schedule.timeZone.replaceAll("_", " ")} time.`,
    });
  }
  if (view.dryRun)
    notes.push({ text: "Dry run is on: each slot records a dry run, and the select stays where it was." });
  if (!view.paused && view.problems.length > 0) {
    notes.push({
      text: `Slots can't post: ${view.problems.join(" ")} Until then they take nothing from the queue or the pool.`,
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
        Stops every slot from posting. Post now, from the Library, still works.
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
function NextUp({
  view,
  selects,
  onChange,
}: {
  view: ScheduleView;
  selects: ReadonlyMap<string, Select>;
  onChange: (view: ScheduleView) => void;
}) {
  const [problem, setProblem] = useState<{ key: string; text: string } | undefined>();
  const [busy, setBusy] = useState<string | undefined>();

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
    setBusy(key);
    setProblem(undefined);
    try {
      const { data, error } = await api.schedule.runs({ id: run.id })[action].post();
      if (data) onChange(data);
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
      setBusy(undefined);
    }
  };

  return (
    <ul className="flex flex-col gap-3">
      {view.upcoming.map((run) => {
        const key = run.id;
        const select = run.selectId === null ? undefined : selects.get(run.selectId);
        const skipped = run.state === "skipped";
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
              {select !== undefined && !skipped ? (
                <img
                  src={`/api/selects/${select.id}/thumbnail`}
                  alt=""
                  className="size-16 shrink-0 rounded-md bg-muted object-cover"
                />
              ) : (
                <span aria-hidden className="size-16 shrink-0 rounded-md border border-dashed" />
              )}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-medium">{slotTime(run.dueAt, view.schedule.timeZone)}</span>
                <span className="truncate">
                  {skipped
                    ? "Skipped: nothing posts in this slot."
                    : run.state === "posting"
                      ? "Posting…"
                      : (select?.fileName ?? "Nothing to post")}
                </span>
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
                    disabled={busy === key}
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
                      disabled={busy === key || run.selectId === null}
                      onClick={() => act(run, "swap")}
                    >
                      <Shuffle aria-hidden className="size-4" />
                      Swap
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy === key}
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
