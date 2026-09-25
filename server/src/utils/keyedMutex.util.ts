/**
 * Serialises async work per key, inside this process. Work under the same key runs one at a time, in arrival
 * order; work under different keys never waits for each other. The lock is released in `finally`, so a throw
 * or rejection anywhere in `work` can never leave a key held.
 *
 * Single-process by construction — the same deployment assumption as `sendSerialized` (chain.service.ts, the
 * wallet nonce) and the in-memory store behind the rate limiters (rateLimit.middleware.ts). A second server
 * process has its own locks. Where that matters, pair the lock with a database constraint (see the partial
 * unique index on EmergencyAccess) or replace it with one.
 */
export const createKeyedMutex = () => {
  const tails = new Map<string, Promise<void>>();

  return async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    tails.set(key, tail);

    await previous;

    try {
      return await work();
    } finally {
      release();
      // Nobody queued behind this holder: drop the key so the map cannot grow with every doctor ever seen.
      if (tails.get(key) === tail) {
        tails.delete(key);
      }
    }
  };
};
