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
  description?: string;
  originalFileName: string;
  mimeType: MedicalDocumentMimeType;
  /** The owning patient — also for lab reports. */
  uploadedBy: User;
  sharedWithDoctors: User[];
  documentHash?: string;
  hashAlgorithm?: 'SHA-256';
  blockchainTxHash?: string;
  blockchainRegisteredAt?: string;
  /** False only for legacy files the encryption migration has not reached yet — show a lock badge when true. */
  encryptedAtRest: boolean;
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

/**
 * A document as the server sends it to a LAB: the same shape without `sharedWithDoctors`. A lab never learns which
 * doctors a patient shared a document with, not even for a report it issued.
 */
export type LabMedicalDocument = Omit<MedicalDocument, 'sharedWithDoctors'>;

/** Anything the shared document components (DocumentList, DocumentPreviewModal) can render. */
export type AnyMedicalDocument = MedicalDocument | LabMedicalDocument;

export interface UploadDocumentInput {
  title: string;
  file: File;
}

export interface DocumentMetadataInput {
  title: string;
  description?: string;
}

export interface IntegrityVerificationResult {
  verified: boolean;
  algorithm: 'SHA-256';
  currentHash: string;
  blockchainHash: string;
  blockchainTxHash: string;
  registeredAt: string;
}
