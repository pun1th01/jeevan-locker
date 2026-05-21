import mongoose, { Document, Schema } from 'mongoose';

export interface IMedicalDocument extends Document {
  patientId: mongoose.Types.ObjectId;
  uploadedBy: mongoose.Types.ObjectId;
  title: string;
  fileUrl: string;
  fileHash: string;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

const documentSchema = new Schema<IMedicalDocument>(
  {
    patientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true },
    fileUrl: { type: String, required: true },
    fileHash: { type: String, required: true },
    tags: [{ type: String }],
  },
  { timestamps: true }
);

export const MedicalDocument = mongoose.model<IMedicalDocument>('MedicalDocument', documentSchema);
