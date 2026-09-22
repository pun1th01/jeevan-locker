import { Types } from 'mongoose';
import { EmergencyAccess } from '../models/EmergencyAccess';
import { createAuditLog } from './audit.util';

export const EMERGENCY_ACCESS_DURATION_MINUTES = 15;
export const EMERGENCY_ACCESS_DURATION_MS = EMERGENCY_ACCESS_DURATION_MINUTES * 60 * 1000;

export const DEFAULT_MAX_ACTIVE_EMERGENCY_GRANTS = 5;
export const DEFAULT_REGRANT_WINDOW_HOURS = 24;

/** Audit rows written by background expiry have no request context, so they carry this marker instead of an IP. */
export const SYSTEM_IP_ADDRESS = 'system';

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

interface ExpireScope {
  doctorId?: string | Types.ObjectId;
  documentId?: string | Types.ObjectId;
}

/**
 * The one place a grant becomes EXPIRED. Every caller — the scheduled job and the lazy sweeps on the
 * doctor's own reads — goes through this, which is what makes the audit row exactly-once:
 *
 *   updateOne({ _id, status: 'ACTIVE' }, { $set: { status: 'EXPIRED' } })
 *
 * is atomic per document, so of any number of concurrent callers exactly one gets modifiedCount 1 and
 * writes the audit row; every other caller gets 0 and skips it. The same guard makes REVOKED terminal:
 * a revoked grant matches neither the find filter nor the update filter, so expiry can never touch it.
 *
 * `limit` bounds one batch. Returns how many grants THIS caller actually expired.
 */
const expireGrants = async (scope: ExpireScope, limit?: number): Promise<number> => {
  const query = EmergencyAccess.find({
    ...(scope.doctorId ? { doctorId: scope.doctorId } : {}),
    ...(scope.documentId ? { documentId: scope.documentId } : {}),
    status: 'ACTIVE',
    expiresAt: { $lte: new Date() },
  })
    .select('_id doctorId patientId documentId expiresAt')
    .sort({ expiresAt: 1 });

  if (limit !== undefined) {
    query.limit(limit);
  }

  let expired = 0;

  for (const grant of await query) {
    const result = await EmergencyAccess.updateOne({ _id: grant._id, status: 'ACTIVE' }, { $set: { status: 'EXPIRED' } });

    if (result.modifiedCount === 0) {
      continue; // another caller (the job, or another request) won the race and is writing the audit row
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
    expired += 1;
  }

  return expired;
};

/**
 * Lazy sweep on a doctor's own reads. Kept as a fallback alongside the scheduled job: it cannot
 * double-log (see the guard above), it costs one indexed query on paths that already touch this
 * collection, and it means a doctor never sees a stale ACTIVE grant even if the job is stopped or the
 * process has only just restarted.
 */
export const expireEmergencyAccesses = (doctorId: string | Types.ObjectId, documentId?: string | Types.ObjectId): Promise<number> =>
  expireGrants({ doctorId, documentId });

/** One batch for the scheduled job: every lapsed grant in the system, oldest expiry first. */
export const expireDueGrants = (limit: number): Promise<number> => expireGrants({}, limit);

export const findActiveEmergencyAccess = async (doctorId: string | Types.ObjectId, documentId: string | Types.ObjectId) => {
  await expireEmergencyAccesses(doctorId, documentId);

  return EmergencyAccess.findOne({
    doctorId,
    documentId,
    status: 'ACTIVE',
    expiresAt: { $gt: new Date() },
  }).sort({ expiresAt: -1 });
};
