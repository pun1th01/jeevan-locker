import { beforeAll, describe, expect, it } from 'vitest';
import type { IUser } from '../../src/models/User';
import {
  activeLabLink,
  approvedConsent,
  breakGlass,
  call,
  createUser,
  decideConsent,
  idOf,
  requestConsent,
  requestLabLink,
  revokeGrant,
  tokenFor,
  uploadDocument,
} from '../support/fixtures';

/**
 * Suite 1g — response minimisation for consents, grants and lab links (claim C60 in docs/TESTING.md; documents are C59,
 * in the read matrix).
 *
 * The specification is the wire shapes written in the API documents: `Consent` (API_CONSENT_EMERGENCY.md §3.2),
 * `EmergencyAccess` (§4.2) and `LabLink` (API_LAB.md §2). Every response either party receives must carry exactly
 * those fields. Each reference to another person must be exactly `{ id, name }` (a lab adds `organisation`), and no
 * email, verification flag or account date of anyone may appear anywhere in them.
 */

interface Shape {
  required: string[];
  optional: string[];
}

const CONSENT: Shape = {
  required: ['document', 'doctor', 'id', 'patient', 'purpose', 'requestedAt', 'status'],
  optional: ['anchors', 'approvedAt', 'rejectedAt', 'revokedAt'],
};

const EMERGENCY: Shape = {
  required: ['createdAt', 'doctorId', 'documentId', 'expiresAt', 'id', 'patientId', 'reason', 'status'],
  optional: ['afterRevocation', 'anchors', 'doctor', 'document', 'followsRevokedGrantId', 'patient', 'revokedAt', 'revokedBy'],
};

const LAB_LINK: Shape = {
  required: ['id', 'lab', 'patient', 'requestedAt', 'status'],
  optional: ['approvedAt', 'rejectedAt', 'revokedAt'],
};

const PERSON = ['id', 'name'];
const LAB = ['id', 'name', 'organisation'];
const DOCUMENT = ['id', 'title'];

const keysOf = (value: unknown) => Object.keys(value as Record<string, unknown>).sort();

const expectShape = (record: Record<string, unknown>, shape: Shape, context: string) => {
  const keys = keysOf(record);
  for (const key of shape.required) expect(keys, `${context}: missing ${key}`).toContain(key);
  expect(keys.filter((key) => !shape.required.includes(key) && !shape.optional.includes(key)), `${context}: undocumented fields`).toEqual([]);
};

/** Nothing account-level about any person: no email, verification flag, role or account date, at any depth. */
const expectNoAccountFields = (payload: unknown, context: string) => {
  const text = JSON.stringify(payload);
  expect(text, `${context}: an email address`).not.toMatch(/@test\.jeevanlocker\.dev/);
  for (const field of ['"email"', '"verified"', '"role"']) expect(text, `${context}: ${field}`).not.toContain(field);
};

const expectConsent = (consent: Record<string, unknown>, context: string) => {
  expectShape(consent, CONSENT, context);
  expect(keysOf(consent.patient), `${context} patient`).toEqual(PERSON);
  expect(keysOf(consent.doctor), `${context} doctor`).toEqual(PERSON);
  expect(keysOf(consent.document), `${context} document`).toEqual(DOCUMENT);
  expectNoAccountFields(consent, context);
};

const expectGrant = (grant: Record<string, unknown>, context: string) => {
  expectShape(grant, EMERGENCY, context);
  for (const [field, shape] of [
    ['doctor', PERSON],
    ['patient', PERSON],
    ['document', DOCUMENT],
  ] as const) {
    if (grant[field] !== undefined) expect(keysOf(grant[field]), `${context} ${field}`).toEqual(shape);
  }
  expectNoAccountFields(grant, context);
};

const expectLink = (link: Record<string, unknown>, context: string) => {
  expectShape(link, LAB_LINK, context);
  expect(keysOf(link.patient), `${context} patient`).toEqual(PERSON);
  expect(keysOf(link.lab), `${context} lab`).toEqual(LAB);
  expectNoAccountFields(link, context);
};

let patient: IUser;
let doctor: IUser;
let lab: IUser;
let documentId: string;

beforeAll(async () => {
  patient = await createUser('patient');
  doctor = await createUser('doctor');
  lab = await createUser('lab');
  documentId = (await uploadDocument(patient)).id;
});

describe('C60 consents, grants and lab links carry exactly their documented fields, to both parties, and no account details', () => {
  it('consents: the doctor’s request response and list, the patient’s lists, and every decision response', async () => {
    const request = await call('post', '/api/consents/request', tokenFor(doctor)).send({ patientId: idOf(patient), documentId, purpose: 'Review' });
    expect(request.status).toBe(201);
    expectConsent(request.body.consent, 'doctor POST /consents/request');

    const rejected = await requestConsent(await createUser('doctor'), patient, documentId);
    const reject = await call('patch', `/api/consents/${rejected.id}/reject`, tokenFor(patient));
    expectConsent(reject.body.consent, 'patient PATCH reject');

    const approve = await call('patch', `/api/consents/${request.body.consent.id as string}/approve`, tokenFor(patient));
    expectConsent(approve.body.consent, 'patient PATCH approve');
    expect(approve.body.consent).toHaveProperty('approvedAt');

    for (const [actor, url] of [
      [doctor, '/api/consents/my'],
      [patient, '/api/consents/received'],
      [patient, '/api/consents/pending'],
    ] as const) {
      const list = await call('get', url, tokenFor(actor));
      expect(list.status, url).toBe(200);
      for (const consent of list.body.consents) expectConsent(consent, `${actor.role} GET ${url}`);
    }

    const revoke = await decideConsent(patient, request.body.consent.id, 'revoke');
    expectConsent(revoke as unknown as Record<string, unknown>, 'patient PATCH revoke');
  });

  it('break-glass grants: the doctor’s grant response and list, the patient’s list, and the revoke response', async () => {
    const otherDocument = (await uploadDocument(patient)).id;
    const grant = await call('post', '/api/emergency-access', tokenFor(doctor)).send({ patientId: idOf(patient), documentId: otherDocument, reason: 'Unconscious' });
    expect(grant.status).toBe(201);
    expectGrant(grant.body.emergencyAccess, 'doctor POST /emergency-access');

    for (const actor of [doctor, patient]) {
      const list = await call('get', '/api/emergency-access?status=all', tokenFor(actor));
      expect(list.status).toBe(200);
      expect(list.body.emergencyAccesses.length, actor.role).toBeGreaterThan(0);
      for (const row of list.body.emergencyAccesses) expectGrant(row, `${actor.role} GET /emergency-access`);
    }

    const revoke = await call('delete', `/api/emergency-access/${grant.body.emergencyAccess.id as string}`, tokenFor(patient));
    expect(revoke.status).toBe(200);
    expectGrant(revoke.body.emergencyAccess, 'patient DELETE /emergency-access/:id');

    // A grant after the revoke carries the re-grant flag and the earlier grant id; still nothing else.
    const again = await breakGlass(doctor, patient, otherDocument);
    expect(again.afterRevocation).toBe(true);
    expectGrant(again as unknown as Record<string, unknown>, 'doctor POST after revoke');
    await revokeGrant(patient, again.id);
  });

  it('lab links: the lab’s request response and list, the patient’s list, and every decision response', async () => {
    const request = await call('post', '/api/lab-links', tokenFor(lab)).send({ query: patient.email });
    expect(request.status).toBe(201);
    expectLink(request.body.link, 'lab POST /lab-links');

    const otherLab = await createUser('lab');
    const rejected = await requestLabLink(otherLab, patient);
    expectLink((await call('patch', `/api/lab-links/${rejected.id}/reject`, tokenFor(patient))).body.link, 'patient PATCH reject');
    expectLink((await call('patch', `/api/lab-links/${request.body.link.id as string}/approve`, tokenFor(patient))).body.link, 'patient PATCH approve');

    for (const actor of [lab, patient]) {
      const list = await call('get', '/api/lab-links', tokenFor(actor));
      expect(list.status).toBe(200);
      for (const link of list.body.links) expectLink(link, `${actor.role} GET /lab-links`);
    }

    expectLink((await call('delete', `/api/lab-links/${request.body.link.id as string}`, tokenFor(patient))).body.link, 'patient DELETE /lab-links/:id');
    await activeLabLink(lab, patient);
  });

  it('a consent approved through the fixture path has the same shape (control for the helpers above)', async () => {
    const consent = await approvedConsent(await createUser('doctor'), patient, (await uploadDocument(patient)).id);
    expectConsent(consent as unknown as Record<string, unknown>, 'fixture approve');
  });
});
