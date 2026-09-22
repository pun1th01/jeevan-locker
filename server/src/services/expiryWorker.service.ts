import { expireDueGrants, readPositiveIntSetting } from '../utils/emergencyAccess.util';

/**
 * Expires lapsed break-glass grants on a schedule, so a grant ends on time whether or not the doctor
 * who holds it ever makes another request. The lazy sweeps on the doctor's own reads stay as a
 * fallback: both go through the same status-guarded transition in emergencyAccess.util.ts, so the
 * EMERGENCY_ACCESS_EXPIRED audit row is written exactly once per grant no matter how they interleave.
 *
 * All state lives on the row (status + expiresAt), so a restart resumes with no bookkeeping: whatever
 * is still ACTIVE and lapsed is simply found by the next tick.
 *
 * A tick drains successive batches until one comes back short, so a backlog larger than a single batch
 * cannot be starved. Ticks never overlap: the next one is only scheduled once the current one has
 * finished, so a long tick delays the next rather than running two sweeps at once.
 */

const DEFAULTS = { pollMs: 60_000, batchLimit: 200 } as const;

export const readExpiryWorkerConfig = () => ({
  pollMs: readPositiveIntSetting('EMERGENCY_EXPIRY_POLL_MS', DEFAULTS.pollMs),
  batchLimit: readPositiveIntSetting('EMERGENCY_EXPIRY_BATCH_LIMIT', DEFAULTS.batchLimit),
});

/**
 * One sweep: drains batch after batch until a short batch says the backlog is gone. Returns the total.
 * `shouldContinue` lets the caller abort between batches — the ticking worker passes `() => !stopped`
 * so shutdown cuts a long drain short. It is NOT read from module state: a sweep called directly (a
 * script, a future admin "sweep now") must drain fully whether or not the worker happens to be running.
 */
export const runExpirySweep = async (shouldContinue: () => boolean = () => true): Promise<number> => {
  const { batchLimit } = readExpiryWorkerConfig();
  let total = 0;
  let batch = 0;

  do {
    batch = await expireDueGrants(batchLimit);
    total += batch;
  } while (batch === batchLimit && shouldContinue());

  return total;
};

let timer: NodeJS.Timeout | null = null;
let running = false;
let stopped = true;

const schedule = (delayMs: number) => {
  if (stopped) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void tick(), delayMs);
};

const tick = async () => {
  if (running || stopped) return;
  running = true;

  try {
    const expired = await runExpirySweep(() => !stopped);

    if (expired > 0) {
      console.log(`[expiry] expired ${expired} lapsed emergency access grant(s)`);
    }
  } catch (error) {
    console.error('[expiry] sweep failed:', error);
  } finally {
    running = false;
    // Scheduled only after the tick finished, so ticks can never overlap.
    schedule(readExpiryWorkerConfig().pollMs);
  }
};

export const startExpiryWorker = () => {
  stopped = false;
  schedule(0);
};

export const stopExpiryWorker = () => {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
};

/** Test helper: true while a tick is in flight. */
export const isExpirySweepRunning = () => running;

/** Test helper: resolves once no tick is in flight. */
export const waitForExpiryWorkerIdle = async () => {
  while (running) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
