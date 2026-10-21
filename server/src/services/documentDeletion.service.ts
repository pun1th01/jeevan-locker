import { Types } from 'mongoose';
import { emitAppEvent, eventBase } from '../events/appEvents';
import { ConsentGrant, type IConsentGrant } from '../models/ConsentGrant';
import { EmergencyAccess } from '../models/EmergencyAccess';
import { MedicalDocument, type IMedicalDocument } from '../models/MedicalDocument';
import type { SafeUser } from '../types/user.types';
import { createAuditLog } from '../utils/audit.util';
import { enqueueConsentAnchor, enqueueDocumentDeletedAnchor, enqueueEmergencyAnchor } from './anchorQueue.service';

/**
 * A patient's soft delete of one document, and everything it ends (docs/API_DOCUMENTS.md §5).
 *
 *   1. One guarded write marks the document deleted ({ deletedAt: null } in the filter), so of several concurrent
 *      deletes exactly one proceeds; the others find nothing to delete.
 *   2. Every live permission on the document ends through the same transitions a patient would make by hand, each
 *      audited, anchored and notified once: an APPROVED consent becomes REVOKED, a PENDING one REJECTED, and a live
 *      break-glass grant REVOKED by the patient. Every audit row carries `cause: 'DOCUMENT_DELETED'`.
 *   3. DOCUMENT_DELETED is audited, with the counts from step 2, and its DELETED anchor enqueued. The document's own
 *      DocumentRegistry entry is write-once and stays on-chain; the deletion is a second, separate anchor.
 *
 * Step 1 happens first, so from that moment no read is served to a doctor whatever step 2 has reached (the access
 * decision denies a deleted document outright), and no new consent or grant can be requested on it. A grant whose
 * window has already passed is left to the expiry sweep: it grants nothing and ends as EXPIRED, not REVOKED.
 */

export const DOCUMENT_DELETED_CAUSE = 'DOCUMENT_DELETED';

export interface DocumentDeletionResult {
  document: IMedicalDocument;
  consentsRevoked: number;
  consentsRejected: number;
  grantsRevoked: number;
}

/** Bounded retry for a consent another request is deciding at the same moment (approve vs. this cascade). */
const MAX_CONSENT_ATTEMPTS = 3;

const closeConsent = async (
  consentId: Types.ObjectId,
  patient: SafeUser,
  ipAddress: string,
  documentTitle: string,
  documentHash: string | null
): Promise<'REVOKED' | 'REJECTED' | null> => {
  for (let attempt = 0; attempt < MAX_CONSENT_ATTEMPTS; attempt += 1) {
    const current = await ConsentGrant.findById(consentId).select('status');
    if (!current || (current.status !== 'PENDING' && current.status !== 'APPROVED')) return null;

    const next = current.status === 'APPROVED' ? 'REVOKED' : 'REJECTED';
    const timestampField = next === 'REVOKED' ? 'revokedAt' : 'rejectedAt';
    const result = await ConsentGrant.updateOne(
      { _id: consentId, status: current.status },
      { $set: { status: next, [timestampField]: new Date() } }
    );

    // Someone else moved it in between (e.g. the patient's own approve in another tab): read it again.
    if (result.modifiedCount !== 1) continue;

    const closed = (await ConsentGrant.findById(consentId))!;
    await auditClosedConsent(closed, next, patient, ipAddress);
    await enqueueConsentAnchor(closed, next, documentHash);
    emitAppEvent(next === 'REVOKED' ? 'consent.revoked' : 'consent.rejected', {
      ...eventBase({
        recipientUserId: closed.doctorId.toString(),
        actorUserId: patient.id,
        actorName: patient.name,
        documentId: closed.documentId.toString(),
        message:
          next === 'REVOKED'
            ? `${patient.name} deleted "${documentTitle}"; your access to it has ended`
            : `${patient.name} deleted "${documentTitle}"; your access request was closed`,
      }),
      documentId: closed.documentId.toString(),
      consentId: closed._id.toString(),
      documentTitle,
    });
    return next;
  }

  return null;
};

const auditClosedConsent = (consent: IConsentGrant, status: 'REVOKED' | 'REJECTED', patient: SafeUser, ipAddress: string) =>
  createAuditLog({
    userId: patient.id,
    action: status === 'REVOKED' ? 'CONSENT_REVOKED' : 'CONSENT_REJECTED',
    targetDocument: consent.documentId,
    ipAddress,
    metadata: {
      consentId: consent._id.toString(),
      doctorId: consent.doctorId.toString(),
      patientId: consent.patientId.toString(),
      purpose: consent.purpose,
      status,
      cause: DOCUMENT_DELETED_CAUSE,
    },
  });

const revokeLiveGrants = async (
  document: IMedicalDocument,
  patient: SafeUser,
  ipAddress: string
): Promise<number> => {
  const now = new Date();
  const live = await EmergencyAccess.find({ documentId: document._id, status: 'ACTIVE', expiresAt: { $gt: now } }).select('_id');
  let revoked = 0;

  for (const { _id } of live) {
    const revokedAt = new Date();
    const result = await EmergencyAccess.updateOne(
      { _id, status: 'ACTIVE' },
      { $set: { status: 'REVOKED', revokedAt, revokedBy: new Types.ObjectId(patient.id) } }
    );
    if (result.modifiedCount !== 1) continue;

    const grant = (await EmergencyAccess.findById(_id))!;
    await createAuditLog({
      userId: patient.id,
      action: 'EMERGENCY_ACCESS_REVOKED',
      targetDocument: grant.documentId,
      ipAddress,
      metadata: {
        emergencyAccessId: grant._id.toString(),
        doctorId: grant.doctorId.toString(),
        patientId: grant.patientId.toString(),
        grantedAt: grant.createdAt.toISOString(),
        expiresAt: grant.expiresAt.toISOString(),
        revokedAt: revokedAt.toISOString(),
        cause: DOCUMENT_DELETED_CAUSE,
      },
    });
    await enqueueEmergencyAnchor(grant, 'REVOKED', document.documentHash ?? null);
    emitAppEvent('emergency.revoked', {
      ...eventBase({
        recipientUserId: grant.doctorId.toString(),
        actorUserId: patient.id,
        actorName: patient.name,
        documentId: grant.documentId.toString(),
        message: `${patient.name} deleted "${document.title}"; your emergency access to it has ended`,
      }),
      documentId: grant.documentId.toString(),
      emergencyAccessId: grant._id.toString(),
      documentTitle: document.title,
    });
    revoked += 1;
  }

  return revoked;
};

/** Returns null when the document was not this patient's live document (already deleted, or deleted concurrently). */
export const deleteDocumentForPatient = async (
  documentId: Types.ObjectId,
  patient: SafeUser,
  ipAddress: string
): Promise<DocumentDeletionResult | null> => {
  const result = await MedicalDocument.updateOne(
    { _id: documentId, uploadedBy: patient.id, deletedAt: null },
    { $set: { deletedAt: new Date(), deletedBy: new Types.ObjectId(patient.id) } }
  );

  if (result.modifiedCount !== 1) {
    return null;
  }

  const document = (await MedicalDocument.findById(documentId))!;

  const liveConsents = await ConsentGrant.find({ documentId, status: { $in: ['PENDING', 'APPROVED'] } }).select('_id');
  let consentsRevoked = 0;
  let consentsRejected = 0;

  for (const { _id } of liveConsents) {
    const closed = await closeConsent(_id, patient, ipAddress, document.title, document.documentHash ?? null);
    if (closed === 'REVOKED') consentsRevoked += 1;
    if (closed === 'REJECTED') consentsRejected += 1;
  }

  const grantsRevoked = await revokeLiveGrants(document, patient, ipAddress);

  await createAuditLog({
    userId: patient.id,
    action: 'DOCUMENT_DELETED',
    targetDocument: document._id,
    ipAddress,
    metadata: {
      patientId: patient.id,
      deletedAt: document.deletedAt!.toISOString(),
      consentsRevoked: String(consentsRevoked),
      consentsRejected: String(consentsRejected),
      grantsRevoked: String(grantsRevoked),
    },
  });
  await enqueueDocumentDeletedAnchor(document);

  return { document, consentsRevoked, consentsRejected, grantsRevoked };
};
