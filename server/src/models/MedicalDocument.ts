import mongoose, { Document, Schema, Types } from 'mongoose';
import type { DocumentEncryption } from '../services/documentCrypto.service';

export type MedicalDocumentMimeType = 'application/pdf' | 'image/jpeg' | 'image/png';

export const TEST_VALUE_FLAGS = ['normal', 'high', 'low', 'critical'] as const;

export type TestValueFlag = (typeof TEST_VALUE_FLAGS)[number];

/**
 * One measured value on a lab report. `flag` is computed server-side at upload from the bounds stored
 * alongside it (see utils/testValues.util.ts), so the reason for a `critical` flag is always auditable.
 */
export interface ITestValue {
  name: string;
  value: number;
  unit: string;
  refLow?: number;
  refHigh?: number;
  criticalLow?: number;
  criticalHigh?: number;
  flag: TestValueFlag;
}

export interface IMedicalDocument extends Document {
  _id: Types.ObjectId;
  title: string;
  originalFileName: string;
  storedFileName: string;
  filePath: string;
  mimeType: MedicalDocumentMimeType;
  /** The patient who owns the document — also for lab reports. */
  uploadedBy: Types.ObjectId;
  sharedWithDoctors: Types.ObjectId[];
  documentHash?: string;
  hashAlgorithm?: 'SHA-256';
  blockchainDocumentId?: string;
  blockchainTxHash?: string;
  blockchainRegisteredAt?: Date;
  /**
   * Encryption-at-rest metadata (server-internal, never serialized). Absent on legacy rows whose file is
   * still plaintext on disk; the migration script (`npm run migrate:encrypt`) fills it in. The DEK is
   * stored only in wrapped form — see services/documentCrypto.service.ts.
   */
  encryption?: DocumentEncryption;
  /** Plaintext byte length, recorded at encryption time so Content-Length needs no arithmetic. */
  plaintextSize?: number;
  // --- Verified lab report fields: all optional, present only when uploadedByLab is set ---
  /** The lab account that issued the report; undefined for patient uploads. */
  uploadedByLab?: Types.ObjectId;
  labName?: string;
  testName?: string;
  nablCertNumber?: string;
  authorizingDoctorName?: string;
  hospitalName?: string;
  reportDate?: Date;
  testValues?: ITestValue[];
  createdAt: Date;
  updatedAt: Date;
}

const REPORT_TEXT_MAX_LENGTH = 120;

const documentEncryptionSchema = new Schema<DocumentEncryption>(
  {
    version: { type: Number, required: true, enum: [1] },
    algorithm: { type: String, required: true, enum: ['AES-256-GCM'] },
    keyId: { type: String, required: true, trim: true },
    wrappedKey: { type: String, required: true },
  },
  { _id: false }
);

const testValueSchema = new Schema<ITestValue>(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    value: { type: Number, required: true },
    unit: { type: String, required: true, trim: true, maxlength: 20 },
    refLow: Number,
    refHigh: Number,
    criticalLow: Number,
    criticalHigh: Number,
    flag: { type: String, enum: TEST_VALUE_FLAGS, required: true },
  },
  { _id: false }
);

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
    encryption: { type: documentEncryptionSchema, default: undefined },
    plaintextSize: { type: Number, min: 0 },
    uploadedByLab: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    labName: { type: String, trim: true, maxlength: REPORT_TEXT_MAX_LENGTH },
    testName: { type: String, trim: true, maxlength: REPORT_TEXT_MAX_LENGTH },
    nablCertNumber: { type: String, trim: true, maxlength: REPORT_TEXT_MAX_LENGTH },
    authorizingDoctorName: { type: String, trim: true, maxlength: REPORT_TEXT_MAX_LENGTH },
    hospitalName: { type: String, trim: true, maxlength: REPORT_TEXT_MAX_LENGTH },
    reportDate: Date,
    testValues: { type: [testValueSchema], default: undefined },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

medicalDocumentSchema.index({ uploadedBy: 1, createdAt: -1 });
medicalDocumentSchema.index({ sharedWithDoctors: 1, createdAt: -1 });
medicalDocumentSchema.index({ uploadedByLab: 1, createdAt: -1 });

export const MedicalDocument = mongoose.model<IMedicalDocument>('MedicalDocument', medicalDocumentSchema);
