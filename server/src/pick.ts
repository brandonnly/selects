/**
 * Picking: which select a slot posts. Pure. The queue drains first, in order, ignoring the pick
 * rules; then the pool is picked from under them. A rule that would leave nothing to pick is
 * relaxed: spacing by place first, then spacing by capture day (ADR 0007).
 */

import { distanceMetres, type Point } from "./zones";

export type PickOrder = "random" | "oldest" | "newest";

/** The pick rules, each with a switch and its numbers. */
export type PickRules = {
  /** Not the same capture day as any of the last `posts` posts. */
  captureDay: { on: boolean; posts: number };
  /** Not within `km` of any of the last `posts` posts. */
  place: { on: boolean; km: number; posts: number };
  /** Which eligible select is taken: one at random, the oldest or the newest by capture time. */
  order: PickOrder;
};

export const DEFAULT_PICK_RULES: PickRules = {
  captureDay: { on: true, posts: 5 },
  place: { on: false, km: 10, posts: 5 },
  order: "random",
};

/** A rule that can be relaxed. Order never leaves nothing, so it never is. */
export type RelaxableRule = "place" | "captureDay";

/**
 * A select as the picker sees it: the owner's view, edits applied. Its location is for spacing
 * only and never leaves the picker.
 */
export type Candidate = {
  id: string;
  /** `YYYY-MM-DDTHH:MM:SS`, as the camera recorded it; null when unknown. */
  capturedAt: string | null;
  location: Point | null;
};

export type PickInput = {
  /** Queued select IDs, in order; only those in the pool. */
  queue: readonly string[];
  /** The pool, oldest added first. */
  pool: readonly Candidate[];
  /** The selects of the latest posts, newest first. */
  recent: readonly Candidate[];
  rules: PickRules;
  random: () => number;
  /** Selects not to take this time: next up for another slot, or swapped away. */
  exclude?: ReadonlySet<string>;
};

export type Pick = { selectId: string; from: "queue" | "pool"; relaxed: RelaxableRule[] };

/** Rules dropped in turn until something is left. */
const RELAXING: RelaxableRule[][] = [[], ["place"], ["captureDay"], ["place", "captureDay"]];

export function pick({ queue, pool, recent, rules, random, exclude }: PickInput): Pick | undefined {
  const allowed = (id: string) => !exclude?.has(id);
  const queued = queue.find(allowed);
  if (queued !== undefined) return { selectId: queued, from: "queue", relaxed: [] };
  const found = eligible({ pool, recent, rules, exclude });
  if (found === undefined) return undefined;
  return { selectId: choose(found.candidates, rules.order, random).id, from: "pool", relaxed: found.relaxed };
}

/**
 * The pool's selects the pick rules allow now, relaxed as little as leaves any: each is one `pick`
 * could choose before order is applied. Undefined when the pool leaves nothing.
 */
export function eligible({
  pool,
  recent,
  rules,
  exclude,
}: Omit<PickInput, "queue" | "random">): { candidates: Candidate[]; relaxed: RelaxableRule[] } | undefined {
  const open = pool.filter((candidate) => !exclude?.has(candidate.id));
  if (open.length === 0) return undefined;

  const day = (candidate: Candidate) => candidate.capturedAt?.slice(0, 10) ?? null;
  const recentDays = new Set(
    recent
      .slice(0, rules.captureDay.posts)
      .map(day)
      .filter((d) => d !== null),
  );
  const recentPlaces = recent
    .slice(0, rules.place.posts)
    .map((candidate) => candidate.location)
    .filter((place) => place !== null);

  const passes: Record<RelaxableRule, (candidate: Candidate) => boolean> = {
    captureDay: (candidate) => {
      const d = day(candidate);
      return !rules.captureDay.on || d === null || !recentDays.has(d);
    },
    place: (candidate) => {
      const here = candidate.location;
      if (!rules.place.on || here === null) return true;
      return recentPlaces.every((there) => distanceMetres(here, there) > rules.place.km * 1000);
    },
  };

  for (const relaxed of RELAXING) {
    const kept = (Object.keys(passes) as RelaxableRule[]).filter((rule) => !relaxed.includes(rule));
    const candidates = open.filter((candidate) => kept.every((rule) => passes[rule](candidate)));
    // Each step is reached only when keeping its rules left nothing, so every rule it drops mattered.
    if (candidates.length > 0) return { candidates, relaxed };
  }
  return undefined;
}

/** The candidate the order takes: one at random, or the oldest or newest by capture time. */
export function choose(eligible: Candidate[], order: PickOrder, random: () => number): Candidate {
  if (order === "random") {
    const index = Math.min(eligible.length - 1, Math.floor(random() * eligible.length));
    return eligible[index] as Candidate;
  }
  // By capture time; undated last, in the pool's order (oldest added first).
  const dated = eligible.filter((candidate) => candidate.capturedAt !== null);
  if (dated.length === 0) return eligible[0] as Candidate;
  const sorted = [...dated].sort((a, b) => (a.capturedAt ?? "").localeCompare(b.capturedAt ?? ""));
  return (order === "oldest" ? sorted[0] : sorted.at(-1)) as Candidate;
}
