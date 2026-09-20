import type { Request } from 'express';
import { User, type IUser } from '../models/User';
import { createAuditLog, getRequestIpAddress } from './audit.util';

export const MAX_LOOKUP_QUERY_LENGTH = 254;
export const LOOKUP_QUERY_REQUIRED_MESSAGE = 'A patient email or ID is required';
export const PATIENT_NOT_FOUND_MESSAGE = 'No patient found for that email or ID';

const objectIdPattern = /^[a-f0-9]{24}$/i;

export type PatientLookupOutcome =
  | { kind: 'invalid' }
  | { kind: 'not_found'; normalizedQuery: string; matchedBy: 'id' | 'email' }
  | { kind: 'found'; normalizedQuery: string; matchedBy: 'id' | 'email'; patient: Pick<IUser, '_id' | 'name'> };

/** Reads `query` from a query-string or JSON body value: first string wins, trimmed. */
export const readLookupQuery = (value: unknown): string => {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0].trim();
  }

  return '';
};

/**
 * The one patient-lookup rule shared by GET /patients/lookup (doctors) and POST /lab-links (labs):
 * exact match on a 24-hex ObjectId or on a lowercased email, always restricted to role 'patient',
 * never a prefix or regex search. Callers must respond to 'not_found' identically for unknown emails
 * and for emails that belong to a non-patient, so the endpoint confirms nothing about other roles.
 */
export const findPatientByQuery = async (rawQuery: string): Promise<PatientLookupOutcome> => {
  if (!rawQuery || rawQuery.length > MAX_LOOKUP_QUERY_LENGTH) {
    return { kind: 'invalid' };
  }

  const matchedBy: 'id' | 'email' = objectIdPattern.test(rawQuery) ? 'id' : 'email';
  const normalizedQuery = matchedBy === 'email' ? rawQuery.toLowerCase() : rawQuery;
  const patient = await User.findOne(
    matchedBy === 'id' ? { _id: normalizedQuery, role: 'patient' } : { email: normalizedQuery, role: 'patient' }
  ).select('name');

  return patient ? { kind: 'found', normalizedQuery, matchedBy, patient } : { kind: 'not_found', normalizedQuery, matchedBy };
};

/**
 * Writes the PATIENT_LOOKUP row for an evaluated lookup (found or not). Never call it for 'invalid'.
 * `query` is stored as typed (normalized), so patient emails appear in the admin audit feed. That is
 * deliberate: the audit trail must show exactly whom a doctor or lab searched for. Do not mask or hash it.
 */
export const auditPatientLookup = async (
  req: Request,
  actorId: string,
  outcome: Exclude<PatientLookupOutcome, { kind: 'invalid' }>
) => {
  await createAuditLog({
    userId: actorId,
    action: 'PATIENT_LOOKUP',
    ipAddress: getRequestIpAddress(req),
    metadata: {
      query: outcome.normalizedQuery,
      matchedBy: outcome.matchedBy,
      found: String(outcome.kind === 'found'),
      ...(outcome.kind === 'found' ? { patientId: outcome.patient._id.toString() } : {}),
    },
  });
};
