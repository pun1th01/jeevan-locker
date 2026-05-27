import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { randomUUID } from 'crypto';

const MAX_UPLOAD_SIZE_BYTES = 5 * 1024 * 1024;
const UPLOAD_DIRECTORY = path.resolve(process.cwd(), 'uploads');

const allowedMimeTypes = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const extensionByMimeType: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
};

fs.mkdirSync(UPLOAD_DIRECTORY, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, UPLOAD_DIRECTORY);
  },
  filename: (_req, file, callback) => {
    const extension = extensionByMimeType[file.mimetype] ?? path.extname(file.originalname).toLowerCase();
    callback(null, `${Date.now()}-${randomUUID()}${extension}`);
  },
});

export const uploadMedicalDocument = multer({
  storage,
  limits: {
    fileSize: MAX_UPLOAD_SIZE_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, callback) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      callback(new Error('Only PDF, JPG, and PNG files are allowed'));
      return;
    }

    callback(null, true);
  },
});

export const getStoredDocumentPath = (storedFileName: string) => path.join('uploads', storedFileName).replace(/\\/g, '/');
