import type { RequestHandler } from 'express';
import { Types } from 'mongoose';
import { AccessLog, type AuditAction, type IAccessLog } from '../models/AccessLog';
import { MedicalDocument } from '../models/MedicalDocument';
import { User } from '../models/User';
import type { SafeUser, UserRole } from '../types/user.types';
import { asyncHandler } from '../utils/asyncHandler.util';

interface PopulatedUserReference {
  _id: Types.ObjectId;
  name: string;
  email: string;
  role: UserRole;
  createdAt: Date;
}

interface PopulatedDocumentReference {
  _id: Types.ObjectId;
  title: string;
  originalFileName: string;
  createdAt: Date;
}

type AccessLogWithReferences = Omit<IAccessLog, 'userId' | 'targetDocument'> & {
  userId: Types.ObjectId | PopulatedUserReference;
  targetDocument: Types.ObjectId | PopulatedDocumentReference | null;
};

interface AuditDocumentSummary {
  id: string;
  title: string;
  originalFileName: string;
  createdAt: string;
}

interface AuditLogResponse {
  id: string;
  user: SafeUser;
  action: AuditAction;
  targetDocument: AuditDocumentSummary | null;
  timestamp: string;
  ipAddress: string;
}

const isPopulatedUserReference = (value: unknown): value is PopulatedUserReference =>
  typeof value === 'object' &&
  value !== null &&
  '_id' in value &&
  'name' in value &&
  'email' in value &&
  'role' in value &&
  'createdAt' in value;

const isPopulatedDocumentReference = (value: unknown): value is PopulatedDocumentReference =>
  typeof value === 'object' &&
  value !== null &&
  '_id' in value &&
  'title' in value &&
  'originalFileName' in value &&
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

const serializeDocumentReference = (
  document: Types.ObjectId | PopulatedDocumentReference | null
): AuditDocumentSummary | null => {
  if (!document) {
    return null;
  }

  if (isPopulatedDocumentReference(document)) {
    return {
      id: document._id.toString(),
      title: document.title,
      originalFileName: document.originalFileName,
      createdAt: document.createdAt.toISOString(),
    };
  }

  return {
    id: document.toString(),
    title: 'Unavailable document',
    originalFileName: '',
    createdAt: '',
  };
};

const serializeAccessLog = (log: IAccessLog): AuditLogResponse => {
  const logWithReferences = log as AccessLogWithReferences;

  return {
    id: log._id.toString(),
    user: serializeUserReference(logWithReferences.userId),
    action: log.action,
    targetDocument: serializeDocumentReference(logWithReferences.targetDocument),
    timestamp: log.timestamp.toISOString(),
    ipAddress: log.ipAddress,
  };
};

export const getAuditSummary: RequestHandler = asyncHandler(async (_req, res) => {
  const [totalUsers, totalDocuments, recentActivity] = await Promise.all([
    User.countDocuments(),
    MedicalDocument.countDocuments(),
    AccessLog.find()
      .sort({ timestamp: -1 })
      .limit(8)
      .populate('userId', 'name email role createdAt')
      .populate('targetDocument', 'title originalFileName createdAt'),
  ]);

  res.json({
    summary: {
      totalUsers,
      totalDocuments,
      recentActivity: recentActivity.map(serializeAccessLog),
    },
  });
});
