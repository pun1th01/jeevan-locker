import { Types } from 'mongoose';
import { EmergencyAccess } from '../models/EmergencyAccess';

export const EMERGENCY_ACCESS_DURATION_MINUTES = 15;
export const EMERGENCY_ACCESS_DURATION_MS = EMERGENCY_ACCESS_DURATION_MINUTES * 60 * 1000;

export const expireEmergencyAccesses = (doctorId: string | Types.ObjectId, documentId?: string | Types.ObjectId) =>
  EmergencyAccess.updateMany(
    {
      doctorId,
      ...(documentId ? { documentId } : {}),
      status: 'ACTIVE',
      expiresAt: { $lte: new Date() },
    },
    { $set: { status: 'EXPIRED' } }
  );

export const findActiveEmergencyAccess = async (doctorId: string | Types.ObjectId, documentId: string | Types.ObjectId) => {
  await expireEmergencyAccesses(doctorId, documentId);

  return EmergencyAccess.findOne({
    doctorId,
    documentId,
    status: 'ACTIVE',
    expiresAt: { $gt: new Date() },
  }).sort({ expiresAt: -1 });
};
