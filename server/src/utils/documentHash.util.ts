import { createHash } from 'crypto';
import { readFile } from 'fs/promises';

export const SHA_256 = 'SHA-256' as const;

/** Hashes document bytes, never its file name or database metadata. */
export const calculateFileSha256 = async (filePath: string): Promise<string> => {
  const bytes = await readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
};
