import { Types } from 'mongoose';
import { ChainAnchor, type AnchorRecordType, type ConsentAnchorEvent, type EmergencyAnchorEvent, type IChainAnchor } from '../models/ChainAnchor';
import { ConsentGrant, type IConsentGrant } from '../models/ConsentGrant';
import { EmergencyAccess, type IEmergencyAccess } from '../models/EmergencyAccess';
import { MedicalDocument, type IMedicalDocument } from '../models/MedicalDocument';
import {
  buildConsentPreimage,
  buildDocumentDeletedPreimage,
  buildEmergencyPreimage,
  consentEventActor,
  consentEventsReached,
  consentRecordKey,
  documentEventActor,
  documentRecordKey,
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
  recordType: AnchorRecordType;
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

/** The deletion of a document by its patient. Its only event is DELETED; returns false if already queued. */
export const enqueueDocumentDeletedAnchor = async (
  document: Pick<IMedicalDocument, '_id' | 'uploadedBy' | 'documentHash' | 'deletedAt' | 'deletedBy'>,
  source: EnqueueSource = 'controller'
): Promise<boolean> => {
  const preimage = buildDocumentDeletedPreimage(document);

  if (!preimage) {
    return false;
  }

  const inserted = await insertIfMissing({
    key: documentRecordKey(document._id.toString(), 'DELETED'),
    recordType: 'document',
    recordId: document._id,
    event: 'DELETED',
    actorUserId: documentEventActor(document),
    documentId: document._id,
    preimage,
    source,
  });

  if (inserted) wakeAnchorWorker();
  return inserted;
};

export interface ReconciliationReport {
  consentsScanned: number;
  grantsScanned: number;
  deletedDocumentsScanned: number;
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
  const deletedFilter = since ? { deletedAt: { $gte: since } } : { deletedAt: { $ne: null } };

  const [consents, grants, deletedDocuments, existingKeys] = await Promise.all([
    ConsentGrant.find(consentFilter).select('patientId doctorId documentId purpose requestedAt approvedAt rejectedAt revokedAt'),
    EmergencyAccess.find(grantFilter).select('doctorId patientId documentId reason createdAt expiresAt revokedAt revokedBy'),
    MedicalDocument.find(deletedFilter).select('uploadedBy documentHash deletedAt deletedBy'),
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

  for (const document of deletedDocuments) {
    const key = documentRecordKey(document._id.toString(), 'DELETED');

    if (!known.has(key) && (await enqueueDocumentDeletedAnchor(document, 'reconciliation'))) {
      enqueued += 1;
      log(`[anchors] reconciliation enqueued ${key}`);
    }
  }

  log(
    `[anchors] reconciliation: ${consents.length} consents, ${grants.length} grants, ${deletedDocuments.length} deleted documents scanned${since ? ` (last ${windowDays} days)` : ''}, ${enqueued} anchor(s) enqueued`
  );
  return { consentsScanned: consents.length, grantsScanned: grants.length, deletedDocumentsScanned: deletedDocuments.length, enqueued, windowDays };
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
