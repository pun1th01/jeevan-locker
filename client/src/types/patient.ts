// Mirrors server/src/controllers/patients.controller.ts — keep the two in sync.
// Replaces ConsentTarget / EmergencyAccessTarget and both `GET …/targets` routes (deleted in Phase 0, task 1b).

/**
 * Relationship between the calling doctor and one document. Exactly one value per document,
 * chosen by precedence: shared > consent_approved > consent_pending > emergency_active > none.
 */
export type PatientDocumentAccess =
  | 'none' // no relationship — selectable in both modals
  | 'shared' // patient shared directly — not selectable anywhere
  | 'consent_approved' // approved consent — not selectable anywhere
  | 'consent_pending' // request awaiting patient — consent: no, emergency: yes (escalation)
  | 'emergency_active'; // live break-glass grant — consent: yes, emergency: no

export interface PatientLookupDocument {
  id: string;
  title: string;
  /** ISO 8601 */
  createdAt: string;
  access: PatientDocumentAccess;
  /** True whenever a live grant exists, independent of `access`. */
  emergencyActive: boolean;
  /** ISO 8601; present iff emergencyActive. Show alongside `access` when access !== 'emergency_active'. */
  emergencyExpiresAt?: string;
}

export interface PatientLookupResult {
  /** No email, by design: a doctor who looked up by ID must not learn it. */
  patient: { id: string; name: string };
  /** Newest first; [] when the patient has no documents. */
  documents: PatientLookupDocument[];
}

/** A document the doctor picked from a lookup result, with the patient it belongs to. */
export interface PatientDocumentSelection {
  patient: PatientLookupResult['patient'];
  document: PatientLookupDocument;
}
