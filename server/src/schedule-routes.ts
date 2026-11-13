import { Elysia, t } from "elysia";
import type { Captures } from "./capture";
import type { Library } from "./library";
import type { PickRules } from "./pick";
import { runKey, SCHEDULE_LIMITS, type Scheduler, SLOT_ID } from "./scheduler";
import type { Settings } from "./settings";
import type { Weekday } from "./slots";

const notFound = { error: "Not found" } as const;
const NOTHING_ELSE = "Nothing else to choose: the queue and the pool hold no other select.";

const slotSchema = t.Object(
  {
    id: t.String({ pattern: SLOT_ID.source }),
    days: t.Array(t.Integer({ minimum: 1, maximum: 7 }), { minItems: 1, maxItems: 7 }),
    time: t.String({ pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" }),
    spreadMinutes: t.Integer({ minimum: 0, maximum: SCHEDULE_LIMITS.spreadMinutes }),
  },
  { additionalProperties: false },
);

const scheduleSchema = t.Object(
  {
    slots: t.Array(slotSchema, { maxItems: SCHEDULE_LIMITS.slots }),
    timeZone: t.String({ minLength: 1, maxLength: 64 }),
    graceMinutes: t.Integer({ minimum: 0, maximum: SCHEDULE_LIMITS.graceMinutes }),
  },
  { additionalProperties: false },
);

const posts = t.Integer({ minimum: 1, maximum: 50 });
const pickRulesSchema = t.Object(
  {
    captureDay: t.Object({ on: t.Boolean(), posts }, { additionalProperties: false }),
    place: t.Object(
      { on: t.Boolean(), km: t.Number({ exclusiveMinimum: 0, maximum: 20_000 }), posts },
      { additionalProperties: false },
    ),
    order: t.Union([t.Literal("random"), t.Literal("oldest"), t.Literal("newest")]),
  },
  { additionalProperties: false },
);

export type ScheduleRoutesOptions = {
  scheduler: Scheduler;
  library: Library;
  captures: Captures;
  settings: Settings;
};

/** The schedule editor, the pick rules, the pause switch, next up and the queue. */
export function scheduleRoutes({ scheduler, library, captures, settings }: ScheduleRoutesOptions) {
  const view = () => ({
    schedule: scheduler.schedule(),
    paused: scheduler.paused(),
    rules: scheduler.rules(),
    dryRun: settings.publishing().dryRun,
    /** Slots to come within a day, with next up. */
    upcoming: scheduler.upcoming(),
    /** Slots that came round, latest first. */
    history: scheduler.history(),
    nextSlotAt: scheduler.nextSlotAt(),
    /** What would stop next up posting now. */
    problems: scheduler.problems(),
    poolSize: library.pool().length,
  });

  // The owner's view, as the Library shows it.
  const queueView = () => {
    const queued = scheduler.queue();
    const inQueue = new Set(queued);
    const show = (id: string) => {
      const select = library.get(id);
      return select === undefined ? [] : [captures.withEdits(select)];
    };
    return {
      queue: queued.flatMap(show),
      pool: library
        .pool()
        .filter((id) => !inQueue.has(id))
        .flatMap(show),
    };
  };

  return new Elysia()
    .get("/api/schedule", view)
    .put(
      "/api/schedule",
      ({ body, status }) => {
        const result = scheduler.setSchedule({
          ...body,
          slots: body.slots.map((slot) => ({ ...slot, days: slot.days as Weekday[] })),
        });
        if (!result.ok) return status(422, { problems: result.problems });
        return view();
      },
      { body: scheduleSchema },
    )
    .put(
      "/api/schedule/paused",
      ({ body }) => {
        scheduler.setPaused(body.paused);
        return view();
      },
      { body: t.Object({ paused: t.Boolean() }, { additionalProperties: false }) },
    )
    .put("/api/pick-rules", ({ body }) => scheduler.setRules(body as PickRules), { body: pickRulesSchema })
    .post("/api/schedule/runs/:id/swap", ({ params, status }) => {
      const key = runKey(params.id);
      const result = key === undefined ? "not-found" : scheduler.swap(key.slotId, key.date);
      if (result === "not-found") return status(404, notFound);
      if (result === "none") return status(409, { problems: [NOTHING_ELSE] });
      return view();
    })
    .post("/api/schedule/runs/:id/skip", ({ params, status }) => {
      const key = runKey(params.id);
      const result = key === undefined ? "not-found" : scheduler.skip(key.slotId, key.date);
      return result === "not-found" ? status(404, notFound) : view();
    })
    .post("/api/schedule/runs/:id/unskip", ({ params, status }) => {
      const key = runKey(params.id);
      const result = key === undefined ? "not-found" : scheduler.unskip(key.slotId, key.date);
      return result === "not-found" ? status(404, notFound) : view();
    })
    .get("/api/queue", queueView)
    .put(
      "/api/queue",
      ({ body }) => {
        scheduler.setQueue(body.selectIds);
        return queueView();
      },
      {
        body: t.Object(
          { selectIds: t.Array(t.String({ maxLength: 64 }), { maxItems: 10_000 }) },
          { additionalProperties: false },
        ),
      },
    );
}
