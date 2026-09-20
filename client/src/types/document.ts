import type { User } from './auth';

export type MedicalDocumentMimeType = 'application/pdf' | 'image/jpeg' | 'image/png';

export interface MedicalDocument {
  id: string;
  title: string;
  originalFileName: string;
  mimeType: MedicalDocumentMimeType;
  uploadedBy: User;
  sharedWithDoctors: User[];
  documentHash?: string;
  hashAlgorithm?: 'SHA-256';
  blockchainTxHash?: string;
  blockchainRegisteredAt?: string;
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
