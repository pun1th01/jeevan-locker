import { createHash } from 'crypto';
import { Types } from 'mongoose';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { onAnyAppEvent, type AppEventName } from '../../src/events/appEvents';
import { AccessLog } from '../../src/models/AccessLog';
import { ChainAnchor } from '../../src/models/ChainAnchor';
import { ConsentGrant } from '../../src/models/ConsentGrant';
import { EmergencyAccess } from '../../src/models/EmergencyAccess';
import { MedicalDocument } from '../../src/models/MedicalDocument';
import type { IUser } from '../../src/models/User';
import { reconcileMissingAnchors } from '../../src/services/anchorQueue.service';
import {
  activeLabLink,
  approvedConsent,
  breakGlass,
  call,
  createUser,
  idOf,
  issueLabReport,
  requestConsent,
  shareDocument,
  tokenFor,
  uploadDocument,
} from '../support/fixtures';
import { drainAnchors, readChainDigest } from '../support/anchors';

/**
 * Suite 1f — a patient deletes a document (claims C57–C58 in docs/TESTING.md).
 *
 * Specification: docs/API_DOCUMENTS.md §5 and docs/ANCHORING.md §2 (*Document deletion*). A soft delete must end every
 * doctor's access through the same audited, anchored transitions a patient makes by hand. The document's own chain
 * record must survive, and the deletion itself must be anchored. Admins still see the document, flagged; the issuing
 * lab keeps its report. Expected preimages are written out here from ANCHORING.md, not built by the server's code.
 */

const READS = ['', '/view', '/download', '/integrity'] as const;
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

const remove = (actor: IUser, documentId: string) => call('delete', `/api/documents/${documentId}`, tokenFor(actor));

/** ANCHORING.md §2, *Document deletion*, written out by hand. */
const specDeletedPreimage = (row: { _id: Types.ObjectId; uploadedBy: Types.ObjectId; documentHash?: string; deletedBy?: Types.ObjectId; deletedAt?: Date }) =>
  JSON.stringify({
    v: 1,
    type: 'document',
    event: 'DELETED',
    documentId: row._id.toString(),
    patientId: row.uploadedBy.toString(),
    documentHash: row.documentHash ?? null,
    deletedBy: row.deletedBy!.toString(),
    deletedAt: row.deletedAt!.toISOString(),
  });

const flushEvents = () => new Promise((resolve) => setImmediate(resolve));
const events: Array<{ name: AppEventName; recipient: string; documentId: string | null }> = [];
let unsubscribe: (() => void) | undefined;

beforeEach(() => {
  events.length = 0;
  unsubscribe = onAnyAppEvent((name, payload) => {
    events.push({ name, recipient: payload.recipientUserId, documentId: payload.documentId });
  });
});
afterEach(() => unsubscribe?.());

let admin: IUser;

beforeAll(async () => {
  admin = await createUser('admin');
});

describe('C57 deleting a document ends every doctor’s access through audited, anchored transitions, and its chain record stays', () => {
  let patient: IUser;
  let sharedDoctor: IUser;
  let consentDoctor: IUser;
  let pendingDoctor: IUser;
  let emergencyDoctor: IUser;
  let documentId: string;
  let consentId: string;
  let pendingConsentId: string;
  let grantId: string;
  let response: Awaited<ReturnType<typeof remove>>;

  beforeAll(async () => {
    patient = await createUser('patient');
    [sharedDoctor, consentDoctor, pendingDoctor, emergencyDoctor] = await Promise.all([
      createUser('doctor'),
      createUser('doctor'),
      createUser('doctor'),
      createUser('doctor'),
    ]);
    documentId = (await uploadDocument(patient, 'Cardiac MRI')).id;
    await shareDocument(patient, documentId, sharedDoctor);
    consentId = (await approvedConsent(consentDoctor, patient, documentId)).id;
    pendingConsentId = (await requestConsent(pendingDoctor, patient, documentId)).id;
    grantId = (await breakGlass(emergencyDoctor, patient, documentId)).id;

    for (const reader of [sharedDoctor, consentDoctor, emergencyDoctor]) {
      expect((await call('get', `/api/documents/${documentId}`, tokenFor(reader))).status).toBe(200);
    }

    response = await remove(patient, documentId);
  });

  it('the owner’s delete answers 200 with what it ended, which the dashboard shows as its message', () => {
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      message: 'Document deleted. Doctors can no longer open it; its hash stays on the blockchain and the audit trail is kept.',
      consentsRevoked: 1,
      consentsRejected: 1,
      grantsRevoked: 1,
    });
  });

  it('for the patient and every doctor who had access, the document no longer exists: 404 on every path, gone from every list', async () => {
    for (const reader of [patient, sharedDoctor, consentDoctor, emergencyDoctor, pendingDoctor]) {
      for (const suffix of READS) {
        const read = await call('get', `/api/documents/${documentId}${suffix}`, tokenFor(reader));
        expect(read.status, `${reader.role} ${suffix}`).toBe(404);
        expect(read.body, `${reader.role} ${suffix}`).toEqual({ message: 'Document not found' });
      }
      const list = await call('get', '/api/documents/my-documents', tokenFor(reader));
      expect(list.body.documents.map((document: { id: string }) => document.id), reader.role).not.toContain(documentId);
    }

    for (const [method, suffix, body] of [
      ['patch', '/share', { doctorId: idOf(sharedDoctor) }],
      ['patch', '/unshare', { doctorId: idOf(sharedDoctor) }],
      ['patch', '/metadata', { title: 'Renamed' }],
      ['delete', '', undefined],
    ] as const) {
      const pending = call(method, `/api/documents/${documentId}${suffix}`, tokenFor(patient));
      const write = body ? await pending.send(body) : await pending;
      expect(write.status, `${method} ${suffix}`).toBe(404);
    }
  });

  it('the approved consent is REVOKED, the pending one REJECTED, the live grant REVOKED by the patient — each audited once with the cause', async () => {
    const consent = (await ConsentGrant.findById(consentId).lean())!;
    expect(consent.status).toBe('REVOKED');
    expect(consent.revokedAt).toBeInstanceOf(Date);

    const pending = (await ConsentGrant.findById(pendingConsentId).lean())!;
    expect(pending.status).toBe('REJECTED');
    expect(pending.rejectedAt).toBeInstanceOf(Date);
    expect(pending.approvedAt).toBeUndefined();

    const grant = (await EmergencyAccess.findById(grantId).lean())!;
    expect(grant.status).toBe('REVOKED');
    expect(grant.revokedBy?.toString()).toBe(idOf(patient));

    const cascade = await AccessLog.find({ targetDocument: documentId, 'metadata.cause': 'DOCUMENT_DELETED' }).lean();
    expect(cascade.map((row) => row.action).sort()).toEqual(['CONSENT_REJECTED', 'CONSENT_REVOKED', 'EMERGENCY_ACCESS_REVOKED']);
    for (const row of cascade) expect(row.userId.toString(), row.action).toBe(idOf(patient));

    const deletion = await AccessLog.find({ action: 'DOCUMENT_DELETED', targetDocument: documentId }).lean();
    expect(deletion).toHaveLength(1);
    expect(deletion[0].userId.toString()).toBe(idOf(patient));
    expect(deletion[0].metadata).toMatchObject({ patientId: idOf(patient), consentsRevoked: '1', consentsRejected: '1', grantsRevoked: '1' });
  });

  it('the cascade is anchored as ordinary REVOKED/REJECTED events, and the deletion as document:<id>:DELETED with the documented preimage', async () => {
    expect(await ChainAnchor.countDocuments({ recordId: consentId, event: 'REVOKED' })).toBe(1);
    expect(await ChainAnchor.countDocuments({ recordId: pendingConsentId, event: 'REJECTED' })).toBe(1);
    expect(await ChainAnchor.countDocuments({ recordId: grantId, event: 'REVOKED' })).toBe(1);

    const row = (await MedicalDocument.findById(documentId).lean())!;
    expect(row.deletedBy?.toString()).toBe(idOf(patient));
    const anchors = await ChainAnchor.find({ recordType: 'document', recordId: documentId }).lean();
    expect(anchors).toHaveLength(1);
    expect(anchors[0].key).toBe(`document:${documentId}:DELETED`);
    expect(anchors[0].preimage).toBe(specDeletedPreimage(row));
    expect(anchors[0].digest).toBe(sha256(specDeletedPreimage(row)));
    expect(anchors[0].actorUserId.toString()).toBe(idOf(patient));
  });

  it('once anchored, the chain holds that digest, the admin verify view agrees three ways, and the proof is written back to the document', async () => {
    await drainAnchors();
    const anchor = (await ChainAnchor.findOne({ recordType: 'document', recordId: documentId }))!;
    expect(anchor.status).toBe('ANCHORED');
    expect(await readChainDigest(anchor.key)).toBe(`0x${anchor.digest}`);

    const verification = (await call('get', `/api/admin/anchors/${anchor._id.toString()}/verify`, tokenFor(admin))).body;
    expect(verification).toMatchObject({ recordFound: true, matchesRecord: true, matchesChain: true, verified: true, differingFields: [] });
    expect(verification.anchor.recordType).toBe('document');

    const listed = await call('get', '/api/admin/anchors?recordType=document', tokenFor(admin));
    expect(listed.status).toBe(200);
    expect(listed.body.anchors.map((row: { id: string }) => row.id)).toContain(anchor._id.toString());

    const row = (await MedicalDocument.findById(documentId).lean())!;
    expect(row.anchors?.deleted?.txHash).toBe(anchor.txHash);
  });

  it('the document’s own chain record stays: an admin still reads it, flagged, and /integrity still verifies against the chain', async () => {
    const read = await call('get', `/api/documents/${documentId}`, tokenFor(admin));
    expect(read.status).toBe(200);
    expect(read.body.document.deletedAt).toBe((await MedicalDocument.findById(documentId).lean())!.deletedAt!.toISOString());

    const integrity = await call('get', `/api/documents/${documentId}/integrity`, tokenFor(admin));
    expect(integrity.status).toBe(200);
    expect(integrity.body.verified).toBe(true);

    const list = await call('get', '/api/documents/my-documents', tokenFor(admin));
    expect(list.body.documents.find((document: { id: string }) => document.id === documentId)?.deletedAt).toBeDefined();

    const summary = (await call('get', '/api/audit/summary', tokenFor(admin))).body.summary;
    expect(summary.deletedDocuments).toBeGreaterThanOrEqual(1);
    const feedRow = summary.recentActivity.find((log: { action: string; targetDocument?: { id: string } }) => log.action === 'DOCUMENT_DELETED' && log.targetDocument?.id === documentId);
    expect(feedRow?.targetDocument.deletedAt).toBeDefined();
  });

  it('nothing new can be opened on it: a consent request and break-glass are 404 and create nothing; the patient lookup no longer lists it', async () => {
    const newcomer = await createUser('doctor');
    const consent = await call('post', '/api/consents/request', tokenFor(newcomer)).send({ patientId: idOf(patient), documentId, purpose: 'x' });
    expect(consent.status).toBe(404);
    expect(consent.body).toEqual({ message: 'Document not found' });
    const glass = await call('post', '/api/emergency-access', tokenFor(newcomer)).send({ patientId: idOf(patient), documentId, reason: 'x' });
    expect(glass.status).toBe(404);
    expect(glass.body).toEqual({ message: 'Document not found' });
    expect(await ConsentGrant.countDocuments({ doctorId: newcomer._id })).toBe(0);
    expect(await EmergencyAccess.countDocuments({ doctorId: newcomer._id })).toBe(0);

    const lookup = await call('get', `/api/patients/lookup?query=${encodeURIComponent(patient.email)}`, tokenFor(newcomer));
    expect(lookup.status).toBe(200);
    expect(lookup.body.documents.map((document: { id: string }) => document.id)).not.toContain(documentId);
  });

  it('a revoked doctor is notified the same way a manual revoke notifies them', async () => {
    // The cascade's events fired during beforeAll; replay the check on a fresh deletion to observe them.
    const owner = await createUser('patient');
    const doctor = await createUser('doctor');
    const id = (await uploadDocument(owner)).id;
    await approvedConsent(doctor, owner, id);
    await flushEvents();
    events.length = 0;

    expect((await remove(owner, id)).status).toBe(200);
    await flushEvents();
    expect(events.filter((event) => event.documentId === id)).toEqual([{ name: 'consent.revoked', recipient: idOf(doctor), documentId: id }]);
  });
});

describe('C58 only the owner deletes, exactly once; the issuing lab keeps its report; a lost deletion anchor is re-derived', () => {
  it('another patient is refused (403) and the shared doctor, the lab and an admin by role; nothing changes and nothing is audited', async () => {
    const owner = await createUser('patient');
    const doctor = await createUser('doctor');
    const documentId = (await uploadDocument(owner)).id;
    await shareDocument(owner, documentId, doctor);

    const stranger = await remove(await createUser('patient'), documentId);
    expect(stranger.status).toBe(403);
    expect(stranger.body).toEqual({ message: 'Only the uploading patient can delete this document' });
    for (const actor of [doctor, await createUser('lab'), admin]) {
      expect((await remove(actor, documentId)).status, actor.role).toBe(403);
    }

    expect((await MedicalDocument.findById(documentId).lean())!.deletedAt).toBeUndefined();
    expect(await AccessLog.countDocuments({ action: 'DOCUMENT_DELETED', targetDocument: documentId })).toBe(0);
    expect((await call('get', `/api/documents/${documentId}`, tokenFor(doctor))).status).toBe(200);
  });

  it('five concurrent deletes: one 200, four 404; one DOCUMENT_DELETED row and one DELETED anchor', async () => {
    const owner = await createUser('patient');
    const documentId = (await uploadDocument(owner)).id;

    const responses = await Promise.all(Array.from({ length: 5 }, () => remove(owner, documentId)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 404, 404, 404, 404]);
    expect(await AccessLog.countDocuments({ action: 'DOCUMENT_DELETED', targetDocument: documentId })).toBe(1);
    expect(await ChainAnchor.countDocuments({ recordType: 'document', recordId: documentId })).toBe(1);
  });

  it('a lab report the patient deletes stays readable by the lab that issued it, which is not told it was deleted', async () => {
    const owner = await createUser('patient');
    const lab = await createUser('lab');
    await activeLabLink(lab, owner);
    const report = await issueLabReport(lab, owner);

    expect((await remove(owner, report.id)).status).toBe(200);
    expect((await call('get', `/api/documents/${report.id}`, tokenFor(owner))).status).toBe(404);

    const read = await call('get', `/api/documents/${report.id}`, tokenFor(lab));
    expect(read.status).toBe(200);
    expect(read.body.document).not.toHaveProperty('deletedAt');
    const integrity = await call('get', `/api/documents/${report.id}/integrity`, tokenFor(lab));
    expect(integrity.body.verified).toBe(true);
    const list = await call('get', '/api/documents/my-documents', tokenFor(lab));
    expect(list.body.documents.map((document: { id: string }) => document.id)).toContain(report.id);
  });

  it('a lost DELETED anchor row is re-derived by boot reconciliation, with the same digest, exactly once', async () => {
    const owner = await createUser('patient');
    const documentId = (await uploadDocument(owner)).id;
    expect((await remove(owner, documentId)).status).toBe(200);
    const original = (await ChainAnchor.findOne({ recordType: 'document', recordId: documentId }).lean())!;

    await ChainAnchor.deleteOne({ _id: original._id });
    await reconcileMissingAnchors(() => undefined);
    const rebuilt = await ChainAnchor.find({ recordType: 'document', recordId: documentId }).lean();
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]).toMatchObject({ key: original.key, digest: original.digest, preimage: original.preimage, source: 'reconciliation' });

    await reconcileMissingAnchors(() => undefined);
    expect(await ChainAnchor.countDocuments({ recordType: 'document', recordId: documentId })).toBe(1);
  });
});
