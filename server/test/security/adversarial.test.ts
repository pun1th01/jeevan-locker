import fs from 'fs';
import net from 'net';
import type { AddressInfo } from 'net';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app';
import { UPLOAD_DIRECTORY } from '../../src/middleware/upload.middleware';
import { MedicalDocument } from '../../src/models/MedicalDocument';
import { User, type IUser } from '../../src/models/User';
import {
  activeLabLink,
  approvedConsent,
  call,
  createUser,
  idOf,
  samplePdf,
  tokenFor,
  uniqueSuffix,
  uploadDocument,
  type HttpMethod,
} from '../support/fixtures';

/**
 * Suite 8 — the final security pass (claim C62 in docs/TESTING.md, findings in §5).
 *
 * Every role attacked every write route with type-confused, injection-shaped and oversized input, and every id route
 * with ids that are not ids; hostile file names went through upload and back out through view and download. The
 * other suites already cover object-level authorization route by route. This one pins what the pass found: a client's
 * mistake is always a clean 4xx (never a 5xx, never a stack trace), and a document whose name is not ASCII can still
 * be opened.
 */

let patient: IUser;
let doctor: IUser;
let lab: IUser;
let admin: IUser;
let documentId: string;
let consentId: string;
let linkId: string;

beforeAll(async () => {
  patient = await createUser('patient');
  doctor = await createUser('doctor');
  lab = await createUser('lab');
  admin = await createUser('admin');
  documentId = (await uploadDocument(patient)).id;
  consentId = (await approvedConsent(doctor, patient, documentId)).id;
  linkId = (await activeLabLink(lab, patient)).id;
});

/** Each write route, called by a role allowed to reach its handler. Real ids, so the handler gets past its lookups. */
const WRITE_ROUTES = (): Array<[HttpMethod, string, IUser]> => [
  ['post', '/api/documents/upload', patient],
  ['patch', `/api/documents/${documentId}/share`, patient],
  ['patch', `/api/documents/${documentId}/unshare`, patient],
  ['patch', `/api/documents/${documentId}/metadata`, patient],
  ['post', '/api/consents/request', doctor],
  ['patch', `/api/consents/${consentId}/revoke`, patient],
  ['post', '/api/emergency-access', doctor],
  ['post', '/api/lab-links', lab],
  ['patch', `/api/lab-links/${linkId}/approve`, patient],
  ['post', '/api/lab/reports', lab],
  ['post', '/api/admin/users', admin],
  ['patch', `/api/admin/users/${idOf(doctor)}/verify`, admin],
  ['post', '/api/appointments/slots', doctor],
  ['patch', `/api/notifications/${new Types.ObjectId().toString()}/read`, patient],
];

const HOSTILE_BODIES: unknown[] = [
  [],
  { doctorId: { $ne: null }, patientId: { $gt: '' }, documentId: { $gt: '' }, purpose: { $ne: '' }, reason: ['x'], query: { $ne: null }, title: ['t'], description: { a: 1 } },
  { title: 't'.repeat(10_000), description: 'd'.repeat(10_000), purpose: 'p'.repeat(10_000), reason: 'r'.repeat(10_000), query: 'q'.repeat(10_000) },
  { startsAt: { $gt: '' }, durationMinutes: '30', email: { $gt: '' }, password: { $gt: '' } },
  { name: '<script>alert(1)</script>', email: 'x@y.z', password: 'short', role: 'lab', organisation: { $ne: 1 } },
  JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}'),
];

describe('C62 a client’s mistake is a clean 4xx, never a 5xx or a stack trace; a non-ASCII file name still opens', () => {
  it('type-confused, injection-shaped, oversized and prototype-polluting bodies on every write route: never a 5xx, no stack, no pollution', async () => {
    const failures: string[] = [];

    for (const [method, url, actor] of WRITE_ROUTES()) {
      for (const [index, body] of HOSTILE_BODIES.entries()) {
        const response = await call(method, url, tokenFor(actor)).send(body as object);
        if (response.status >= 500 || 'stack' in (response.body ?? {})) failures.push(`${method.toUpperCase()} ${url} body#${index} -> ${response.status}`);
      }
    }

    expect(failures).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('ids that are not ids, on every kind of id route: a 400 or 404, never a 5xx', async () => {
    const failures: string[] = [];

    for (const id of ['not-an-id', '..%2F..%2Fetc', '%00', '123', 'zzzzzzzzzzzzzzzzzzzzzzzz']) {
      for (const [method, url, actor] of [
        ['get', `/api/documents/${id}`, patient],
        ['get', `/api/documents/${id}/view`, patient],
        ['get', `/api/documents/${id}/integrity`, admin],
        ['patch', `/api/documents/${id}/metadata`, patient],
        ['delete', `/api/documents/${id}`, patient],
        ['patch', `/api/consents/${id}/approve`, patient],
        ['delete', `/api/emergency-access/${id}`, patient],
        ['patch', `/api/lab-links/${id}/reject`, patient],
        ['get', `/api/admin/anchors/${id}/verify`, admin],
        ['patch', `/api/notifications/${id}/read`, patient],
        ['patch', `/api/appointments/slots/${id}/book`, patient],
      ] as Array<[HttpMethod, string, IUser]>) {
        const response = await call(method, url, tokenFor(actor)).send({});
        if (![400, 404].includes(response.status)) failures.push(`${method.toUpperCase()} ${url} -> ${response.status}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('malformed JSON is a plain 400 and an oversized body a plain 413 — the message only, no parser internals, no stack', async () => {
    const broken = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"email":');
    expect(broken.status).toBe(400);
    expect(broken.body).toEqual({ message: 'Request body is not valid JSON' });

    const oversized = await call('patch', `/api/documents/${documentId}/metadata`, tokenFor(patient))
      .set('Content-Type', 'application/json')
      .send(`{"title":"${'x'.repeat(1_100_000)}"}`);
    expect(oversized.status).toBe(413);
    expect(oversized.body).toEqual({ message: 'Request body is too large' });

    // Any other client error that reaches the generic handler (here body-parser's 415) carries no stack either.
    const charset = await request(app).post('/api/auth/login').set('Content-Type', 'application/json; charset=koi8-r').send('{}');
    expect(charset.status).toBe(415);
    expect(charset.body).not.toHaveProperty('stack');
    expect(Object.keys(charset.body)).toEqual(['message']);
  });

  // The error handler's Mongoose ValidationError mapping has no HTTP trigger left (every controller validates first),
  // so this pins the shape clients actually receive from a field-validation refusal (TESTING.md §4 records the rest).
  it('a field-validation refusal answers one plain sentence per field, never the submitted value or validator internals', async () => {
    const response = await call('post', '/api/auth/register').send({
      name: 'A',
      email: `short-name-${uniqueSuffix()}@test.jeevanlocker.dev`,
      password: 'Long-enough-password-1',
      role: 'patient',
    });
    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Validation failed');
    for (const value of Object.values(response.body.errors ?? {})) expect(typeof value).toBe('string');
    expect(JSON.stringify(response.body)).not.toMatch(/ValidatorError|Path `|"value"|"properties"/);
  });

  it('an upload title over 120 characters is refused by name, and leaves no file and no row behind', async () => {
    const before = fs.readdirSync(UPLOAD_DIRECTORY).length;
    const rowsBefore = await MedicalDocument.countDocuments({ uploadedBy: patient._id });

    const response = await call('post', '/api/documents/upload', tokenFor(patient))
      .field('title', 't'.repeat(121))
      .attach('file', samplePdf(), { filename: 'r.pdf', contentType: 'application/pdf' });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: 'Document title must be 1 to 120 characters' });
    expect(fs.readdirSync(UPLOAD_DIRECTORY)).toHaveLength(before);
    expect(await MedicalDocument.countDocuments({ uploadedBy: patient._id })).toBe(rowsBefore);
  });

  describe('file names outside ASCII', () => {
    let port = 0;
    let server: ReturnType<typeof app.listen>;

    beforeAll(() => {
      server = app.listen(0);
      port = (server.address() as AddressInfo).port;
    });
    afterAll(() => server.close());

    /** The raw response head as bytes on the wire: what a browser parses, before any client library is lenient. */
    const rawHead = (path: string, token: string) =>
      new Promise<Buffer>((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`);
        });
        const chunks: Buffer[] = [];
        socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        socket.on('end', () => {
          const all = Buffer.concat(chunks);
          resolve(all.subarray(0, all.indexOf('\r\n\r\n')));
        });
        socket.on('error', reject);
      });

    const dispositionOf = (head: Buffer) =>
      head
        .toString('latin1')
        .split('\r\n')
        .find((line) => /^content-disposition:/i.test(line))!
        .replace(/^content-disposition:\s*/i, '');

    it('a Devanagari name opens on /view and /download: the header is printable ASCII, and filename* carries the exact name', async () => {
      const name = 'रक्त जाँच रिपोर्ट.pdf';
      const upload = await call('post', '/api/documents/upload', tokenFor(patient))
        .field('title', 'Blood test')
        .attach('file', samplePdf(), { filename: name, contentType: 'application/pdf' });
      expect(upload.status).toBe(201);
      expect(upload.body.document.originalFileName).toBe(name);

      for (const [suffix, kind] of [
        ['/view', 'inline'],
        ['/download', 'attachment'],
      ] as const) {
        const head = await rawHead(`/api/documents/${upload.body.document.id as string}${suffix}`, tokenFor(patient));
        expect(head.toString('latin1').split('\r\n')[0]).toBe('HTTP/1.1 200 OK');
        // Every byte of the response head is printable ASCII (or the CRLF separators): nothing a browser rejects.
        expect([...head].filter((byte) => byte !== 13 && byte !== 10 && (byte < 0x20 || byte > 0x7e))).toEqual([]);

        const disposition = dispositionOf(head);
        expect(disposition.startsWith(`${kind}; filename="`)).toBe(true);
        const encoded = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1];
        expect(encoded && decodeURIComponent(encoded)).toBe(name);
      }

      // Through a normal client as well: the request parses and the body is the file.
      const download = await call('get', `/api/documents/${upload.body.document.id as string}/download`, tokenFor(patient)).buffer(true);
      expect(download.status).toBe(200);
    });

    it('quotes, semicolons, non-ASCII and path segments cannot break out of the header — the same on every platform', async () => {
      const id = (await uploadDocument(patient)).id;
      await MedicalDocument.updateOne({ _id: id }, { $set: { originalFileName: 'dir/sub\\a"b;cé.pdf' } });

      const disposition = dispositionOf(await rawHead(`/api/documents/${id}/download`, tokenFor(patient)));
      expect(disposition).toBe(`attachment; filename="a_b;c_.pdf"; filename*=UTF-8''a%22b%3Bc%C3%A9.pdf`);
    });
  });
});

/** Unused here but kept honest: the fixture users exist, so a role refusal is not mistaken for a missing account. */
afterAll(async () => {
  expect(await User.countDocuments({ _id: { $in: [patient._id, doctor._id, lab._id, admin._id] } })).toBe(4);
});
