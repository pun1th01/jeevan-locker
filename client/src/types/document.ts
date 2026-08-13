import type { User } from './auth';

export type MedicalDocumentMimeType = 'application/pdf' | 'image/jpeg' | 'image/png';

export interface MedicalDocument {
  id: string;
  title: string;
  originalFileName: string;
  storedFileName: string;
  filePath: string;
  mimeType: MedicalDocumentMimeType;
  uploadedBy: User;
  sharedWithDoctors: User[];
  createdAt: string;
  updatedAt: string;
}

export interface UploadDocumentInput {
  title: string;
  file: File;
}
