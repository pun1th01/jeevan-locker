import { open } from 'fs/promises';
import type { MedicalDocumentMimeType } from '../models/MedicalDocument';

/**
 * Magic-byte signatures for the upload whitelist. The declared multipart MIME type is client-controlled,
 * so it is only ever compared against what the bytes on disk actually say.
 */
const FILE_SIGNATURES: ReadonlyArray<{ mimeType: MedicalDocumentMimeType; bytes: readonly number[] }> = [
  { mimeType: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { mimeType: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }, // \x89PNG\r\n\x1a\n
  { mimeType: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] }, // SOI + first marker prefix
];

const LONGEST_SIGNATURE = Math.max(...FILE_SIGNATURES.map((signature) => signature.bytes.length));

/** Reads only the leading bytes of the file and returns the whitelisted type they identify, or null. */
export const detectDocumentMimeType = async (filePath: string): Promise<MedicalDocumentMimeType | null> => {
  const handle = await open(filePath, 'r');

  try {
    const header = Buffer.alloc(LONGEST_SIGNATURE);
    const { bytesRead } = await handle.read(header, 0, LONGEST_SIGNATURE, 0);
    const match = FILE_SIGNATURES.find(
      (signature) => bytesRead >= signature.bytes.length && signature.bytes.every((byte, index) => header[index] === byte)
    );

    return match?.mimeType ?? null;
  } finally {
    await handle.close();
  }
};
