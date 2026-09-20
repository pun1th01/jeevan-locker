import type { Request } from 'express';
import { Types } from 'mongoose';
import { AccessLog, type AuditAction } from '../models/AccessLog';

interface CreateAuditLogInput {
  userId: string | Types.ObjectId;
  action: AuditAction;
  targetDocument?: string | Types.ObjectId | null;
  ipAddress: string;
  metadata?: Record<string, string>;
}

const toObjectId = (value: string | Types.ObjectId): Types.ObjectId =>
  value instanceof Types.ObjectId ? value : new Types.ObjectId(value);

/**
 * Client IP for audit rows. `req.ip` already honours X-Forwarded-For exactly as far as `trust proxy`
 * allows (see env.ts), so the header is never read here directly — reading it would let any client
 * write an arbitrary address into the audit log.
 */
export const getRequestIpAddress = (req: Request): string => req.ip ?? req.socket.remoteAddress ?? 'unknown';

export const createAuditLog = async ({
  userId,
  action,
  targetDocument = null,
  ipAddress,
  metadata,
}: CreateAuditLogInput) => {
  await AccessLog.create({
    userId: toObjectId(userId),
    action,
    targetDocument: targetDocument ? toObjectId(targetDocument) : null,
    timestamp: new Date(),
    ipAddress,
    metadata,
  });
};
