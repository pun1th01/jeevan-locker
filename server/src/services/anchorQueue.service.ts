import { Types } from 'mongoose';
import { ChainAnchor, type ConsentAnchorEvent, type EmergencyAnchorEvent, type IChainAnchor } from '../models/ChainAnchor';
import { ConsentGrant, type IConsentGrant } from '../models/ConsentGrant';
import { EmergencyAccess, type IEmergencyAccess } from '../models/EmergencyAccess';
import { MedicalDocument } from '../models/MedicalDocument';
import {
  buildConsentPreimage,
  buildEmergencyPreimage,
  consentEventActor,
  consentEventsReached,
  consentRecordKey,
  emergencyEventActor,
  emergencyEventsReached,
  emergencyRecordKey,
  sha256Hex,
} from './anchorPreimage.service';
import { wakeAnchorWorker } from './anchorWorker.service';

/**
 * Durable enqueue: one local insert, awaited by the controller right after its audit row, never a
 * chain call. Duplicate keys (a re-run, a race) are ignored, so enqueueing is idempotent.
 */

type EnqueueSource = 'controller' | 'reconciliation';

interface EnqueueInput {
  key: string;
  recordType: 'consent' | 'emergency';
  recordId: Types.ObjectId;
  event: IChainAnchor['event'];
  actorUserId: Types.ObjectId;
  documentId: Types.ObjectId;
  preimage: string;
  source: EnqueueSource;
}

const insertIfMissing = async (input: EnqueueInput): Promise<boolean> => {
  try {
    await ChainAnchor.create({ ...input, digest: sha256Hex(input.preimage), status: 'PENDING', attempts: 0, nextAttemptAt: new Date() });
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      return false; // already queued
    }

    throw error;
  }
};

const documentHashFor = async (documentId: Types.ObjectId): Promise<string | null> => {
  const document = await MedicalDocument.findById(documentId).select('documentHash');
  return document?.documentHash ?? null;
};

export const enqueueConsentAnchor = async (
  consent: IConsentGrant,
  event: ConsentAnchorEvent,
  documentHash: string | null,
  source: EnqueueSource = 'controller'
): Promise<boolean> => {
  const preimage = buildConsentPreimage(consent, event, documentHash);

  if (!preimage) {
    return false;
  }

  const inserted = await insertIfMissing({
    key: consentRecordKey(consent._id.toString(), event),
    recordType: 'consent',
    recordId: consent._id,
    event,
    actorUserId: consentEventActor(consent, event),
    documentId: consent.documentId,
    preimage,
    source,
  });

  if (inserted) wakeAnchorWorker();
  return inserted;
};

export const enqueueEmergencyAnchor = async (
  grant: IEmergencyAccess,
  event: EmergencyAnchorEvent,
  documentHash: string | null,
  source: EnqueueSource = 'controller'
): Promise<boolean> => {
  const preimage = buildEmergencyPreimage(grant, event, documentHash);

  if (!preimage) {
    return false;
  }

  const inserted = await insertIfMissing({
    key: emergencyRecordKey(grant._id.toString(), event),
    recordType: 'emergency',
    recordId: grant._id,
    event,
    actorUserId: emergencyEventActor(grant, event),
    documentId: grant.documentId,
    preimage,
    source,
  });

  if (inserted) wakeAnchorWorker();
  return inserted;
};

export interface ReconciliationReport {
  consentsScanned: number;
  grantsScanned: number;
  enqueued: number;
  windowDays: number;
}

/**
 * Boot reconciliation: re-derives every anchor a record SHOULD have from the record itself (REQUESTED
 * always; APPROVED/REJECTED/REVOKED when the matching timestamp is set; GRANTED for every emergency
 * grant) and enqueues whatever has no row. This is what makes the queue self-healing: a crash between
 * the audit write and the enqueue leaves a record with no anchor row, and this sweep finds it.
 *
 * Cost: three lean, projected scans — consents, grants and existing anchor keys — plus an in-memory set
 * difference. ANCHOR_RECONCILE_WINDOW_DAYS (default 0 = unbounded) restricts the record scans to rows
 * created recently, for when the collections outgrow a full scan at boot; see docs/ANCHORING.md.
 */
export const reconcileMissingAnchors = async (log: (message: string) => void = console.log): Promise<ReconciliationReport> => {
  const windowDays = Number(process.env.ANCHOR_RECONCILE_WINDOW_DAYS ?? 0) || 0;
  const since = windowDays > 0 ? new Date(Date.now() - windowDays * 86_400_000) : null;
  const consentFilter = since ? { requestedAt: { $gte: since } } : {};
  const grantFilter = since ? { createdAt: { $gte: since } } : {};

  const [consents, grants, existingKeys] = await Promise.all([
    ConsentGrant.find(consentFilter).select('patientId doctorId documentId purpose requestedAt approvedAt rejectedAt revokedAt'),
    EmergencyAccess.find(grantFilter).select('doctorId patientId documentId reason createdAt expiresAt revokedAt revokedBy'),
    ChainAnchor.find({}).select('key').lean(),
  ]);
  const known = new Set(existingKeys.map((row) => row.key));
  let enqueued = 0;

  for (const consent of consents) {
    const missing = consentEventsReached(consent).filter((event) => !known.has(consentRecordKey(consent._id.toString(), event)));

    if (missing.length === 0) continue;

    const documentHash = await documentHashFor(consent.documentId);

    for (const event of missing) {
      if (await enqueueConsentAnchor(consent, event, documentHash, 'reconciliation')) {
        enqueued += 1;
        log(`[anchors] reconciliation enqueued ${consentRecordKey(consent._id.toString(), event)}`);
      }
    }
  }

  for (const grant of grants) {
    const missing = emergencyEventsReached(grant).filter((event) => !known.has(emergencyRecordKey(grant._id.toString(), event)));

    if (missing.length === 0) continue;

    const documentHash = await documentHashFor(grant.documentId);

    for (const event of missing) {
      if (await enqueueEmergencyAnchor(grant, event, documentHash, 'reconciliation')) {
        enqueued += 1;
        log(`[anchors] reconciliation enqueued ${emergencyRecordKey(grant._id.toString(), event)}`);
      }
    }
  }

  log(`[anchors] reconciliation: ${consents.length} consents, ${grants.length} grants scanned${since ? ` (last ${windowDays} days)` : ''}, ${enqueued} anchor(s) enqueued`);
  return { consentsScanned: consents.length, grantsScanned: grants.length, enqueued, windowDays };
};

/** Admin action: put a FAILED (or stuck PENDING) row back at the front of the queue. */
export const retryAnchor = async (anchorId: string): Promise<IChainAnchor | null> => {
  if (!Types.ObjectId.isValid(anchorId)) return null;

  const anchor = await ChainAnchor.findOneAndUpdate(
    { _id: anchorId, status: { $in: ['PENDING', 'FAILED'] } },
    { $set: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), source: 'retry' }, $unset: { failedAt: 1 } },
    { returnDocument: 'after' }
  );

  if (anchor) wakeAnchorWorker();
  return anchor;
};
