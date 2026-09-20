import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { open, rename, stat, unlink } from 'fs/promises';
import path from 'path';
import { Transform, Writable, type Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { env } from '../config/env';

/**
 * Encryption at rest for vault files. AES-256-GCM with a random per-file data key (DEK), wrapped by the
 * master key (KEK) from DOCUMENT_MASTER_KEY. The DEK exists in memory only while a file is being written
 * or served; only its wrapped form is stored, on the MedicalDocument row.
 *
 * On-disk container (self-contained, streaming-friendly):
 *   offset 0   4 bytes   magic "JLE1"
 *   offset 4   12 bytes  IV (random per file; never reused because the DEK is per file too)
 *   offset 16  N bytes   ciphertext (same length as the plaintext)
 *   end-16     16 bytes  GCM auth tag (written last)
 * Both the file and the wrapped DEK use the document's ObjectId string as GCM associated data, so a
 * ciphertext or a wrapped key moved onto another row fails authentication.
 *
 * GCM caveat: Node's Decipher emits plaintext before it verifies the tag at final(). Serving therefore
 * makes two streaming passes — verifyEncryptedFile (throws on tampering, yields the plaintext SHA-256)
 * and then openDecryptedStream — so a tampered file never reaches a client with a 200.
 * Design notes and key rotation: docs/ENCRYPTION.md.
 */

export const ENCRYPTION_ALGORITHM = 'AES-256-GCM' as const;
export const CONTAINER_VERSION = 1 as const;
export const ENCRYPTED_FILE_SUFFIX = '.enc';

const CIPHER = 'aes-256-gcm';
const MAGIC = Buffer.from('JLE1', 'latin1');
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const DEK_LENGTH = 32;
const HEADER_LENGTH = MAGIC.length + IV_LENGTH; // 16
const CONTAINER_OVERHEAD = HEADER_LENGTH + TAG_LENGTH; // 32

export interface DocumentEncryption {
  version: typeof CONTAINER_VERSION;
  algorithm: typeof ENCRYPTION_ALGORITHM;
  /** Which master key wrapped the DEK. */
  keyId: string;
  /** base64 of iv(12) || tag(16) || ciphertext(32) of the DEK, AAD = documentId. */
  wrappedKey: string;
}

export type VaultFileErrorCode = 'TAMPERED' | 'BAD_CONTAINER' | 'KEY_UNAVAILABLE';

/** Raised when an encrypted file cannot be authenticated or its key cannot be unwrapped. */
export class VaultFileError extends Error {
  constructor(
    readonly code: VaultFileErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'VaultFileError';
  }
}

const associatedData = (documentId: string) => Buffer.from(documentId, 'utf8');

const isAuthError = (error: unknown) =>
  error instanceof Error && /unable to authenticate|auth tag|Unsupported state/i.test(error.message);

// ---------- data-key wrapping ----------

export const generateDataKey = (): Buffer => randomBytes(DEK_LENGTH);

export const wrapDataKey = (dataKey: Buffer, documentId: string): DocumentEncryption => {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(CIPHER, env.documentMasterKey, iv);
  cipher.setAAD(associatedData(documentId));
  const wrapped = Buffer.concat([cipher.update(dataKey), cipher.final()]);

  return {
    version: CONTAINER_VERSION,
    algorithm: ENCRYPTION_ALGORITHM,
    keyId: env.documentMasterKeyId,
    wrappedKey: Buffer.concat([iv, cipher.getAuthTag(), wrapped]).toString('base64'),
  };
};

export const unwrapDataKey = (encryption: DocumentEncryption, documentId: string): Buffer => {
  if (encryption.keyId !== env.documentMasterKeyId) {
    throw new VaultFileError(
      'KEY_UNAVAILABLE',
      `Document was wrapped with master key "${encryption.keyId}" but the server holds "${env.documentMasterKeyId}"`
    );
  }

  const blob = Buffer.from(encryption.wrappedKey, 'base64');

  if (blob.length !== IV_LENGTH + TAG_LENGTH + DEK_LENGTH) {
    throw new VaultFileError('BAD_CONTAINER', 'Wrapped data key has an unexpected length');
  }

  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const wrapped = blob.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(CIPHER, env.documentMasterKey, iv);
  decipher.setAAD(associatedData(documentId));
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(wrapped), decipher.final()]);
  } catch (error) {
    if (isAuthError(error)) {
      throw new VaultFileError('TAMPERED', 'Wrapped data key failed authentication');
    }

    throw error;
  }
};

// ---------- encrypt ----------

export interface EncryptFileInput {
  /** Plaintext file to encrypt. Left in place; the caller decides when to unlink it. */
  sourcePath: string;
  /** Directory the encrypted file is written to. */
  targetDirectory: string;
  /** Name of the plaintext file; the encrypted file is `${baseFileName}.enc`. */
  baseFileName: string;
  /** ObjectId string of the row this file will belong to — used as associated data. */
  documentId: string;
}

export interface EncryptFileResult {
  storedFileName: string;
  plaintextSize: number;
  /** SHA-256 hex of the PLAINTEXT — the value that goes on-chain. */
  sha256: string;
  encryption: DocumentEncryption;
}

/**
 * Streams `sourcePath` through a SHA-256 tee and an AES-256-GCM cipher into `${baseFileName}.enc.tmp`,
 * appends the tag, flushes to disk, then atomically renames to `${baseFileName}.enc`. On any failure the
 * temp file is removed and the error rethrown; the target is never left half-written.
 */
export const encryptFileToVault = async ({ sourcePath, targetDirectory, baseFileName, documentId }: EncryptFileInput): Promise<EncryptFileResult> => {
  const storedFileName = `${baseFileName}${ENCRYPTED_FILE_SUFFIX}`;
  const targetPath = path.join(targetDirectory, storedFileName);
  const tempPath = `${targetPath}.tmp`;
  const dataKey = generateDataKey();
  // Wrap first: the wrapped form is what the row stores, and the raw key is zeroed as soon as the file is written.
  const encryption = wrapDataKey(dataKey, documentId);
  const iv = randomBytes(IV_LENGTH);
  const hash = createHash('sha256');
  let plaintextSize = 0;

  const tee = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      plaintextSize += chunk.length;
      callback(null, chunk);
    },
  });
  const cipher = createCipheriv(CIPHER, dataKey, iv);
  cipher.setAAD(associatedData(documentId));
  // The tag only exists after the cipher has finalised, i.e. after everything upstream has ended.
  const tagAppender = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      callback(null, chunk);
    },
    flush(callback) {
      callback(null, cipher.getAuthTag());
    },
  });

  try {
    const output = createWriteStream(tempPath, { flags: 'wx', flush: true });
    output.write(Buffer.concat([MAGIC, iv]));
    await pipeline(createReadStream(sourcePath), tee, cipher, tagAppender, output);
    await rename(tempPath, targetPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  } finally {
    dataKey.fill(0);
  }

  return { storedFileName, plaintextSize, sha256: hash.digest('hex'), encryption };
};

// ---------- decrypt ----------

interface ContainerInfo {
  iv: Buffer;
  tag: Buffer;
  fileSize: number;
  plaintextSize: number;
}

const readContainerInfo = async (filePath: string): Promise<ContainerInfo> => {
  const { size } = await stat(filePath);

  if (size < CONTAINER_OVERHEAD) {
    throw new VaultFileError('BAD_CONTAINER', 'Encrypted file is too short to be a vault container');
  }

  const handle = await open(filePath, 'r');

  try {
    const header = Buffer.alloc(HEADER_LENGTH);
    const tag = Buffer.alloc(TAG_LENGTH);
    await handle.read(header, 0, HEADER_LENGTH, 0);
    await handle.read(tag, 0, TAG_LENGTH, size - TAG_LENGTH);

    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new VaultFileError('BAD_CONTAINER', 'Encrypted file does not start with the vault magic');
    }

    return { iv: header.subarray(MAGIC.length), tag, fileSize: size, plaintextSize: size - CONTAINER_OVERHEAD };
  } finally {
    await handle.close();
  }
};

const createDecipherFor = (info: ContainerInfo, dataKey: Buffer, documentId: string) => {
  const decipher = createDecipheriv(CIPHER, dataKey, info.iv);
  decipher.setAAD(associatedData(documentId));
  decipher.setAuthTag(info.tag);
  return decipher;
};

const ciphertextStream = (filePath: string, info: ContainerInfo): Readable =>
  createReadStream(filePath, { start: HEADER_LENGTH, end: info.fileSize - TAG_LENGTH - 1 });

export interface VerifiedFile {
  /** SHA-256 hex of the decrypted plaintext. */
  sha256: string;
  plaintextSize: number;
}

/**
 * Pass 1: decrypts the whole file into a hash sink without buffering it. Throws VaultFileError('TAMPERED')
 * if the tag or associated data do not authenticate. Its result is also the integrity-check hash.
 */
export const verifyEncryptedFile = async (filePath: string, encryption: DocumentEncryption, documentId: string): Promise<VerifiedFile> => {
  const info = await readContainerInfo(filePath);
  const dataKey = unwrapDataKey(encryption, documentId);
  const hash = createHash('sha256');
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback();
    },
  });

  try {
    await pipeline(ciphertextStream(filePath, info), createDecipherFor(info, dataKey, documentId), sink);
  } catch (error) {
    if (isAuthError(error)) {
      throw new VaultFileError('TAMPERED', 'Encrypted file failed authentication');
    }

    throw error;
  } finally {
    dataKey.fill(0);
  }

  return { sha256: hash.digest('hex'), plaintextSize: info.plaintextSize };
};

/**
 * Pass 2: a readable of decrypted plaintext for piping to a response. Call verifyEncryptedFile first;
 * this stream still fails at the end if the file changed in between, and the caller must handle 'error'.
 */
export const openDecryptedStream = async (filePath: string, encryption: DocumentEncryption, documentId: string): Promise<Readable> => {
  const info = await readContainerInfo(filePath);
  const dataKey = unwrapDataKey(encryption, documentId);
  const decipher = createDecipherFor(info, dataKey, documentId);
  dataKey.fill(0);
  const source = ciphertextStream(filePath, info);
  source.on('error', (error) => decipher.destroy(error));
  return source.pipe(decipher);
};

/** Streaming SHA-256 of a plaintext (legacy, unencrypted) file. */
export const hashPlaintextFile = async (filePath: string): Promise<string> => {
  const hash = createHash('sha256');
  await pipeline(
    createReadStream(filePath),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback();
      },
    })
  );
  return hash.digest('hex');
};
