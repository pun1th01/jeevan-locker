import { Types } from 'mongoose';
import { EmergencyAccess } from '../models/EmergencyAccess';
import { createAuditLog } from './audit.util';

export const EMERGENCY_ACCESS_DURATION_MINUTES = 15;
export const EMERGENCY_ACCESS_DURATION_MS = EMERGENCY_ACCESS_DURATION_MINUTES * 60 * 1000;

export const DEFAULT_MAX_ACTIVE_EMERGENCY_GRANTS = 5;
export const DEFAULT_REGRANT_WINDOW_HOURS = 24;

const readPositiveNumber = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/** How many live grants one doctor may hold at once, across all patients (EMERGENCY_MAX_ACTIVE_GRANTS). */
export const maxActiveEmergencyGrants = () => readPositiveNumber('EMERGENCY_MAX_ACTIVE_GRANTS', DEFAULT_MAX_ACTIVE_EMERGENCY_GRANTS);

/** How long after a revocation a new grant on the same doctor+document counts as a return (EMERGENCY_REGRANT_WINDOW_HOURS). */
export const regrantWindowMs = () => readPositiveNumber('EMERGENCY_REGRANT_WINDOW_HOURS', DEFAULT_REGRANT_WINDOW_HOURS) * 60 * 60 * 1000;

/** Live grants held by one doctor right now. Call after a lazy sweep so lapsed rows do not count. */
export const countActiveEmergencyAccesses = (doctorId: string | Types.ObjectId) =>
  EmergencyAccess.countDocuments({ doctorId, status: 'ACTIVE', expiresAt: { $gt: new Date() } });

/** Audit rows written by background expiry have no request context, so they carry this marker instead of an IP. */
export const SYSTEM_IP_ADDRESS = 'system';

/**
 * Marks lapsed ACTIVE grants as EXPIRED and writes one EMERGENCY_ACCESS_EXPIRED audit row per grant.
 * Each grant is flipped with an atomic status-guarded updateOne so concurrent callers never double-log.
 */
export const expireEmergencyAccesses = async (doctorId: string | Types.ObjectId, documentId?: string | Types.ObjectId) => {
  const lapsedGrants = await EmergencyAccess.find({
    doctorId,
    ...(documentId ? { documentId } : {}),
    status: 'ACTIVE',
    expiresAt: { $lte: new Date() },
  }).select('_id doctorId patientId documentId expiresAt');

  for (const grant of lapsedGrants) {
    const result = await EmergencyAccess.updateOne({ _id: grant._id, status: 'ACTIVE' }, { $set: { status: 'EXPIRED' } });

    if (result.modifiedCount === 0) {
      continue;
    }

    await createAuditLog({
      userId: grant.doctorId,
      action: 'EMERGENCY_ACCESS_EXPIRED',
      targetDocument: grant.documentId,
      ipAddress: SYSTEM_IP_ADDRESS,
      metadata: {
        emergencyAccessId: grant._id.toString(),
        doctorId: grant.doctorId.toString(),
        patientId: grant.patientId.toString(),
        expiresAt: grant.expiresAt.toISOString(),
      },
    });
  }
};

export const findActiveEmergencyAccess = async (doctorId: string | Types.ObjectId, documentId: string | Types.ObjectId) => {
  await expireEmergencyAccesses(doctorId, documentId);

  return EmergencyAccess.findOne({
    doctorId,
    documentId,
    status: 'ACTIVE',
    expiresAt: { $gt: new Date() },
  }).sort({ expiresAt: -1 });
};
