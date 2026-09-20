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
import { calculateFileSha256, SHA_256 } from '../utils/documentHash.util';
import { getRegisteredDocumentHash } from '../services/documentRegistry.service';
import { DocumentIngestError, discardUploadedFile, ingestUploadedDocument } from '../services/documentIngest.service';

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
  sharedWithDoctors: SafeUser[];
  documentHash?: string;
  hashAlgorithm?: 'SHA-256';
  blockchainTxHash?: string;
  blockchainRegisteredAt?: string;
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

export const serializeMedicalDocument = (document: IMedicalDocument): MedicalDocumentResponse => {
  const documentWithUsers = document as DocumentWithUsers;

  return {
    id: document._id.toString(),
    title: document.title,
    originalFileName: document.originalFileName,
    mimeType: document.mimeType,
    uploadedBy: serializeUserReference(documentWithUsers.uploadedBy),
    sharedWithDoctors: documentWithUsers.sharedWithDoctors.map(serializeUserReference),
    documentHash: document.documentHash,
    hashAlgorithm: document.hashAlgorithm,
    blockchainTxHash: document.blockchainTxHash,
    blockchainRegisteredAt: document.blockchainRegisteredAt?.toISOString(),
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

interface DocumentAccessDecision {
  allowed: boolean;
  consentGrantId?: string;
  emergencyAccessId?: string;
  emergencyExpiresAt?: string;
}

/** Compile-time exhaustiveness guard: adding a role to USER_ROLES without a branch below is a type error. */
const assertRoleHandled = (role: never): never => {
  throw new Error(`Unhandled user role: ${String(role)}`);
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
      return { allowed: true };

    case 'patient':
      return { allowed: document.uploadedBy.toString() === user.id };

    case 'lab':
      return { allowed: document.uploadedByLab?.toString() === user.id };

    case 'doctor': {
      if (document.sharedWithDoctors.some((doctorId) => doctorId.toString() === user.id)) {
        return { allowed: true };
      }

      const approvedConsent = await findApprovedConsent(user.id, document._id);

      if (approvedConsent) {
        return { allowed: true, consentGrantId: approvedConsent._id.toString() };
      }

      const emergencyAccess = await findActiveEmergencyAccess(user.id, document._id);

      if (!emergencyAccess) {
        return { allowed: false };
      }

      return {
        allowed: true,
        emergencyAccessId: emergencyAccess._id.toString(),
        emergencyExpiresAt: emergencyAccess.expiresAt.toISOString(),
      };
    }

    default:
      return assertRoleHandled(user.role);
  }
};

const getDocumentAccessAuditMetadata = (
  accessDecision: DocumentAccessDecision,
  patientId: string
): Record<string, string> | undefined => {
  if (accessDecision.consentGrantId) {
    return { accessMethod: 'consent', consentGrantId: accessDecision.consentGrantId, patientId };
  }

  if (accessDecision.emergencyAccessId && accessDecision.emergencyExpiresAt) {
    return {
        accessMethod: 'emergency',
        emergencyAccessId: accessDecision.emergencyAccessId,
        patientId,
        expiresAt: accessDecision.emergencyExpiresAt,
      };
  }

  return undefined;
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

  const safeFileName = getSafeDownloadFileName(document.originalFileName || document.storedFileName);

  res.setHeader('Content-Type', document.mimeType);
  res.setHeader('Content-Length', fileStats.size.toString());
  res.setHeader('Content-Disposition', `${disposition}; filename="${safeFileName}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  await createAuditLog({
    userId: user.id,
    action: disposition === 'inline' ? 'DOCUMENT_PREVIEW' : 'DOCUMENT_DOWNLOAD',
    targetDocument: document._id,
    ipAddress: getRequestIpAddress(req),
    metadata: getDocumentAccessAuditMetadata(accessDecision, document.uploadedBy.toString()),
  });

  const fileStream = createReadStream(resolvedFilePath);
  fileStream.on('error', next);
  fileStream.pipe(res);
};

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
  res.status(201).json({ document: serializeMedicalDocument(populatedDocument) });
});

/**
 * Builds the list filter for GET /documents/my-documents. Mirrors getDocumentAccessDecision branch for branch:
 * anything this returns must also be allowed by that function, and vice versa.
 */
const getMyDocumentsFilter = async (user: SafeUser): Promise<Record<string, unknown>> => {
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
      return assertRoleHandled(user.role);
  }
};

export const getMyDocuments: RequestHandler = asyncHandler(async (req, res) => {
  const user = validateAuthenticatedUser(req as AuthenticatedRequest);

  if (!user) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const documents = await MedicalDocument.find(await getMyDocumentsFilter(user))
    .sort({ createdAt: -1 })
    .populate('uploadedBy', USER_REFERENCE_FIELDS)
    .populate('sharedWithDoctors', USER_REFERENCE_FIELDS)
    .populate('uploadedByLab', USER_REFERENCE_FIELDS);

  res.json({ documents: documents.map(serializeMedicalDocument) });
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
  res.json({ document: serializeMedicalDocument(populatedDocument) });
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
    const currentHash = await calculateFileSha256(resolvedFilePath);
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
      metadata: { integrityVerified: String(verified) },
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
  }

  const populatedDocument = await populateDocumentUsers(document);

  res.json({
    message: alreadyShared ? 'Doctor already has access to this document' : 'Document shared with doctor',
    document: serializeMedicalDocument(populatedDocument),
  });
});
