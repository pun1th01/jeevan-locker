import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import path from 'path';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Types } from 'mongoose';
import {
  DOCUMENT_DESCRIPTION_MAX_LENGTH,
  DOCUMENT_TITLE_MAX_LENGTH,
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
import { deleteDocumentForPatient } from '../services/documentDeletion.service';

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
  /** The owning patient's note. Present only when set, and never sent to a lab — see receivesPatientNotes. */
  description?: string;
  originalFileName: string;
  mimeType: MedicalDocumentMimeType;
  /** The owning patient, minimised per reader (REFERENCE_FIELDS). */
  uploadedBy: UserReference;
  /** Which doctors the patient shared the document with. Only the patient and admins receive it — see receivesSharing. */
  sharedWithDoctors?: UserReference[];
  documentHash?: string;
  hashAlgorithm?: 'SHA-256';
  blockchainTxHash?: string;
  blockchainRegisteredAt?: string;
  /** False only for legacy rows the encryption migration has not reached yet. */
  encryptedAtRest: boolean;
  /** The issuing lab, minimised per reader (REFERENCE_FIELDS). */
  uploadedByLab?: UserReference;
  labName?: string;
  testName?: string;
  nablCertNumber?: string;
  authorizingDoctorName?: string;
  hospitalName?: string;
  reportDate?: string;
  testValues?: ITestValue[];
  /** Admins only: when the owning patient soft-deleted the document. */
  deletedAt?: string;
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
 * Whether a reader receives `sharedWithDoctors` — the doctors a patient chose to share a document with. It is the
 * patient's own decision about their care team, so it goes to the patient (who manages it) and to admins. A doctor
 * reads the document, not the list of colleagues who also may; a lab issues reports but takes no part in care
 * decisions. Exhaustive over the roles: a new role must decide explicitly.
 */
const receivesSharing = (viewer: UserRole): boolean => {
  switch (viewer) {
    case 'patient':
    case 'admin':
      return true;
    case 'doctor':
    case 'lab':
      return false;
    default: {
      const unhandled: never = viewer;
      return Boolean(unhandled);
    }
  }
};

/** A user as one reader of a document sees them: `id` and `name` always, and only what that reader needs beyond. */
export type UserReference = Pick<SafeUser, 'id' | 'name'> & Partial<Omit<SafeUser, 'id' | 'name'>>;

/** Which part a referenced user plays in the document. */
type ReferenceRole = 'owner' | 'sharedDoctor' | 'issuingLab';

/**
 * Response minimisation (docs/API_DOCUMENTS.md §6): the fields of each referenced user that each reader receives.
 * An admin gets the full account record. Nobody else ever gets `verified`, `createdAt` or `role` of another user, and an
 * email only where the reader acts on it: a doctor contacting the patient, a patient managing whom they shared with.
 * `sharedDoctor` applies only to readers that receive the share list at all (receivesSharing).
 */
const REFERENCE_FIELDS: Record<Exclude<UserRole, 'admin'>, Record<ReferenceRole, ReadonlyArray<keyof SafeUser>>> = {
  patient: { owner: ['id', 'name'], sharedDoctor: ['id', 'name', 'email'], issuingLab: ['id', 'name', 'organisation'] },
  doctor: { owner: ['id', 'name', 'email'], sharedDoctor: [], issuingLab: ['id', 'name', 'organisation'] },
  lab: { owner: ['id', 'name'], sharedDoctor: [], issuingLab: ['id', 'name', 'organisation'] },
};

const referenceFor = (user: Types.ObjectId | PopulatedUserReference, part: ReferenceRole, viewer: UserRole): UserReference => {
  const full = serializeUserReference(user);

  if (viewer === 'admin') {
    return full;
  }

  return Object.fromEntries(
    REFERENCE_FIELDS[viewer][part].filter((field) => full[field] !== undefined).map((field) => [field, full[field]])
  ) as UserReference;
};

/**
 * Whether a reader receives the patient's own `description` of a document. It is the patient's note, written for
 * their care; a lab that issued a report gets the report back as issued, never what the patient wrote about it.
 * Exhaustive over the roles, like receivesSharing.
 */
const receivesPatientNotes = (viewer: UserRole): boolean => {
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
    ...(document.description && receivesPatientNotes(viewer) ? { description: document.description } : {}),
    originalFileName: document.originalFileName,
    mimeType: document.mimeType,
    uploadedBy: referenceFor(documentWithUsers.uploadedBy, 'owner', viewer),
    ...(receivesSharing(viewer)
      ? { sharedWithDoctors: documentWithUsers.sharedWithDoctors.map((doctor) => referenceFor(doctor, 'sharedDoctor', viewer)) }
      : {}),
    documentHash: document.documentHash,
    hashAlgorithm: document.hashAlgorithm,
    blockchainTxHash: document.blockchainTxHash,
    blockchainRegisteredAt: document.blockchainRegisteredAt?.toISOString(),
    encryptedAtRest: Boolean(document.encryption),
    ...(isLabReport(documentWithUsers) ? serializeLabReportFields(documentWithUsers, viewer) : {}),
    // The flag is for admins only: the issuing lab, which also still reads a deleted report, is not told.
    ...(document.deletedAt && viewer === 'admin' ? { deletedAt: document.deletedAt.toISOString() } : {}),
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  };
};

type LabReportDocument = DocumentWithUsers & { uploadedByLab: Types.ObjectId | PopulatedUserReference };

const isLabReport = (document: DocumentWithUsers): document is LabReportDocument => document.uploadedByLab !== undefined && document.uploadedByLab !== null;

/** Report fields are emitted only when a lab issued the document; bounds are omitted when unset. */
const serializeLabReportFields = (
  document: LabReportDocument,
  viewer: UserRole
): Pick<
  MedicalDocumentResponse,
  'uploadedByLab' | 'labName' | 'testName' | 'nablCertNumber' | 'authorizingDoctorName' | 'hospitalName' | 'reportDate' | 'testValues'
> => ({
  uploadedByLab: referenceFor(document.uploadedByLab, 'issuingLab', viewer),
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
  // A soft-deleted document reaches only the readers seesDeletedDocuments names; the lookup already returns 404 to
  // everyone else, and this keeps the rule true for any caller that loads the document some other way.
  if (document.deletedAt && !seesDeletedDocuments(user.role)) {
    return { allowed: false };
  }

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


/**
 * Whether a soft-deleted document still exists for this reader. For the patient who deleted it and for every doctor
 * it is gone: 404, exactly like an id that never existed. An admin sees it, flagged. The issuing lab keeps its own
 * report, for the reason it keeps one after a link is revoked: a lab must be able to stand behind what it signed.
 * Exhaustive over the roles.
 */
const seesDeletedDocuments = (viewer: UserRole): boolean => {
  switch (viewer) {
    case 'admin':
    case 'lab':
      return true;
    case 'patient':
    case 'doctor':
      return false;
    default: {
      const unhandled: never = viewer;
      return Boolean(unhandled);
    }
  }
};

const getDocumentByValidatedId = async (documentId: string, viewer: UserRole) => {
  if (!Types.ObjectId.isValid(documentId)) {
    return null;
  }

  return MedicalDocument.findOne({ _id: documentId, ...(seesDeletedDocuments(viewer) ? {} : { deletedAt: null }) });
};

const getStringParam = (value: string | string[] | undefined): string => {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }

  return value ?? '';
};

/**
 * Content-Disposition per RFC 6266: an ASCII `filename` fallback (anything outside printable ASCII, and quotes and
 * backslashes, become "_") plus `filename*` carrying the exact name as percent-encoded UTF-8. Node writes header
 * values as Latin-1, so a raw non-Latin name (a Devanagari "रिपोर्ट.pdf") would be cut into control bytes and the
 * whole response rejected by the browser.
 */
export const contentDispositionFor = (disposition: 'inline' | 'attachment', fileName: string): string => {
  // The last segment after either separator, on every platform (path.basename splits on "\" only on Windows).
  const name = fileName.split(/[\\/]/).pop() ?? '';
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};

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

  const document = await getDocumentByValidatedId(getStringParam(req.params.id), user.role);

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

  res.setHeader('Content-Type', document.mimeType);
  res.setHeader('Content-Length', contentLength.toString());
  res.setHeader('Content-Disposition', contentDispositionFor(disposition, document.originalFileName || document.storedFileName));
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

  // Checked here, like the lab-report and metadata routes, rather than left to the model: a refusal names the rule.
  if (title.length > DOCUMENT_TITLE_MAX_LENGTH) {
    await discardUploadedFile(file.path);
    res.status(400).json({ message: TITLE_LENGTH_MESSAGE });
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
      return { uploadedBy: user.id, deletedAt: null };

    case 'lab':
      return { uploadedByLab: user.id };

    case 'doctor': {
      await expireEmergencyAccesses(user.id);

      const [activeEmergencyAccesses, approvedConsents] = await Promise.all([
        EmergencyAccess.find({ doctorId: user.id, status: 'ACTIVE', expiresAt: { $gt: new Date() } }).select('documentId'),
        ConsentGrant.find({ doctorId: user.id, status: 'APPROVED' }).select('documentId'),
      ]);

      return {
        deletedAt: null,
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
  const document = await getDocumentByValidatedId(documentId, user.role);

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

  const document = await getDocumentByValidatedId(getStringParam(req.params.id), user.role);
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

  const document = await getDocumentByValidatedId(getStringParam(req.params.id), user.role);

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

/** The document as stored after a write, populated and serialized for the caller — every write responds through it. */
const respondWithDocument = async (res: Response, documentId: Types.ObjectId, viewer: UserRole, message: string) => {
  const stored = await MedicalDocument.findById(documentId);
  if (!stored) throw new Error(`Document ${documentId.toString()} disappeared before its response was built`);
  res.json({ message, document: serializeMedicalDocument(await populateDocumentUsers(stored), viewer) });
};

/**
 * PATCH /documents/:id/unshare { doctorId }   (patient, owner)
 * Removes one doctor from the DIRECT share list and nothing else: an approved consent or a live break-glass grant the
 * same doctor holds is a separate permission with its own revoke, and survives. One guarded $pull, so concurrent
 * unshares audit once. Unsharing a doctor with no direct share is a 200 that writes nothing, mirroring a repeated share.
 */
export const unshareDocumentFromDoctor: RequestHandler = asyncHandler(async (req, res) => {
  const user = validateAuthenticatedUser(req as AuthenticatedRequest);

  if (!user) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const doctorId = typeof req.body?.doctorId === 'string' ? req.body.doctorId : '';

  if (!Types.ObjectId.isValid(doctorId)) {
    res.status(400).json({ message: 'A valid doctor ID is required' });
    return;
  }

  const document = await getDocumentByValidatedId(getStringParam(req.params.id), user.role);

  if (!document) {
    res.status(404).json({ message: 'Document not found' });
    return;
  }

  if (document.uploadedBy.toString() !== user.id) {
    res.status(403).json({ message: 'Only the uploading patient can change who this document is shared with' });
    return;
  }

  const result = await MedicalDocument.updateOne(
    { _id: document._id, uploadedBy: document.uploadedBy, sharedWithDoctors: doctorId },
    { $pull: { sharedWithDoctors: new Types.ObjectId(doctorId) } }
  );
  const removed = result.modifiedCount === 1;

  if (removed) {
    await createAuditLog({
      userId: user.id,
      action: 'DOCUMENT_UNSHARED',
      targetDocument: document._id,
      ipAddress: getRequestIpAddress(req),
      metadata: { doctorId, patientId: user.id },
    });
  }

  await respondWithDocument(res, document._id, user.role, removed ? 'Direct access removed' : 'This doctor had no direct access to this document');
});

const EDITABLE_METADATA_FIELDS: ReadonlySet<string> = new Set(['title', 'description']);
const TITLE_LENGTH_MESSAGE = `Document title must be 1 to ${DOCUMENT_TITLE_MAX_LENGTH} characters`;
const DESCRIPTION_LENGTH_MESSAGE = `Description must be ${DOCUMENT_DESCRIPTION_MAX_LENGTH} characters or fewer`;

/**
 * PATCH /documents/:id/metadata { title?, description? }   (patient, owner)
 * The only fields a patient may change, and the body may carry nothing else: ownership, sharing, the file, its hash
 * and every lab-issued field are refused outright rather than silently ignored. A lab report keeps the title its lab
 * issued; the patient may only describe it. An empty description clears it. The file and its on-chain hash are not
 * touched, so /integrity verifies exactly as before. Saving unchanged values is a 200 that audits nothing.
 */
export const updateDocumentMetadata: RequestHandler = asyncHandler(async (req, res) => {
  const user = validateAuthenticatedUser(req as AuthenticatedRequest);

  if (!user) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;

  if (Object.keys(body).some((field) => !EDITABLE_METADATA_FIELDS.has(field))) {
    res.status(400).json({ message: 'Only the title and description of a document can be changed' });
    return;
  }

  if (body.title === undefined && body.description === undefined) {
    res.status(400).json({ message: 'Send a title or a description to change' });
    return;
  }

  const title = typeof body.title === 'string' ? body.title.trim() : undefined;

  if (body.title !== undefined && (!title || title.length > DOCUMENT_TITLE_MAX_LENGTH)) {
    res.status(400).json({ message: TITLE_LENGTH_MESSAGE });
    return;
  }

  const description = typeof body.description === 'string' ? body.description.trim() : undefined;

  if (body.description !== undefined && (description === undefined || description.length > DOCUMENT_DESCRIPTION_MAX_LENGTH)) {
    res.status(400).json({ message: DESCRIPTION_LENGTH_MESSAGE });
    return;
  }

  const document = await getDocumentByValidatedId(getStringParam(req.params.id), user.role);

  if (!document) {
    res.status(404).json({ message: 'Document not found' });
    return;
  }

  if (document.uploadedBy.toString() !== user.id) {
    res.status(403).json({ message: 'Only the uploading patient can edit this document' });
    return;
  }

  const titleChanged = title !== undefined && title !== document.title;

  if (titleChanged && document.uploadedByLab) {
    res.status(403).json({ message: 'A lab report keeps the title its lab issued; only its description can be changed' });
    return;
  }

  const descriptionChanged = description !== undefined && description !== (document.description ?? '');

  if (!titleChanged && !descriptionChanged) {
    await respondWithDocument(res, document._id, user.role, 'No changes to save');
    return;
  }

  const update: { $set?: Record<string, string>; $unset?: Record<string, ''> } = {};
  if (titleChanged) update.$set = { title };
  if (descriptionChanged && description) update.$set = { ...update.$set, description };
  if (descriptionChanged && !description) update.$unset = { description: '' };

  await MedicalDocument.updateOne({ _id: document._id, uploadedBy: document.uploadedBy }, update, { runValidators: true });

  await createAuditLog({
    userId: user.id,
    action: 'DOCUMENT_UPDATED',
    targetDocument: document._id,
    ipAddress: getRequestIpAddress(req),
    metadata: {
      fields: [titleChanged ? 'title' : null, descriptionChanged ? 'description' : null].filter(Boolean).join(','),
      ...(titleChanged ? { previousTitle: document.title } : {}),
      patientId: user.id,
    },
  });

  await respondWithDocument(res, document._id, user.role, 'Document details updated');
});

export const DOCUMENT_DELETED_MESSAGE =
  'Document deleted. Doctors can no longer open it; its hash stays on the blockchain and the audit trail is kept.';

/**
 * DELETE /documents/:id   (patient, owner)
 * Soft delete: see services/documentDeletion.service.ts for the cascade and docs/API_DOCUMENTS.md §5. A document the
 * patient already deleted is not found — it no longer exists for them — and so is the loser of two concurrent deletes.
 */
export const deleteDocument: RequestHandler = asyncHandler(async (req, res) => {
  const user = validateAuthenticatedUser(req as AuthenticatedRequest);

  if (!user) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const document = await getDocumentByValidatedId(getStringParam(req.params.id), user.role);

  if (!document) {
    res.status(404).json({ message: 'Document not found' });
    return;
  }

  if (document.uploadedBy.toString() !== user.id) {
    res.status(403).json({ message: 'Only the uploading patient can delete this document' });
    return;
  }

  const deletion = await deleteDocumentForPatient(document._id, user, getRequestIpAddress(req));

  if (!deletion) {
    res.status(404).json({ message: 'Document not found' });
    return;
  }

  res.json({
    message: DOCUMENT_DELETED_MESSAGE,
    consentsRevoked: deletion.consentsRevoked,
    consentsRejected: deletion.consentsRejected,
    grantsRevoked: deletion.grantsRevoked,
  });
});
