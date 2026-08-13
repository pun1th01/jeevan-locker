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
  documentHash?: string;
  hashAlgorithm?: 'SHA-256';
  blockchainDocumentId?: string;
  blockchainTxHash?: string;
  blockchainRegisteredAt?: Date;
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
    documentHash: {
      type: String,
      trim: true,
      match: [/^[a-f0-9]{64}$/i, 'Document hash must be a SHA-256 hex digest'],
    },
    hashAlgorithm: {
      type: String,
      enum: ['SHA-256'],
    },
    blockchainDocumentId: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
    },
    blockchainTxHash: {
      type: String,
      trim: true,
    },
    blockchainRegisteredAt: Date,
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

medicalDocumentSchema.index({ uploadedBy: 1, createdAt: -1 });
medicalDocumentSchema.index({ sharedWithDoctors: 1, createdAt: -1 });

export const MedicalDocument = mongoose.model<IMedicalDocument>('MedicalDocument', medicalDocumentSchema);
