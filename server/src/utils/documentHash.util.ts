import { hashPlaintextFile } from '../services/documentCrypto.service';

export const SHA_256 = 'SHA-256' as const;

/**
 * Streaming SHA-256 of a PLAINTEXT file's bytes — never its file name or database metadata.
 * For encrypted vault files use verifyEncryptedFile from documentCrypto.service, which hashes the
 * decrypted plaintext; hashing a `.enc` container would never match the on-chain record.
 */
export const calculateFileSha256 = (filePath: string): Promise<string> => hashPlaintextFile(filePath);
