import type { User } from './auth';

export type MedicalDocumentMimeType = 'application/pdf' | 'image/jpeg' | 'image/png';

export type TestValueFlag = 'normal' | 'high' | 'low' | 'critical';

/**
 * One measured value on a verified lab report. `flag` is computed server-side:
 * outside [criticalLow, criticalHigh] -> critical; outside [refLow, refHigh] -> low/high; else normal.
 * Bounds are omitted when the lab did not supply them.
 */
export interface TestValue {
  name: string;
  value: number;
  unit: string;
  refLow?: number;
  refHigh?: number;
  criticalLow?: number;
  criticalHigh?: number;
  flag: TestValueFlag;
}

// Mirrors MedicalDocumentResponse in server/src/controllers/document.controller.ts — keep in sync.
export interface MedicalDocument {
  id: string;
  title: string;
  originalFileName: string;
  mimeType: MedicalDocumentMimeType;
  /** The owning patient — also for lab reports. */
  uploadedBy: User;
  sharedWithDoctors: User[];
  documentHash?: string;
  hashAlgorithm?: 'SHA-256';
  blockchainTxHash?: string;
  blockchainRegisteredAt?: string;
  // --- Verified lab report fields: present only when uploadedByLab is set ---
  uploadedByLab?: User;
  labName?: string;
  testName?: string;
  nablCertNumber?: string;
  authorizingDoctorName?: string;
  hospitalName?: string;
  /** ISO 8601 */
  reportDate?: string;
  testValues?: TestValue[];
  createdAt: string;
  updatedAt: string;
}

export interface UploadDocumentInput {
  title: string;
  file: File;
}

export interface IntegrityVerificationResult {
  verified: boolean;
  algorithm: 'SHA-256';
  currentHash: string;
  blockchainHash: string;
  blockchainTxHash: string;
  registeredAt: string;
}
