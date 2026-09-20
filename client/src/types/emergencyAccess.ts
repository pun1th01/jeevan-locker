import type { AnchorReference } from './consent';

export type EmergencyAccessStatus = 'ACTIVE' | 'EXPIRED';

export interface EmergencyAccess {
  id: string;
  doctorId: string;
  patientId: string;
  documentId: string;
  reason: string;
  status: EmergencyAccessStatus;
  createdAt: string;
  expiresAt: string;
  /** Present once the grant is on-chain. */
  anchors?: { granted?: AnchorReference };
}

export interface GrantEmergencyAccessInput {
  patientId: string;
  documentId: string;
  reason: string;
}
