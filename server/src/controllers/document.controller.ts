import { createReadStream } from 'fs';
import { stat, unlink } from 'fs/promises';
import path from 'path';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Types } from 'mongoose';
import {
  MedicalDocument,
  type IMedicalDocument,
  type MedicalDocumentMimeType,
} from '../models/MedicalDocument';
import { User } from '../models/User';
import type { AuthenticatedRequest } from '../types/auth.types';
import type { SafeUser, UserRole } from '../types/user.types';
import { createAuditLog, getRequestIpAddress } from '../utils/audit.util';
import { toSafeUser } from '../utils/auth.util';
import { asyncHandler } from '../utils/asyncHandler.util';
import { getStoredDocumentPath, UPLOAD_DIRECTORY } from '../middleware/upload.middleware';

interface PopulatedUserReference {
  _id: Types.ObjectId;
  name: string;
  email: string;
  role: UserRole;
  createdAt: Date;
}

type DocumentWithUsers = Omit<IMedicalDocument, 'uploadedBy' | 'sharedWithDoctors'> & {
  uploadedBy: Types.ObjectId | PopulatedUserReference;
  sharedWithDoctors: Array<Types.ObjectId | PopulatedUserReference>;
};

interface MedicalDocumentResponse {
  id: string;
  title: string;
  originalFileName: string;
  storedFileName: string;
  filePath: string;
  mimeType: MedicalDocumentMimeType;
  uploadedBy: SafeUser;
  sharedWithDoctors: SafeUser[];
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
      createdAt: user.createdAt.toISOString(),
    };
  }

  return {
    id: user.toString(),
    name: 'Unknown user',
    email: '',
    role: 'patient',
    createdAt: '',
  };
};

const serializeMedicalDocument = (document: IMedicalDocument): MedicalDocumentResponse => {
  const documentWithUsers = document as DocumentWithUsers;

  return {
    id: document._id.toString(),
    title: document.title,
    originalFileName: document.originalFileName,
    storedFileName: document.storedFileName,
    filePath: document.filePath,
    mimeType: document.mimeType,
    uploadedBy: serializeUserReference(documentWithUsers.uploadedBy),
    sharedWithDoctors: documentWithUsers.sharedWithDoctors.map(serializeUserReference),
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  };
};

const populateDocumentUsers = async (document: IMedicalDocument): Promise<IMedicalDocument> => {
  await document.populate([
    { path: 'uploadedBy', select: 'name email role createdAt' },
    { path: 'sharedWithDoctors', select: 'name email role createdAt' },
  ]);

  return document;
};

const validateAuthenticatedUser = (req: AuthenticatedRequest) => req.user ?? null;

const canAccessDocument = (user: SafeUser, document: IMedicalDocument): boolean => {
  if (user.role === 'admin') {
    return true;
  }

  if (user.role === 'patient') {
    return document.uploadedBy.toString() === user.id;
  }

  return document.sharedWithDoctors.some((doctorId) => doctorId.toString() === user.id);
};

const removeUploadedFile = async (filePath: string) => {
  try {
    await unlink(filePath);
  } catch {
    // A failed cleanup should not hide the request validation or database error.
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

  if (!canAccessDocument(user, document)) {
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
    await removeUploadedFile(file.path);
    res.status(400).json({ message: 'Document title is required' });
    return;
  }

  let document: IMedicalDocument;

  try {
    document = await MedicalDocument.create({
      title,
      originalFileName: file.originalname,
      storedFileName: file.filename,
      filePath: getStoredDocumentPath(file.filename),
      mimeType: file.mimetype as MedicalDocumentMimeType,
      uploadedBy: user.id,
      sharedWithDoctors: [],
    });
  } catch (error) {
    await removeUploadedFile(file.path);
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

export const getMyDocuments: RequestHandler = asyncHandler(async (req, res) => {
  const user = validateAuthenticatedUser(req as AuthenticatedRequest);

  if (!user) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const query =
    user.role === 'admin'
      ? {}
      : user.role === 'doctor'
        ? { sharedWithDoctors: user.id }
        : { uploadedBy: user.id };

  const documents = await MedicalDocument.find(query)
    .sort({ createdAt: -1 })
    .populate('uploadedBy', 'name email role createdAt')
    .populate('sharedWithDoctors', 'name email role createdAt');

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

  if (!canAccessDocument(user, document)) {
    res.status(403).json({ message: 'You do not have permission to access this document' });
    return;
  }

  await createAuditLog({
    userId: user.id,
    action: 'DOCUMENT_ACCESS',
    targetDocument: document._id,
    ipAddress: getRequestIpAddress(req),
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
