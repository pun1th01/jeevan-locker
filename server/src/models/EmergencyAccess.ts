import mongoose, { Document, Schema, Types } from 'mongoose';
import { anchorReferenceSchema, type AnchorReference } from './ConsentGrant';

/**
 * ACTIVE  -> EXPIRED  (the grant window on the row lapsed; scheduled job or the lazy path, exactly once)
 * ACTIVE  -> REVOKED  (the patient ended the session early)
 * Both transitions are terminal and guarded by an atomic status-conditioned update.
 */
export const EMERGENCY_ACCESS_STATUSES = ['ACTIVE', 'EXPIRED', 'REVOKED'] as const;

export type EmergencyAccessStatus = (typeof EMERGENCY_ACCESS_STATUSES)[number];

export interface IEmergencyAccess extends Document {
  _id: Types.ObjectId;
  doctorId: Types.ObjectId;
  patientId: Types.ObjectId;
  documentId: Types.ObjectId;
  reason: string;
  status: EmergencyAccessStatus;
  createdAt: Date;
  expiresAt: Date;
  /** Set once when the patient revokes; never cleared. */
  revokedAt?: Date;
  revokedBy?: Types.ObjectId;
  /**
   * True when this grant was started while a revocation of the SAME doctor on the SAME document was
   * still recent (EMERGENCY_REGRANT_WINDOW_HOURS). Off-chain by design: it is derivable from the
   * anchored REVOKED and GRANTED events, and the GRANTED preimage must stay byte-identical.
   */
  afterRevocation?: boolean;
  /** The revoked grant this one followed, when afterRevocation is true. */
  followsRevokedGrantId?: Types.ObjectId;
  /** Denormalized on-chain proofs; the ChainAnchor collection is the full ledger. */
  anchors?: { granted?: AnchorReference; revoked?: AnchorReference };
}

const emergencyAccessSchema = new Schema<IEmergencyAccess>(
  {
    doctorId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    patientId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    documentId: {
      type: Schema.Types.ObjectId,
      ref: 'MedicalDocument',
      required: true,
      index: true,
    },
    reason: {
      type: String,
      required: [true, 'Emergency access reason is required'],
      trim: true,
      maxlength: 500,
    },
    status: {
      type: String,
      enum: EMERGENCY_ACCESS_STATUSES,
      default: 'ACTIVE',
      required: true,
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    revokedAt: { type: Date, default: undefined },
    revokedBy: { type: Schema.Types.ObjectId, ref: 'User', default: undefined },
    afterRevocation: { type: Boolean, default: undefined },
    followsRevokedGrantId: { type: Schema.Types.ObjectId, ref: 'EmergencyAccess', default: undefined },
    anchors: {
      type: new Schema(
        { granted: { type: anchorReferenceSchema, default: undefined }, revoked: { type: anchorReferenceSchema, default: undefined } },
        { _id: false }
      ),
      default: undefined,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  }
);

emergencyAccessSchema.index({ doctorId: 1, documentId: 1, status: 1, expiresAt: 1 });
// The patient's list, and the scheduled expiry sweep over every lapsed ACTIVE grant.
emergencyAccessSchema.index({ patientId: 1, status: 1, createdAt: -1 });
emergencyAccessSchema.index({ status: 1, expiresAt: 1 });

export const EmergencyAccess = mongoose.model<IEmergencyAccess>('EmergencyAccess', emergencyAccessSchema);
