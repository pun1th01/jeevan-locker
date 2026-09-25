import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Contract, JsonRpcProvider } from 'ethers';
import { Types } from 'mongoose';
import type { Response } from 'supertest';
import { beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { UPLOAD_DIRECTORY } from '../../src/middleware/upload.middleware';
import { AccessLog, type AuditAction } from '../../src/models/AccessLog';
import { MedicalDocument, type IMedicalDocument } from '../../src/models/MedicalDocument';
import type { IUser } from '../../src/models/User';
import { registerDocumentHash } from '../../src/services/documentRegistry.service';
import { call, createUser, tokenFor, uniqueSuffix } from '../support/fixtures';
import { freePort } from '../support/hardhat';

/**
 * Suite 2 — encryption at rest (claims C18–C25 in docs/TESTING.md). The specification is docs/ENCRYPTION.md.
 *
 * Nothing here mocks the vault: files are uploaded over HTTP, encrypted to this file's own uploads directory,
 * tampered with at the byte level on disk, and read back through the real endpoints. The chain the hashes are
 * compared against is the run's real Hardhat node, read directly with ethers as well as through the server.
 */

const INTEGRITY_FAILED = { message: 'Document file failed integrity check' };
const KEY_UNAVAILABLE = { message: 'Document encryption key is unavailable' };
const CONTAINER_OVERHEAD = 32; // magic(4) + IV(12) + tag(16)

type Mime = 'application/pdf' | 'image/png' | 'image/jpeg';
const SIGNATURE: Record<Mime, Buffer> = {
  'application/pdf': Buffer.from('%PDF-1.4\n', 'latin1'),
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
};
const EXTENSION: Record<Mime, string> = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' };

/** A file of the given type: its real magic bytes, a searchable marker, then random filler. */
const makeFile = (mime: Mime, size = 4096) => {
  const marker = Buffer.from(`JEEVANLOCKER-PLAINTEXT-MARKER-${uniqueSuffix()}`, 'latin1');
  const filler = randomBytes(Math.max(0, size - SIGNATURE[mime].length - marker.length));
  return { bytes: Buffer.concat([SIGNATURE[mime], marker, filler]), marker };
};

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

let patient: IUser;
let token: string;

beforeAll(async () => {
  patient = await createUser('patient');
  token = tokenFor(patient);
});

const upload = async (bytes: Buffer, mime: Mime = 'application/pdf', title = `Vault ${uniqueSuffix()}`) => {
  const response = await call('post', '/api/documents/upload', token)
    .field('title', title)
    .attach('file', bytes, { filename: `upload.${EXTENSION[mime]}`, contentType: mime });
  if (response.status !== 201) throw new Error(`upload failed: ${response.status} ${JSON.stringify(response.body)}`);
  const id = (response.body as { document: { id: string } }).document.id;
  return { id, row: (await MedicalDocument.findById(id))! };
};

const filePathOf = (row: IMedicalDocument) => path.join(UPLOAD_DIRECTORY, row.storedFileName);

/** Reads any response — a streamed file or a JSON error — as raw bytes. */
const fetchRaw = async (url: string): Promise<{ status: number; headers: Record<string, string>; bytes: Buffer }> => {
  const response: Response = await call('get', url, token)
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    });
  return { status: response.status, headers: response.headers as Record<string, string>, bytes: response.body as Buffer };
};

const auditCount = (documentId: string, action: AuditAction) => AccessLog.countDocuments({ targetDocument: new Types.ObjectId(documentId), action });
const failureRows = (documentId: string) =>
  AccessLog.find({ targetDocument: new Types.ObjectId(documentId), action: 'DOCUMENT_INTEGRITY_FAILED' }).sort({ timestamp: 1 }).lean();

describe('C18 round trip: what is served is exactly what was uploaded', () => {
  it.each([
    ['PDF', 'application/pdf', 4096],
    ['PNG', 'image/png', 4096],
    ['JPEG', 'image/jpeg', 4096],
    ['4.5 MB PDF (many stream chunks)', 'application/pdf', 4.5 * 1024 * 1024],
  ] as const)('%s: /view and /download return the uploaded bytes, byte for byte', async (_label, mime, size) => {
    const { bytes } = makeFile(mime, size);
    const { id } = await upload(bytes, mime);

    for (const suffix of ['/view', '/download']) {
      const served = await fetchRaw(`/api/documents/${id}${suffix}`);
      expect(served.status, suffix).toBe(200);
      expect(served.headers['content-type'], suffix).toBe(mime);
      expect(Number(served.headers['content-length']), suffix).toBe(bytes.length);
      expect(served.bytes.equals(bytes), `${suffix} bytes differ`).toBe(true);
    }
  });
});

describe('C19 at rest: the disk holds only authenticated ciphertext, never the plaintext', () => {
  it('the stored file is a JLE1 container of plaintext + 32 bytes that does not contain the plaintext', async () => {
    const before = new Set(fs.readdirSync(UPLOAD_DIRECTORY));
    const { bytes, marker } = makeFile('application/pdf');
    const { row, id } = await upload(bytes);

    const added = fs.readdirSync(UPLOAD_DIRECTORY).filter((name) => !before.has(name));
    expect(added, 'exactly one new file, and it is the ciphertext — the plaintext temp is gone').toEqual([row.storedFileName]);
    expect(row.storedFileName).toMatch(/\.enc$/);

    const stored = fs.readFileSync(filePathOf(row));
    expect(stored.subarray(0, 4).toString('latin1')).toBe('JLE1');
    expect(stored.length).toBe(bytes.length + CONTAINER_OVERHEAD);
    expect(stored.indexOf(marker)).toBe(-1);
    expect(stored.indexOf(SIGNATURE['application/pdf'])).toBe(-1);

    expect(row.encryption).toMatchObject({ version: 1, algorithm: 'AES-256-GCM', keyId: 'test' });
    expect(Buffer.from(row.encryption!.wrappedKey, 'base64')).toHaveLength(12 + 16 + 32);
    expect(row.plaintextSize).toBe(bytes.length);
    expect((await call('get', `/api/documents/${id}`, token)).body.document.encryptedAtRest).toBe(true);
  });

  it('identical plaintext uploaded twice shares no IV, ciphertext or wrapped key (a fresh key per file)', async () => {
    const { bytes } = makeFile('application/pdf');
    const first = await upload(bytes);
    const second = await upload(bytes);
    const [a, b] = [fs.readFileSync(filePathOf(first.row)), fs.readFileSync(filePathOf(second.row))];

    expect(a.subarray(4, 16).equals(b.subarray(4, 16)), 'IV reused').toBe(false);
    expect(a.subarray(16).equals(b.subarray(16)), 'ciphertext identical').toBe(false);
    expect(first.row.encryption!.wrappedKey).not.toBe(second.row.encryption!.wrappedKey);
    expect(first.row.documentHash).toBe(second.row.documentHash); // same plaintext, same attested hash
  });
});

describe('C20 the chain attests the plaintext: encryption does not change what is verified', () => {
  it('documentHash, the on-chain record and /integrity all equal SHA-256 of the uploaded bytes', async () => {
    const { bytes } = makeFile('application/pdf');
    const { id, row } = await upload(bytes);
    const expected = sha256(bytes);

    expect(row.documentHash).toBe(expected);

    // Read the registry directly, independent of the server's own chain code.
    const { rpcUrl, documentRegistryAddress } = inject('chain');
    const provider = new JsonRpcProvider(rpcUrl);
    try {
      const registry = new Contract(documentRegistryAddress, ['function getDocumentHash(string documentId) view returns (bytes32)'], provider);
      expect(await registry.getDocumentHash(id)).toBe(`0x${expected}`);
    } finally {
      provider.destroy();
    }

    const integrity = await call('get', `/api/documents/${id}/integrity`, token);
    expect(integrity.status).toBe(200);
    expect(integrity.body).toMatchObject({ verified: true, currentHash: expected, blockchainHash: expected });
  });
});

type Tamper = (file: Buffer) => Buffer;
const flipByteAt = (offsetFromStart: (file: Buffer) => number): Tamper => (file) => {
  const copy = Buffer.from(file);
  const offset = offsetFromStart(copy);
  copy[offset] ^= 0x01;
  return copy;
};

const TAMPERS: [label: string, tamper: Tamper | 'plaintext', reason: 'TAMPERED' | 'BAD_CONTAINER'][] = [
  ['one ciphertext bit flipped', flipByteAt((file) => Math.floor(file.length / 2)), 'TAMPERED'],
  ['one tag bit flipped', flipByteAt((file) => file.length - 1), 'TAMPERED'],
  ['one IV bit flipped', flipByteAt(() => 6), 'TAMPERED'],
  ['truncated by one byte', (file) => file.subarray(0, file.length - 1), 'TAMPERED'],
  ['one byte appended', (file) => Buffer.concat([file, Buffer.from([0])]), 'TAMPERED'],
  ['truncated below the container size', (file) => file.subarray(0, 20), 'BAD_CONTAINER'],
  ['magic corrupted', flipByteAt(() => 0), 'BAD_CONTAINER'],
  ['replaced by the original plaintext', 'plaintext', 'BAD_CONTAINER'],
];

describe('C21 a modified file is never served: 409 on every read path, before any byte leaves', () => {
  it.each(TAMPERS)('%s', async (_label, tamper, reason) => {
    const { bytes, marker } = makeFile('application/pdf');
    const { id, row } = await upload(bytes);
    const stored = fs.readFileSync(filePathOf(row));
    fs.writeFileSync(filePathOf(row), tamper === 'plaintext' ? bytes : tamper(stored));

    const successAuditsBefore = (await auditCount(id, 'DOCUMENT_PREVIEW')) + (await auditCount(id, 'DOCUMENT_DOWNLOAD')) + (await auditCount(id, 'INTEGRITY_VERIFIED'));

    for (const [suffix, operation] of [['/view', 'view'], ['/download', 'download'], ['/integrity', 'integrity']] as const) {
      const before = (await failureRows(id)).length;
      const served = await fetchRaw(`/api/documents/${id}${suffix}`);

      expect(served.status, suffix).toBe(409);
      expect(served.headers['content-type'], suffix).toMatch(/^application\/json/);
      expect(served.headers['content-disposition'], suffix).toBeUndefined();
      expect(JSON.parse(served.bytes.toString('utf8')), suffix).toEqual(INTEGRITY_FAILED);
      expect(served.bytes.indexOf(marker), `${suffix} leaked plaintext`).toBe(-1);

      // Exactly one DOCUMENT_INTEGRITY_FAILED row per failed request, carrying why and on which operation.
      const rows = await failureRows(id);
      expect(rows.length, `${suffix} audit rows`).toBe(before + 1);
      expect(rows[rows.length - 1].metadata).toMatchObject({ reason, operation, documentId: id, storedFileName: row.storedFileName, keyId: 'test' });
      expect(rows[rows.length - 1].userId.toString()).toBe(patient._id.toString());
    }

    // A failure is never also recorded as a successful read.
    expect((await auditCount(id, 'DOCUMENT_PREVIEW')) + (await auditCount(id, 'DOCUMENT_DOWNLOAD')) + (await auditCount(id, 'INTEGRITY_VERIFIED'))).toBe(
      successAuditsBefore
    );
  });

  it('an untouched file writes no DOCUMENT_INTEGRITY_FAILED row on any read path', async () => {
    const { id } = await upload(makeFile('application/pdf').bytes);
    for (const suffix of ['/view', '/download', '/integrity']) {
      expect((await call('get', `/api/documents/${id}${suffix}`, token)).status, suffix).toBe(200);
    }
    expect(await failureRows(id)).toHaveLength(0);
  });
});

describe('C22 each file is bound to its own row: swapped files and swapped keys do not decrypt', () => {
  const readAll = async (...ids: string[]) =>
    Promise.all(ids.map(async (id) => (await fetchRaw(`/api/documents/${id}/view`)).status));

  it('swapping two documents’ files on disk makes both fail', async () => {
    const a = await upload(makeFile('application/pdf').bytes);
    const b = await upload(makeFile('application/pdf').bytes);
    const [fileA, fileB] = [fs.readFileSync(filePathOf(a.row)), fs.readFileSync(filePathOf(b.row))];

    fs.writeFileSync(filePathOf(a.row), fileB);
    fs.writeFileSync(filePathOf(b.row), fileA);
    expect(await readAll(a.id, b.id)).toEqual([409, 409]);

    fs.writeFileSync(filePathOf(a.row), fileA);
    fs.writeFileSync(filePathOf(b.row), fileB);
    expect(await readAll(a.id, b.id), 'control: restored files serve again').toEqual([200, 200]);
  });

  it('swapping two rows’ wrapped keys makes both fail', async () => {
    const a = await upload(makeFile('application/pdf').bytes);
    const b = await upload(makeFile('application/pdf').bytes);
    const [keyA, keyB] = [a.row.encryption!.wrappedKey, b.row.encryption!.wrappedKey];

    await MedicalDocument.updateOne({ _id: a.row._id }, { $set: { 'encryption.wrappedKey': keyB } });
    await MedicalDocument.updateOne({ _id: b.row._id }, { $set: { 'encryption.wrappedKey': keyA } });
    expect(await readAll(a.id, b.id)).toEqual([409, 409]);
    expect((await failureRows(a.id)).slice(-1)[0].metadata).toMatchObject({ reason: 'TAMPERED' });

    await MedicalDocument.updateOne({ _id: a.row._id }, { $set: { 'encryption.wrappedKey': keyA } });
    await MedicalDocument.updateOne({ _id: b.row._id }, { $set: { 'encryption.wrappedKey': keyB } });
    expect(await readAll(a.id, b.id), 'control: restored keys serve again').toEqual([200, 200]);
  });

  it('transplanting a whole file + key pair onto another row fails on that row and nowhere else', async () => {
    const a = await upload(makeFile('application/pdf').bytes);
    const b = await upload(makeFile('application/pdf').bytes);

    // Row B now holds A's ciphertext and A's wrapped key: a self-consistent pair that decrypts perfectly under
    // A's id, moved onto a row with a different id. (storedFileName is unique, so the bytes are copied instead.)
    fs.copyFileSync(filePathOf(a.row), filePathOf(b.row));
    await MedicalDocument.updateOne({ _id: b.row._id }, { $set: { 'encryption.wrappedKey': a.row.encryption!.wrappedKey, plaintextSize: a.row.plaintextSize } });
    expect(await readAll(a.id, b.id)).toEqual([200, 409]);
  });
});

describe('C23 the master key is required, exact, and the only way in', () => {
  it('a row wrapped under a key label the server does not hold is refused with 503 and audited', async () => {
    const { id, row } = await upload(makeFile('application/pdf').bytes);
    await MedicalDocument.updateOne({ _id: row._id }, { $set: { 'encryption.keyId': 'retired' } });

    for (const suffix of ['/view', '/download', '/integrity']) {
      const response = await call('get', `/api/documents/${id}${suffix}`, token);
      expect(response.status, suffix).toBe(503);
      expect(response.body, suffix).toEqual(KEY_UNAVAILABLE);
    }
    const rows = await failureRows(id);
    expect(rows).toHaveLength(3);
    expect(rows.map((entry) => entry.metadata?.reason)).toEqual(['KEY_UNAVAILABLE', 'KEY_UNAVAILABLE', 'KEY_UNAVAILABLE']);
  });

  it('the files and the database without the master key decrypt nothing', async () => {
    const { bytes } = makeFile('application/pdf');
    const { id, row } = await upload(bytes);

    // The same vault code, loaded fresh under a different 32-byte master key with the same label.
    vi.resetModules();
    vi.stubEnv('DOCUMENT_MASTER_KEY', randomBytes(32).toString('base64'));
    const otherServer = await import('../../src/services/documentCrypto.service');
    await expect(otherServer.verifyEncryptedFile(filePathOf(row), row.encryption!, id)).rejects.toMatchObject({ name: 'VaultFileError', code: 'TAMPERED' });

    // Control: the real key (still loaded by this file's app) authenticates the same file and yields the plaintext hash.
    vi.unstubAllEnvs();
    vi.resetModules();
    const sameServer = await import('../../src/services/documentCrypto.service');
    expect((await sameServer.verifyEncryptedFile(filePathOf(row), row.encryption!, id)).sha256).toBe(sha256(bytes));
  });

  it.each([
    ['missing', '', /Missing required environment variable: DOCUMENT_MASTER_KEY/],
    ['16 bytes', randomBytes(16).toString('base64'), /exactly 32 bytes/],
    ['33 bytes', randomBytes(33).toString('base64'), /exactly 32 bytes/],
  ])('the server refuses to start with a master key that is %s', async (_label, value, message) => {
    vi.resetModules();
    vi.stubEnv('DOCUMENT_MASTER_KEY', value);
    await expect(import('../../src/config/env')).rejects.toThrow(message);
  });
});

describe('C24 legacy plaintext rows keep working, and the chain still catches changes to them', () => {
  const createLegacyDocument = async (bytes: Buffer) => {
    const documentId = new Types.ObjectId();
    const storedFileName = `${Date.now()}-legacy-${uniqueSuffix()}.pdf`;
    fs.writeFileSync(path.join(UPLOAD_DIRECTORY, storedFileName), bytes);
    const registration = await registerDocumentHash(documentId.toString(), sha256(bytes));

    await MedicalDocument.create({
      _id: documentId,
      title: 'Pre-encryption record',
      originalFileName: 'legacy.pdf',
      storedFileName,
      filePath: `uploads/${storedFileName}`,
      mimeType: 'application/pdf',
      uploadedBy: patient._id,
      sharedWithDoctors: [],
      documentHash: sha256(bytes),
      blockchainDocumentId: documentId.toString(),
      blockchainTxHash: registration.transactionHash,
      blockchainRegisteredAt: registration.registeredAt,
    });
    return { id: documentId.toString(), path: path.join(UPLOAD_DIRECTORY, storedFileName) };
  };

  it('is served byte for byte, reported as not encrypted, and verifies against the chain', async () => {
    const { bytes } = makeFile('application/pdf');
    const legacy = await createLegacyDocument(bytes);

    const served = await fetchRaw(`/api/documents/${legacy.id}/view`);
    expect(served.status).toBe(200);
    expect(served.bytes.equals(bytes)).toBe(true);
    expect((await call('get', `/api/documents/${legacy.id}`, token)).body.document.encryptedAtRest).toBe(false);
    expect((await call('get', `/api/documents/${legacy.id}/integrity`, token)).body).toMatchObject({ verified: true });
  });

  it('a changed legacy file is caught by the integrity check (verified: false), since there is no GCM tag to catch it', async () => {
    const { bytes } = makeFile('application/pdf');
    const legacy = await createLegacyDocument(bytes);
    const changed = Buffer.from(bytes);
    changed[changed.length - 1] ^= 0x01;
    fs.writeFileSync(legacy.path, changed);

    const integrity = await call('get', `/api/documents/${legacy.id}/integrity`, token);
    expect(integrity.status).toBe(200);
    expect(integrity.body).toMatchObject({ verified: false, currentHash: sha256(changed), blockchainHash: sha256(bytes) });
  });
});

describe('C25 plaintext never outlives the upload request, whatever fails', () => {
  const snapshot = () => new Set(fs.readdirSync(UPLOAD_DIRECTORY));
  const newFiles = (before: Set<string>) => fs.readdirSync(UPLOAD_DIRECTORY).filter((name) => !before.has(name));

  it('a validation failure (no title) leaves no file and no row', async () => {
    const before = snapshot();
    const rowsBefore = await MedicalDocument.countDocuments();
    const response = await call('post', '/api/documents/upload', token).attach('file', makeFile('application/pdf').bytes, {
      filename: 'x.pdf',
      contentType: 'application/pdf',
    });

    expect(response.status).toBe(400);
    expect(newFiles(before)).toEqual([]);
    expect(await MedicalDocument.countDocuments()).toBe(rowsBefore);
  });

  it('a chain failure after encryption leaves no plaintext, no ciphertext and no row', async () => {
    const before = snapshot();
    const rowsBefore = await MedicalDocument.countDocuments();

    // A real outage: nothing listens on this port. The upload has already been encrypted when the chain call fails.
    vi.stubEnv('BLOCKCHAIN_RPC_URL', `http://127.0.0.1:${await freePort()}`);
    const response = await call('post', '/api/documents/upload', token)
      .field('title', 'During an outage')
      .attach('file', makeFile('application/pdf').bytes, { filename: 'x.pdf', contentType: 'application/pdf' });

    // ENCRYPTION.md §7 promises the cleanup, not a status; see TESTING.md §3.3 for the status observed.
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.body.document).toBeUndefined();
    expect(newFiles(before)).toEqual([]);
    expect(await MedicalDocument.countDocuments()).toBe(rowsBefore);

    // Control: with the chain back, the same upload succeeds.
    vi.unstubAllEnvs();
    await upload(makeFile('application/pdf').bytes);
  });
});
