import { Types } from 'mongoose';
import { ConsentGrant } from '../models/ConsentGrant';

export const findApprovedConsent = (doctorId: string | Types.ObjectId, documentId: string | Types.ObjectId) =>
  ConsentGrant.findOne({ doctorId, documentId, status: 'APPROVED' }).sort({ approvedAt: -1 });
