import mongoose, { Document, Schema, Types } from 'mongoose';

export const EMERGENCY_ACCESS_STATUSES = ['ACTIVE', 'EXPIRED'] as const;

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
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  }
);

emergencyAccessSchema.index({ doctorId: 1, documentId: 1, status: 1, expiresAt: 1 });

export const EmergencyAccess = mongoose.model<IEmergencyAccess>('EmergencyAccess', emergencyAccessSchema);
