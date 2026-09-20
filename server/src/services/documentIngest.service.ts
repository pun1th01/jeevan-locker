import { unlink } from 'fs/promises';
import type { Types } from 'mongoose';
import { getStoredDocumentPath } from '../middleware/upload.middleware';
import { MedicalDocument, type IMedicalDocument, type ITestValue, type MedicalDocumentMimeType } from '../models/MedicalDocument';
import { calculateFileSha256, SHA_256 } from '../utils/documentHash.util';
import { detectDocumentMimeType } from '../utils/fileSignature.util';
import { registerDocumentHash } from './documentRegistry.service';

/** Raised for request-level problems with the uploaded file; the file has already been removed from disk. */
export class DocumentIngestError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'DocumentIngestError';
  }
}

export const FILE_TYPE_MISMATCH_MESSAGE = 'File content does not match its declared type';

/** Best-effort unlink: a failed cleanup must never mask the error that caused it. */
export const discardUploadedFile = async (filePath: string) => {
  try {
    await unlink(filePath);
  } catch {
    // ignore
  }
};

/** Report-only fields a lab attaches to a document; never accepted from a patient upload. */
export interface LabReportFields {
  uploadedByLab: Types.ObjectId | string;
  labName?: string;
  testName?: string;
  nablCertNumber?: string;
  authorizingDoctorName?: string;
  hospitalName?: string;
  reportDate?: Date;
  testValues: ITestValue[];
}

export interface IngestDocumentInput {
  file: Express.Multer.File;
  title: string;
  /** Owning patient. */
  uploadedBy: Types.ObjectId | string;
  labReport?: LabReportFields;
}

/**
 * The single ingest pipeline for every document that lands in the vault, used by the patient upload and
 * the lab report upload alike:
 *   1. magic-byte check against the declared MIME type   -> mismatch: unlink, DocumentIngestError (400)
 *   2. SHA-256 of the bytes
 *   3. MedicalDocument row                                -> failure: unlink, rethrow
 *   4. on-chain registration + save tx details           -> failure: delete row, unlink, rethrow
 * Callers must have already validated everything else (title, ownership, authorisation) and must unlink
 * the file themselves on their own validation failures — this function only owns steps 1–4.
 */
export const ingestUploadedDocument = async ({ file, title, uploadedBy, labReport }: IngestDocumentInput): Promise<IMedicalDocument> => {
  // Multer's fileFilter only sees the client-declared MIME type; the bytes on disk are the truth.
  const detectedMimeType = await detectDocumentMimeType(file.path);

  if (detectedMimeType !== file.mimetype) {
    await discardUploadedFile(file.path);
    throw new DocumentIngestError(FILE_TYPE_MISMATCH_MESSAGE);
  }

  const documentHash = await calculateFileSha256(file.path);
  let document: IMedicalDocument;

  try {
    document = await MedicalDocument.create({
      title,
      originalFileName: file.originalname,
      storedFileName: file.filename,
      filePath: getStoredDocumentPath(file.filename),
      mimeType: file.mimetype as MedicalDocumentMimeType,
      uploadedBy,
      sharedWithDoctors: [],
      documentHash,
      hashAlgorithm: SHA_256,
      ...(labReport ?? {}),
    });
  } catch (error) {
    await discardUploadedFile(file.path);
    throw error;
  }

  try {
    const blockchainDocumentId = document._id.toString();
    const registration = await registerDocumentHash(blockchainDocumentId, documentHash);
    document.blockchainDocumentId = blockchainDocumentId;
    document.blockchainTxHash = registration.transactionHash;
    document.blockchainRegisteredAt = registration.registeredAt;
    await document.save();
  } catch (error) {
    await MedicalDocument.findByIdAndDelete(document._id);
    await discardUploadedFile(file.path);
    throw error;
  }

  return document;
};
