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
}

export interface EmergencyAccessTarget {
  patient: {
    id: string;
    name: string;
  };
  document: {
    id: string;
    title: string;
  };
}

export interface GrantEmergencyAccessInput {
  patientId: string;
  documentId: string;
  reason: string;
}
