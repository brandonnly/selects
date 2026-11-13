/**
 * Keeps an older answer from replacing a newer one on screen. Every change to what a read shows
 * is started and ended here; a read is shown only if no change began or was on its way while it
 * ran, and a change's answer only if no later change began since.
 */
export function createFreshness() {
  let started = 0;
  let pending = 0;
  return {
    /** Call before sending a change. */
    startWrite(): number {
      pending++;
      return ++started;
    },
    /** Call once its answer is in, or it failed. True when its answer is the latest to show. */
    endWrite(write: number): boolean {
      pending--;
      return write === started;
    },
    /** Call before sending a read. Undefined when a change is on its way: the read is never shown. */
    startRead(): number | undefined {
      return pending === 0 ? started : undefined;
    },
    /** True when no change began or is on its way since the read began. */
    readIsFresh(read: number | undefined): boolean {
      return read !== undefined && read === started && pending === 0;
    },
  };
}

export type Freshness = ReturnType<typeof createFreshness>;

/** Sends a change through `freshness`: its answer, and whether it is the latest to show. */
export async function track<T>(
  freshness: Freshness,
  send: () => Promise<T>,
): Promise<{ answer: T; latest: boolean }> {
  const write = freshness.startWrite();
  let answer: T;
  try {
    answer = await send();
  } catch (error) {
    freshness.endWrite(write);
    throw error;
  }
  return { answer, latest: freshness.endWrite(write) };
}
