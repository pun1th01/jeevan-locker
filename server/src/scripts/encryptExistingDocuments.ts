/**
 * Encrypts legacy plaintext vault files in place. Idempotent and resumable: re-run it until it reports
 * nothing left to do. Run ONE instance at a time.
 *
 *   npm run migrate:encrypt              encrypt every document that has no `encryption` yet
 *   npm run migrate:encrypt -- --dry-run report what would happen, change nothing
 *   npm run migrate:encrypt -- --verify  after migrating, decrypt every encrypted file and compare its
 *                                        plaintext SHA-256 with documentHash
 *
 * Per document without `encryption` (see docs/ENCRYPTION.md for the crash matrix):
 *   0. sweep  uploads/*.enc.tmp                       leftovers of a crash mid-write
 *   1. if <name>.enc exists          -> delete it     orphan from a crash before the DB switch-over: its
 *                                                     wrapped key never reached the row, so it is
 *                                                     unrecoverable by design — re-encrypt
 *   2. if <name> (plaintext) missing -> report, skip  never invent data
 *   3. if documentHash is set and the file's SHA-256 differs -> report, skip
 *                                                     the bytes changed since upload; encrypting them
 *                                                     would launder a tampered or replaced file
 *   4. encrypt <name> -> <name>.enc.tmp ; flush ; rename -> <name>.enc         (atomic publish)
 *   5. ONE conditional updateOne({ _id, encryption: {$exists:false} }, { $set: { storedFileName,
 *      filePath, encryption, plaintextSize, documentHash if absent } })         (atomic switch-over)
 *   6. unlink <name>                                                            (plaintext last)
 * For documents WITH `encryption`: unlink a leftover plaintext sibling (crash between 5 and 6). This
 * recovery pass runs BEFORE the pending loop, so a run that dies mid-loop still cleaned up the last one.
 *
 * MIGRATE_CRASH_AFTER=encrypt|update|unlink makes the process exit(99) right after that step — a test hook
 * to exercise the crash matrix with a real process death. Never set it in production.
 *
 * Connects straight to MONGO_URI (the in-memory dev database is bypassed on purpose, like create:admin).
 */
import { readdir, stat, unlink } from 'fs/promises';
import path from 'path';
import mongoose from 'mongoose';
import { env } from '../config/env';
import { UPLOAD_DIRECTORY, getStoredDocumentPath } from '../middleware/upload.middleware';
import { MedicalDocument, type IMedicalDocument } from '../models/MedicalDocument';
import { ENCRYPTED_FILE_SUFFIX, encryptFileToVault, hashPlaintextFile, verifyEncryptedFile } from '../services/documentCrypto.service';
import { SHA_256 } from '../utils/documentHash.util';

type CrashPoint = 'encrypt' | 'update' | 'unlink';

const CRASH_EXIT_CODE = 99;

interface Options {
  dryRun: boolean;
  verify: boolean;
}

interface Summary {
  encrypted: number;
  alreadyEncrypted: number;
  wouldEncrypt: number;
  orphansRemoved: number;
  tempsRemoved: number;
  leftoverPlaintextRemoved: number;
  missingPlaintext: number;
  hashMismatch: number;
  invalidName: number;
  conflicts: number;
  verifiedOk: number;
  verifiedMismatch: number;
  verifyErrors: number;
}

const parseOptions = (argv: string[]): Options => {
  const options: Options = { dryRun: false, verify: false };

  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--verify') options.verify = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
};

const crashPoint = ((): CrashPoint | null => {
  const value = process.env.MIGRATE_CRASH_AFTER;
  return value === 'encrypt' || value === 'update' || value === 'unlink' ? value : null;
})();

const crashIfRequested = (point: CrashPoint) => {
  if (crashPoint === point) {
    console.log(`[migrate] MIGRATE_CRASH_AFTER=${point}: simulating a crash now`);
    process.exit(CRASH_EXIT_CODE);
  }
};

const exists = async (filePath: string) => {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
};

const removeIfPresent = async (filePath: string) => {
  try {
    await unlink(filePath);
    return true;
  } catch {
    return false;
  }
};

/** Same rule as the controller: a stored name must be a bare file name inside the upload directory. */
const isSafeStoredName = (storedFileName: string) => path.basename(storedFileName) === storedFileName && storedFileName.length > 0;

const label = (document: IMedicalDocument) => `${document._id.toString()} (${document.storedFileName})`;

const sweepTempFiles = async (summary: Summary, options: Options) => {
  for (const name of await readdir(UPLOAD_DIRECTORY)) {
    if (name.endsWith(`${ENCRYPTED_FILE_SUFFIX}.tmp`)) {
      console.log(`[migrate] ${options.dryRun ? 'would remove' : 'removing'} partial temp file ${name}`);
      if (!options.dryRun) await unlink(path.join(UPLOAD_DIRECTORY, name));
      summary.tempsRemoved += 1;
    }
  }
};

const migrateDocument = async (document: IMedicalDocument, summary: Summary, options: Options) => {
  if (!isSafeStoredName(document.storedFileName)) {
    console.log(`[migrate] SKIP ${label(document)}: stored file name is not a bare file name`);
    summary.invalidName += 1;
    return;
  }

  const plaintextPath = path.join(UPLOAD_DIRECTORY, document.storedFileName);
  const encryptedName = `${document.storedFileName}${ENCRYPTED_FILE_SUFFIX}`;
  const encryptedPath = path.join(UPLOAD_DIRECTORY, encryptedName);

  if (await exists(encryptedPath)) {
    // Orphan: encrypted before the row was switched, so its wrapped DEK is gone. Redo from the plaintext.
    console.log(`[migrate] ${options.dryRun ? 'would remove' : 'removing'} orphan ${encryptedName} (no matching key on the row)`);
    if (!options.dryRun) await unlink(encryptedPath);
    summary.orphansRemoved += 1;
  }

  if (!(await exists(plaintextPath))) {
    console.log(`[migrate] SKIP ${label(document)}: plaintext file is missing`);
    summary.missingPlaintext += 1;
    return;
  }

  if (document.documentHash) {
    const currentHash = await hashPlaintextFile(plaintextPath);

    if (currentHash.toLowerCase() !== document.documentHash.toLowerCase()) {
      console.log(
        `[migrate] SKIP ${label(document)}: SHA-256 of the file (${currentHash.slice(0, 12)}…) does not match documentHash (${document.documentHash.slice(0, 12)}…) — bytes changed since upload; refusing to encrypt`
      );
      summary.hashMismatch += 1;
      return;
    }
  }

  if (options.dryRun) {
    console.log(`[migrate] would encrypt ${label(document)}`);
    summary.wouldEncrypt += 1;
    return;
  }

  const encrypted = await encryptFileToVault({
    sourcePath: plaintextPath,
    targetDirectory: UPLOAD_DIRECTORY,
    baseFileName: document.storedFileName,
    documentId: document._id.toString(),
  });
  crashIfRequested('encrypt');

  const result = await MedicalDocument.updateOne(
    { _id: document._id, encryption: { $exists: false } },
    {
      $set: {
        storedFileName: encrypted.storedFileName,
        filePath: getStoredDocumentPath(encrypted.storedFileName),
        encryption: encrypted.encryption,
        plaintextSize: encrypted.plaintextSize,
        ...(document.documentHash ? {} : { documentHash: encrypted.sha256, hashAlgorithm: SHA_256 }),
      },
    }
  );

  if (result.matchedCount === 0) {
    // Another process switched this row first. Its file is on disk under the same name; ours may have
    // overwritten it. Do not touch the plaintext — the operator must re-run with a single instance.
    console.log(`[migrate] CONFLICT ${label(document)}: row was switched by another process; plaintext kept`);
    summary.conflicts += 1;
    return;
  }

  crashIfRequested('update');

  await unlink(plaintextPath);
  crashIfRequested('unlink');

  console.log(`[migrate] encrypted ${label(document)} -> ${encrypted.storedFileName}`);
  summary.encrypted += 1;
};

const removeLeftoverPlaintext = async (document: IMedicalDocument, summary: Summary, options: Options) => {
  if (!document.storedFileName.endsWith(ENCRYPTED_FILE_SUFFIX) || !isSafeStoredName(document.storedFileName)) {
    return;
  }

  const plaintextPath = path.join(UPLOAD_DIRECTORY, document.storedFileName.slice(0, -ENCRYPTED_FILE_SUFFIX.length));

  if (await exists(plaintextPath)) {
    console.log(`[migrate] ${options.dryRun ? 'would remove' : 'removing'} leftover plaintext for ${label(document)}`);
    if (!options.dryRun) await removeIfPresent(plaintextPath);
    summary.leftoverPlaintextRemoved += 1;
  }
};

const verifyDocument = async (document: IMedicalDocument, summary: Summary) => {
  if (!document.encryption || !isSafeStoredName(document.storedFileName)) {
    return;
  }

  try {
    const { sha256 } = await verifyEncryptedFile(path.join(UPLOAD_DIRECTORY, document.storedFileName), document.encryption, document._id.toString());

    if (document.documentHash && sha256.toLowerCase() !== document.documentHash.toLowerCase()) {
      console.log(`[verify] MISMATCH ${label(document)}: decrypted SHA-256 ${sha256.slice(0, 12)}… != documentHash ${document.documentHash.slice(0, 12)}…`);
      summary.verifiedMismatch += 1;
      return;
    }

    summary.verifiedOk += 1;
  } catch (error) {
    console.log(`[verify] ERROR ${label(document)}: ${error instanceof Error ? error.message : String(error)}`);
    summary.verifyErrors += 1;
  }
};

const run = async () => {
  const options = parseOptions(process.argv.slice(2));
  const summary: Summary = {
    encrypted: 0, alreadyEncrypted: 0, wouldEncrypt: 0, orphansRemoved: 0, tempsRemoved: 0, leftoverPlaintextRemoved: 0,
    missingPlaintext: 0, hashMismatch: 0, invalidName: 0, conflicts: 0, verifiedOk: 0, verifiedMismatch: 0, verifyErrors: 0,
  };

  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 5000 });
  const { host, port, name } = mongoose.connection;
  console.log(`[migrate] connected to ${host}:${port}/${name} (direct MONGO_URI); master key id "${env.documentMasterKeyId}"${options.dryRun ? '; DRY RUN' : ''}`);

  // Recovery first, new work second: a run that dies mid-loop must still have cleaned up after the last one.
  await sweepTempFiles(summary, options);

  const previouslyEncrypted = await MedicalDocument.find({ encryption: { $exists: true } });
  summary.alreadyEncrypted = previouslyEncrypted.length;

  for (const document of previouslyEncrypted) {
    await removeLeftoverPlaintext(document, summary, options);
  }

  const pending = await MedicalDocument.find({ encryption: { $exists: false } }).sort({ createdAt: 1 });
  console.log(`[migrate] ${pending.length} document(s) without encryption`);

  for (const document of pending) {
    await migrateDocument(document, summary, options);
  }

  if (options.verify) {
    for (const document of await MedicalDocument.find({ encryption: { $exists: true } })) {
      await verifyDocument(document, summary);
    }
  }

  console.log('[migrate] summary', JSON.stringify(summary));

  const problems = summary.missingPlaintext + summary.hashMismatch + summary.invalidName + summary.conflicts + summary.verifiedMismatch + summary.verifyErrors;

  if (problems > 0) {
    console.log(`[migrate] ${problems} document(s) need attention (see SKIP / CONFLICT / MISMATCH / ERROR lines above)`);
  }

  await mongoose.disconnect();
  process.exit(problems > 0 ? 1 : 0);
};

run().catch(async (error: unknown) => {
  console.error(`[migrate] failed: ${error instanceof Error ? error.message : String(error)}`);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
