import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import { AccessLog, type AuditAction } from '../../src/models/AccessLog';
import { EmergencyAccess } from '../../src/models/EmergencyAccess';
import { MedicalDocument } from '../../src/models/MedicalDocument';
import { User, type IUser } from '../../src/models/User';
import {
  activeLabLink,
  approvedConsent,
  breakGlass,
  call,
  createUser,
  decideConsent,
  decideLabLink,
  idOf,
  issueLabReport,
  requestConsent,
  revokeGrant,
  samplePdf,
  shareDocument,
  tokenFor,
  uniqueSuffix,
  uploadDocument,
} from '../support/fixtures';

/**
 * Suite 1b — every actor against every document (claims C5–C12 in docs/TESTING.md).
 *
 * READABLE is the specification: the document read rule of API_LAB.md §5 and API_ADMIN.md §3, written out by
 * hand for this world. It is never computed by calling the server's own decision function.
 *   admin   -> everything
 *   patient -> documents they own, including lab reports issued to them
 *   lab     -> only reports it issued — nothing else, and still after the link is revoked
 *   doctor  -> a direct share, an APPROVED consent, or a LIVE break-glass grant; verification gates initiating
 *              new access, not access already given
 *   any other role -> nothing, refused with the same clean 403 as any other denial
 */

type DocName = 'doc1' | 'doc2' | 'doc3' | 'reportA' | 'reportA2' | 'docB' | 'reportB';
type ActorName =
  | 'patientA'
  | 'patientB'
  | 'admin'
  | 'doctorShare'
  | 'doctorUnverifiedShare'
  | 'doctorConsent'
  | 'doctorGrant'
  | 'doctorLaterUnverified'
  | 'doctorStranger'
  | 'doctorPendingConsent'
  | 'doctorRejectedConsent'
  | 'doctorRevokedConsent'
  | 'doctorRevokedGrant'
  | 'doctorExpiredGrant'
  | 'labIssuer'
  | 'labRevoked'
  | 'labOther'
  | 'unknownRole';

const ALL_DOCS: readonly DocName[] = ['doc1', 'doc2', 'doc3', 'reportA', 'reportA2', 'docB', 'reportB'];

const READABLE: Record<ActorName, readonly DocName[]> = {
  patientA: ['doc1', 'doc2', 'doc3', 'reportA', 'reportA2'],
  patientB: ['docB', 'reportB'],
  admin: ALL_DOCS,
  doctorShare: ['doc1'],
  doctorUnverifiedShare: ['doc1'], // shared with them; verification does not gate reads already granted
  doctorConsent: ['doc2'],
  doctorGrant: ['doc3'],
  doctorLaterUnverified: ['doc2', 'doc3'], // consent + live grant obtained while verified, then unverified
  doctorStranger: [],
  doctorPendingConsent: [],
  doctorRejectedConsent: [],
  doctorRevokedConsent: [],
  doctorRevokedGrant: [],
  doctorExpiredGrant: [], // grant row still says ACTIVE, but its window has lapsed
  labIssuer: ['reportA'], // linked to patient A, yet cannot read A's own uploads
  labRevoked: ['reportA2'], // link revoked after issuing: keeps its own report, per API_LAB.md §2
  labOther: ['reportB'],
  unknownRole: [],
};

const ACTOR_NAMES = Object.keys(READABLE) as ActorName[];

const DENIED_MESSAGE = 'You do not have permission to access this document';

const READ_ENDPOINTS = [
  { suffix: '', action: 'DOCUMENT_ACCESS' },
  { suffix: '/view', action: 'DOCUMENT_PREVIEW' },
  { suffix: '/download', action: 'DOCUMENT_DOWNLOAD' },
  { suffix: '/integrity', action: 'INTEGRITY_VERIFIED' },
] as const satisfies readonly { suffix: string; action: AuditAction }[];

const users = {} as Record<ActorName, IUser>;
const tokens = {} as Record<ActorName, string>;
const docIds = {} as Record<DocName, string>;

/** A user whose stored role is not one of the four. The schema enum is bypassed on purpose (raw collection insert). */
const insertUnknownRoleUser = async (): Promise<IUser> => {
  const now = new Date();
  const { insertedId } = await User.collection.insertOne({
    name: 'Unknown Role',
    email: `superadmin-${uniqueSuffix()}@test.jeevanlocker.dev`,
    password: 'x'.repeat(60),
    role: 'superadmin',
    verified: true,
    createdAt: now,
    updatedAt: now,
  });
  return (await User.findById(insertedId))!;
};

beforeAll(async () => {
  const patientA = await createUser('patient');
  const patientB = await createUser('patient');
  Object.assign(users, {
    patientA,
    patientB,
    admin: await createUser('admin'),
    doctorShare: await createUser('doctor'),
    doctorUnverifiedShare: await createUser('doctor', { verified: false }),
    doctorConsent: await createUser('doctor'),
    doctorGrant: await createUser('doctor'),
    doctorLaterUnverified: await createUser('doctor'),
    doctorStranger: await createUser('doctor'),
    doctorPendingConsent: await createUser('doctor'),
    doctorRejectedConsent: await createUser('doctor'),
    doctorRevokedConsent: await createUser('doctor'),
    doctorRevokedGrant: await createUser('doctor'),
    doctorExpiredGrant: await createUser('doctor'),
    labIssuer: await createUser('lab'),
    labRevoked: await createUser('lab'),
    labOther: await createUser('lab'),
    unknownRole: await insertUnknownRoleUser(),
  } satisfies Record<ActorName, IUser>);

  // Documents, all through the real endpoints (encrypted to disk, hash registered on-chain).
  docIds.doc1 = (await uploadDocument(patientA, 'A doc1 (shared)')).id;
  docIds.doc2 = (await uploadDocument(patientA, 'A doc2 (consent)')).id;
  docIds.doc3 = (await uploadDocument(patientA, 'A doc3 (break-glass)')).id;
  docIds.docB = (await uploadDocument(patientB, 'B doc')).id;

  await activeLabLink(users.labIssuer, patientA);
  docIds.reportA = (await issueLabReport(users.labIssuer, patientA, 'A report by labIssuer')).id;

  const revokedLink = await activeLabLink(users.labRevoked, patientA);
  docIds.reportA2 = (await issueLabReport(users.labRevoked, patientA, 'A report by labRevoked')).id;
  await decideLabLink(patientA, revokedLink.id, 'revoke');

  await activeLabLink(users.labOther, patientB);
  docIds.reportB = (await issueLabReport(users.labOther, patientB, 'B report by labOther')).id;

  // doc1: direct shares — one to an unverified doctor.
  await shareDocument(patientA, docIds.doc1, users.doctorShare);
  await shareDocument(patientA, docIds.doc1, users.doctorUnverifiedShare);

  // doc2: consent in every state.
  await approvedConsent(users.doctorConsent, patientA, docIds.doc2);
  await approvedConsent(users.doctorLaterUnverified, patientA, docIds.doc2);
  await requestConsent(users.doctorPendingConsent, patientA, docIds.doc2);
  await decideConsent(patientA, (await requestConsent(users.doctorRejectedConsent, patientA, docIds.doc2)).id, 'reject');
  await decideConsent(patientA, (await approvedConsent(users.doctorRevokedConsent, patientA, docIds.doc2)).id, 'revoke');

  // doc3: break-glass in every state.
  await breakGlass(users.doctorGrant, patientA, docIds.doc3);
  await breakGlass(users.doctorLaterUnverified, patientA, docIds.doc3);
  await revokeGrant(patientA, (await breakGlass(users.doctorRevokedGrant, patientA, docIds.doc3)).id);
  const lapsing = await breakGlass(users.doctorExpiredGrant, patientA, docIds.doc3);
  // The window lapses: the row keeps status ACTIVE until something sweeps it, which is the case to prove safe.
  await EmergencyAccess.updateOne({ _id: lapsing.id }, { $set: { expiresAt: new Date(Date.now() - 1_000) } });

  // Access obtained while verified; then an admin-side flip to unverified (there is no unverify endpoint).
  await User.updateOne({ _id: users.doctorLaterUnverified._id }, { $set: { verified: false } });

  for (const name of ACTOR_NAMES) {
    tokens[name] =
      name === 'unknownRole'
        ? jwt.sign({ userId: idOf(users.unknownRole), role: 'superadmin' }, process.env.JWT_SECRET ?? '', { expiresIn: '1h' })
        : tokenFor(users[name]);
  }
});

const countAudit = (actor: ActorName, doc: DocName, action: AuditAction) =>
  AccessLog.countDocuments({ userId: users[actor]._id, targetDocument: new Types.ObjectId(docIds[doc]), action });

const cells = ACTOR_NAMES.flatMap((actor) =>
  ALL_DOCS.flatMap((doc) => READ_ENDPOINTS.map((endpoint) => ({ actor, doc, endpoint, label: `${actor} GET ${doc}${endpoint.suffix}` })))
);

describe('read matrix: every actor x every document x every read endpoint', () => {
  it.each(cells)('$label', async ({ actor, doc, endpoint }) => {
    const allowed = READABLE[actor].includes(doc);
    const auditBefore = await countAudit(actor, doc, endpoint.action);
    const response = await call('get', `/api/documents/${docIds[doc]}${endpoint.suffix}`, tokens[actor]);
    const context = `${actor} -> ${doc}${endpoint.suffix}: ${response.status} ${JSON.stringify(response.body).slice(0, 200)}`;

    if (allowed) {
      expect(response.status, context).toBe(200);
      if (endpoint.suffix === '') expect(response.body.document.id, context).toBe(docIds[doc]);
      if (endpoint.suffix === '/view') expect(response.headers['content-disposition'], context).toMatch(/^inline/);
      if (endpoint.suffix === '/download') expect(response.headers['content-disposition'], context).toMatch(/^attachment/);
      if (endpoint.suffix === '/integrity') expect(response.body.verified, context).toBe(true);
    } else {
      // Includes the unknown role: the tail of the role switch denies explicitly, like any other refusal —
      // no thrown error, no 500, no stack trace.
      expect(response.status, context).toBe(403);
      expect(response.body, context).toEqual({ message: DENIED_MESSAGE });
    }

    // Every served read is audited exactly once; a denied read leaves no access record.
    expect(await countAudit(actor, doc, endpoint.action), `audit rows for ${context}`).toBe(auditBefore + (allowed ? 1 : 0));
  });

  // API_LAB.md §5: 404 Document not found for unknown ids. A malformed id is an unknown id — same answer, so the
  // response never distinguishes "exists but not yours" (403) from anything but a real, well-formed id.
  it.each(ACTOR_NAMES)('%s gets 404 for an unknown or malformed document id', async (actor) => {
    for (const endpoint of READ_ENDPOINTS) {
      for (const id of [new Types.ObjectId().toString(), 'not-an-id']) {
        const response = await call('get', `/api/documents/${id}${endpoint.suffix}`, tokens[actor]);
        expect(response.status, `${actor} ${id}${endpoint.suffix}`).toBe(404);
        expect(response.body).toEqual({ message: 'Document not found' });
      }
    }
  });
});

describe('list mirrors decision: my-documents holds exactly what the actor may open', () => {
  it.each(ACTOR_NAMES.filter((actor) => actor !== 'unknownRole'))('%s', async (actor) => {
    const response = await call('get', '/api/documents/my-documents', tokens[actor]);
    expect(response.status).toBe(200);

    const worldIds = new Set(Object.values(docIds));
    const listed = (response.body.documents as { id: string }[]).map((document) => document.id).filter((id) => worldIds.has(id));
    expect(listed.sort()).toEqual(READABLE[actor].map((doc) => docIds[doc]).sort());
  });

  it('an unknown role is refused the list with a clean 403', async () => {
    const response = await call('get', '/api/documents/my-documents', tokens.unknownRole);
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ message: 'You do not have permission to access this resource' });
  });
});

describe('document writes: only the owner shares, only to doctors, and ownership cannot be injected', () => {
  it('another patient cannot share a document they do not own', async () => {
    const response = await call('patch', `/api/documents/${docIds.doc2}/share`, tokens.patientB).send({ doctorId: idOf(users.doctorStranger) });
    expect(response.status).toBe(403);
    expect(response.body.message).toBe('Only the uploading patient can share this document');
    expect((await MedicalDocument.findById(docIds.doc2))!.sharedWithDoctors.map(String)).not.toContain(idOf(users.doctorStranger));
  });

  it('a lab cannot share even the report it issued', async () => {
    const response = await call('patch', `/api/documents/${docIds.reportA}/share`, tokens.labIssuer).send({ doctorId: idOf(users.doctorStranger) });
    expect(response.status).toBe(403);
  });

  it.each(['admin', 'labIssuer', 'patientB', 'unknownRole'] as const)('the owner cannot share with a non-doctor (%s)', async (target) => {
    const response = await call('patch', `/api/documents/${docIds.doc2}/share`, tokens.patientA).send({ doctorId: idOf(users[target]) });
    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Selected user must be a registered doctor');
    expect((await MedicalDocument.findById(docIds.doc2))!.sharedWithDoctors.map(String)).not.toContain(idOf(users[target]));
  });

  it('upload ignores client-supplied ownership, sharing and lab fields', async () => {
    const response = await call('post', '/api/documents/upload', tokens.patientA)
      .field('title', 'Injection attempt')
      .field('uploadedBy', idOf(users.patientB))
      .field('sharedWithDoctors', idOf(users.doctorStranger))
      .field('uploadedByLab', idOf(users.labOther))
      .attach('file', samplePdf(), { filename: 'x.pdf', contentType: 'application/pdf' });
    expect(response.status).toBe(201);

    const stored = (await MedicalDocument.findById(response.body.document.id))!;
    expect(stored.uploadedBy.toString()).toBe(idOf(users.patientA));
    expect(stored.sharedWithDoctors).toHaveLength(0);
    expect(stored.uploadedByLab ?? null).toBeNull();

    // And the injected parties really cannot read it.
    for (const actor of ['patientB', 'doctorStranger', 'labOther'] as const) {
      expect((await call('get', `/api/documents/${stored._id.toString()}`, tokens[actor])).status, actor).toBe(403);
    }
  });
});
