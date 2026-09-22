import { createHash } from 'crypto';
import type { ConsentAnchorEvent, EmergencyAnchorEvent } from '../models/ChainAnchor';
import type { IConsentGrant } from '../models/ConsentGrant';
import type { IEmergencyAccess } from '../models/EmergencyAccess';

/**
 * Canonical preimages for anchored audit events. The digest that goes on-chain is
 *   SHA-256( UTF-8( preimage ) )
 * and the preimage is a JSON object with EXACTLY these keys in EXACTLY this order, serialized by
 * JSON.stringify with no whitespace. Every field is immutable once the event has happened (ids,
 * the free text as recorded, the transition timestamp), so anyone holding the database record can
 * recompute the digest and compare it with the chain — see docs/ANCHORING.md for a worked example.
 * Never put `status` or any later-mutated field in here.
 */
export const PREIMAGE_VERSION = 1;

/** The transition timestamp that identifies each consent event. */
const CONSENT_TIMESTAMP_FIELD: Record<ConsentAnchorEvent, keyof Pick<IConsentGrant, 'requestedAt' | 'approvedAt' | 'rejectedAt' | 'revokedAt'>> = {
  REQUESTED: 'requestedAt',
  APPROVED: 'approvedAt',
  REJECTED: 'rejectedAt',
  REVOKED: 'revokedAt',
};

/** Who caused each consent event — the audit actor for a failed anchor. */
export const consentEventActor = (consent: Pick<IConsentGrant, 'patientId' | 'doctorId'>, event: ConsentAnchorEvent) =>
  event === 'REQUESTED' ? consent.doctorId : consent.patientId;

export const consentRecordKey = (consentId: string, event: ConsentAnchorEvent) => `consent:${consentId}:${event}`;
export const emergencyRecordKey = (emergencyAccessId: string, event: EmergencyAnchorEvent) => `emergency:${emergencyAccessId}:${event}`;

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Returns null when the record has not reached that event yet (e.g. APPROVED on a PENDING consent). */
export const buildConsentPreimage = (
  consent: Pick<IConsentGrant, '_id' | 'patientId' | 'doctorId' | 'documentId' | 'purpose' | 'requestedAt' | 'approvedAt' | 'rejectedAt' | 'revokedAt'>,
  event: ConsentAnchorEvent,
  documentHash: string | null
): string | null => {
  const occurredAt = consent[CONSENT_TIMESTAMP_FIELD[event]];

  if (!occurredAt) {
    return null;
  }

  return JSON.stringify({
    v: PREIMAGE_VERSION,
    type: 'consent',
    event,
    consentId: consent._id.toString(),
    patientId: consent.patientId.toString(),
    doctorId: consent.doctorId.toString(),
    documentId: consent.documentId.toString(),
    documentHash: documentHash ? documentHash.toLowerCase() : null,
    purpose: consent.purpose,
    occurredAt: occurredAt.toISOString(),
  });
};

type EmergencyGrantFields = Pick<IEmergencyAccess, '_id' | 'doctorId' | 'patientId' | 'documentId' | 'reason' | 'createdAt' | 'expiresAt'>;
type EmergencyRevocationFields = EmergencyGrantFields & Pick<IEmergencyAccess, 'revokedAt' | 'revokedBy'>;

/**
 * GRANTED preimage. DO NOT CHANGE THESE BYTES — every grant anchored before this line was written
 * verifies against exactly this layout, and docs/ANCHORING.md pins it with a worked example that the
 * verification suite asserts. `afterRevocation` is deliberately absent: it is derivable from the
 * anchored REVOKED event of the earlier grant plus this one, and adding it would break every
 * existing anchor.
 */
export const buildEmergencyGrantedPreimage = (grant: EmergencyGrantFields, documentHash: string | null): string =>
  JSON.stringify({
    v: PREIMAGE_VERSION,
    type: 'emergency',
    event: 'GRANTED',
    emergencyAccessId: grant._id.toString(),
    doctorId: grant.doctorId.toString(),
    patientId: grant.patientId.toString(),
    documentId: grant.documentId.toString(),
    documentHash: documentHash ? documentHash.toLowerCase() : null,
    reason: grant.reason,
    createdAt: grant.createdAt.toISOString(),
    expiresAt: grant.expiresAt.toISOString(),
  });

/**
 * REVOKED preimage. `grantedAt` pins which grant instance this revokes; `revokedBy`/`revokedAt` are
 * written once. `expiresAt` is absent on purpose — the grant ended early, so the original expiry is a
 * property of the GRANTED event and is already anchored there. Returns null until the record is revoked.
 */
export const buildEmergencyRevokedPreimage = (grant: EmergencyRevocationFields, documentHash: string | null): string | null => {
  if (!grant.revokedAt || !grant.revokedBy) {
    return null;
  }

  return JSON.stringify({
    v: PREIMAGE_VERSION,
    type: 'emergency',
    event: 'REVOKED',
    emergencyAccessId: grant._id.toString(),
    doctorId: grant.doctorId.toString(),
    patientId: grant.patientId.toString(),
    documentId: grant.documentId.toString(),
    documentHash: documentHash ? documentHash.toLowerCase() : null,
    grantedAt: grant.createdAt.toISOString(),
    revokedBy: grant.revokedBy.toString(),
    revokedAt: grant.revokedAt.toISOString(),
  });
};

/** Returns null when the record has not reached that event yet. */
export const buildEmergencyPreimage = (
  grant: EmergencyRevocationFields,
  event: EmergencyAnchorEvent,
  documentHash: string | null
): string | null =>
  event === 'GRANTED' ? buildEmergencyGrantedPreimage(grant, documentHash) : buildEmergencyRevokedPreimage(grant, documentHash);

/** Which emergency events a grant has actually reached — what the reconciliation sweep expects anchored. */
export const emergencyEventsReached = (grant: Pick<IEmergencyAccess, 'revokedAt'>): EmergencyAnchorEvent[] =>
  grant.revokedAt ? ['GRANTED', 'REVOKED'] : ['GRANTED'];

/** Who caused each emergency event — the audit actor for a failed anchor. */
export const emergencyEventActor = (grant: Pick<IEmergencyAccess, 'doctorId' | 'patientId'>, event: EmergencyAnchorEvent) =>
  event === 'GRANTED' ? grant.doctorId : grant.patientId;

/** Which consent events a record has actually reached — what the reconciliation sweep expects to find anchored. */
export const consentEventsReached = (consent: Pick<IConsentGrant, 'requestedAt' | 'approvedAt' | 'rejectedAt' | 'revokedAt'>): ConsentAnchorEvent[] => {
  const events: ConsentAnchorEvent[] = ['REQUESTED'];
  if (consent.approvedAt) events.push('APPROVED');
  if (consent.rejectedAt) events.push('REJECTED');
  if (consent.revokedAt) events.push('REVOKED');
  return events;
};
