import type { Request } from 'express';
import { Types } from 'mongoose';
import { AccessLog, type AuditAction } from '../models/AccessLog';

interface CreateAuditLogInput {
  userId: string | Types.ObjectId;
  action: AuditAction;
  targetDocument?: string | Types.ObjectId | null;
  ipAddress: string;
}

const toObjectId = (value: string | Types.ObjectId): Types.ObjectId =>
  value instanceof Types.ObjectId ? value : new Types.ObjectId(value);

export const getRequestIpAddress = (req: Request): string => {
  const forwardedFor = req.headers['x-forwarded-for'];

  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  if (Array.isArray(forwardedFor) && forwardedFor[0]) {
    return forwardedFor[0];
  }

  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
};

export const createAuditLog = async ({
  userId,
  action,
  targetDocument = null,
  ipAddress,
}: CreateAuditLogInput) => {
  await AccessLog.create({
    userId: toObjectId(userId),
    action,
    targetDocument: targetDocument ? toObjectId(targetDocument) : null,
    timestamp: new Date(),
    ipAddress,
  });
};
