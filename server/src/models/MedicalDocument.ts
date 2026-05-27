import mongoose, { Document, Schema, Types } from 'mongoose';

export type MedicalDocumentMimeType = 'application/pdf' | 'image/jpeg' | 'image/png';

export interface IMedicalDocument extends Document {
  _id: Types.ObjectId;
  title: string;
  originalFileName: string;
  storedFileName: string;
  filePath: string;
  mimeType: MedicalDocumentMimeType;
  uploadedBy: Types.ObjectId;
  sharedWithDoctors: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const medicalDocumentSchema = new Schema<IMedicalDocument>(
  {
    title: {
      type: String,
      required: [true, 'Document title is required'],
      trim: true,
      maxlength: 120,
    },
    originalFileName: {
      type: String,
      required: true,
      trim: true,
    },
    storedFileName: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    filePath: {
      type: String,
      required: true,
      trim: true,
    },
    mimeType: {
      type: String,
      enum: ['application/pdf', 'image/jpeg', 'image/png'],
      required: true,
    },
    uploadedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    sharedWithDoctors: [
      {
        type: Schema.Types.ObjectId,
        ref: 'User',
        index: true,
      },
    ],
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

medicalDocumentSchema.index({ uploadedBy: 1, createdAt: -1 });
medicalDocumentSchema.index({ sharedWithDoctors: 1, createdAt: -1 });

export const MedicalDocument = mongoose.model<IMedicalDocument>('MedicalDocument', medicalDocumentSchema);
