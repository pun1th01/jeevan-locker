import mongoose, { Document, Schema, Types } from 'mongoose';

export const CONSENT_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'REVOKED'] as const;

export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

export interface IConsentGrant extends Document {
  _id: Types.ObjectId;
  patientId: Types.ObjectId;
  doctorId: Types.ObjectId;
  documentId: Types.ObjectId;
  purpose: string;
  status: ConsentStatus;
  requestedAt: Date;
  approvedAt?: Date;
  rejectedAt?: Date;
  revokedAt?: Date;
}

const consentGrantSchema = new Schema<IConsentGrant>(
  {
    patientId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    doctorId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    documentId: { type: Schema.Types.ObjectId, ref: 'MedicalDocument', required: true, index: true },
    purpose: { type: String, required: [true, 'Consent purpose is required'], trim: true, maxlength: 500 },
    status: { type: String, enum: CONSENT_STATUSES, default: 'PENDING', required: true, index: true },
    requestedAt: { type: Date, default: Date.now, required: true, index: true },
    approvedAt: { type: Date, default: undefined },
    rejectedAt: { type: Date, default: undefined },
    revokedAt: { type: Date, default: undefined },
  },
  { versionKey: false }
);

consentGrantSchema.index(
  { doctorId: 1, documentId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['PENDING', 'APPROVED'] } } }
);
consentGrantSchema.index({ patientId: 1, status: 1, requestedAt: -1 });

export const ConsentGrant = mongoose.model<IConsentGrant>('ConsentGrant', consentGrantSchema);
