import { Types } from 'mongoose';
import { EmergencyAccess } from '../models/EmergencyAccess';

export const EMERGENCY_ACCESS_DURATION_MINUTES = 15;
export const EMERGENCY_ACCESS_DURATION_MS = EMERGENCY_ACCESS_DURATION_MINUTES * 60 * 1000;

export const findActiveEmergencyAccess = (doctorId: string | Types.ObjectId, documentId: string | Types.ObjectId) =>
  EmergencyAccess.findOne({
    doctorId,
    documentId,
    status: 'ACTIVE',
    expiresAt: { $gt: new Date() },
  }).sort({ expiresAt: -1 });
