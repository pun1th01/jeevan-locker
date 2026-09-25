import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import path from 'path';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Types } from 'mongoose';
import {
  MedicalDocument,
  type IMedicalDocument,
  type ITestValue,
  type MedicalDocumentMimeType,
} from '../models/MedicalDocument';
import { EmergencyAccess } from '../models/EmergencyAccess';
import { ConsentGrant } from '../models/ConsentGrant';
import { User } from '../models/User';
import type { AuthenticatedRequest } from '../types/auth.types';
import type { SafeUser, UserRole } from '../types/user.types';
import { createAuditLog, getRequestIpAddress } from '../utils/audit.util';
import { toSafeUser } from '../utils/auth.util';
import { asyncHandler } from '../utils/asyncHandler.util';
import { expireEmergencyAccesses, findActiveEmergencyAccess } from '../utils/emergencyAccess.util';
import { findApprovedConsent } from '../utils/consent.util';
import { UPLOAD_DIRECTORY } from '../middleware/upload.middleware';
import { SHA_256 } from '../utils/documentHash.util';
import { getRegisteredDocumentHash } from '../services/documentRegistry.service';
import { DocumentIngestError, discardUploadedFile, ingestUploadedDocument } from '../services/documentIngest.service';
import { hashPlaintextFile, openDecryptedStream, verifyEncryptedFile, VaultFileError } from '../services/documentCrypto.service';
import { emitAppEvent, eventBase } from '../events/appEvents';

/** Projection for every populated user reference in document responses. Must cover everything SafeUser needs. */
export const USER_REFERENCE_FIELDS = 'name email role verified organisation createdAt';

interface PopulatedUserReference {
  _id: Types.ObjectId;
  name: string;
  email: string;
  role: UserRole;
  verified: boolean;
  organisation?: string;
  createdAt: Date;
}

type DocumentWithUsers = Omit<IMedicalDocument, 'uploadedBy' | 'sharedWithDoctors' | 'uploadedByLab'> & {
  uploadedBy: Types.ObjectId | PopulatedUserReference;
  sharedWithDoctors: Array<Types.ObjectId | PopulatedUserReference>;
  uploadedByLab?: Types.ObjectId | PopulatedUserReference;
};

/**
 * Wire shape for a document. Storage details (storedFileName, filePath) are server-internal and never serialized.
 * Lab-report fields are flat and optional, mirroring the model; `uploadedByLab` being present is what marks a
 * verified lab report. Mirrored by MedicalDocument in client/src/types/document.ts.
 */
export interface MedicalDocumentResponse {
  id: string;
  title: string;
  originalFileName: string;
  mimeType: MedicalDocumentMimeType;
  uploadedBy: SafeUser;
  /** Which doctors the patient shared the document with. Never sent to a lab — see receivesSharing. */
  sharedWithDoctors?: SafeUser[];
  documentHash?: string;
  hashAlgorithm?: 'SHA-256';
  blockchainTxHash?: string;
  blockchainRegisteredAt?: string;
  /** False only for legacy rows the encryption migration has not reached yet. */
  encryptedAtRest: boolean;
  uploadedByLab?: SafeUser;
  labName?: string;
  testName?: string;
  nablCertNumber?: string;
  authorizingDoctorName?: string;
  hospitalName?: string;
  reportDate?: string;
  testValues?: ITestValue[];
  createdAt: string;
  updatedAt: string;
}

const isPopulatedUserReference = (value: unknown): value is PopulatedUserReference =>
  typeof value === 'object' &&
  value !== null &&
  '_id' in value &&
  'name' in value &&
  'email' in value &&
  'role' in value &&
  'createdAt' in value;

const serializeUserReference = (user: Types.ObjectId | PopulatedUserReference): SafeUser => {
  if (isPopulatedUserReference(user)) {
    return {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      role: user.role,
      verified: Boolean(user.verified),
      ...(user.organisation ? { organisation: user.organisation } : {}),
      createdAt: user.createdAt.toISOString(),
    };
  }

  return {
    id: user.toString(),
    name: 'Unknown user',
    email: '',
    role: 'patient',
    verified: false,
    createdAt: '',
  };
};

/**
 * Whether a reader receives `sharedWithDoctors` — the doctors a patient chose to share a document with, with their
 * names and emails. A lab issues reports but takes no part in the patient's care decisions, so it never learns who
 * else can read a document, not even one it issued. Exhaustive over the roles: a new role must decide explicitly.
 */
const receivesSharing = (viewer: UserRole): boolean => {
  switch (viewer) {
    case 'patient':
    case 'doctor':
    case 'admin':
      return true;
    case 'lab':
      return false;
    default: {
      const unhandled: never = viewer;
      return Boolean(unhandled);
    }
  }
};

/** The document as `viewer` may see it. Every document response goes through here with the caller's role. */
export const serializeMedicalDocument = (document: IMedicalDocument, viewer: UserRole): MedicalDocumentResponse => {
  const documentWithUsers = document as DocumentWithUsers;

  return {
    id: document._id.toString(),
    title: document.title,
    originalFileName: document.originalFileName,
    mimeType: document.mimeType,
    uploadedBy: serializeUserReference(documentWithUsers.uploadedBy),
    ...(receivesSharing(viewer) ? { sharedWithDoctors: documentWithUsers.sharedWithDoctors.map(serializeUserReference) } : {}),
    documentHash: document.documentHash,
    hashAlgorithm: document.hashAlgorithm,
    blockchainTxHash: document.blockchainTxHash,
    blockchainRegisteredAt: document.blockchainRegisteredAt?.toISOString(),
    encryptedAtRest: Boolean(document.encryption),
    ...(isLabReport(documentWithUsers) ? serializeLabReportFields(documentWithUsers) : {}),
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  };
};

type LabReportDocument = DocumentWithUsers & { uploadedByLab: Types.ObjectId | PopulatedUserReference };

const isLabReport = (document: DocumentWithUsers): document is LabReportDocument => document.uploadedByLab !== undefined && document.uploadedByLab !== null;

/** Report fields are emitted only when a lab issued the document; bounds are omitted when unset. */
const serializeLabReportFields = (
  document: LabReportDocument
): Pick<
  MedicalDocumentResponse,
  'uploadedByLab' | 'labName' | 'testName' | 'nablCertNumber' | 'authorizingDoctorName' | 'hospitalName' | 'reportDate' | 'testValues'
> => ({
  uploadedByLab: serializeUserReference(document.uploadedByLab),
  labName: document.labName,
  testName: document.testName,
  nablCertNumber: document.nablCertNumber,
  authorizingDoctorName: document.authorizingDoctorName,
  hospitalName: document.hospitalName,
  reportDate: document.reportDate?.toISOString(),
  testValues: document.testValues?.map((testValue) => ({
    name: testValue.name,
    value: testValue.value,
    unit: testValue.unit,
    ...(testValue.refLow !== undefined ? { refLow: testValue.refLow } : {}),
    ...(testValue.refHigh !== undefined ? { refHigh: testValue.refHigh } : {}),
    ...(testValue.criticalLow !== undefined ? { criticalLow: testValue.criticalLow } : {}),
    ...(testValue.criticalHigh !== undefined ? { criticalHigh: testValue.criticalHigh } : {}),
    flag: testValue.flag,
  })),
});

export const populateDocumentUsers = async (document: IMedicalDocument): Promise<IMedicalDocument> => {
  await document.populate([
    { path: 'uploadedBy', select: USER_REFERENCE_FIELDS },
    { path: 'sharedWithDoctors', select: USER_REFERENCE_FIELDS },
    { path: 'uploadedByLab', select: USER_REFERENCE_FIELDS },
  ]);

  return document;
};

const validateAuthenticatedUser = (req: AuthenticatedRequest) => req.user ?? null;

/**
 * Why a read was allowed, recorded as `metadata.accessMethod` on every served read (DOCUMENT_ACCESS, DOCUMENT_PREVIEW,
 * DOCUMENT_DOWNLOAD, INTEGRITY_VERIFIED) so the admin feed can say why each one happened.
 */
export type DocumentAccessMethod = 'owner' | 'admin' | 'share' | 'consent' | 'emergency' | 'lab';

type DocumentAccessDecision =
  | { allowed: false }
  | { allowed: true; method: Exclude<DocumentAccessMethod, 'consent' | 'emergency'> }
  | { allowed: true; method: 'consent'; consentGrantId: string }
  | { allowed: true; method: 'emergency'; emergencyAccessId: string; emergencyExpiresAt: string };

/**
 * Exhaustiveness guard for the role switches below. At compile time `role` narrows to `never` only when every
 * role in USER_ROLES has a branch, so adding a role without one fails tsc. At runtime it is reached only by a
 * stored role outside USER_ROLES (the schema enum rules that out through the app), and the caller denies:
 * a clean 403, never a thrown error — and never a stack trace — in the access path.
 */
const assertRoleHandled = (role: never): void => {
  void role;
};

/**
 * The single read-access rule for a document. Every branch is explicit and the tail denies, so a new role
 * can never inherit another role's permissions by falling through.
 *   admin   -> everything
 *   patient -> only documents they own (uploadedBy), lab reports included
 *   lab     -> only reports it issued (uploadedByLab); unaffected by later link revocation
 *   doctor  -> direct share, approved consent, or a live break-glass grant, in that precedence
 */
const getDocumentAccessDecision = async (
  user: SafeUser,
  document: IMedicalDocument
): Promise<DocumentAccessDecision> => {
  switch (user.role) {
    case 'admin':
      return { allowed: true, method: 'admin' };

    case 'patient':
      return document.uploadedBy.toString() === user.id ? { allowed: true, method: 'owner' } : { allowed: false };

    case 'lab':
      return document.uploadedByLab?.toString() === user.id ? { allowed: true, method: 'lab' } : { allowed: false };

    case 'doctor': {
      if (document.sharedWithDoctors.some((doctorId) => doctorId.toString() === user.id)) {
        return { allowed: true, method: 'share' };
      }

      const approvedConsent = await findApprovedConsent(user.id, document._id);

      if (approvedConsent) {
        return { allowed: true, method: 'consent', consentGrantId: approvedConsent._id.toString() };
      }

      const emergencyAccess = await findActiveEmergencyAccess(user.id, document._id);

      if (!emergencyAccess) {
        return { allowed: false };
      }

      return {
        allowed: true,
        method: 'emergency',
        emergencyAccessId: emergencyAccess._id.toString(),
        emergencyExpiresAt: emergencyAccess.expiresAt.toISOString(),
      };
    }

    default:
      assertRoleHandled(user.role);
      return { allowed: false };
  }
};

/**
 * Metadata for the audit row of a SERVED read: always the access method and the document's patient, plus the consent
 * or grant that allowed it. Exhaustive over the methods, so a new one cannot be audited without its own fields.
 */
const getDocumentAccessAuditMetadata = (
  accessDecision: Extract<DocumentAccessDecision, { allowed: true }>,
  patientId: string
): Record<string, string> => {
  switch (accessDecision.method) {
    case 'owner':
    case 'admin':
    case 'share':
    case 'lab':
      return { accessMethod: accessDecision.method, patientId };

    case 'consent':
      return { accessMethod: 'consent', patientId, consentGrantId: accessDecision.consentGrantId };

    case 'emergency':
      return {
        accessMethod: 'emergency',
        patientId,
        emergencyAccessId: accessDecision.emergencyAccessId,
        expiresAt: accessDecision.emergencyExpiresAt,
      };

    default: {
      const unhandled: never = accessDecision;
      return unhandled;
    }
  }
};


const getDocumentByValidatedId = async (documentId: string) => {
  if (!Types.ObjectId.isValid(documentId)) {
    return null;
  }

  return MedicalDocument.findById(documentId);
};

const getStringParam = (value: string | string[] | undefined): string => {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }

  return value ?? '';
};

const getSafeDownloadFileName = (fileName: string): string => path.basename(fileName).replace(/["\\]/g, '');

const resolveDocumentFilePath = (document: IMedicalDocument): string | null => {
  if (path.basename(document.storedFileName) !== document.storedFileName) {
    return null;
  }

  const resolvedFilePath = path.resolve(UPLOAD_DIRECTORY, document.storedFileName);
  const uploadRoot = `${UPLOAD_DIRECTORY}${path.sep}`;

  if (!resolvedFilePath.startsWith(uploadRoot)) {
    return null;
  }

  return resolvedFilePath;
};

const streamDocumentFile = async (
  req: Request,
  res: Response,
  next: NextFunction,
  disposition: 'inline' | 'attachment'
) => {
  const user = validateAuthenticatedUser(req as AuthenticatedRequest);

  if (!user) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const document = await getDocumentByValidatedId(getStringParam(req.params.id));

  if (!document) {
    res.status(404).json({ message: 'Document not found' });
    return;
  }

  const accessDecision = await getDocumentAccessDecision(user, document);

  if (!accessDecision.allowed) {
    res.status(403).json({ message: 'You do not have permission to access this document' });
    return;
  }

  const resolvedFilePath = resolveDocumentFilePath(document);

  if (!resolvedFilePath) {
    res.status(400).json({ message: 'Stored document path is invalid' });
    return;
  }

  let fileStats;

  try {
    fileStats = await stat(resolvedFilePath);
  } catch {
    res.status(404).json({ message: 'Document file is no longer available' });
    return;
  }

  if (!fileStats.isFile()) {
    res.status(404).json({ message: 'Document file is no longer available' });
    return;
  }

  let contentLength = fileStats.size;

  if (document.encryption) {
    // Pass 1: authenticate the whole file before a single byte is sent. GCM would otherwise let us stream
    // unverified plaintext and only discover tampering at the end, after a 200 has gone out.
    try {
      contentLength = (await verifyEncryptedFile(resolvedFilePath, document.encryption, document._id.toString())).plaintextSize;
    } catch (error) {
      if (await respondToVaultError(req, res, error, user, document, disposition === 'inline' ? 'view' : 'download')) {
        return;
      }

      throw error;
    }
  }

  const safeFileName = getSafeDownloadFileName(document.originalFileName || document.storedFileName);

  res.setHeader('Content-Type', document.mimeType);
  res.setHeader('Content-Length', contentLength.toString());
  res.setHeader('Content-Disposition', `${disposition}; filename="${safeFileName}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  await createAuditLog({
    userId: user.id,
    action: disposition === 'inline' ? 'DOCUMENT_PREVIEW' : 'DOCUMENT_DOWNLOAD',
    targetDocument: document._id,
    ipAddress: getRequestIpAddress(req),
    metadata: getDocumentAccessAuditMetadata(accessDecision, document.uploadedBy.toString()),
  });

  // Pass 2 (or the only pass for a legacy plaintext file): stream to the client.
  const fileStream = document.encryption
    ? await openDecryptedStream(resolvedFilePath, document.encryption, document._id.toString())
    : createReadStream(resolvedFilePath);

  fileStream.on('error', (error) => {
    // Headers are already out; the only honest outcome is a broken transfer, never a fake success.
    res.destroy(error);
    next(error);
  });
  fileStream.pipe(res);
};

export const VAULT_INTEGRITY_FAILURE_MESSAGE = 'Document file failed integrity check';
export const VAULT_KEY_UNAVAILABLE_MESSAGE = 'Document encryption key is unavailable';

type VaultOperation = 'view' | 'download' | 'integrity';

/**
 * Maps a decryption failure to a response AND writes the DOCUMENT_INTEGRITY_FAILED audit row. A file
 * failing its own authentication is tampering or disk corruption — it must never be the one event that
 * leaves no trace. Returns false for errors that are not vault errors (caller rethrows).
 */
const respondToVaultError = async (
  req: Request,
  res: Response,
  error: unknown,
  user: SafeUser,
  document: IMedicalDocument,
  operation: VaultOperation
): Promise<boolean> => {
  if (!(error instanceof VaultFileError)) {
    return false;
  }

  await createAuditLog({
    userId: user.id,
    action: 'DOCUMENT_INTEGRITY_FAILED',
    targetDocument: document._id,
    ipAddress: getRequestIpAddress(req),
    metadata: {
      reason: error.code,
      operation,
      documentId: document._id.toString(),
      storedFileName: document.storedFileName,
      keyId: document.encryption?.keyId ?? '',
    },
  });

  if (error.code === 'KEY_UNAVAILABLE') {
    res.status(503).json({ message: VAULT_KEY_UNAVAILABLE_MESSAGE });
    return true;
  }

  res.status(409).json({ message: VAULT_INTEGRITY_FAILURE_MESSAGE });
  return true;
};

/** SHA-256 of the document's PLAINTEXT — decrypting when needed — for comparison with the chain. */
const hashDocumentPlaintext = async (document: IMedicalDocument, resolvedFilePath: string): Promise<string> =>
  document.encryption
    ? (await verifyEncryptedFile(resolvedFilePath, document.encryption, document._id.toString())).sha256
    : hashPlaintextFile(resolvedFilePath);

export const listDoctors: RequestHandler = asyncHandler(async (_req, res) => {
  const doctors = await User.find({ role: 'doctor' }).sort({ name: 1 });
  res.json({ doctors: doctors.map(toSafeUser) });
});

export const uploadDocument: RequestHandler = asyncHandler(async (req, res) => {
  const user = validateAuthenticatedUser(req as AuthenticatedRequest);

  if (!user) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const file = req.file;

  if (!file) {
    res.status(400).json({ message: 'A PDF, JPG, or PNG document file is required' });
    return;
  }

  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';

  if (!title) {
    await discardUploadedFile(file.path);
    res.status(400).json({ message: 'Document title is required' });
    return;
  }

  let document: IMedicalDocument;

  try {
    // Magic-byte check, hash, DB row, chain registration — with unlink/rollback on every failure.
    document = await ingestUploadedDocument({ file, title, uploadedBy: user.id });
  } catch (error) {
    if (error instanceof DocumentIngestError) {
      res.status(error.statusCode).json({ message: error.message });
      return;
    }

    throw error;
  }

  await createAuditLog({
    userId: user.id,
    action: 'DOCUMENT_UPLOAD',
    targetDocument: document._id,
    ipAddress: getRequestIpAddress(req),
  });

  const populatedDocument = await populateDocumentUsers(document);
  res.status(201).json({ document: serializeMedicalDocument(populatedDocument, user.role) });
});

/**
 * Builds the list filter for GET /documents/my-documents. Mirrors getDocumentAccessDecision branch for branch:
 * anything this returns must also be allowed by that function, and vice versa. null = the role may not list.
 */
const getMyDocumentsFilter = async (user: SafeUser): Promise<Record<string, unknown> | null> => {
  switch (user.role) {
    case 'admin':
      return {};

    case 'patient':
      return { uploadedBy: user.id };

    case 'lab':
      return { uploadedByLab: user.id };

    case 'doctor': {
      await expireEmergencyAccesses(user.id);

      const [activeEmergencyAccesses, approvedConsents] = await Promise.all([
        EmergencyAccess.find({ doctorId: user.id, status: 'ACTIVE', expiresAt: { $gt: new Date() } }).select('documentId'),
        ConsentGrant.find({ doctorId: user.id, status: 'APPROVED' }).select('documentId'),
      ]);

      return {
        $or: [
          { sharedWithDoctors: user.id },
          { _id: { $in: approvedConsents.map((consent) => consent.documentId) } },
          { _id: { $in: activeEmergencyAccesses.map((emergencyAccess) => emergencyAccess.documentId) } },
        ],
      };
    }

    default:
      assertRoleHandled(user.role);
      return null;
  }
};

export const getMyDocuments: RequestHandler = asyncHandler(async (req, res) => {
  const user = validateAuthenticatedUser(req as AuthenticatedRequest);

  if (!user) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const filter = await getMyDocumentsFilter(user);

  if (!filter) {
    res.status(403).json({ message: 'You do not have permission to access this resource' });
    return;
  }

  const documents = await MedicalDocument.find(filter)
    .sort({ createdAt: -1 })
    .populate('uploadedBy', USER_REFERENCE_FIELDS)
    .populate('sharedWithDoctors', USER_REFERENCE_FIELDS)
    .populate('uploadedByLab', USER_REFERENCE_FIELDS);

  res.json({ documents: documents.map((document) => serializeMedicalDocument(document, user.role)) });
});

export const getDocument: RequestHandler = asyncHandler(async (req, res) => {
  const user = validateAuthenticatedUser(req as AuthenticatedRequest);

  if (!user) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const documentId = getStringParam(req.params.id);
  const document = await getDocumentByValidatedId(documentId);

  if (!document) {
    res.status(404).json({ message: 'Document not found' });
    return;
  }

  const accessDecision = await getDocumentAccessDecision(user, document);

  if (!accessDecision.allowed) {
    res.status(403).json({ message: 'You do not have permission to access this document' });
    return;
  }

  await createAuditLog({
    userId: user.id,
    action: 'DOCUMENT_ACCESS',
    targetDocument: document._id,
    ipAddress: getRequestIpAddress(req),
    metadata: getDocumentAccessAuditMetadata(accessDecision, document.uploadedBy.toString()),
  });

  const populatedDocument = await populateDocumentUsers(document);
  res.json({ document: serializeMedicalDocument(populatedDocument, user.role) });
});

export const viewDocument: RequestHandler = asyncHandler(async (req, res, next) => {
  await streamDocumentFile(req, res, next, 'inline');
});

export const downloadDocument: RequestHandler = asyncHandler(async (req, res, next) => {
  await streamDocumentFile(req, res, next, 'attachment');
});

export const verifyDocumentIntegrity: RequestHandler = asyncHandler(async (req, res) => {
  const user = validateAuthenticatedUser(req as AuthenticatedRequest);

  if (!user) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const document = await getDocumentByValidatedId(getStringParam(req.params.id));
  if (!document) {
    res.status(404).json({ message: 'Document not found' });
    return;
  }

  const accessDecision = await getDocumentAccessDecision(user, document);
  if (!accessDecision.allowed) {
    res.status(403).json({ message: 'You do not have permission to access this document' });
    return;
  }

  if (!document.blockchainDocumentId || !document.blockchainTxHash) {
    res.status(409).json({ message: 'This document was not registered on the blockchain' });
    return;
  }

  const resolvedFilePath = resolveDocumentFilePath(document);
  if (!resolvedFilePath) {
    res.status(400).json({ message: 'Stored document path is invalid' });
    return;
  }

  try {
    let currentHash: string;

    try {
      currentHash = await hashDocumentPlaintext(document, resolvedFilePath);
    } catch (error) {
      // An encrypted file that fails authentication cannot yield a hash at all — that is itself the finding.
      if (await respondToVaultError(req, res, error, user, document, 'integrity')) {
        return;
      }

      throw error;
    }

    const blockchainRecord = await getRegisteredDocumentHash(document.blockchainDocumentId);

    if (!blockchainRecord) {
      res.status(409).json({ message: 'No blockchain hash record exists for this document' });
      return;
    }

    const verified = currentHash.toLowerCase() === blockchainRecord.hash.toLowerCase();
    await createAuditLog({
      userId: user.id,
      action: 'INTEGRITY_VERIFIED',
      targetDocument: document._id,
      ipAddress: getRequestIpAddress(req),
      metadata: { ...getDocumentAccessAuditMetadata(accessDecision, document.uploadedBy.toString()), integrityVerified: String(verified) },
    });

    res.json({
      verified,
      algorithm: SHA_256,
      currentHash,
      blockchainHash: blockchainRecord.hash,
      blockchainTxHash: document.blockchainTxHash,
      registeredAt: blockchainRecord.timestamp.toISOString(),
    });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      res.status(404).json({ message: 'Document file is no longer available' });
      return;
    }
    throw error;
  }
});

export const shareDocumentWithDoctor: RequestHandler = asyncHandler(async (req, res) => {
  const user = validateAuthenticatedUser(req as AuthenticatedRequest);

  if (!user) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const doctorId = typeof req.body.doctorId === 'string' ? req.body.doctorId : '';

  if (!Types.ObjectId.isValid(doctorId)) {
    res.status(400).json({ message: 'A valid doctor ID is required' });
    return;
  }

  const document = await getDocumentByValidatedId(getStringParam(req.params.id));

  if (!document) {
    res.status(404).json({ message: 'Document not found' });
    return;
  }

  if (document.uploadedBy.toString() !== user.id) {
    res.status(403).json({ message: 'Only the uploading patient can share this document' });
    return;
  }

  const doctor = await User.findOne({ _id: doctorId, role: 'doctor' });

  if (!doctor) {
    res.status(400).json({ message: 'Selected user must be a registered doctor' });
    return;
  }

  const alreadyShared = document.sharedWithDoctors.some((sharedDoctorId) => sharedDoctorId.equals(doctor._id));

  if (!alreadyShared) {
    document.sharedWithDoctors.push(doctor._id);
    await document.save();

    await createAuditLog({
      userId: user.id,
      action: 'DOCUMENT_SHARE',
      targetDocument: document._id,
      ipAddress: getRequestIpAddress(req),
    });

    // Inside the !alreadyShared branch on purpose: re-sharing with the same doctor is not a notification.
    emitAppEvent('document.shared', {
      ...eventBase({
        recipientUserId: doctor._id.toString(),
        actorUserId: user.id,
        actorName: user.name,
        documentId: document._id.toString(),
        message: `${user.name} shared "${document.title}" with you`,
      }),
      documentId: document._id.toString(),
      documentTitle: document.title,
    });
  }

  const populatedDocument = await populateDocumentUsers(document);

  res.json({
    message: alreadyShared ? 'Doctor already has access to this document' : 'Document shared with doctor',
    document: serializeMedicalDocument(populatedDocument, user.role),
  });
});
