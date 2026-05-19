import mongoose, { Document, Schema } from 'mongoose';

export interface IAccessLog extends Document {
  userId: mongoose.Types.ObjectId;
  documentId: mongoose.Types.ObjectId;
  action: 'read' | 'write' | 'delete';
  ipAddress: string;
  createdAt: Date;
}

const accessLogSchema = new Schema<IAccessLog>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    documentId: { type: Schema.Types.ObjectId, ref: 'MedicalDocument', required: true },
    action: { type: String, enum: ['read', 'write', 'delete'], required: true },
    ipAddress: { type: String },
  },
  { timestamps: true }
);

export const AccessLog = mongoose.model<IAccessLog>('AccessLog', accessLogSchema);