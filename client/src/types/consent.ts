export type ConsentStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'REVOKED';

export interface ConsentGrant {
  id: string;
  patient: { id: string; name: string };
  doctor: { id: string; name: string };
  document: { id: string; title: string };
  purpose: string;
  status: ConsentStatus;
  requestedAt: string;
  approvedAt?: string;
  rejectedAt?: string;
  revokedAt?: string;
}

export interface RequestConsentInput {
  patientId: string;
  documentId: string;
  purpose: string;
}
