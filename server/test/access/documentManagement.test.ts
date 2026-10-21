import { beforeAll, describe, expect, it } from 'vitest';
import { AccessLog } from '../../src/models/AccessLog';
import { ConsentGrant } from '../../src/models/ConsentGrant';
import { EmergencyAccess } from '../../src/models/EmergencyAccess';
import { MedicalDocument } from '../../src/models/MedicalDocument';
import type { IUser } from '../../src/models/User';
import {
  activeLabLink,
  approvedConsent,
  breakGlass,
  call,
  createUser,
  idOf,
  issueLabReport,
  shareDocument,
  tokenFor,
  uploadDocument,
} from '../support/fixtures';

/**
 * Suite 1d — document management: unshare and metadata (claims C54–C55 in docs/TESTING.md).
 *
 * Specification: docs/API_DOCUMENTS.md, which was written to match the calls the patient dashboard already makes
 * (client/src/services/document.service.ts): `PATCH /documents/:id/unshare { doctorId }` and
 * `PATCH /documents/:id/metadata { title, description? }`, both answering `{ message, document }`. As in the rest of
 * suite 1, every refusal is also checked for its side effect: the document must be unchanged and nothing audited.
 */

const READS = ['', '/view', '/download', '/integrity'] as const;

const unshare = (actor: IUser, documentId: string, doctorId: string) =>
  call('patch', `/api/documents/${documentId}/unshare`, tokenFor(actor)).send({ doctorId });

const editMetadata = (actor: IUser, documentId: string, body: Record<string, unknown>) =>
  call('patch', `/api/documents/${documentId}/metadata`, tokenFor(actor)).send(body);

const auditCount = (action: 'DOCUMENT_UNSHARED' | 'DOCUMENT_UPDATED', documentId: string) =>
  AccessLog.countDocuments({ action, targetDocument: documentId });

const sharedIds = async (documentId: string) =>
  ((await MedicalDocument.findById(documentId).lean())!.sharedWithDoctors ?? []).map((id) => id.toString()).sort();

/** The stored fields a metadata edit may or may not touch, for "nothing changed" checks. */
const snapshot = async (documentId: string) => {
  const row = (await MedicalDocument.findById(documentId).lean())!;
  return {
    title: row.title,
    description: (row as { description?: string }).description,
    uploadedBy: row.uploadedBy.toString(),
    sharedWithDoctors: row.sharedWithDoctors.map((id) => id.toString()),
    documentHash: row.documentHash,
    blockchainTxHash: row.blockchainTxHash,
    uploadedByLab: row.uploadedByLab?.toString(),
    labName: row.labName,
    testName: row.testName,
    testValues: row.testValues,
  };
};

describe('C54 unshare removes one doctor’s direct share, and only that', () => {
  let patient: IUser;
  let doctor: IUser;

  beforeAll(async () => {
    patient = await createUser('patient');
    doctor = await createUser('doctor');
  });

  it('the owner unshares: the doctor loses every read path and the list entry, one DOCUMENT_UNSHARED row, answered as the client reads it', async () => {
    const documentId = (await uploadDocument(patient)).id;
    await shareDocument(patient, documentId, doctor);
    for (const suffix of READS) {
      expect((await call('get', `/api/documents/${documentId}${suffix}`, tokenFor(doctor))).status, `before ${suffix}`).toBe(200);
    }

    const response = await unshare(patient, documentId, idOf(doctor));
    expect(response.status).toBe(200);
    expect(response.body.message).toBe('Direct access removed');
    expect(response.body.document.id).toBe(documentId);
    expect(response.body.document.sharedWithDoctors).toEqual([]);

    for (const suffix of READS) {
      expect((await call('get', `/api/documents/${documentId}${suffix}`, tokenFor(doctor))).status, `after ${suffix}`).toBe(403);
    }
    const list = await call('get', '/api/documents/my-documents', tokenFor(doctor));
    expect(list.body.documents.map((document: { id: string }) => document.id)).not.toContain(documentId);

    const audits = await AccessLog.find({ action: 'DOCUMENT_UNSHARED', targetDocument: documentId }).lean();
    expect(audits).toHaveLength(1);
    expect(audits[0].userId.toString()).toBe(idOf(patient));
    expect(audits[0].metadata).toEqual({ doctorId: idOf(doctor), patientId: idOf(patient) });
  });

  it('only the named doctor is removed: another doctor’s share stays', async () => {
    const other = await createUser('doctor');
    const documentId = (await uploadDocument(patient)).id;
    await shareDocument(patient, documentId, doctor);
    await shareDocument(patient, documentId, other);

    expect((await unshare(patient, documentId, idOf(doctor))).status).toBe(200);
    expect(await sharedIds(documentId)).toEqual([idOf(other)]);
    expect((await call('get', `/api/documents/${documentId}`, tokenFor(other))).status).toBe(200);
  });

  it('an approved consent and a live break-glass grant are untouched: both doctors keep reading, by their own method', async () => {
    const consentDoctor = await createUser('doctor');
    const emergencyDoctor = await createUser('doctor');
    const documentId = (await uploadDocument(patient)).id;

    const consent = await approvedConsent(consentDoctor, patient, documentId);
    const grant = await breakGlass(emergencyDoctor, patient, documentId);
    await shareDocument(patient, documentId, consentDoctor);
    await shareDocument(patient, documentId, emergencyDoctor);

    expect((await unshare(patient, documentId, idOf(consentDoctor))).status).toBe(200);
    expect((await unshare(patient, documentId, idOf(emergencyDoctor))).status).toBe(200);
    expect(await sharedIds(documentId)).toEqual([]);

    expect((await ConsentGrant.findById(consent.id).lean())!.status).toBe('APPROVED');
    expect((await EmergencyAccess.findById(grant.id).lean())!.status).toBe('ACTIVE');

    for (const [reader, method] of [
      [consentDoctor, 'consent'],
      [emergencyDoctor, 'emergency'],
    ] as const) {
      expect((await call('get', `/api/documents/${documentId}`, tokenFor(reader))).status).toBe(200);
      const row = await AccessLog.findOne({ action: 'DOCUMENT_ACCESS', userId: reader._id, targetDocument: documentId }).sort({ timestamp: -1 }).lean();
      expect(row?.metadata?.accessMethod).toBe(method);
    }
  });

  it('another patient cannot unshare: 403, the share stays and nothing is audited', async () => {
    const stranger = await createUser('patient');
    const documentId = (await uploadDocument(patient)).id;
    await shareDocument(patient, documentId, doctor);

    const response = await unshare(stranger, documentId, idOf(doctor));
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ message: 'Only the uploading patient can change who this document is shared with' });
    expect(await sharedIds(documentId)).toEqual([idOf(doctor)]);
    expect(await auditCount('DOCUMENT_UNSHARED', documentId)).toBe(0);
  });

  it('the shared doctor, a lab and an admin are refused by role and change nothing', async () => {
    const documentId = (await uploadDocument(patient)).id;
    await shareDocument(patient, documentId, doctor);

    for (const actor of [doctor, await createUser('lab'), await createUser('admin')]) {
      expect((await unshare(actor, documentId, idOf(doctor))).status, actor.role).toBe(403);
    }
    expect(await sharedIds(documentId)).toEqual([idOf(doctor)]);
    expect(await auditCount('DOCUMENT_UNSHARED', documentId)).toBe(0);
  });

  it('unsharing a doctor who holds no direct share is a 200 that writes nothing; bad ids are 400 and 404', async () => {
    const documentId = (await uploadDocument(patient)).id;

    const response = await unshare(patient, documentId, idOf(doctor));
    expect(response.status).toBe(200);
    expect(response.body.message).toBe('This doctor had no direct access to this document');
    expect(await auditCount('DOCUMENT_UNSHARED', documentId)).toBe(0);

    expect((await unshare(patient, documentId, 'not-an-id')).status).toBe(400);
    expect((await call('patch', `/api/documents/${documentId}/unshare`, tokenFor(patient)).send({})).status).toBe(400);
    const unknown = await unshare(patient, '0123456789abcdef01234567', idOf(doctor));
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ message: 'Document not found' });
  });

  it('five concurrent unshares of one doctor: all 200, one audit row', async () => {
    const documentId = (await uploadDocument(patient)).id;
    await shareDocument(patient, documentId, doctor);

    const responses = await Promise.all(Array.from({ length: 5 }, () => unshare(patient, documentId, idOf(doctor))));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    expect(responses.filter((response) => response.body.message === 'Direct access removed')).toHaveLength(1);
    expect(await auditCount('DOCUMENT_UNSHARED', documentId)).toBe(1);
  });
});

describe('C55 only the owning patient edits a document’s title and description, and nothing else about it', () => {
  let patient: IUser;
  let lab: IUser;

  beforeAll(async () => {
    patient = await createUser('patient');
    lab = await createUser('lab');
    await activeLabLink(lab, patient);
  });

  it('the owner renames and describes a document; every read shows it, the response is what the client renders, and integrity still verifies', async () => {
    const documentId = (await uploadDocument(patient, 'Original title')).id;

    const response = await editMetadata(patient, documentId, { title: '  Blood panel, March  ', description: '  Fasting sample.  ' });
    expect(response.status).toBe(200);
    expect(response.body.message).toBe('Document details updated');
    expect(response.body.document).toMatchObject({ id: documentId, title: 'Blood panel, March', description: 'Fasting sample.' });

    const read = await call('get', `/api/documents/${documentId}`, tokenFor(patient));
    expect(read.body.document).toMatchObject({ title: 'Blood panel, March', description: 'Fasting sample.' });
    const list = await call('get', '/api/documents/my-documents', tokenFor(patient));
    expect(list.body.documents.find((document: { id: string }) => document.id === documentId)).toMatchObject({ description: 'Fasting sample.' });

    // The file and its on-chain hash are untouched by a metadata edit.
    const integrity = await call('get', `/api/documents/${documentId}/integrity`, tokenFor(patient));
    expect(integrity.status).toBe(200);
    expect(integrity.body.verified).toBe(true);

    const audits = await AccessLog.find({ action: 'DOCUMENT_UPDATED', targetDocument: documentId }).lean();
    expect(audits).toHaveLength(1);
    expect(audits[0].userId.toString()).toBe(idOf(patient));
    expect(audits[0].metadata).toEqual({ fields: 'title,description', previousTitle: 'Original title', patientId: idOf(patient) });
  });

  it('a doctor with access sees the new title and description; the issuing lab never sees the patient’s description', async () => {
    const doctor = await createUser('doctor');
    const report = await issueLabReport(lab, patient, 'CBC report');
    await shareDocument(patient, report.id, doctor);
    expect((await editMetadata(patient, report.id, { title: 'CBC report', description: 'Asked Dr. Rao about the low iron.' })).status).toBe(200);

    expect((await call('get', `/api/documents/${report.id}`, tokenFor(doctor))).body.document.description).toBe('Asked Dr. Rao about the low iron.');

    const labRead = await call('get', `/api/documents/${report.id}`, tokenFor(lab));
    expect(labRead.status).toBe(200);
    expect(labRead.body.document).not.toHaveProperty('description');
    const labList = await call('get', '/api/documents/my-documents', tokenFor(lab));
    expect(labList.body.documents.find((document: { id: string }) => document.id === report.id)).not.toHaveProperty('description');
  });

  it('an empty description clears it; a title-only edit leaves the description alone', async () => {
    const documentId = (await uploadDocument(patient)).id;
    expect((await editMetadata(patient, documentId, { title: 'Scan', description: 'Left knee' })).status).toBe(200);

    const titleOnly = await editMetadata(patient, documentId, { title: 'Knee scan' });
    expect(titleOnly.body.document).toMatchObject({ title: 'Knee scan', description: 'Left knee' });

    const cleared = await editMetadata(patient, documentId, { title: 'Knee scan', description: '   ' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.document).not.toHaveProperty('description');
    expect((await snapshot(documentId)).description).toBeUndefined();
  });

  it('validation: title 1–120 characters, description at most 500, strings only; a refusal changes nothing and audits nothing', async () => {
    const documentId = (await uploadDocument(patient, 'Stable title')).id;
    const before = await snapshot(documentId);

    expect((await editMetadata(patient, documentId, { description: 'd'.repeat(500) })).status).toBe(200);
    const accepted = await snapshot(documentId);
    expect(accepted.description).toHaveLength(500);

    for (const [label, body] of [
      ['empty title', { title: '   ' }],
      ['121-character title', { title: 't'.repeat(121) }],
      ['501-character description', { description: 'd'.repeat(501) }],
      ['non-string title', { title: 42 }],
      ['non-string description', { description: ['x'] }],
      ['nothing to change', {}],
    ] as const) {
      const response = await editMetadata(patient, documentId, body);
      expect(response.status, label).toBe(400);
      expect(await snapshot(documentId), label).toEqual(accepted);
    }

    expect(before.title).toBe(accepted.title);
    expect(await auditCount('DOCUMENT_UPDATED', documentId)).toBe(1);
  });

  it('only title and description may be sent: ownership, sharing, chain and lab-report fields are refused and nothing changes', async () => {
    const documentId = (await uploadDocument(patient)).id;
    const before = await snapshot(documentId);
    const intruder = await createUser('patient');

    for (const field of ['uploadedBy', 'sharedWithDoctors', 'documentHash', 'blockchainTxHash', 'uploadedByLab', 'labName', 'testValues', 'mimeType']) {
      const response = await editMetadata(patient, documentId, { title: 'Renamed', [field]: field === 'testValues' ? [] : idOf(intruder) });
      expect(response.status, field).toBe(400);
      expect(response.body, field).toEqual({ message: 'Only the title and description of a document can be changed' });
      expect(await snapshot(documentId), field).toEqual(before);
    }
    expect(await auditCount('DOCUMENT_UPDATED', documentId)).toBe(0);
  });

  it('a lab report: the patient may describe it, but its lab-issued title and report fields never change', async () => {
    const report = await issueLabReport(lab, patient, 'Lipid profile');
    const before = await snapshot(report.id);

    const described = await editMetadata(patient, report.id, { title: 'Lipid profile', description: 'Repeat in 3 months' });
    expect(described.status).toBe(200);
    expect(described.body.document).toMatchObject({ title: 'Lipid profile', description: 'Repeat in 3 months' });
    expect(described.body.document.uploadedByLab.id).toBe(idOf(lab));

    const renamed = await editMetadata(patient, report.id, { title: 'My cholesterol' });
    expect(renamed.status).toBe(403);
    expect(renamed.body).toEqual({ message: 'A lab report keeps the title its lab issued; only its description can be changed' });

    const after = await snapshot(report.id);
    expect({ ...after, description: undefined }).toEqual({ ...before, description: undefined });
    expect(after.description).toBe('Repeat in 3 months');
  });

  it('another patient cannot edit: 403, nothing changes; the shared doctor, the issuing lab and an admin are refused by role', async () => {
    const doctor = await createUser('doctor');
    const documentId = (await uploadDocument(patient)).id;
    await shareDocument(patient, documentId, doctor);
    const report = await issueLabReport(lab, patient);
    const before = await snapshot(documentId);
    const reportBefore = await snapshot(report.id);

    const stranger = await editMetadata(await createUser('patient'), documentId, { title: 'Hijacked' });
    expect(stranger.status).toBe(403);
    expect(stranger.body).toEqual({ message: 'Only the uploading patient can edit this document' });

    for (const actor of [doctor, await createUser('admin')]) {
      expect((await editMetadata(actor, documentId, { title: 'Hijacked' })).status, actor.role).toBe(403);
    }
    expect((await editMetadata(lab, report.id, { title: 'Hijacked', description: 'x' })).status).toBe(403);

    expect(await snapshot(documentId)).toEqual(before);
    expect(await snapshot(report.id)).toEqual(reportBefore);
    expect(await auditCount('DOCUMENT_UPDATED', documentId)).toBe(0);
    expect(await auditCount('DOCUMENT_UPDATED', report.id)).toBe(0);
  });

  it('saving unchanged values is a 200 that writes no audit row; an unknown document is 404', async () => {
    const documentId = (await uploadDocument(patient, 'Same')).id;
    const response = await editMetadata(patient, documentId, { title: 'Same' });
    expect(response.status).toBe(200);
    expect(response.body.message).toBe('No changes to save');
    expect(await auditCount('DOCUMENT_UPDATED', documentId)).toBe(0);

    const unknown = await editMetadata(patient, '0123456789abcdef01234567', { title: 'x' });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ message: 'Document not found' });
  });
});
