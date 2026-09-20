import type { RequestHandler } from 'express';
import { Types } from 'mongoose';
import { ConsentGrant } from '../models/ConsentGrant';
import { EmergencyAccess } from '../models/EmergencyAccess';
import { MedicalDocument } from '../models/MedicalDocument';
import { User } from '../models/User';
import type { AuthenticatedRequest } from '../types/auth.types';
import { createAuditLog, getRequestIpAddress } from '../utils/audit.util';
import { asyncHandler } from '../utils/asyncHandler.util';
import { expireEmergencyAccesses } from '../utils/emergencyAccess.util';

/**
 * Relationship between the calling doctor and one document. Exactly one value per document,
 * chosen by precedence: shared > consent_approved > consent_pending > emergency_active > none.
 * Mirrored by PatientDocumentAccess in client/src/types/patient.ts.
 */
export type PatientDocumentAccess = 'none' | 'shared' | 'consent_approved' | 'consent_pending' | 'emergency_active';

export interface PatientLookupDocument {
  id: string;
  title: string;
  createdAt: string;
  access: PatientDocumentAccess;
  emergencyActive: boolean;
  emergencyExpiresAt?: string;
}

export interface PatientLookupResult {
  patient: { id: string; name: string };
  documents: PatientLookupDocument[];
}

const MAX_LOOKUP_QUERY_LENGTH = 254;
const objectIdPattern = /^[a-f0-9]{24}$/i;

const getQueryString = (value: unknown): string => {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0].trim();
  }

  return '';
};

const resolvePatientAccess = async (
  doctorId: string,
  documents: Array<{ _id: Types.ObjectId; sharedWithDoctors: Types.ObjectId[] }>
): Promise<Map<string, Pick<PatientLookupDocument, 'access' | 'emergencyActive' | 'emergencyExpiresAt'>>> => {
  const documentIds = documents.map((document) => document._id);

  await expireEmergencyAccesses(doctorId);

  const [consents, emergencyGrants] = await Promise.all([
    ConsentGrant.find({ doctorId, documentId: { $in: documentIds }, status: { $in: ['PENDING', 'APPROVED'] } }).select(
      'documentId status'
    ),
    EmergencyAccess.find({ doctorId, documentId: { $in: documentIds }, status: 'ACTIVE', expiresAt: { $gt: new Date() } })
      .sort({ expiresAt: -1 })
      .select('documentId expiresAt'),
  ]);

  const consentStatusByDocument = new Map<string, 'PENDING' | 'APPROVED'>();
  for (const consent of consents) {
    // The partial unique index guarantees at most one PENDING|APPROVED consent per doctor+document.
    if (consent.status === 'PENDING' || consent.status === 'APPROVED') {
      consentStatusByDocument.set(consent.documentId.toString(), consent.status);
    }
  }

  const emergencyExpiryByDocument = new Map<string, Date>();
  for (const grant of emergencyGrants) {
    const key = grant.documentId.toString();
    if (!emergencyExpiryByDocument.has(key)) {
      emergencyExpiryByDocument.set(key, grant.expiresAt);
    }
  }

  const accessByDocument = new Map<string, Pick<PatientLookupDocument, 'access' | 'emergencyActive' | 'emergencyExpiresAt'>>();

  for (const document of documents) {
    const key = document._id.toString();
    const isShared = document.sharedWithDoctors.some((sharedDoctorId) => sharedDoctorId.toString() === doctorId);
    const consentStatus = consentStatusByDocument.get(key);
    const emergencyExpiresAt = emergencyExpiryByDocument.get(key);

    let access: PatientDocumentAccess = 'none';
    if (isShared) {
      access = 'shared';
    } else if (consentStatus === 'APPROVED') {
      access = 'consent_approved';
    } else if (consentStatus === 'PENDING') {
      access = 'consent_pending';
    } else if (emergencyExpiresAt) {
      access = 'emergency_active';
    }

    accessByDocument.set(key, {
      access,
      emergencyActive: Boolean(emergencyExpiresAt),
      ...(emergencyExpiresAt ? { emergencyExpiresAt: emergencyExpiresAt.toISOString() } : {}),
    });
  }

  return accessByDocument;
};

/**
 * GET /api/patients/lookup?query=<email | ObjectId>
 * Exact match only — never a prefix or regex search — so a doctor cannot enumerate patients.
 * Every evaluated lookup is audited as PATIENT_LOOKUP, whether or not a patient was found.
 * The 404 is identical for "no such user" and "user exists but is not a patient" on purpose.
 */
export const lookupPatient: RequestHandler = asyncHandler(async (req, res) => {
  const doctor = (req as AuthenticatedRequest).user;

  if (!doctor) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const rawQuery = getQueryString(req.query.query);

  if (!rawQuery || rawQuery.length > MAX_LOOKUP_QUERY_LENGTH) {
    res.status(400).json({ message: 'A patient email or ID is required' });
    return;
  }

  const matchedBy: 'id' | 'email' = objectIdPattern.test(rawQuery) ? 'id' : 'email';
  const normalizedQuery = matchedBy === 'email' ? rawQuery.toLowerCase() : rawQuery;
  const patient = await User.findOne(
    matchedBy === 'id' ? { _id: normalizedQuery, role: 'patient' } : { email: normalizedQuery, role: 'patient' }
  ).select('name');

  // `query` is stored as typed (normalized), so patient emails appear in the admin audit feed. That is
  // deliberate: the audit trail must show exactly whom a doctor searched for. Do not mask or hash it.
  await createAuditLog({
    userId: doctor.id,
    action: 'PATIENT_LOOKUP',
    ipAddress: getRequestIpAddress(req),
    metadata: {
      query: normalizedQuery,
      matchedBy,
      found: String(Boolean(patient)),
      ...(patient ? { patientId: patient._id.toString() } : {}),
    },
  });

  if (!patient) {
    res.status(404).json({ message: 'No patient found for that email or ID' });
    return;
  }

  const documents = await MedicalDocument.find({ uploadedBy: patient._id })
    .sort({ createdAt: -1 })
    .select('title createdAt sharedWithDoctors');
  const accessByDocument = await resolvePatientAccess(doctor.id, documents);

  const result: PatientLookupResult = {
    patient: { id: patient._id.toString(), name: patient.name },
    documents: documents.map((document) => {
      const access = accessByDocument.get(document._id.toString()) ?? { access: 'none', emergencyActive: false };

      return {
        id: document._id.toString(),
        title: document.title,
        createdAt: document.createdAt.toISOString(),
        ...access,
      };
    }),
  };

  res.json(result);
});
