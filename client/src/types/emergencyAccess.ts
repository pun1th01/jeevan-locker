import type { AnchorReference } from './consent';

export type EmergencyAccessStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';

export interface EmergencyAccess {
  id: string;
  doctorId: string;
  patientId: string;
  documentId: string;
  reason: string;
  status: EmergencyAccessStatus;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  revokedBy?: string;
  /** This grant re-opened access the patient had revoked within the last 24 h — show it prominently. */
  afterRevocation?: boolean;
  followsRevokedGrantId?: string;
  /** Present once the grant (and, after revocation, the revocation) is on-chain. */
  anchors?: { granted?: AnchorReference; revoked?: AnchorReference };
  /** Joined summaries, present on GET /emergency-access. */
  doctor?: { id: string; name: string };
  patient?: { id: string; name: string };
  document?: { id: string; title: string };
}

export interface GrantEmergencyAccessInput {
  patientId: string;
  documentId: string;
  reason: string;
}
