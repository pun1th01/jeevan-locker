import { ChainAnchor, type IChainAnchor } from '../models/ChainAnchor';
import { ConsentGrant } from '../models/ConsentGrant';
import { EmergencyAccess } from '../models/EmergencyAccess';
import { createAuditLog } from '../utils/audit.util';
import { SYSTEM_IP_ADDRESS } from '../utils/emergencyAccess.util';
import { anchorDigest, findAnchoredEvent, getAnchor, type AnchorResult } from './auditAnchor.service';

/**
 * Drains PENDING ChainAnchor rows, one transaction at a time (the wallet nonce is per process — see
 * chain.service.sendSerialized). Nothing about the worker's state lives in memory: every attempt updates
 * the row (attempts, lastAttemptAt, nextAttemptAt, lastError), so a restart resumes exactly where the
 * previous process stopped and a long-pending row explains itself without logs.
 *
 * Backoff: 5s · 2^(attempts-1), capped at 1 hour. Attempt cap 60 ≈ 50 hours of continuous outage before
 * a row becomes FAILED (still visible, retryable by an admin, audited as CHAIN_ANCHOR_FAILED).
 * Overridable for tests/dev: ANCHOR_POLL_MS, ANCHOR_BACKOFF_BASE_MS, ANCHOR_BACKOFF_MAX_MS, ANCHOR_MAX_ATTEMPTS.
 */

const DEFAULTS = { pollMs: 5_000, backoffBaseMs: 5_000, backoffMaxMs: 60 * 60 * 1_000, maxAttempts: 60 } as const;

const readNumber = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const readWorkerConfig = () => ({
  pollMs: readNumber('ANCHOR_POLL_MS', DEFAULTS.pollMs),
  backoffBaseMs: readNumber('ANCHOR_BACKOFF_BASE_MS', DEFAULTS.backoffBaseMs),
  backoffMaxMs: readNumber('ANCHOR_BACKOFF_MAX_MS', DEFAULTS.backoffMaxMs),
  maxAttempts: readNumber('ANCHOR_MAX_ATTEMPTS', DEFAULTS.maxAttempts),
});

export const backoffMs = (attempts: number, config = readWorkerConfig()) =>
  Math.min(config.backoffBaseMs * 2 ** Math.max(0, attempts - 1), config.backoffMaxMs);

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1000);

/** Copies the on-chain proof onto the consent / emergency record (write-once, keyed by event). */
const writeBackToRecord = async (anchor: IChainAnchor, result: AnchorResult) => {
  const reference = { digest: anchor.digest, txHash: result.transactionHash, blockNumber: result.blockNumber, anchoredAt: result.anchoredAt };
  const field = `anchors.${anchor.event.toLowerCase()}`;

  if (anchor.recordType === 'consent') {
    await ConsentGrant.updateOne({ _id: anchor.recordId }, { $set: { [field]: reference } });
  } else {
    await EmergencyAccess.updateOne({ _id: anchor.recordId }, { $set: { [field]: reference } });
  }
};

/**
 * Sends the anchor. If the key is already on-chain (we sent it but died before recording the result),
 * accept it when the digest matches and recover the tx from the Anchored event; a different digest under
 * our key is unrecoverable and becomes FAILED immediately.
 */
const sendAnchor = async (anchor: IChainAnchor): Promise<AnchorResult> => {
  try {
    return await anchorDigest(anchor.key, anchor.digest);
  } catch (error) {
    if (!/Key already anchored/.test(errorMessage(error))) {
      throw error;
    }

    const onChain = await getAnchor(anchor.key);

    if (!onChain || onChain.digest !== anchor.digest) {
      throw new UnrecoverableAnchorError(`Key already anchored on-chain with a different digest (${onChain?.digest ?? 'none'})`);
    }

    const event = await findAnchoredEvent(anchor.key);

    if (!event) {
      throw new Error('Key is anchored but its Anchored event could not be found');
    }

    return { transactionHash: event.transactionHash, blockNumber: event.blockNumber, anchoredAt: onChain.timestamp };
  }
};

class UnrecoverableAnchorError extends Error {}

const markFailed = async (anchor: IChainAnchor, message: string) => {
  const now = new Date();
  await ChainAnchor.updateOne(
    { _id: anchor._id },
    { $set: { status: 'FAILED', lastError: message, lastAttemptAt: now, failedAt: now, nextAttemptAt: now }, $inc: { attempts: 1 } }
  );
  await createAuditLog({
    userId: anchor.actorUserId,
    action: 'CHAIN_ANCHOR_FAILED',
    targetDocument: anchor.documentId,
    ipAddress: SYSTEM_IP_ADDRESS,
    metadata: { anchorId: anchor._id.toString(), key: anchor.key, attempts: String(anchor.attempts + 1), lastError: message },
  });
  console.error(`[anchors] FAILED ${anchor.key} after ${anchor.attempts + 1} attempts: ${message}`);
};

/** Processes the oldest due row. Returns false when nothing is due. */
export const processNextAnchor = async (): Promise<boolean> => {
  const config = readWorkerConfig();
  const now = new Date();
  const anchor = await ChainAnchor.findOne({ status: 'PENDING', nextAttemptAt: { $lte: now } }).sort({ nextAttemptAt: 1, createdAt: 1 });

  if (!anchor) {
    return false;
  }

  try {
    const result = await sendAnchor(anchor);
    await ChainAnchor.updateOne(
      { _id: anchor._id },
      {
        $set: { status: 'ANCHORED', txHash: result.transactionHash, blockNumber: result.blockNumber, anchoredAt: result.anchoredAt, lastAttemptAt: now },
        $inc: { attempts: 1 },
        $unset: { lastError: 1 },
      }
    );
    await writeBackToRecord(anchor, result);
    console.log(`[anchors] ANCHORED ${anchor.key} tx ${result.transactionHash}`);
  } catch (error) {
    const message = errorMessage(error);
    const attempts = anchor.attempts + 1;

    if (error instanceof UnrecoverableAnchorError || attempts >= config.maxAttempts) {
      await markFailed(anchor, message);
    } else {
      await ChainAnchor.updateOne(
        { _id: anchor._id },
        { $set: { lastError: message, lastAttemptAt: now, nextAttemptAt: new Date(now.getTime() + backoffMs(attempts, config)) }, $inc: { attempts: 1 } }
      );
    }
  }

  return true;
};

// ---------- loop ----------

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
    while (!stopped && (await processNextAnchor())) {
      // drain everything that is due
    }
  } catch (error) {
    console.error('[anchors] worker tick failed:', error);
  } finally {
    running = false;
    schedule(readWorkerConfig().pollMs);
  }
};

export const startAnchorWorker = () => {
  stopped = false;
  schedule(0);
};

/** Called by every enqueue so a fresh row is attempted immediately rather than on the next poll. */
export const wakeAnchorWorker = () => {
  if (!stopped) schedule(0);
};

export const stopAnchorWorker = () => {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
};

/** Test helper: resolves once the loop is idle (no tick running). */
export const waitForAnchorWorkerIdle = async () => {
  while (running) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
