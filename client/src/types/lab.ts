import type { MedicalDocument } from './document';

export type LabLinkStatus = 'PENDING' | 'ACTIVE' | 'REJECTED' | 'REVOKED';

export interface LabLink {
  id: string;
  patient: {
    id: string;
    name: string;
  };
  lab: {
    id: string;
    name: string;
    organisation?: string;
  };
  status: LabLinkStatus;
  requestedAt: string;
  approvedAt?: string;
  rejectedAt?: string;
  revokedAt?: string;
}

export interface RequestLabLinkInput {
  query: string;
}

export interface LabReportTestValueInput {
  name: string;
  value: number;
  unit: string;
  refLow?: number;
  refHigh?: number;
  criticalLow?: number;
  criticalHigh?: number;
}

export interface UploadLabReportInput {
  patientId: string;
  file: File;
  title: string;
  labName?: string;
  testName?: string;
  nablCertNumber?: string;
  authorizingDoctorName?: string;
  hospitalName?: string;
  reportDate?: string;
  testValues: LabReportTestValueInput[];
}

export interface LabLinkResponse {
  message: string;
  link: LabLink;
}

export interface LabLinksResponse {
  links: LabLink[];
}

export interface LabReportResponse {
  document: MedicalDocument;
}
