import { Types } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onAnyAppEvent, type AppEventName } from '../../src/events/appEvents';
import { AccessLog } from '../../src/models/AccessLog';
import { ChainAnchor } from '../../src/models/ChainAnchor';
import { ConsentGrant } from '../../src/models/ConsentGrant';
import { LabLink } from '../../src/models/LabLink';
import type { IUser } from '../../src/models/User';
import {
  approvedConsent,
  activeLabLink,
  call,
  createUser,
  idOf,
  requestConsent,
  requestLabLink,
  tokenFor,
  uploadDocument,
} from '../support/fixtures';

/**
 * Suite 7 — a patient's decision takes effect exactly once (claims C51–C53 in docs/TESTING.md).
 *
 * Consents and lab links used to change state by read → check → save: two decisions arriving together (approve and
 * reject from two tabs, a double-click) both read PENDING and both won, so one record ended up approved AND
 * rejected, with two audit rows, two anchors and two notifications. The specification here is the break-glass rule
 * (C34, C36): one guarded write decides, everything after it happens once, and the database holds at most one live
 * record per pair. Every race is fired over HTTP against the real app; nothing is intercepted.
 */

const ROUNDS = 15;

/** Lets every listener queued with setImmediate run, so "no second event" is checked after the fact, not before. */
const flushEvents = () => new Promise((resolve) => setImmediate(resolve));

const events: Array<{ name: AppEventName; recordId: string }> = [];
let unsubscribe: (() => void) | undefined;

beforeEach(() => {
  events.length = 0;
  unsubscribe = onAnyAppEvent((name, payload) => {
    const recordId = 'consentId' in payload ? payload.consentId : 'labLinkId' in payload ? payload.labLinkId : null;
    if (recordId) events.push({ name, recordId });
  });
});

afterEach(() => unsubscribe?.());

const eventsFor = async (recordId: string) => {
  await flushEvents();
  return events.filter((event) => event.recordId === recordId).map((event) => event.name);
};

const consentAudits = (consentId: string) =>
  AccessLog.find({ 'metadata.consentId': consentId, action: { $in: ['CONSENT_APPROVED', 'CONSENT_REJECTED', 'CONSENT_REVOKED'] } }).lean();

const linkAudits = (linkId: string) =>
  AccessLog.find({ 'metadata.labLinkId': linkId, action: { $in: ['LAB_LINKED', 'LAB_LINK_REJECTED', 'LAB_UNLINKED'] } }).lean();

const statuses = (responses: Array<{ status: number }>) => responses.map((response) => response.status).sort();

describe('C51 concurrent decisions on one consent take effect exactly once', () => {
  it(`${ROUNDS} rounds of approve ×2 + reject ×2 at once: one decision wins, with one audit row, one anchor and one event`, async () => {
    const patient = await createUser('patient');
    const documentId = (await uploadDocument(patient)).id;
    const winners: string[] = [];

    for (let round = 0; round < ROUNDS; round += 1) {
      const doctor = await createUser('doctor');
      const consent = await requestConsent(doctor, patient, documentId);
      await flushEvents();
      events.length = 0;
      const decide = (action: 'approve' | 'reject') => call('patch', `/api/consents/${consent.id}/${action}`, tokenFor(patient));

      const responses = await Promise.all([decide('approve'), decide('reject'), decide('approve'), decide('reject')]);
      const context = `round ${round}: ${responses.map((response) => `${response.status} ${JSON.stringify(response.body)}`).join(' | ')}`;
      expect(statuses(responses), context).toEqual([200, 409, 409, 409]);

      const winner = responses.find((response) => response.status === 200)!.body.consent.status as 'APPROVED' | 'REJECTED';
      winners.push(winner);

      const row = (await ConsentGrant.findById(consent.id).lean())!;
      expect(row.status, context).toBe(winner);
      // Exactly one decision timestamp: the loser must not have written its own.
      expect(Boolean(row.approvedAt), context).toBe(winner === 'APPROVED');
      expect(Boolean(row.rejectedAt), context).toBe(winner === 'REJECTED');

      const audits = await consentAudits(consent.id);
      expect(audits.map((audit) => audit.action), context).toEqual([winner === 'APPROVED' ? 'CONSENT_APPROVED' : 'CONSENT_REJECTED']);
      expect(audits[0].metadata?.status, context).toBe(winner);

      const anchors = await ChainAnchor.find({ recordId: consent.id, event: { $ne: 'REQUESTED' } }).lean();
      expect(anchors.map((anchor) => anchor.event), context).toEqual([winner]);

      expect(await eventsFor(consent.id), context).toEqual([winner === 'APPROVED' ? 'consent.approved' : 'consent.rejected']);
    }

    // Not asserted: which decision wins. Either is a correct outcome; the bug was getting both.
    expect(winners).toHaveLength(ROUNDS);
  });

  it('five concurrent revokes of one approved consent: one succeeds, one audit row, one REVOKED anchor, one event', async () => {
    const patient = await createUser('patient');
    const doctor = await createUser('doctor');
    const documentId = (await uploadDocument(patient)).id;
    const consent = await approvedConsent(doctor, patient, documentId);
    await flushEvents();
    events.length = 0;

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => call('patch', `/api/consents/${consent.id}/revoke`, tokenFor(patient)))
    );
    expect(statuses(responses)).toEqual([200, 409, 409, 409, 409]);

    expect((await consentAudits(consent.id)).map((audit) => audit.action)).toEqual(['CONSENT_APPROVED', 'CONSENT_REVOKED']);
    expect(await ChainAnchor.countDocuments({ recordId: consent.id, event: 'REVOKED' })).toBe(1);
    expect(await eventsFor(consent.id)).toEqual(['consent.revoked']);
  });

  it('five concurrent requests from one doctor for one document: one consent row, one audit row, one anchor', async () => {
    const patient = await createUser('patient');
    const doctor = await createUser('doctor');
    const documentId = (await uploadDocument(patient)).id;

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        call('post', '/api/consents/request', tokenFor(doctor)).send({ patientId: idOf(patient), documentId, purpose: 'Concurrent request' })
      )
    );
    expect(statuses(responses)).toEqual([201, 409, 409, 409, 409]);

    const rows = await ConsentGrant.find({ doctorId: doctor._id, documentId }).lean();
    expect(rows).toHaveLength(1);
    expect(await AccessLog.countDocuments({ action: 'CONSENT_REQUESTED', 'metadata.consentId': rows[0]._id.toString() })).toBe(1);
    expect(await ChainAnchor.countDocuments({ recordId: rows[0]._id })).toBe(1);
    expect(await eventsFor(rows[0]._id.toString())).toEqual(['consent.requested']);
  });
});

describe('C52 concurrent decisions on one lab link take effect exactly once', () => {
  it(`${ROUNDS} rounds of approve ×2 + reject ×2 at once: one decision wins, with one audit row and at most one event`, async () => {
    const patient = await createUser('patient');

    for (let round = 0; round < ROUNDS; round += 1) {
      const lab = await createUser('lab');
      const link = await requestLabLink(lab, patient);
      await flushEvents();
      events.length = 0;
      const decide = (action: 'approve' | 'reject') => call('patch', `/api/lab-links/${link.id}/${action}`, tokenFor(patient));

      const responses = await Promise.all([decide('approve'), decide('reject'), decide('approve'), decide('reject')]);
      const context = `round ${round}: ${responses.map((response) => `${response.status} ${JSON.stringify(response.body)}`).join(' | ')}`;
      expect(statuses(responses), context).toEqual([200, 409, 409, 409]);

      const winner = responses.find((response) => response.status === 200)!.body.link.status as 'ACTIVE' | 'REJECTED';
      const row = (await LabLink.findById(link.id).lean())!;
      expect(row.status, context).toBe(winner);
      expect(Boolean(row.approvedAt), context).toBe(winner === 'ACTIVE');
      expect(Boolean(row.rejectedAt), context).toBe(winner === 'REJECTED');

      const audits = await linkAudits(link.id);
      expect(audits.map((audit) => audit.action), context).toEqual([winner === 'ACTIVE' ? 'LAB_LINKED' : 'LAB_LINK_REJECTED']);
      expect(audits[0].metadata?.status, context).toBe(winner);

      // Only approval notifies the lab (docs/EVENTS.md); a rejection is audit-only.
      expect(await eventsFor(link.id), context).toEqual(winner === 'ACTIVE' ? ['lab.link.approved'] : []);
    }
  });

  it('five concurrent revokes of one active link: one succeeds and one LAB_UNLINKED row is written', async () => {
    const patient = await createUser('patient');
    const lab = await createUser('lab');
    const link = await activeLabLink(lab, patient);

    const responses = await Promise.all(Array.from({ length: 5 }, () => call('delete', `/api/lab-links/${link.id}`, tokenFor(patient))));
    expect(statuses(responses)).toEqual([200, 409, 409, 409, 409]);
    expect((await linkAudits(link.id)).map((audit) => audit.action)).toEqual(['LAB_LINKED', 'LAB_UNLINKED']);
  });

  it('five concurrent link requests from one lab for one patient: one link row, one audit row, one event', async () => {
    const patient = await createUser('patient');
    const lab = await createUser('lab');

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => call('post', '/api/lab-links', tokenFor(lab)).send({ query: patient.email }))
    );
    expect(statuses(responses)).toEqual([201, 409, 409, 409, 409]);

    const rows = await LabLink.find({ labId: lab._id, patientId: patient._id }).lean();
    expect(rows).toHaveLength(1);
    expect(await AccessLog.countDocuments({ action: 'LAB_LINK_REQUESTED', 'metadata.labLinkId': rows[0]._id.toString() })).toBe(1);
    expect(await eventsFor(rows[0]._id.toString())).toEqual(['lab.link.requested']);
  });
});

describe('C53 the database holds at most one live consent per doctor+document and one open link per lab+patient', () => {
  // Inserted directly, with no request handler and so no pre-check: what a second server process could do.
  const isDuplicateKey = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;

  it('a pending consent cannot be inserted beside an approved one, nor a second pending one; closed history is unlimited', async () => {
    const pair = { patientId: new Types.ObjectId(), doctorId: new Types.ObjectId(), documentId: new Types.ObjectId(), purpose: 'x' };
    await ConsentGrant.create({ ...pair, status: 'APPROVED', approvedAt: new Date() });

    await expect(ConsentGrant.create({ ...pair, status: 'PENDING' })).rejects.toSatisfy(isDuplicateKey);
    await expect(ConsentGrant.create({ ...pair, status: 'APPROVED', approvedAt: new Date() })).rejects.toSatisfy(isDuplicateKey);
    await ConsentGrant.create({ ...pair, status: 'REJECTED', rejectedAt: new Date() });
    await ConsentGrant.create({ ...pair, status: 'REVOKED', revokedAt: new Date() });
    await ConsentGrant.create({ ...pair, status: 'REVOKED', revokedAt: new Date() });

    expect(await ConsentGrant.countDocuments(pair)).toBe(4);
  });

  it('a pending link cannot be inserted beside an active one, nor a second pending one; closed history is unlimited', async () => {
    const pair = { labId: new Types.ObjectId(), patientId: new Types.ObjectId() };
    await LabLink.create({ ...pair, status: 'ACTIVE', approvedAt: new Date() });

    await expect(LabLink.create({ ...pair, status: 'PENDING' })).rejects.toSatisfy(isDuplicateKey);
    await expect(LabLink.create({ ...pair, status: 'ACTIVE', approvedAt: new Date() })).rejects.toSatisfy(isDuplicateKey);
    await LabLink.create({ ...pair, status: 'REJECTED', rejectedAt: new Date() });
    await LabLink.create({ ...pair, status: 'REVOKED', revokedAt: new Date() });

    expect(await LabLink.countDocuments(pair)).toBe(3);
  });

  it('after a revoke the pair is free again: a new request and its approval succeed', async () => {
    const patient = await createUser('patient');
    const doctor = await createUser('doctor');
    const lab = await createUser('lab');
    const documentId = (await uploadDocument(patient)).id;

    const consent = await approvedConsent(doctor, patient, documentId);
    expect((await call('patch', `/api/consents/${consent.id}/revoke`, tokenFor(patient))).status).toBe(200);
    expect((await approvedConsent(doctor, patient, documentId)).status).toBe('APPROVED');

    const link = await activeLabLink(lab, patient);
    expect((await call('delete', `/api/lab-links/${link.id}`, tokenFor(patient))).status).toBe(200);
    expect((await activeLabLink(lab, patient)).status).toBe('ACTIVE');
  });
});

/** Guards the fixtures this file leans on: a patient other than the named one still cannot decide. */
describe('the guarded write keeps the ownership rule', () => {
  let owner: IUser;
  let stranger: IUser;

  beforeEach(async () => {
    owner = await createUser('patient');
    stranger = await createUser('patient');
  });

  it('another patient racing the owner is refused and changes nothing', async () => {
    const doctor = await createUser('doctor');
    const documentId = (await uploadDocument(owner)).id;
    const consent = await requestConsent(doctor, owner, documentId);

    const [strangerResponse, ownerResponse] = await Promise.all([
      call('patch', `/api/consents/${consent.id}/reject`, tokenFor(stranger)),
      call('patch', `/api/consents/${consent.id}/approve`, tokenFor(owner)),
    ]);
    expect(strangerResponse.status).toBe(403);
    expect(ownerResponse.status).toBe(200);
    expect((await consentAudits(consent.id)).map((audit) => audit.action)).toEqual(['CONSENT_APPROVED']);
  });
});
