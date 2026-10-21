import type { RequestHandler } from 'express';
import { Types } from 'mongoose';
import { ConsentGrant, type IConsentGrant } from '../models/ConsentGrant';
import { MedicalDocument } from '../models/MedicalDocument';
import { User } from '../models/User';
import type { AuthenticatedRequest } from '../types/auth.types';
import { createAuditLog, getRequestIpAddress } from '../utils/audit.util';
import { asyncHandler } from '../utils/asyncHandler.util';
import { emitAppEvent, eventBase } from '../events/appEvents';
import { enqueueConsentAnchor } from '../services/anchorQueue.service';
import { serializeAnchorReferences } from '../utils/anchors.util';

interface PopulatedUser {
  _id: Types.ObjectId;
  name: string;
  role: string;
}

interface PopulatedDocument {
  _id: Types.ObjectId;
  title: string;
}

type ConsentWithReferences = Omit<IConsentGrant, 'patientId' | 'doctorId' | 'documentId'> & {
  patientId: Types.ObjectId | PopulatedUser;
  doctorId: Types.ObjectId | PopulatedUser;
  documentId: Types.ObjectId | PopulatedDocument;
};

const getUser = (req: AuthenticatedRequest) => req.user ?? null;
const getRequestString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const getIdParam = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] ?? '' : value ?? '');
const isUser = (value: unknown): value is PopulatedUser => typeof value === 'object' && value !== null && '_id' in value && 'name' in value;
const isDocument = (value: unknown): value is PopulatedDocument =>
  typeof value === 'object' && value !== null && '_id' in value && 'title' in value;

const serializeConsent = (consent: IConsentGrant) => {
  const populated = consent as ConsentWithReferences;
  const patient = isUser(populated.patientId) ? populated.patientId : null;
  const doctor = isUser(populated.doctorId) ? populated.doctorId : null;
  const document = isDocument(populated.documentId) ? populated.documentId : null;

  return {
    id: consent._id.toString(),
    patient: { id: patient ? patient._id.toString() : consent.patientId.toString(), name: patient?.name ?? 'Unknown patient' },
    doctor: { id: doctor ? doctor._id.toString() : consent.doctorId.toString(), name: doctor?.name ?? 'Unknown doctor' },
    document: { id: document ? document._id.toString() : consent.documentId.toString(), title: document?.title ?? 'Unavailable document' },
    purpose: consent.purpose,
    status: consent.status,
    requestedAt: consent.requestedAt.toISOString(),
    approvedAt: consent.approvedAt?.toISOString(),
    rejectedAt: consent.rejectedAt?.toISOString(),
    revokedAt: consent.revokedAt?.toISOString(),
    anchors: serializeAnchorReferences(consent.anchors),
  };
};

const CONSENT_REFERENCES = [
  { path: 'patientId', select: 'name role' },
  { path: 'doctorId', select: 'name role' },
  { path: 'documentId', select: 'title' },
];

/**
 * The consent as a response body, with real names and title. It is a SEPARATE read: the in-memory consent that the
 * handlers pass to the audit row and the anchor preimage must keep bare ObjectIds — populated in place, those fields
 * would stringify as whole user documents and change the anchored digest.
 */
const respondWithConsent = async (consentId: Types.ObjectId): Promise<ReturnType<typeof serializeConsent>> => {
  const populated = await ConsentGrant.findById(consentId).populate(CONSENT_REFERENCES);
  if (!populated) throw new Error(`Consent ${consentId.toString()} disappeared before its response was built`);
  return serializeConsent(populated);
};

const auditConsent = async (
  req: AuthenticatedRequest,
  action: 'CONSENT_REQUESTED' | 'CONSENT_APPROVED' | 'CONSENT_REJECTED' | 'CONSENT_REVOKED',
  consent: IConsentGrant,
  userId: string
) => {
  await createAuditLog({
    userId,
    action,
    targetDocument: consent.documentId,
    ipAddress: getRequestIpAddress(req),
    metadata: {
      consentId: consent._id.toString(),
      doctorId: consent.doctorId.toString(),
      patientId: consent.patientId.toString(),
      purpose: consent.purpose,
      status: consent.status,
    },
  });
};

export const requestConsent: RequestHandler = asyncHandler(async (req, res) => {
  const doctor = getUser(req as AuthenticatedRequest);
  if (!doctor) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const patientId = getRequestString(req.body.patientId);
  const documentId = getRequestString(req.body.documentId);
  const purpose = getRequestString(req.body.purpose);

  if (!purpose || purpose.length > 500) {
    res.status(400).json({ message: 'A consent purpose of 1 to 500 characters is required' });
    return;
  }
  if (!Types.ObjectId.isValid(patientId) || !Types.ObjectId.isValid(documentId)) {
    res.status(400).json({ message: 'A valid patient ID and document ID are required' });
    return;
  }
  if (doctor.id === patientId) {
    res.status(400).json({ message: 'Doctors cannot request access to their own document' });
    return;
  }

  const [patient, document] = await Promise.all([
    User.findOne({ _id: patientId, role: 'patient' }),
    MedicalDocument.findById(documentId),
  ]);
  if (!patient) {
    res.status(404).json({ message: 'Patient not found' });
    return;
  }
  if (!document) {
    res.status(404).json({ message: 'Document not found' });
    return;
  }
  if (!document.uploadedBy.equals(patient._id)) {
    res.status(400).json({ message: 'The selected document does not belong to the selected patient' });
    return;
  }

  const existing = await ConsentGrant.findOne({
    doctorId: doctor.id,
    documentId: document._id,
    status: { $in: ['PENDING', 'APPROVED'] },
  });
  if (existing) {
    res.status(409).json({ message: existing.status === 'APPROVED' ? 'Access is already approved' : 'An access request is already pending' });
    return;
  }

  let consent: IConsentGrant;
  try {
    consent = await ConsentGrant.create({
      patientId: patient._id,
      doctorId: doctor.id,
      documentId: document._id,
      purpose,
      status: 'PENDING',
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      res.status(409).json({ message: 'An access request is already pending or approved' });
      return;
    }
    throw error;
  }
  await auditConsent(req as AuthenticatedRequest, 'CONSENT_REQUESTED', consent, doctor.id);
  // Durable enqueue only (one local insert); the chain write happens in the anchor worker.
  await enqueueConsentAnchor(consent, 'REQUESTED', document.documentHash ?? null);
  emitAppEvent('consent.requested', {
    ...eventBase({
      recipientUserId: patient._id.toString(),
      actorUserId: doctor.id,
      actorName: doctor.name,
      documentId: document._id.toString(),
      message: `${doctor.name} requested access to "${document.title}"`,
    }),
    documentId: document._id.toString(),
    consentId: consent._id.toString(),
    documentTitle: document.title,
    purpose: consent.purpose,
  });
  res.status(201).json({ message: 'Access request sent to patient', consent: await respondWithConsent(consent._id) });
});

const sendConsents = async (res: Parameters<RequestHandler>[1], filter: Record<string, unknown>) => {
  const consents = await ConsentGrant.find(filter).sort({ requestedAt: -1 }).populate(CONSENT_REFERENCES);
  res.json({ consents: consents.map(serializeConsent) });
};

export const getPendingConsents: RequestHandler = asyncHandler(async (req, res) => {
  const patient = getUser(req as AuthenticatedRequest);
  if (!patient) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }
  await sendConsents(res, { patientId: patient.id, status: 'PENDING' });
});

export const getReceivedConsents: RequestHandler = asyncHandler(async (req, res) => {
  const patient = getUser(req as AuthenticatedRequest);
  if (!patient) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }
  await sendConsents(res, { patientId: patient.id, status: { $in: ['PENDING', 'APPROVED'] } });
});

export const getMyConsents: RequestHandler = asyncHandler(async (req, res) => {
  const doctor = getUser(req as AuthenticatedRequest);
  if (!doctor) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }
  await sendConsents(res, { doctorId: doctor.id });
});

const updateConsent = (
  status: 'APPROVED' | 'REJECTED' | 'REVOKED',
  requiredStatus: 'PENDING' | 'APPROVED',
  action: 'CONSENT_APPROVED' | 'CONSENT_REJECTED' | 'CONSENT_REVOKED'
): RequestHandler =>
  asyncHandler(async (req, res) => {
    const patient = getUser(req as AuthenticatedRequest);
    if (!patient) {
      res.status(401).json({ message: 'Authentication is required' });
      return;
    }
    const consentId = getIdParam(req.params.id);
    if (!Types.ObjectId.isValid(consentId)) {
      res.status(400).json({ message: 'A valid consent ID is required' });
      return;
    }
    const consent = await ConsentGrant.findById(consentId);
    if (!consent) {
      res.status(404).json({ message: 'Consent request not found' });
      return;
    }
    if (!consent.patientId.equals(patient.id)) {
      res.status(403).json({ message: 'You do not have permission to change this consent request' });
      return;
    }
    // The transition is one guarded write: of two concurrent decisions (approve + reject, or the same one twice)
    // exactly one matches `status: requiredStatus`, and only that one goes on to audit, anchor and notify.
    const result = await ConsentGrant.updateOne(
      { _id: consent._id, patientId: consent.patientId, status: requiredStatus },
      { $set: { status, [CONSENT_TIMESTAMP_BY_STATUS[status]]: new Date() } }
    );
    if (result.modifiedCount !== 1) {
      res.status(409).json({ message: `Only ${requiredStatus.toLowerCase()} consent requests can be ${status.toLowerCase()}` });
      return;
    }

    // Re-read, not populated: the audit row and the anchor preimage need the stored record with bare ObjectIds.
    const decided = (await ConsentGrant.findById(consent._id))!;
    await auditConsent(req as AuthenticatedRequest, action, decided, patient.id);

    const document = await MedicalDocument.findById(decided.documentId).select('title documentHash');
    await enqueueConsentAnchor(decided, status, document?.documentHash ?? null);
    const documentTitle = document?.title ?? 'a document';
    emitAppEvent(CONSENT_EVENT_BY_STATUS[status], {
      ...eventBase({
        recipientUserId: decided.doctorId.toString(),
        actorUserId: patient.id,
        actorName: patient.name,
        documentId: decided.documentId.toString(),
        message: CONSENT_MESSAGE_BY_STATUS[status](patient.name, documentTitle),
      }),
      documentId: decided.documentId.toString(),
      consentId: decided._id.toString(),
      documentTitle,
    });

    res.json({ message: `Consent ${status.toLowerCase()}`, consent: await respondWithConsent(decided._id) });
  });

const CONSENT_TIMESTAMP_BY_STATUS = {
  APPROVED: 'approvedAt',
  REJECTED: 'rejectedAt',
  REVOKED: 'revokedAt',
} as const;

const CONSENT_EVENT_BY_STATUS = {
  APPROVED: 'consent.approved',
  REJECTED: 'consent.rejected',
  REVOKED: 'consent.revoked',
} as const;

const CONSENT_MESSAGE_BY_STATUS: Record<'APPROVED' | 'REJECTED' | 'REVOKED', (patientName: string, title: string) => string> = {
  APPROVED: (patientName, title) => `${patientName} approved your access to "${title}"`,
  REJECTED: (patientName, title) => `${patientName} declined your access request for "${title}"`,
  REVOKED: (patientName, title) => `${patientName} revoked your access to "${title}"`,
};

export const approveConsent = updateConsent('APPROVED', 'PENDING', 'CONSENT_APPROVED');
export const rejectConsent = updateConsent('REJECTED', 'PENDING', 'CONSENT_REJECTED');
export const revokeConsent = updateConsent('REVOKED', 'APPROVED', 'CONSENT_REVOKED');
