import mongoose, { Document, Schema, Types } from 'mongoose';

export const AUDIT_ACTIONS = [
  // Authentication
  'USER_LOGIN',
  // Documents
  'DOCUMENT_UPLOAD',
  'DOCUMENT_ACCESS',
  'DOCUMENT_PREVIEW',
  'DOCUMENT_DOWNLOAD',
  'DOCUMENT_SHARE',
  'DOCUMENT_UNSHARED',
  'DOCUMENT_DELETED',
  'DOCUMENT_UPDATED',
  'INTEGRITY_VERIFIED',
  // Consent workflow
  'CONSENT_REQUESTED',
  'CONSENT_APPROVED',
  'CONSENT_REJECTED',
  'CONSENT_REVOKED',
  // Break-glass emergency access
  'EMERGENCY_ACCESS_GRANTED',
  'EMERGENCY_ACCESS_REVOKED',
  'EMERGENCY_ACCESS_EXPIRED',
  // Doctor / lab workflows
  'PATIENT_LOOKUP',
  'LAB_LINK_REQUESTED',
  'LAB_LINKED',
  'LAB_LINK_REJECTED',
  'LAB_UNLINKED',
  'LAB_REPORT_UPLOADED',
  // Platform / admin
  'NOTIFICATION_SENT',
  'ADMIN_CREATED',
  'DOCTOR_VERIFIED',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface IAccessLog extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  action: AuditAction;
  targetDocument: Types.ObjectId | null;
  timestamp: Date;
  ipAddress: string;
  metadata?: Record<string, string>;
}

const accessLogSchema = new Schema<IAccessLog>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    action: {
      type: String,
      enum: AUDIT_ACTIONS,
      required: true,
      index: true,
    },
    targetDocument: {
      type: Schema.Types.ObjectId,
      ref: 'MedicalDocument',
      default: null,
      index: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      required: true,
      index: true,
    },
    ipAddress: {
      type: String,
      required: true,
      trim: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: undefined,
    },
  },
  {
    versionKey: false,
  }
);

accessLogSchema.index({ timestamp: -1 });

export const AccessLog = mongoose.model<IAccessLog>('AccessLog', accessLogSchema);
