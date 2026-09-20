import mongoose, { Document, Schema, Types } from 'mongoose';

export const CONSENT_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'REVOKED'] as const;

export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

/** Proof that one event of this record is on-chain. Written once by the anchor worker; see docs/ANCHORING.md. */
export interface AnchorReference {
  digest: string;
  txHash: string;
  blockNumber: number;
  anchoredAt: Date;
}

export const anchorReferenceSchema = new Schema<AnchorReference>(
  {
    digest: { type: String, required: true },
    txHash: { type: String, required: true },
    blockNumber: { type: Number, required: true },
    anchoredAt: { type: Date, required: true },
  },
  { _id: false }
);

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
  /** Denormalized on-chain proofs, keyed by event; the ChainAnchor collection is the full ledger. */
  anchors?: {
    requested?: AnchorReference;
    approved?: AnchorReference;
    rejected?: AnchorReference;
    revoked?: AnchorReference;
  };
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
    anchors: {
      type: new Schema(
        {
          requested: { type: anchorReferenceSchema, default: undefined },
          approved: { type: anchorReferenceSchema, default: undefined },
          rejected: { type: anchorReferenceSchema, default: undefined },
          revoked: { type: anchorReferenceSchema, default: undefined },
        },
        { _id: false }
      ),
      default: undefined,
    },
  },
  { versionKey: false }
);

consentGrantSchema.index(
  { doctorId: 1, documentId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['PENDING', 'APPROVED'] } } }
);
consentGrantSchema.index({ patientId: 1, status: 1, requestedAt: -1 });

export const ConsentGrant = mongoose.model<IConsentGrant>('ConsentGrant', consentGrantSchema);
