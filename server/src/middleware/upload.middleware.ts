import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { randomUUID } from 'crypto';

/**
 * The largest accepted upload, INCLUSIVE: a file of exactly 5 MB (5,242,880 bytes) is accepted and one byte more is
 * refused with 413. The client's check (DocumentUploadModal: `file.size > 5 MB` is the only rejection) uses the same
 * boundary, so a file the UI approves is never refused here.
 */
export const MAX_UPLOAD_SIZE_BYTES = 5 * 1024 * 1024;
export const UPLOAD_DIRECTORY = path.resolve(process.cwd(), 'uploads');

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
    // busboy reports the limit the moment a file REACHES `fileSize` bytes — it cannot know whether more follow — so
    // the configured value is one byte above the largest file we accept.
    fileSize: MAX_UPLOAD_SIZE_BYTES + 1,
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
