import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * One row per (record, event) whose digest is anchored on the AuditAnchorRegistry contract. This
 * collection is both the durable work queue and the off-chain ledger:
 *   PENDING  -> queued; `attempts`, `nextAttemptAt` and (after the first failure) `lastError` are always
 *               populated so a long-pending row is diagnosable without logs
 *   ANCHORED -> on-chain; txHash / blockNumber / anchoredAt filled, digest write-back done on the record
 *   FAILED   -> gave up after the attempt cap; row kept, visible, retryable by an admin
 * Nothing is ever deleted. The boot reconciliation sweep re-derives missing rows from the records
 * themselves, so this collection is a work list, not the only source of truth. See docs/ANCHORING.md.
 */
export const CHAIN_ANCHOR_STATUSES = ['PENDING', 'ANCHORED', 'FAILED'] as const;
export type ChainAnchorStatus = (typeof CHAIN_ANCHOR_STATUSES)[number];

export const CONSENT_ANCHOR_EVENTS = ['REQUESTED', 'APPROVED', 'REJECTED', 'REVOKED'] as const;
export type ConsentAnchorEvent = (typeof CONSENT_ANCHOR_EVENTS)[number];

export const EMERGENCY_ANCHOR_EVENTS = ['GRANTED'] as const;
export type EmergencyAnchorEvent = (typeof EMERGENCY_ANCHOR_EVENTS)[number];

export type AnchorRecordType = 'consent' | 'emergency';
export type AnchorEvent = ConsentAnchorEvent | EmergencyAnchorEvent;

export interface IChainAnchor extends Document {
  _id: Types.ObjectId;
  /** Off-chain record key, e.g. "consent:<id>:APPROVED". keccak256 of it is the on-chain key. */
  key: string;
  recordType: AnchorRecordType;
  recordId: Types.ObjectId;
  event: AnchorEvent;
  /** Who caused the event — the audit actor for CHAIN_ANCHOR_FAILED rows. */
  actorUserId: Types.ObjectId;
  documentId: Types.ObjectId;
  /** The exact canonical string that was hashed. Kept so verification shows what was anchored. */
  preimage: string;
  /** SHA-256 hex of `preimage`, lower-case. */
  digest: string;
  status: ChainAnchorStatus;
  attempts: number;
  nextAttemptAt: Date;
  lastError?: string;
  lastAttemptAt?: Date;
  txHash?: string;
  blockNumber?: number;
  anchoredAt?: Date;
  failedAt?: Date;
  /** How the row came to exist: written by the controller, or re-derived by the boot sweep. */
  source: 'controller' | 'reconciliation' | 'retry';
  createdAt: Date;
  updatedAt: Date;
}

const chainAnchorSchema = new Schema<IChainAnchor>(
  {
    key: { type: String, required: true, unique: true, trim: true },
    recordType: { type: String, enum: ['consent', 'emergency'], required: true, index: true },
    recordId: { type: Schema.Types.ObjectId, required: true, index: true },
    event: { type: String, enum: [...CONSENT_ANCHOR_EVENTS, ...EMERGENCY_ANCHOR_EVENTS], required: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    documentId: { type: Schema.Types.ObjectId, ref: 'MedicalDocument', required: true },
    preimage: { type: String, required: true },
    digest: { type: String, required: true, match: [/^[a-f0-9]{64}$/, 'digest must be a SHA-256 hex'] },
    status: { type: String, enum: CHAIN_ANCHOR_STATUSES, default: 'PENDING', required: true, index: true },
    attempts: { type: Number, default: 0, required: true, min: 0 },
    nextAttemptAt: { type: Date, default: Date.now, required: true },
    lastError: { type: String, default: undefined, maxlength: 1000 },
    lastAttemptAt: { type: Date, default: undefined },
    txHash: { type: String, default: undefined, trim: true },
    blockNumber: { type: Number, default: undefined },
    anchoredAt: { type: Date, default: undefined },
    failedAt: { type: Date, default: undefined },
    source: { type: String, enum: ['controller', 'reconciliation', 'retry'], required: true },
  },
  { timestamps: true, versionKey: false }
);

// The worker's poll: due PENDING rows, oldest first.
chainAnchorSchema.index({ status: 1, nextAttemptAt: 1 });
chainAnchorSchema.index({ createdAt: -1 });

export const ChainAnchor = mongoose.model<IChainAnchor>('ChainAnchor', chainAnchorSchema);
