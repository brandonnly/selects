/**
 * Time, for everything that waits or compares against now: retry backoff, container polling and
 * token refresh. Tests pass a fake one, so they never sleep.
 */
export type Clock = {
  /** Milliseconds since the epoch. */
  now(): number;
  sleep(ms: number): Promise<void>;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
};

/** A clock that moves only when told to. Sleeping moves it on at once. */
export function createFakeClock(start = Date.parse("2026-11-13T09:00:00Z")) {
  let now = start;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

export type FakeClock = ReturnType<typeof createFakeClock>;

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
