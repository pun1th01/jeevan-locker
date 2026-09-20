import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * A lab's authorisation to upload reports into one patient's vault.
 *   PENDING  -> ACTIVE   (patient approves)
 *   PENDING  -> REJECTED (patient rejects)
 *   ACTIVE   -> REVOKED  (patient revokes)
 * Only ACTIVE permits POST /api/lab/reports. Revoking stops future uploads; reports the lab already issued
 * stay readable by that lab (see getDocumentAccessDecision), because a lab must be able to stand behind
 * — and re-verify — what it signed.
 */
export const LAB_LINK_STATUSES = ['PENDING', 'ACTIVE', 'REJECTED', 'REVOKED'] as const;

export type LabLinkStatus = (typeof LAB_LINK_STATUSES)[number];

export interface ILabLink extends Document {
  _id: Types.ObjectId;
  patientId: Types.ObjectId;
  labId: Types.ObjectId;
  status: LabLinkStatus;
  requestedAt: Date;
  approvedAt?: Date;
  rejectedAt?: Date;
  revokedAt?: Date;
}

const labLinkSchema = new Schema<ILabLink>(
  {
    patientId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    labId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: { type: String, enum: LAB_LINK_STATUSES, default: 'PENDING', required: true, index: true },
    requestedAt: { type: Date, default: Date.now, required: true, index: true },
    approvedAt: { type: Date, default: undefined },
    rejectedAt: { type: Date, default: undefined },
    revokedAt: { type: Date, default: undefined },
  },
  { versionKey: false }
);

// At most one open (PENDING or ACTIVE) link per lab+patient; rejected/revoked history can accumulate.
labLinkSchema.index(
  { labId: 1, patientId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['PENDING', 'ACTIVE'] } } }
);
labLinkSchema.index({ patientId: 1, status: 1, requestedAt: -1 });

export const LabLink = mongoose.model<ILabLink>('LabLink', labLinkSchema);
