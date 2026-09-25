import { randomBytes } from 'crypto';
import fs from 'fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { UPLOAD_DIRECTORY } from '../../src/middleware/upload.middleware';
import { MedicalDocument } from '../../src/models/MedicalDocument';
import type { IUser } from '../../src/models/User';
import { activeLabLink, call, createUser, tokenFor } from '../support/fixtures';

/**
 * Suite 5a — what the upload endpoints accept (claims C40–C41 in docs/TESTING.md). Specification: API_LAB.md §3
 * (the declared MIME type is checked against the file's magic bytes; 5 MB; one file; PDF/JPEG/PNG only) and
 * ENCRYPTION.md §7 (the plaintext temp is removed on every path).
 *
 * Both upload routes are exercised — the patient's and the lab's — because they share the pipeline, and a refusal
 * is only counted as a refusal if nothing is left behind: no file of any kind in this file's uploads directory and
 * no document row.
 */

const MISMATCH = { message: 'File content does not match its declared type' };
const NOT_WHITELISTED = { message: 'Only PDF, JPG, and PNG files are allowed' };
const TOO_LARGE = { message: 'Uploaded file exceeds the 5 MB limit' };
const MAX_BYTES = 5 * 1024 * 1024;

const PDF = Buffer.from('%PDF-1.4\n', 'latin1');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const body = (head: Buffer, size = 2048) => Buffer.concat([head, randomBytes(Math.max(0, size - head.length))]);

let patient: IUser;
let lab: IUser;

beforeAll(async () => {
  patient = await createUser('patient');
  lab = await createUser('lab');
  await activeLabLink(lab, patient);
});

type Route = 'patient upload' | 'lab report';

const send = (route: Route, bytes: Buffer, contentType: string, filename = 'file.bin') =>
  route === 'patient upload'
    ? call('post', '/api/documents/upload', tokenFor(patient)).field('title', 'Probe').attach('file', bytes, { filename, contentType })
    : call('post', '/api/lab/reports', tokenFor(lab)).field('patientId', patient._id.toString()).field('title', 'Probe').attach('file', bytes, { filename, contentType });

/** Runs a request and asserts it left nothing behind: no new file (plaintext or ciphertext) and no new row. */
const leavesNothing = async (request: () => Promise<{ status: number; body: unknown }>) => {
  const filesBefore = new Set(fs.readdirSync(UPLOAD_DIRECTORY));
  const rowsBefore = await MedicalDocument.countDocuments();
  const response = await request();
  expect(fs.readdirSync(UPLOAD_DIRECTORY).filter((name) => !filesBefore.has(name)), 'files left behind').toEqual([]);
  expect(await MedicalDocument.countDocuments(), 'rows left behind').toBe(rowsBefore);
  return response;
};

const ROUTES: Route[] = ['patient upload', 'lab report'];

describe('C40 the bytes must be what the upload claims to be', () => {
  const MISMATCHES: [label: string, bytes: Buffer, declared: string][] = [
    ['PNG bytes declared as a PDF', body(PNG), 'application/pdf'],
    ['PDF bytes declared as a PNG', body(PDF), 'image/png'],
    ['JPEG bytes declared as a PNG', body(JPEG), 'image/png'],
    ['plain text declared as a PDF', Buffer.from('just some text, no signature at all\n'.repeat(40)), 'application/pdf'],
    ['a Windows executable (MZ) declared as a PDF', body(Buffer.from('MZ\x90\x00', 'latin1')), 'application/pdf'],
    ['HTML with a script declared as a JPEG', Buffer.from('<html><script>alert(1)</script></html>'), 'image/jpeg'],
    ['a PDF signature that is not at offset 0', body(Buffer.concat([Buffer.from(' '), PDF])), 'application/pdf'],
    ['an empty file declared as a PDF', Buffer.alloc(0), 'application/pdf'],
  ];

  describe.each(ROUTES)('%s', (route) => {
    it.each(MISMATCHES)('%s: 400, nothing stored', async (_label, bytes, declared) => {
      const response = await leavesNothing(() => send(route, bytes, declared));
      expect(response.status).toBe(400);
      expect(response.body).toEqual(MISMATCH);
    });
  });
});

describe('C41 only whitelisted types, at most 5 MB, one file — refused before anything is kept', () => {
  describe.each(ROUTES)('%s', (route) => {
    it.each(['text/html', 'image/svg+xml', 'application/x-msdownload', 'application/octet-stream', 'image/gif'])(
      'declared type %s is refused',
      async (declared) => {
        const response = await leavesNothing(() => send(route, body(PDF), declared));
        expect(response.status).toBe(400);
        expect(response.body).toEqual(NOT_WHITELISTED);
      }
    );

    it('one byte over 5 MB is refused with 413 and the partial file is removed', async () => {
      const response = await leavesNothing(() => send(route, body(PDF, MAX_BYTES + 1), 'application/pdf', 'big.pdf'));
      expect(response.status).toBe(413);
      expect(response.body).toEqual(TOO_LARGE);
    });

    it('two files in one request are refused', async () => {
      const response = await leavesNothing(() => {
        const pending =
          route === 'patient upload'
            ? call('post', '/api/documents/upload', tokenFor(patient)).field('title', 'Two')
            : call('post', '/api/lab/reports', tokenFor(lab)).field('patientId', patient._id.toString()).field('title', 'Two');
        return pending
          .attach('file', body(PDF), { filename: 'a.pdf', contentType: 'application/pdf' })
          .attach('file', body(PDF), { filename: 'b.pdf', contentType: 'application/pdf' });
      });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ message: 'Document upload failed' });
    });
  });

  // The unambiguous edges of "max 5 MB". A file of EXACTLY 5 MB (5,242,880 bytes) is refused by the multer limit,
  // which reads "max 5 MB" as exclusive; the docs do not say which is meant. That is recorded as an open finding in
  // docs/TESTING.md §5 and deliberately not asserted either way here.
  it('one byte under 5 MB is accepted', async () => {
    const response = await send('patient upload', body(PDF, MAX_BYTES - 1), 'application/pdf', 'just-under.pdf');
    expect(response.status).toBe(201);
  });
});
