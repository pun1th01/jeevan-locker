import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import { UNVERIFIED_DOCTOR_MESSAGE } from '../../src/middleware/auth.middleware';
import { AccessLog } from '../../src/models/AccessLog';
import { ConsentGrant } from '../../src/models/ConsentGrant';
import { EmergencyAccess } from '../../src/models/EmergencyAccess';
import { LabLink } from '../../src/models/LabLink';
import { MedicalDocument } from '../../src/models/MedicalDocument';
import { User, type IUser } from '../../src/models/User';
import { PATIENT_NOT_FOUND_MESSAGE } from '../../src/utils/patientLookup.util';
import {
  breakGlass,
  call,
  createUser,
  decideLabLink,
  idOf,
  requestConsent,
  requestLabLink,
  samplePdf,
  tokenFor,
  uniqueSuffix,
  uploadDocument,
} from '../support/fixtures';

/**
 * Suite 1c — who may act on whose consent, grant and lab link; the verification gate; admin creation; and
 * the lookup that must not reveal which emails exist (claims C13–C17 in docs/TESTING.md).
 *
 * Every denial is also checked for its side effect: a refused request must not have created, changed or
 * audited anything. A 403 that still wrote the row would pass a status-only test.
 */

const LAB_REPORT = (lab: IUser, patientId: string) =>
  call('post', '/api/lab/reports', tokenFor(lab))
    .field('patientId', patientId)
    .field('title', `Report ${uniqueSuffix()}`)
    .attach('file', samplePdf(), { filename: 'report.pdf', contentType: 'application/pdf' });

describe('verification gate: an unverified doctor cannot initiate access, and nothing is written when refused', () => {
  let patient: IUser;
  let documentId: string;
  let doctor: IUser;
  let admin: IUser;

  beforeAll(async () => {
    patient = await createUser('patient');
    documentId = (await uploadDocument(patient)).id;
    doctor = await createUser('doctor', { verified: false });
    admin = await createUser('admin');
  });

  it('patient lookup: 403, and no PATIENT_LOOKUP audit row (the gate runs before the lookup)', async () => {
    const response = await call('get', `/api/patients/lookup?query=${encodeURIComponent(patient.email)}`, tokenFor(doctor));
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ message: UNVERIFIED_DOCTOR_MESSAGE });
    expect(await AccessLog.countDocuments({ userId: doctor._id, action: 'PATIENT_LOOKUP' })).toBe(0);
  });

  it('consent request: 403, and no consent row', async () => {
    const response = await call('post', '/api/consents/request', tokenFor(doctor)).send({ patientId: idOf(patient), documentId, purpose: 'x' });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ message: UNVERIFIED_DOCTOR_MESSAGE });
    expect(await ConsentGrant.countDocuments({ doctorId: doctor._id })).toBe(0);
  });

  it('break-glass: 403, and no grant row', async () => {
    const response = await call('post', '/api/emergency-access', tokenFor(doctor)).send({ patientId: idOf(patient), documentId, reason: 'x' });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ message: UNVERIFIED_DOCTOR_MESSAGE });
    expect(await EmergencyAccess.countDocuments({ doctorId: doctor._id })).toBe(0);
  });

  it('once an admin verifies the account, the SAME token passes all three — no re-login', async () => {
    const token = tokenFor(doctor);
    expect((await call('patch', `/api/admin/users/${idOf(doctor)}/verify`, tokenFor(admin))).status).toBe(200);

    expect((await call('get', `/api/patients/lookup?query=${encodeURIComponent(patient.email)}`, token)).status).toBe(200);
    expect((await call('post', '/api/consents/request', token).send({ patientId: idOf(patient), documentId, purpose: 'x' })).status).toBe(201);
    const otherDocument = (await uploadDocument(patient)).id;
    expect((await call('post', '/api/emergency-access', token).send({ patientId: idOf(patient), documentId: otherDocument, reason: 'x' })).status).toBe(201);
  });
});

describe('admin creation is impossible over HTTP', () => {
  let admin: IUser;
  const adminCount = () => User.countDocuments({ role: 'admin' });

  beforeAll(async () => {
    admin = await createUser('admin');
  });

  // POST /auth/register allows 5 per IP per hour and every request here is 127.0.0.1: this block uses 4.
  it.each([
    ['admin', 'admin'],
    ['lab', 'lab'],
    ['["admin"]', ['admin']],
  ])('self-registration with role %s is refused and creates nobody', async (_label, role) => {
    const before = await adminCount();
    const email = `escalate-${uniqueSuffix()}@test.jeevanlocker.dev`;
    const response = await call('post', '/api/auth/register').send({ name: 'Escalation Attempt', email, password: 'Str0ngPass!', role, organisation: 'X Labs' });

    expect(response.status).toBe(400);
    expect(response.body.errors?.role).toBe('Role must be patient or doctor');
    expect(await User.exists({ email })).toBeNull();
    expect(await adminCount()).toBe(before);
  });

  it('a self-registered doctor cannot verify themselves by sending verified: true', async () => {
    const email = `selfverify-${uniqueSuffix()}@test.jeevanlocker.dev`;
    const response = await call('post', '/api/auth/register').send({ name: 'Self Verifier', email, password: 'Str0ngPass!', role: 'doctor', verified: true });

    expect(response.status).toBe(201);
    expect(response.body.user.verified).toBe(false);
    expect((await User.findOne({ email }))!.verified).toBe(false);
  });

  it.each([
    ['admin', 'admin'],
    ['Admin', 'Admin'],
    ['" admin "', ' admin '],
    ['doctor', 'doctor'],
    ['["admin"]', ['admin']],
    ['{ $ne: "lab" }', { $ne: 'lab' }],
  ])('POST /admin/users with role %s is refused and creates nobody', async (_label, role) => {
    const before = await adminCount();
    const email = `mint-${uniqueSuffix()}@test.jeevanlocker.dev`;
    const response = await call('post', '/api/admin/users', tokenFor(admin)).send({ name: 'Minted', email, password: 'Str0ngPass!', organisation: 'Minted Org', role });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: 'This endpoint creates lab accounts only' });
    expect(await User.exists({ email })).toBeNull();
    expect(await adminCount()).toBe(before);
  });

  it('with no role at all it creates a lab — never anything else', async () => {
    const email = `lab-${uniqueSuffix()}@test.jeevanlocker.dev`;
    const response = await call('post', '/api/admin/users', tokenFor(admin)).send({ name: 'New Lab', email, password: 'Str0ngPass!', organisation: 'New Lab Pvt Ltd' });

    expect(response.status).toBe(201);
    expect(response.body.user).toMatchObject({ role: 'lab', verified: true });
    expect((await User.findOne({ email }))!.role).toBe('lab');
  });

  it.each(['patient', 'lab', 'admin'] as const)('the verify endpoint refuses a %s and changes nothing', async (role) => {
    const target = await createUser(role);
    const response = await call('patch', `/api/admin/users/${idOf(target)}/verify`, tokenFor(admin));

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: 'Only doctor accounts require verification' });
    const stored = (await User.findById(target._id))!;
    expect(stored.role).toBe(role);
    expect(stored.verified).toBe(target.verified);
  });
});

describe('patient lookup never reveals whether an address or id exists with another role', () => {
  let patient: IUser;
  let doctor: IUser;
  let lab: IUser;
  let probes: [string, string][];

  beforeAll(async () => {
    patient = await createUser('patient');
    doctor = await createUser('doctor');
    lab = await createUser('lab');
    const otherDoctor = await createUser('doctor');
    const admin = await createUser('admin');
    const otherLab = await createUser('lab');

    probes = [
      ['an unknown email', `nobody-${uniqueSuffix()}@test.jeevanlocker.dev`],
      ['a doctor’s email', otherDoctor.email],
      ['an admin’s email', admin.email],
      ['a lab’s email', otherLab.email],
      ['an unknown id', new Types.ObjectId().toString()],
      ['a doctor’s id', idOf(otherDoctor)],
      ['an admin’s id', idOf(admin)],
      ['a lab’s id', idOf(otherLab)],
      ['a prefix of the patient’s email (no partial search)', patient.email.slice(0, 8)],
    ];
  });

  const fingerprint = (response: { status: number; body: unknown; headers: Record<string, string> }) => ({
    status: response.status,
    body: response.body,
    contentType: response.headers['content-type'],
    contentLength: response.headers['content-length'],
  });

  it('GET /patients/lookup: every non-patient probe gets a byte-identical 404', async () => {
    const results = [];
    for (const [label, query] of probes) {
      results.push({ label, ...fingerprint(await call('get', `/api/patients/lookup?query=${encodeURIComponent(query)}`, tokenFor(doctor))) });
    }

    for (const result of results) {
      expect(result, result.label).toMatchObject({ status: 404, body: { message: PATIENT_NOT_FOUND_MESSAGE } });
      expect({ ...result, label: '' }, result.label).toEqual({ ...results[0], label: '' });
    }
  });

  it('POST /lab-links: the same probes get the same byte-identical 404', async () => {
    const results = [];
    for (const [label, query] of probes) {
      results.push({ label, ...fingerprint(await call('post', '/api/lab-links', tokenFor(lab)).send({ query })) });
    }

    for (const result of results) {
      expect(result, result.label).toMatchObject({ status: 404, body: { message: PATIENT_NOT_FOUND_MESSAGE } });
      expect({ ...result, label: '' }, result.label).toEqual({ ...results[0], label: '' });
    }
    expect(await LabLink.countDocuments({ labId: lab._id })).toBe(0);
  });

  it('positive controls: the patient is found by email (trimmed, any case) and by id', async () => {
    for (const query of [patient.email, `  ${patient.email.toUpperCase()}  `, idOf(patient)]) {
      const response = await call('get', `/api/patients/lookup?query=${encodeURIComponent(query)}`, tokenFor(doctor));
      expect(response.status, query).toBe(200);
    }
    expect((await call('post', '/api/lab-links', tokenFor(lab)).send({ query: patient.email })).status).toBe(201);
  });
});

describe('consent: only the patient it names can decide it, and only the doctor who asked can see it', () => {
  let patientA: IUser;
  let patientB: IUser;
  let doctor: IUser;
  let otherDoctor: IUser;
  let docA: string;
  let consentId: string;

  beforeAll(async () => {
    patientA = await createUser('patient');
    patientB = await createUser('patient');
    doctor = await createUser('doctor');
    otherDoctor = await createUser('doctor');
    docA = (await uploadDocument(patientA)).id;
    consentId = (await requestConsent(doctor, patientA, docA)).id;
  });

  it.each(['approve', 'reject', 'revoke'] as const)('another patient cannot %s it, and it stays PENDING', async (action) => {
    const response = await call('patch', `/api/consents/${consentId}/${action}`, tokenFor(patientB));
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ message: 'You do not have permission to change this consent request' });
    expect((await ConsentGrant.findById(consentId))!.status).toBe('PENDING');
  });

  it('another patient and another doctor cannot see it in their lists', async () => {
    const listed = async (url: string, user: IUser) =>
      ((await call('get', url, tokenFor(user))).body.consents as { id: string }[]).map((consent) => consent.id);

    expect(await listed('/api/consents/received', patientB)).not.toContain(consentId);
    expect(await listed('/api/consents/pending', patientB)).not.toContain(consentId);
    expect(await listed('/api/consents/my', otherDoctor)).not.toContain(consentId);
    expect(await listed('/api/consents/received', patientA)).toContain(consentId);
    expect(await listed('/api/consents/my', doctor)).toContain(consentId);
  });

  it('a doctor cannot pair one patient with another patient’s document', async () => {
    const response = await call('post', '/api/consents/request', tokenFor(otherDoctor)).send({ patientId: idOf(patientB), documentId: docA, purpose: 'x' });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: 'The selected document does not belong to the selected patient' });
    expect(await ConsentGrant.countDocuments({ doctorId: otherDoctor._id })).toBe(0);
  });

  it('a pending request grants nothing until the named patient approves it', async () => {
    expect((await call('get', `/api/documents/${docA}`, tokenFor(doctor))).status).toBe(403);
    expect((await call('patch', `/api/consents/${consentId}/approve`, tokenFor(patientA))).status).toBe(200);
    expect((await call('get', `/api/documents/${docA}`, tokenFor(doctor))).status).toBe(200);
    expect((await call('get', `/api/documents/${docA}`, tokenFor(otherDoctor))).status).toBe(403);
  });
});

describe('consent write responses name the real patient, doctor and document', () => {
  it('request, approve, reject and revoke all return the joined names, like the lists do', async () => {
    const patient = await createUser('patient', { name: 'Meera Patient' });
    const doctor = await createUser('doctor', { name: 'Dr Arjun Rao' });
    const firstDocument = (await uploadDocument(patient, 'Echocardiogram 2026')).id;
    const secondDocument = (await uploadDocument(patient, 'Lipid Panel')).id;
    const expectNames = (consent: { patient: { name: string }; doctor: { name: string }; document: { title: string } }, title: string, label: string) =>
      expect({ patient: consent.patient.name, doctor: consent.doctor.name, document: consent.document.title }, label).toEqual({
        patient: 'Meera Patient',
        doctor: 'Dr Arjun Rao',
        document: title,
      });

    const requested = await call('post', '/api/consents/request', tokenFor(doctor)).send({ patientId: idOf(patient), documentId: firstDocument, purpose: 'Review' });
    expect(requested.status).toBe(201);
    expectNames(requested.body.consent, 'Echocardiogram 2026', 'request');

    const approved = await call('patch', `/api/consents/${requested.body.consent.id}/approve`, tokenFor(patient));
    expect(approved.status).toBe(200);
    expectNames(approved.body.consent, 'Echocardiogram 2026', 'approve');

    const revoked = await call('patch', `/api/consents/${requested.body.consent.id}/revoke`, tokenFor(patient));
    expect(revoked.status).toBe(200);
    expectNames(revoked.body.consent, 'Echocardiogram 2026', 'revoke');

    const second = await requestConsent(doctor, patient, secondDocument);
    const rejected = await call('patch', `/api/consents/${second.id}/reject`, tokenFor(patient));
    expect(rejected.status).toBe(200);
    expectNames(rejected.body.consent, 'Lipid Panel', 'reject');
  });
});

describe('break-glass: only the patient it names can end it, and nobody else can see it', () => {
  let patientA: IUser;
  let patientB: IUser;
  let doctor: IUser;
  let otherDoctor: IUser;
  let docA: string;
  let grantId: string;

  beforeAll(async () => {
    patientA = await createUser('patient');
    patientB = await createUser('patient');
    doctor = await createUser('doctor');
    otherDoctor = await createUser('doctor');
    docA = (await uploadDocument(patientA)).id;
    grantId = (await breakGlass(doctor, patientA, docA)).id;
  });

  it('another patient cannot revoke it: 403, the grant stays ACTIVE and the doctor still reads', async () => {
    const response = await call('delete', `/api/emergency-access/${grantId}`, tokenFor(patientB));
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ message: 'You do not have permission to revoke this emergency access' });
    expect((await EmergencyAccess.findById(grantId))!.status).toBe('ACTIVE');
    expect((await call('get', `/api/documents/${docA}`, tokenFor(doctor))).status).toBe(200);
  });

  it('another patient and another doctor cannot see it', async () => {
    const listed = async (user: IUser) =>
      ((await call('get', '/api/emergency-access?status=all', tokenFor(user))).body.emergencyAccesses as { id: string }[]).map((grant) => grant.id);

    expect(await listed(patientB)).not.toContain(grantId);
    expect(await listed(otherDoctor)).not.toContain(grantId);
    expect(await listed(patientA)).toContain(grantId);
    expect(await listed(doctor)).toContain(grantId);
  });

  it('a doctor cannot pair one patient with another patient’s document', async () => {
    const response = await call('post', '/api/emergency-access', tokenFor(otherDoctor)).send({ patientId: idOf(patientB), documentId: docA, reason: 'x' });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: 'The selected document does not belong to the selected patient' });
    expect(await EmergencyAccess.countDocuments({ doctorId: otherDoctor._id })).toBe(0);
  });

  it('an unknown grant is 404, a malformed id is 400, and neither touches the real grant', async () => {
    expect((await call('delete', `/api/emergency-access/${new Types.ObjectId().toString()}`, tokenFor(patientA))).status).toBe(404);
    expect((await call('delete', '/api/emergency-access/not-an-id', tokenFor(patientA))).status).toBe(400);
    expect((await EmergencyAccess.findById(grantId))!.status).toBe('ACTIVE');
  });
});

describe('lab links: only the named patient decides, and a lab uploads only while the link is ACTIVE', () => {
  let patientA: IUser;
  let patientB: IUser;
  let lab: IUser;
  let otherLab: IUser;
  let doctor: IUser;
  let linkId: string;

  const reportsIssuedBy = (issuer: IUser) => MedicalDocument.countDocuments({ uploadedByLab: issuer._id });

  beforeAll(async () => {
    patientA = await createUser('patient');
    patientB = await createUser('patient');
    lab = await createUser('lab');
    otherLab = await createUser('lab');
    doctor = await createUser('doctor');
    linkId = (await requestLabLink(lab, patientA)).id;
  });

  it.each(['approve', 'reject', 'revoke'] as const)('another patient cannot %s it, and it stays PENDING', async (action) => {
    const response =
      action === 'revoke'
        ? await call('delete', `/api/lab-links/${linkId}`, tokenFor(patientB))
        : await call('patch', `/api/lab-links/${linkId}/${action}`, tokenFor(patientB));
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ message: 'You do not have permission to change this lab link' });
    expect((await LabLink.findById(linkId))!.status).toBe('PENDING');
  });

  it('another patient and another lab cannot see it', async () => {
    const listed = async (user: IUser) => ((await call('get', '/api/lab-links', tokenFor(user))).body.links as { id: string }[]).map((link) => link.id);

    expect(await listed(patientB)).not.toContain(linkId);
    expect(await listed(otherLab)).not.toContain(linkId);
    expect(await listed(patientA)).toContain(linkId);
    expect(await listed(lab)).toContain(linkId);
  });

  it('upload is refused while PENDING, allowed once ACTIVE, refused again after REVOKED — and a refusal stores nothing', async () => {
    const refused = { message: 'This patient has not authorised your lab' };

    let response = await LAB_REPORT(lab, idOf(patientA));
    expect(response.status).toBe(403);
    expect(response.body).toEqual(refused);
    expect(await reportsIssuedBy(lab)).toBe(0);

    await decideLabLink(patientA, linkId, 'approve');
    response = await LAB_REPORT(lab, idOf(patientA));
    expect(response.status).toBe(201);
    expect(await reportsIssuedBy(lab)).toBe(1);

    await decideLabLink(patientA, linkId, 'revoke');
    response = await LAB_REPORT(lab, idOf(patientA));
    expect(response.status).toBe(403);
    expect(response.body).toEqual(refused);
    expect(await reportsIssuedBy(lab)).toBe(1);
  });

  it('a rejected link never permits an upload', async () => {
    const rejectedLab = await createUser('lab');
    await decideLabLink(patientB, (await requestLabLink(rejectedLab, patientB)).id, 'reject');

    const response = await LAB_REPORT(rejectedLab, idOf(patientB));
    expect(response.status).toBe(403);
    expect(await reportsIssuedBy(rejectedLab)).toBe(0);
  });

  it('a lab with a link to one patient cannot upload into another patient’s vault', async () => {
    const response = await LAB_REPORT(otherLab, idOf(patientA));
    expect(response.status).toBe(403);
    expect(await reportsIssuedBy(otherLab)).toBe(0);
  });

  it('a report addressed to a non-patient id is 404 and stores nothing', async () => {
    const response = await LAB_REPORT(lab, idOf(doctor));
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: 'Patient not found' });
    expect(await MedicalDocument.countDocuments({ uploadedBy: doctor._id })).toBe(0);
  });
});
