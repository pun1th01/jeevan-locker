import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';
import { Types } from 'mongoose';
import { connectDB, disconnectDB } from '../config/db';
import { env } from '../config/env';
import { AccessLog, type AuditAction } from '../models/AccessLog';
import { MedicalDocument, type IMedicalDocument, type MedicalDocumentMimeType } from '../models/MedicalDocument';
import { User, type IUser } from '../models/User';
import { getStoredDocumentPath, UPLOAD_DIRECTORY } from '../middleware/upload.middleware';
import type { UserRole } from '../types/user.types';

interface DemoAccount {
  name: string;
  email: string;
  password: string;
  role: UserRole;
}

interface DemoDocumentSeed {
  key: string;
  ownerEmail: string;
  title: string;
  originalFileName: string;
  storedFileName: string;
  mimeType: MedicalDocumentMimeType;
  createdAt: Date;
  sharedWithDoctorEmails: string[];
  asset: DemoAsset;
}

type DemoAsset =
  | { kind: 'pdf'; subtitle: string; sections: string[] }
  | { kind: 'png'; variant: 'xray' | 'vaccination' }
  | { kind: 'jpeg'; variant: 'mri' };

interface DemoAuditSeed {
  userEmail: string;
  action: AuditAction;
  documentKey?: string;
  timestamp: Date;
  ipAddress: string;
}

const demoAccounts: DemoAccount[] = [
  {
    name: 'Demo Admin',
    email: 'admin@jeevanlocker.dev',
    password: 'Admin123!',
    role: 'admin',
  },
  {
    name: 'Dr. Meera Iyer',
    email: 'doctor@jeevanlocker.dev',
    password: 'Doctor123!',
    role: 'doctor',
  },
  {
    name: 'Dr. Rahul Menon',
    email: 'doctor2@jeevanlocker.dev',
    password: 'Doctor123!',
    role: 'doctor',
  },
  {
    name: 'Aarav Sharma',
    email: 'patient@jeevanlocker.dev',
    password: 'Patient123!',
    role: 'patient',
  },
  {
    name: 'Priya Nair',
    email: 'patient2@jeevanlocker.dev',
    password: 'Patient123!',
    role: 'patient',
  },
];

const date = (value: string) => new Date(value);

const demoDocuments: DemoDocumentSeed[] = [
  {
    key: 'aarav-prescription',
    ownerEmail: 'patient@jeevanlocker.dev',
    title: 'Cardiology Prescription - Hypertension Review',
    originalFileName: 'cardiology-prescription-may-2026.pdf',
    storedFileName: 'demo-aarav-cardiology-prescription-2026-05-02.pdf',
    mimeType: 'application/pdf',
    createdAt: date('2026-05-02T09:35:00+05:30'),
    sharedWithDoctorEmails: ['doctor@jeevanlocker.dev'],
    asset: {
      kind: 'pdf',
      subtitle: 'Outpatient prescription summary',
      sections: [
        'Patient: Aarav Sharma | Age: 42 | UHID: JLN-PT-1001',
        'Consultant: Dr. Meera Iyer, MD Cardiology',
        'Diagnosis: Stage 1 hypertension with lifestyle risk factors.',
        'Medication: Telmisartan 40 mg once daily after breakfast.',
        'Advice: BP log twice daily, reduce sodium intake, 30 minute walk five days weekly.',
        'Follow-up: Review with blood pressure chart after 21 days.',
      ],
    },
  },
  {
    key: 'aarav-blood-report',
    ownerEmail: 'patient@jeevanlocker.dev',
    title: 'Comprehensive Blood Test Report',
    originalFileName: 'thyrocare-blood-panel-2026-05-07.pdf',
    storedFileName: 'demo-aarav-blood-test-2026-05-07.pdf',
    mimeType: 'application/pdf',
    createdAt: date('2026-05-07T08:15:00+05:30'),
    sharedWithDoctorEmails: ['doctor@jeevanlocker.dev'],
    asset: {
      kind: 'pdf',
      subtitle: 'Laboratory report - fasting sample',
      sections: [
        'Patient: Aarav Sharma | Sample ID: LAB-26-0507-8842',
        'Hemoglobin: 14.1 g/dL | WBC: 7,200 cells/uL | Platelets: 2.6 lakh/uL',
        'Fasting glucose: 101 mg/dL | HbA1c: 5.8%',
        'Total cholesterol: 198 mg/dL | LDL: 124 mg/dL | HDL: 46 mg/dL',
        'Creatinine: 0.92 mg/dL | eGFR: 96 mL/min/1.73m2',
        'Doctor note: Borderline glycemic control; correlate clinically.',
      ],
    },
  },
  {
    key: 'aarav-mri',
    ownerEmail: 'patient@jeevanlocker.dev',
    title: 'MRI Brain Scan - Follow-up Imaging',
    originalFileName: 'mri-brain-axial-slice-2026-05-11.jpg',
    storedFileName: 'demo-aarav-mri-brain-2026-05-11.jpg',
    mimeType: 'image/jpeg',
    createdAt: date('2026-05-11T16:20:00+05:30'),
    sharedWithDoctorEmails: ['doctor@jeevanlocker.dev'],
    asset: { kind: 'jpeg', variant: 'mri' },
  },
  {
    key: 'aarav-xray',
    ownerEmail: 'patient@jeevanlocker.dev',
    title: 'Chest X-Ray Image - PA View',
    originalFileName: 'chest-xray-pa-view-2026-05-14.png',
    storedFileName: 'demo-aarav-chest-xray-2026-05-14.png',
    mimeType: 'image/png',
    createdAt: date('2026-05-14T11:10:00+05:30'),
    sharedWithDoctorEmails: ['doctor@jeevanlocker.dev'],
    asset: { kind: 'png', variant: 'xray' },
  },
  {
    key: 'aarav-insurance',
    ownerEmail: 'patient@jeevanlocker.dev',
    title: 'Health Insurance Policy PDF',
    originalFileName: 'star-health-policy-2026.pdf',
    storedFileName: 'demo-aarav-insurance-policy-2026.pdf',
    mimeType: 'application/pdf',
    createdAt: date('2026-05-17T14:45:00+05:30'),
    sharedWithDoctorEmails: [],
    asset: {
      kind: 'pdf',
      subtitle: 'Insurance policy summary',
      sections: [
        'Policy holder: Aarav Sharma | Policy No: SHL-IND-2026-4472',
        'Provider: Star Health Demo Assurance',
        'Coverage: Family floater health plan | Sum insured: INR 8,00,000',
        'Cashless network: Active across listed partner hospitals.',
        'Renewal due: 16 May 2027',
        'Privacy note: Kept private in JeevanLocker; not shared with doctors by default.',
      ],
    },
  },
  {
    key: 'aarav-vaccination',
    ownerEmail: 'patient@jeevanlocker.dev',
    title: 'Vaccination Record - Adult Immunization',
    originalFileName: 'adult-vaccination-record-2026.pdf',
    storedFileName: 'demo-aarav-vaccination-record-2026.pdf',
    mimeType: 'application/pdf',
    createdAt: date('2026-05-21T10:05:00+05:30'),
    sharedWithDoctorEmails: ['doctor2@jeevanlocker.dev'],
    asset: {
      kind: 'pdf',
      subtitle: 'Immunization certificate',
      sections: [
        'Patient: Aarav Sharma | Record ID: VAC-ARV-2026-118',
        'Influenza vaccine: 18 Apr 2026 | Batch: FLU26-A91',
        'Tdap booster: 18 Apr 2026 | Batch: TD26-552',
        'COVID booster: Completed prior schedule; no adverse reaction recorded.',
        'Next reminder: Influenza booster after 12 months.',
      ],
    },
  },
  {
    key: 'priya-allergy-panel',
    ownerEmail: 'patient2@jeevanlocker.dev',
    title: 'Allergy Panel Report - Seasonal Rhinitis',
    originalFileName: 'allergy-panel-priya-nair-2026.pdf',
    storedFileName: 'demo-priya-allergy-panel-2026-05-18.pdf',
    mimeType: 'application/pdf',
    createdAt: date('2026-05-18T12:20:00+05:30'),
    sharedWithDoctorEmails: ['doctor@jeevanlocker.dev'],
    asset: {
      kind: 'pdf',
      subtitle: 'Immunology lab report',
      sections: [
        'Patient: Priya Nair | Age: 35 | UHID: JLN-PT-1002',
        'Dust mite IgE: Moderate positive | Pollen mix IgE: Mild positive',
        'Food allergen screen: No clinically significant elevation detected.',
        'Recommendation: Symptom diary and review with treating physician.',
      ],
    },
  },
  {
    key: 'priya-ultrasound',
    ownerEmail: 'patient2@jeevanlocker.dev',
    title: 'Abdominal Ultrasound Summary',
    originalFileName: 'abdominal-ultrasound-summary-2026.pdf',
    storedFileName: 'demo-priya-ultrasound-summary-2026-05-23.pdf',
    mimeType: 'application/pdf',
    createdAt: date('2026-05-23T15:30:00+05:30'),
    sharedWithDoctorEmails: [],
    asset: {
      kind: 'pdf',
      subtitle: 'Radiology impression',
      sections: [
        'Patient: Priya Nair | Accession: RAD-26-0523-0901',
        'Liver, gall bladder, spleen, pancreas, and kidneys: No focal abnormality seen.',
        'Impression: No acute sonographic abnormality.',
        'Report status: Finalized by radiology consultant.',
      ],
    },
  },
];

const demoAudits: DemoAuditSeed[] = [
  {
    userEmail: 'admin@jeevanlocker.dev',
    action: 'USER_LOGIN',
    timestamp: date('2026-05-01T08:40:00+05:30'),
    ipAddress: '103.88.42.19',
  },
  {
    userEmail: 'patient@jeevanlocker.dev',
    action: 'USER_LOGIN',
    timestamp: date('2026-05-02T09:28:00+05:30'),
    ipAddress: '49.36.118.20',
  },
  {
    userEmail: 'patient@jeevanlocker.dev',
    action: 'DOCUMENT_UPLOAD',
    documentKey: 'aarav-prescription',
    timestamp: date('2026-05-02T09:37:00+05:30'),
    ipAddress: '49.36.118.20',
  },
  {
    userEmail: 'patient@jeevanlocker.dev',
    action: 'DOCUMENT_SHARE',
    documentKey: 'aarav-prescription',
    timestamp: date('2026-05-02T09:42:00+05:30'),
    ipAddress: '49.36.118.20',
  },
  {
    userEmail: 'patient@jeevanlocker.dev',
    action: 'DOCUMENT_UPLOAD',
    documentKey: 'aarav-blood-report',
    timestamp: date('2026-05-07T08:20:00+05:30'),
    ipAddress: '49.36.118.20',
  },
  {
    userEmail: 'doctor@jeevanlocker.dev',
    action: 'USER_LOGIN',
    timestamp: date('2026-05-07T18:05:00+05:30'),
    ipAddress: '122.172.81.14',
  },
  {
    userEmail: 'doctor@jeevanlocker.dev',
    action: 'DOCUMENT_PREVIEW',
    documentKey: 'aarav-blood-report',
    timestamp: date('2026-05-07T18:08:00+05:30'),
    ipAddress: '122.172.81.14',
  },
  {
    userEmail: 'patient@jeevanlocker.dev',
    action: 'DOCUMENT_UPLOAD',
    documentKey: 'aarav-mri',
    timestamp: date('2026-05-11T16:24:00+05:30'),
    ipAddress: '49.36.118.20',
  },
  {
    userEmail: 'patient@jeevanlocker.dev',
    action: 'DOCUMENT_SHARE',
    documentKey: 'aarav-mri',
    timestamp: date('2026-05-11T16:28:00+05:30'),
    ipAddress: '49.36.118.20',
  },
  {
    userEmail: 'doctor@jeevanlocker.dev',
    action: 'DOCUMENT_ACCESS',
    documentKey: 'aarav-mri',
    timestamp: date('2026-05-12T10:12:00+05:30'),
    ipAddress: '122.172.81.14',
  },
  {
    userEmail: 'doctor@jeevanlocker.dev',
    action: 'DOCUMENT_DOWNLOAD',
    documentKey: 'aarav-mri',
    timestamp: date('2026-05-12T10:15:00+05:30'),
    ipAddress: '122.172.81.14',
  },
  {
    userEmail: 'patient@jeevanlocker.dev',
    action: 'DOCUMENT_UPLOAD',
    documentKey: 'aarav-xray',
    timestamp: date('2026-05-14T11:14:00+05:30'),
    ipAddress: '49.36.118.20',
  },
  {
    userEmail: 'patient@jeevanlocker.dev',
    action: 'DOCUMENT_UPLOAD',
    documentKey: 'aarav-insurance',
    timestamp: date('2026-05-17T14:49:00+05:30'),
    ipAddress: '49.36.118.20',
  },
  {
    userEmail: 'patient2@jeevanlocker.dev',
    action: 'USER_LOGIN',
    timestamp: date('2026-05-18T12:10:00+05:30'),
    ipAddress: '103.92.55.104',
  },
  {
    userEmail: 'patient2@jeevanlocker.dev',
    action: 'DOCUMENT_UPLOAD',
    documentKey: 'priya-allergy-panel',
    timestamp: date('2026-05-18T12:23:00+05:30'),
    ipAddress: '103.92.55.104',
  },
  {
    userEmail: 'patient2@jeevanlocker.dev',
    action: 'DOCUMENT_SHARE',
    documentKey: 'priya-allergy-panel',
    timestamp: date('2026-05-18T12:26:00+05:30'),
    ipAddress: '103.92.55.104',
  },
  {
    userEmail: 'patient@jeevanlocker.dev',
    action: 'DOCUMENT_UPLOAD',
    documentKey: 'aarav-vaccination',
    timestamp: date('2026-05-21T10:08:00+05:30'),
    ipAddress: '49.36.118.20',
  },
  {
    userEmail: 'doctor2@jeevanlocker.dev',
    action: 'DOCUMENT_PREVIEW',
    documentKey: 'aarav-vaccination',
    timestamp: date('2026-05-21T17:35:00+05:30'),
    ipAddress: '117.213.45.60',
  },
  {
    userEmail: 'patient2@jeevanlocker.dev',
    action: 'DOCUMENT_UPLOAD',
    documentKey: 'priya-ultrasound',
    timestamp: date('2026-05-23T15:34:00+05:30'),
    ipAddress: '103.92.55.104',
  },
  {
    userEmail: 'admin@jeevanlocker.dev',
    action: 'USER_LOGIN',
    timestamp: date('2026-05-25T09:05:00+05:30'),
    ipAddress: '103.88.42.19',
  },
  {
    userEmail: 'admin@jeevanlocker.dev',
    action: 'DOCUMENT_ACCESS',
    documentKey: 'aarav-insurance',
    timestamp: date('2026-05-25T09:11:00+05:30'),
    ipAddress: '103.88.42.19',
  },
];

const crcTable = new Uint32Array(256).map((_, tableIndex) => {
  let crc = tableIndex;

  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }

  return crc >>> 0;
});

const escapePdfText = (value: string) => value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

const writeUInt16 = (value: number) => Buffer.from([(value >> 8) & 255, value & 255]);

const marker = (code: number, payload?: Buffer) => {
  if (!payload) {
    return Buffer.from([0xff, code]);
  }

  return Buffer.concat([Buffer.from([0xff, code]), writeUInt16(payload.length + 2), payload]);
};

const createPdfBuffer = (title: string, subtitle: string, sections: string[]): Buffer => {
  const lines = [
    'JeevanLocker Medical Record',
    title,
    subtitle,
    '',
    ...sections,
    '',
    'Generated for JeevanLocker IEI demo environment.',
  ];
  const contentLines = ['BT', '/F1 18 Tf', '72 760 Td'];

  lines.forEach((line, index) => {
    if (index === 1) {
      contentLines.push('/F1 14 Tf');
    }

    if (index === 3) {
      contentLines.push('/F1 11 Tf');
    }

    contentLines.push(`(${escapePdfText(line)}) Tj`);
    contentLines.push(index === 0 ? '0 -30 Td' : '0 -20 Td');
  });

  contentLines.push('ET');
  const stream = contentLines.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];

  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf);
};

const crc32 = (buffer: Buffer) => {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type: string, data: Buffer) => {
  const typeBuffer = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  return Buffer.concat([length, typeBuffer, data, crc]);
};

const createPngBuffer = (variant: 'xray' | 'vaccination'): Buffer => {
  const width = 640;
  const height = 420;
  const rows = Buffer.alloc((width * 3 + 1) * height);

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 3 + 1);
    rows[rowOffset] = 0;

    for (let x = 0; x < width; x += 1) {
      const normalizedX = (x - width / 2) / (width / 2);
      const normalizedY = (y - height / 2) / (height / 2);
      const pixelOffset = rowOffset + 1 + x * 3;
      let value = 24 + Math.round(28 * (1 - Math.abs(normalizedX)));

      if (variant === 'xray') {
        const leftLung = (normalizedX + 0.35) ** 2 / 0.13 + normalizedY ** 2 / 0.72;
        const rightLung = (normalizedX - 0.35) ** 2 / 0.13 + normalizedY ** 2 / 0.72;
        const spine = Math.abs(normalizedX) < 0.07 && Math.abs(normalizedY) < 0.86;
        const ribWave = Math.abs(Math.sin((normalizedY + 0.92) * 18) - Math.abs(normalizedX) * 0.95);

        if (leftLung < 1 || rightLung < 1) {
          value += 34;
        }

        if (spine) {
          value += 76;
        }

        if (ribWave < 0.06 && Math.abs(normalizedX) < 0.78 && Math.abs(normalizedY) < 0.86) {
          value += 92;
        }
      } else {
        const card = x > 90 && x < 550 && y > 70 && y < 350;
        const stripe = card && y > 135 && y < 180;
        const rowsPattern = card && x > 135 && x < 500 && y % 46 < 4;

        value = card ? 55 : 16;
        if (stripe) {
          value = 102;
        }
        if (rowsPattern) {
          value = 156;
        }
      }

      const clamped = Math.max(0, Math.min(230, value));
      rows[pixelOffset] = clamped;
      rows[pixelOffset + 1] = variant === 'xray' ? clamped : Math.min(240, clamped + 24);
      rows[pixelOffset + 2] = variant === 'xray' ? clamped : Math.min(250, clamped + 42);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
};

class BitWriter {
  private bytes: number[] = [];
  private currentByte = 0;
  private bitCount = 0;

  write(code: number, length: number) {
    for (let bit = length - 1; bit >= 0; bit -= 1) {
      this.currentByte = (this.currentByte << 1) | ((code >> bit) & 1);
      this.bitCount += 1;

      if (this.bitCount === 8) {
        this.pushByte(this.currentByte);
        this.currentByte = 0;
        this.bitCount = 0;
      }
    }
  }

  flush() {
    if (this.bitCount > 0) {
      const padding = 8 - this.bitCount;
      this.pushByte((this.currentByte << padding) | ((1 << padding) - 1));
    }

    return Buffer.from(this.bytes);
  }

  private pushByte(value: number) {
    this.bytes.push(value & 255);

    if ((value & 255) === 0xff) {
      this.bytes.push(0);
    }
  }
}

const getMagnitudeBits = (value: number, category: number) => {
  if (category === 0) {
    return 0;
  }

  return value >= 0 ? value : value - 1 + (1 << category);
};

const getCategory = (value: number) => {
  const absolute = Math.abs(value);
  return absolute === 0 ? 0 : Math.floor(Math.log2(absolute)) + 1;
};

const createJpegBuffer = (): Buffer => {
  const width = 512;
  const height = 384;
  const quantization = Buffer.alloc(65, 16);
  quantization[0] = 0;
  const dcLengths = Buffer.from([0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const acLengths = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const dcValues = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const acValues = Buffer.from([0]);
  const bitWriter = new BitWriter();
  const dcCodes = Array.from({ length: 12 }, (_, index) => ({ code: index, length: 4 }));
  const acEndOfBlock = { code: 0, length: 1 };
  let previousDc = 0;

  for (let y = 0; y < height; y += 8) {
    for (let x = 0; x < width; x += 8) {
      const normalizedX = (x - width / 2) / (width / 2);
      const normalizedY = (y - height / 2) / (height / 2);
      const ring = Math.sin((normalizedX ** 2 + normalizedY ** 2) * 24);
      const brainShape = normalizedX ** 2 / 0.62 + normalizedY ** 2 / 0.88;
      const midline = Math.abs(normalizedX) < 0.03 ? 24 : 0;
      const tissue = brainShape < 1 ? 116 + Math.round(ring * 22) + midline : 20;
      const quantizedDc = Math.round((tissue - 128) / 2);
      const diff = quantizedDc - previousDc;
      const category = getCategory(diff);
      const dcCode = dcCodes[category];

      bitWriter.write(dcCode.code, dcCode.length);
      bitWriter.write(getMagnitudeBits(diff, category), category);
      bitWriter.write(acEndOfBlock.code, acEndOfBlock.length);
      previousDc = quantizedDc;
    }
  }

  const frameHeader = Buffer.concat([
    Buffer.from([8]),
    writeUInt16(height),
    writeUInt16(width),
    Buffer.from([1, 1, 0x11, 0]),
  ]);
  const scanHeader = Buffer.from([1, 1, 0, 0, 63, 0]);
  const entropy = bitWriter.flush();

  return Buffer.concat([
    marker(0xd8),
    marker(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])),
    marker(0xdb, quantization),
    marker(0xc0, frameHeader),
    marker(0xc4, Buffer.concat([Buffer.from([0]), dcLengths, dcValues])),
    marker(0xc4, Buffer.concat([Buffer.from([0x10]), acLengths, acValues])),
    marker(0xda, scanHeader),
    entropy,
    marker(0xd9),
  ]);
};

const createAssetBuffer = (document: DemoDocumentSeed) => {
  if (document.asset.kind === 'pdf') {
    return createPdfBuffer(document.title, document.asset.subtitle, document.asset.sections);
  }

  if (document.asset.kind === 'png') {
    return createPngBuffer(document.asset.variant);
  }

  return createJpegBuffer();
};

const ensureDemoAccount = async (account: DemoAccount): Promise<IUser> => {
  const existingUser = await User.findOne({ email: account.email }).select('+password');

  if (!existingUser) {
    return User.create({
      name: account.name,
      email: account.email,
      password: account.password,
      role: account.role,
    });
  }

  let changed = false;

  if (existingUser.name !== account.name) {
    existingUser.name = account.name;
    changed = true;
  }

  if (existingUser.role !== account.role) {
    existingUser.role = account.role;
    changed = true;
  }

  if (!(await existingUser.comparePassword(account.password))) {
    existingUser.password = account.password;
    changed = true;
  }

  if (changed) {
    await existingUser.save();
  }

  return existingUser;
};

const ensureDemoDocument = async (
  documentSeed: DemoDocumentSeed,
  userByEmail: Map<string, IUser>
): Promise<IMedicalDocument> => {
  const owner = userByEmail.get(documentSeed.ownerEmail);

  if (!owner) {
    throw new Error(`Missing seeded owner account: ${documentSeed.ownerEmail}`);
  }

  const sharedWithDoctors = documentSeed.sharedWithDoctorEmails
    .map((email) => userByEmail.get(email)?._id)
    .filter((doctorId): doctorId is Types.ObjectId => Boolean(doctorId));
  const fileBuffer = createAssetBuffer(documentSeed);
  const filePath = path.join(UPLOAD_DIRECTORY, documentSeed.storedFileName);

  await fs.mkdir(UPLOAD_DIRECTORY, { recursive: true });
  await fs.writeFile(filePath, fileBuffer);

  const existingDocument = await MedicalDocument.findOne({ storedFileName: documentSeed.storedFileName });
  const documentPayload = {
    title: documentSeed.title,
    originalFileName: documentSeed.originalFileName,
    storedFileName: documentSeed.storedFileName,
    filePath: getStoredDocumentPath(documentSeed.storedFileName),
    mimeType: documentSeed.mimeType,
    uploadedBy: owner._id,
    sharedWithDoctors,
  };

  if (!existingDocument) {
    const createdDocument = await MedicalDocument.create(documentPayload);
    await MedicalDocument.updateOne(
      { _id: createdDocument._id },
      {
        $set: {
          createdAt: documentSeed.createdAt,
          updatedAt: documentSeed.createdAt,
        },
      },
      { timestamps: false }
    );

    return (await MedicalDocument.findById(createdDocument._id)) ?? createdDocument;
  }

  await MedicalDocument.updateOne(
    { _id: existingDocument._id },
    {
      $set: {
        ...documentPayload,
        createdAt: documentSeed.createdAt,
        updatedAt: documentSeed.createdAt,
      },
    },
    { timestamps: false }
  );

  return (await MedicalDocument.findById(existingDocument._id)) ?? existingDocument;
};

const ensureDemoAuditLog = async (
  auditSeed: DemoAuditSeed,
  userByEmail: Map<string, IUser>,
  documentByKey: Map<string, IMedicalDocument>
) => {
  const user = userByEmail.get(auditSeed.userEmail);
  const document = auditSeed.documentKey ? documentByKey.get(auditSeed.documentKey) : null;

  if (!user) {
    throw new Error(`Missing audit user account: ${auditSeed.userEmail}`);
  }

  const targetDocument = document?._id ?? null;
  const exists = await AccessLog.exists({
    userId: user._id,
    action: auditSeed.action,
    targetDocument,
    timestamp: auditSeed.timestamp,
    ipAddress: auditSeed.ipAddress,
  });

  if (exists) {
    return;
  }

  await AccessLog.create({
    userId: user._id,
    action: auditSeed.action,
    targetDocument,
    timestamp: auditSeed.timestamp,
    ipAddress: auditSeed.ipAddress,
  });
};

export const seedDemoUsers = async (): Promise<void> => {
  if (env.nodeEnv !== 'development') {
    return;
  }

  const userByEmail = new Map<string, IUser>();
  const documentByKey = new Map<string, IMedicalDocument>();

  await fs.mkdir(UPLOAD_DIRECTORY, { recursive: true });

  for (const account of demoAccounts) {
    const user = await ensureDemoAccount(account);
    userByEmail.set(account.email, user);
  }

  for (const documentSeed of demoDocuments) {
    const document = await ensureDemoDocument(documentSeed, userByEmail);
    documentByKey.set(documentSeed.key, document);
  }

  for (const auditSeed of demoAudits) {
    await ensureDemoAuditLog(auditSeed, userByEmail, documentByKey);
  }

  console.log(
    `[Dev] Demo environment ready: ${demoAccounts.length} accounts, ${demoDocuments.length} documents, ${demoAudits.length} audit events.`
  );
};

if (require.main === module) {
  connectDB()
    .then(seedDemoUsers)
    .then(disconnectDB)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Unknown seed error';
      console.error(`[Dev] Demo seed failed: ${message}`);
      process.exit(1);
    });
}
