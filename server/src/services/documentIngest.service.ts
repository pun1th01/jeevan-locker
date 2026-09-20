import { unlink } from 'fs/promises';
import path from 'path';
import { Types } from 'mongoose';
import { getStoredDocumentPath } from '../middleware/upload.middleware';
import { MedicalDocument, type IMedicalDocument, type ITestValue, type MedicalDocumentMimeType } from '../models/MedicalDocument';
import { SHA_256 } from '../utils/documentHash.util';
import { detectDocumentMimeType } from '../utils/fileSignature.util';
import { encryptFileToVault, type EncryptFileResult } from './documentCrypto.service';
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
 *   1. magic-byte check on the plaintext temp        -> mismatch: unlink temp, DocumentIngestError (400)
 *   2. encrypt temp -> `<name>.enc` (SHA-256 of the   -> failure: unlink temp, rethrow
 *      PLAINTEXT is computed in the same pass; that is
 *      the hash that goes on-chain), then unlink temp
 *   3. MedicalDocument row (_id allocated up front:    -> failure: unlink .enc, rethrow
 *      it is the AEAD associated data of the file)
 *   4. on-chain registration + save tx details         -> failure: delete row, unlink .enc, rethrow
 * Callers must have already validated everything else (title, ownership, authorisation) and must unlink
 * the temp themselves on their own validation failures — this function only owns steps 1–4.
 * The multer temp is plaintext on disk for the duration of one request only (see docs/ENCRYPTION.md).
 */
export const ingestUploadedDocument = async ({ file, title, uploadedBy, labReport }: IngestDocumentInput): Promise<IMedicalDocument> => {
  // Multer's fileFilter only sees the client-declared MIME type; the bytes on disk are the truth.
  const detectedMimeType = await detectDocumentMimeType(file.path);

  if (detectedMimeType !== file.mimetype) {
    await discardUploadedFile(file.path);
    throw new DocumentIngestError(FILE_TYPE_MISMATCH_MESSAGE);
  }

  const documentId = new Types.ObjectId();
  let encrypted: EncryptFileResult;

  try {
    encrypted = await encryptFileToVault({
      sourcePath: file.path,
      targetDirectory: path.dirname(file.path),
      baseFileName: file.filename,
      documentId: documentId.toString(),
    });
  } catch (error) {
    await discardUploadedFile(file.path);
    throw error;
  }

  await discardUploadedFile(file.path);
  const encryptedPath = path.join(path.dirname(file.path), encrypted.storedFileName);
  let document: IMedicalDocument;

  try {
    document = await MedicalDocument.create({
      _id: documentId,
      title,
      originalFileName: file.originalname,
      storedFileName: encrypted.storedFileName,
      filePath: getStoredDocumentPath(encrypted.storedFileName),
      mimeType: file.mimetype as MedicalDocumentMimeType,
      uploadedBy,
      sharedWithDoctors: [],
      documentHash: encrypted.sha256,
      hashAlgorithm: SHA_256,
      encryption: encrypted.encryption,
      plaintextSize: encrypted.plaintextSize,
      ...(labReport ?? {}),
    });
  } catch (error) {
    await discardUploadedFile(encryptedPath);
    throw error;
  }

  try {
    const blockchainDocumentId = document._id.toString();
    const registration = await registerDocumentHash(blockchainDocumentId, encrypted.sha256);
    document.blockchainDocumentId = blockchainDocumentId;
    document.blockchainTxHash = registration.transactionHash;
    document.blockchainRegisteredAt = registration.registeredAt;
    await document.save();
  } catch (error) {
    await MedicalDocument.findByIdAndDelete(document._id);
    await discardUploadedFile(encryptedPath);
    throw error;
  }

  return document;
};
