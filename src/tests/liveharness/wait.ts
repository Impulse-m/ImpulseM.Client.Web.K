/*
 * Bounded condition wait for the B1 live lane.
 *
 * Every live scenario waits on the sign of the action itself (an event observed, a record
 * appearing), never on wall-clock sleeps. This helper is the shared primitive: it polls a
 * probe until it yields a value, and fails with the caller's own description of what never
 * happened — so a timeout names the missing observation, not just a number of milliseconds.
 */
export function waitUntil<T>(
  probe: () => T | undefined,
  timeoutMs: number,
  what: string
): Promise<T> {
  const startedAt = Date.now();
  return new Promise<T>((resolve, reject) => {
    const tick = () => {
      const value = probe();
      if(value !== undefined) {
        resolve(value);
        return;
      }

      if(Date.now() - startedAt > timeoutMs) {
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${what}`));
        return;
      }

      setTimeout(tick, 250);
    };

    tick();
  });
}
