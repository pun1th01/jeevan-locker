import { Types } from 'mongoose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { onAppEvent, type AppEventMap } from '../../src/events/appEvents';
import { AccessLog, type AuditAction } from '../../src/models/AccessLog';
import { ChainAnchor } from '../../src/models/ChainAnchor';
import { EmergencyAccess } from '../../src/models/EmergencyAccess';
import type { IUser } from '../../src/models/User';
import { runExpirySweep, startExpiryWorker, stopExpiryWorker, waitForExpiryWorkerIdle } from '../../src/services/expiryWorker.service';
import { expireDueGrants, expireEmergencyAccesses } from '../../src/utils/emergencyAccess.util';
import { breakGlass, call, createUser, idOf, revokeGrant, tokenFor, uploadDocument } from '../support/fixtures';
import { waitFor } from '../support/waitFor';

/**
 * Suite 4 — break-glass hardening (claims C34–C39 in docs/TESTING.md). The specification is Task 7's design as
 * documented in docs/EVENTS.md, docs/ANCHORING.md and server/.env.example: patient revocation, the re-grant flag,
 * the concurrency cap, REVOKED as a terminal state, and exactly-once expiry by the scheduled job or the lazy path.
 */

const READS = ['', '/view', '/download', '/integrity'] as const;

/** Lets every listener queued with setImmediate run, so "no second event" is checked after the fact, not before. */
const flushEvents = () => new Promise((resolve) => setImmediate(resolve));

const auditRows = (action: AuditAction, grantId: string) => AccessLog.find({ action, 'metadata.emergencyAccessId': grantId }).lean();

/** A grant that is ACTIVE but whose window has passed — the state both expiry paths act on. */
const lapse = (grantId: string) => EmergencyAccess.updateOne({ _id: grantId }, { $set: { expiresAt: new Date(Date.now() - 1_000) } });

const setting = { patient: null as IUser | null };
beforeAll(async () => {
  setting.patient = await createUser('patient');
});

afterEach(async () => {
  stopExpiryWorker();
  await waitForExpiryWorkerIdle();
});

describe('C34 revoking ends access on the doctor’s very next request, and is recorded once', () => {
  it('every read path and the list close immediately; one audit row, one event to the doctor; a second revoke is a 409 that records nothing', async () => {
    const patient = await createUser('patient');
    const doctor = await createUser('doctor');
    const documentId = (await uploadDocument(patient)).id;
    const grant = await breakGlass(doctor, patient, documentId);

    for (const suffix of READS) {
      expect((await call('get', `/api/documents/${documentId}${suffix}`, tokenFor(doctor))).status, `before ${suffix}`).toBe(200);
    }

    const events: AppEventMap['emergency.revoked'][] = [];
    const unsubscribe = onAppEvent('emergency.revoked', (payload) => {
      if (payload.emergencyAccessId === grant.id) events.push(payload);
    });

    try {
      expect((await call('delete', `/api/emergency-access/${grant.id}`, tokenFor(patient))).status).toBe(200);

      // No sweep, no job, no wait: the very next request.
      for (const suffix of READS) {
        const response = await call('get', `/api/documents/${documentId}${suffix}`, tokenFor(doctor));
        expect(response.status, `after ${suffix}`).toBe(403);
      }
      const listed = (await call('get', '/api/documents/my-documents', tokenFor(doctor))).body.documents as { id: string }[];
      expect(listed.map((document) => document.id)).not.toContain(documentId);
      const live = (await call('get', '/api/emergency-access', tokenFor(doctor))).body.emergencyAccesses as { id: string }[];
      expect(live.map((entry) => entry.id)).not.toContain(grant.id);

      const audit = await auditRows('EMERGENCY_ACCESS_REVOKED', grant.id);
      expect(audit).toHaveLength(1);
      expect(audit[0].userId.toString()).toBe(idOf(patient));
      expect(audit[0].metadata).toMatchObject({ doctorId: idOf(doctor), patientId: idOf(patient) });

      await waitFor(() => events.length === 1, { description: 'the emergency.revoked event' });
      expect(events[0]).toMatchObject({ recipientUserId: idOf(doctor), actorUserId: idOf(patient), documentId });

      const again = await call('delete', `/api/emergency-access/${grant.id}`, tokenFor(patient));
      expect(again.status).toBe(409);
      expect(again.body).toEqual({ message: 'Only active emergency access can be revoked' });
      await flushEvents();
      expect(await auditRows('EMERGENCY_ACCESS_REVOKED', grant.id)).toHaveLength(1);
      expect(events).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });
});

describe('C35 a return after revocation is flagged everywhere — and only a real return is', () => {
  it('same doctor, same document, inside the window: flagged on the grant, the audit row, the event and the patient’s list', async () => {
    const patient = await createUser('patient');
    const doctor = await createUser('doctor');
    const documentId = (await uploadDocument(patient)).id;
    const first = await breakGlass(doctor, patient, documentId);
    await revokeGrant(patient, first.id);

    const granted: AppEventMap['emergency.granted'][] = [];
    const unsubscribe = onAppEvent('emergency.granted', (payload) => {
      if (payload.documentId === documentId) granted.push(payload);
    });

    try {
      const second = await breakGlass(doctor, patient, documentId);
      expect(second.afterRevocation).toBe(true);
      expect((await EmergencyAccess.findById(second.id))!.followsRevokedGrantId?.toString()).toBe(first.id);

      const [audit] = await auditRows('EMERGENCY_ACCESS_GRANTED', second.id);
      expect(audit.metadata).toMatchObject({ afterRevocation: 'true', followsRevokedGrantId: first.id });
      expect(audit.metadata?.previouslyRevokedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      await waitFor(() => granted.length === 1, { description: 'the emergency.granted event' });
      expect(granted[0].afterRevocation).toBe(true);
      expect(granted[0].message).toMatch(/again after you revoked it/);

      const patientView = (await call('get', '/api/emergency-access', tokenFor(patient))).body.emergencyAccesses as { id: string; afterRevocation?: boolean }[];
      expect(patientView.find((entry) => entry.id === second.id)?.afterRevocation).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it('the flag stays off-chain: the GRANTED preimage has exactly the documented fields', async () => {
    const patient = await createUser('patient');
    const doctor = await createUser('doctor');
    const documentId = (await uploadDocument(patient)).id;
    await revokeGrant(patient, (await breakGlass(doctor, patient, documentId)).id);
    const flagged = await breakGlass(doctor, patient, documentId);

    const anchor = (await ChainAnchor.findOne({ recordId: new Types.ObjectId(flagged.id), event: 'GRANTED' }))!;
    expect(Object.keys(JSON.parse(anchor.preimage) as object)).toEqual([
      'v', 'type', 'event', 'emergencyAccessId', 'doctorId', 'patientId', 'documentId', 'documentHash', 'reason', 'createdAt', 'expiresAt',
    ]);
  });

  it.each([
    ['a first-ever grant', 'first'],
    ['a different doctor on the revoked document', 'otherDoctor'],
    ['the same doctor on a different document', 'otherDocument'],
    ['the same doctor and document, after the window has passed', 'afterWindow'],
  ] as const)('is not flagged: %s', async (_label, variant) => {
    const patient = await createUser('patient');
    const doctor = await createUser('doctor');
    const documentId = (await uploadDocument(patient)).id;

    let grantee = doctor;
    let target = documentId;
    if (variant !== 'first') {
      const revoked = await breakGlass(doctor, patient, documentId);
      await revokeGrant(patient, revoked.id);
      if (variant === 'otherDoctor') grantee = await createUser('doctor');
      if (variant === 'otherDocument') target = (await uploadDocument(patient)).id;
      if (variant === 'afterWindow') {
        await EmergencyAccess.updateOne({ _id: revoked.id }, { $set: { revokedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } });
      }
    }

    const grant = await breakGlass(grantee, patient, target);
    expect(grant.afterRevocation ?? false).toBe(false);
    const [audit] = await auditRows('EMERGENCY_ACCESS_GRANTED', grant.id);
    expect(audit.metadata).toMatchObject({ afterRevocation: 'false' });
  });
});

describe('C36 a doctor cannot hold more live grants than the cap — including under concurrent requests', () => {
  it('the request over the cap is refused and creates nothing; lapsed and revoked grants free a slot', async () => {
    vi.stubEnv('EMERGENCY_MAX_ACTIVE_GRANTS', '2');
    const patient = await createUser('patient');
    const doctor = await createUser('doctor');
    const documents = [];
    for (let index = 0; index < 4; index += 1) documents.push((await uploadDocument(patient)).id);

    const first = await breakGlass(doctor, patient, documents[0]);
    await breakGlass(doctor, patient, documents[1]);

    const refused = await call('post', '/api/emergency-access', tokenFor(doctor)).send({ patientId: idOf(patient), documentId: documents[2], reason: 'third' });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/^You already have 2 active emergency accesses \(limit 2\)/);
    expect(await EmergencyAccess.countDocuments({ doctorId: doctor._id, documentId: new Types.ObjectId(documents[2]) })).toBe(0);

    await lapse(first.id);
    const third = await breakGlass(doctor, patient, documents[2]); // the lapsed grant no longer counts

    await revokeGrant(patient, third.id);
    await breakGlass(doctor, patient, documents[3]); // nor does a revoked one
  });

  it('concurrent requests for different documents never push a doctor past the cap', async () => {
    vi.stubEnv('EMERGENCY_MAX_ACTIVE_GRANTS', '2');
    const patient = await createUser('patient');
    const doctor = await createUser('doctor');
    const documents = [];
    for (let index = 0; index < 6; index += 1) documents.push((await uploadDocument(patient)).id);

    const responses = await Promise.all(
      documents.map((documentId) =>
        call('post', '/api/emergency-access', tokenFor(doctor)).send({ patientId: idOf(patient), documentId, reason: 'concurrent' })
      )
    );

    const statuses = responses.map((response) => response.status).sort();
    const live = await EmergencyAccess.countDocuments({ doctorId: doctor._id, status: 'ACTIVE', expiresAt: { $gt: new Date() } });
    expect({ granted: statuses.filter((status) => status === 201).length, live }, `statuses ${statuses.join(',')}`).toEqual({ granted: 2, live: 2 });
  });

  it('concurrent requests for the same document create one grant, not several', async () => {
    const patient = await createUser('patient');
    const doctor = await createUser('doctor');
    const documentId = (await uploadDocument(patient)).id;

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => call('post', '/api/emergency-access', tokenFor(doctor)).send({ patientId: idOf(patient), documentId, reason: 'duplicate' }))
    );

    const statuses = responses.map((response) => response.status).sort();
    const rows = await EmergencyAccess.countDocuments({ doctorId: doctor._id, documentId: new Types.ObjectId(documentId), status: 'ACTIVE' });
    expect({ rows, created: statuses.filter((status) => status === 201).length }, `statuses ${statuses.join(',')}`).toEqual({ rows: 1, created: 1 });
  });
});

describe('C37 REVOKED and EXPIRED are terminal', () => {
  it('a revoked grant whose window then passes stays REVOKED through every expiry path and a second revoke', async () => {
    const patient = await createUser('patient');
    const doctor = await createUser('doctor');
    const documentId = (await uploadDocument(patient)).id;
    const grant = await breakGlass(doctor, patient, documentId);
    await revokeGrant(patient, grant.id);
    const revoked = (await EmergencyAccess.findById(grant.id))!;
    await lapse(grant.id);

    for (let round = 0; round < 3; round += 1) {
      await runExpirySweep();
      await expireDueGrants(200);
      await expireEmergencyAccesses(doctor._id, documentId);
      expect((await call('get', `/api/documents/${documentId}`, tokenFor(doctor))).status).toBe(403);
      expect((await call('delete', `/api/emergency-access/${grant.id}`, tokenFor(patient))).status).toBe(409);
    }

    const after = (await EmergencyAccess.findById(grant.id))!;
    expect(after.status).toBe('REVOKED');
    expect(after.revokedAt?.getTime()).toBe(revoked.revokedAt?.getTime());
    expect(after.revokedBy?.toString()).toBe(idOf(patient));
    expect(await auditRows('EMERGENCY_ACCESS_EXPIRED', grant.id)).toHaveLength(0);
    expect(await auditRows('EMERGENCY_ACCESS_REVOKED', grant.id)).toHaveLength(1);
  });

  it('an expired grant cannot be revoked or revived', async () => {
    const patient = await createUser('patient');
    const doctor = await createUser('doctor');
    const documentId = (await uploadDocument(patient)).id;
    const grant = await breakGlass(doctor, patient, documentId);
    await lapse(grant.id);
    await runExpirySweep();

    expect((await call('delete', `/api/emergency-access/${grant.id}`, tokenFor(patient))).status).toBe(409);
    expect((await call('get', `/api/documents/${documentId}`, tokenFor(doctor))).status).toBe(403);
    expect((await EmergencyAccess.findById(grant.id))!.status).toBe('EXPIRED');
    expect(await auditRows('EMERGENCY_ACCESS_EXPIRED', grant.id)).toHaveLength(1);
    expect(await auditRows('EMERGENCY_ACCESS_REVOKED', grant.id)).toHaveLength(0);
  });
});

describe('C38 expiry is exactly-once under contention', () => {
  const ROUNDS = 30;

  it(`${ROUNDS} rounds x 7 concurrent expirers (job, sweeps, and the doctor’s own requests): exactly one EXPIRED row each round`, async () => {
    const patient = await createUser('patient');
    const doctor = await createUser('doctor');
    const documentId = (await uploadDocument(patient)).id;
    const doctorToken = tokenFor(doctor);

    for (let round = 0; round < ROUNDS; round += 1) {
      const grant = await EmergencyAccess.create({
        doctorId: doctor._id,
        patientId: patient._id,
        documentId,
        reason: `race ${round}`,
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() - 1_000),
      });
      const grantId = grant._id.toString();

      await Promise.all([
        expireDueGrants(200),
        runExpirySweep(),
        expireEmergencyAccesses(doctor._id),
        expireEmergencyAccesses(doctor._id, documentId),
        call('get', `/api/documents/${documentId}`, doctorToken),
        call('get', '/api/documents/my-documents', doctorToken),
        call('get', '/api/emergency-access', doctorToken),
      ]);

      expect((await EmergencyAccess.findById(grantId))!.status, `round ${round}`).toBe('EXPIRED');
      const rows = await auditRows('EMERGENCY_ACCESS_EXPIRED', grantId);
      expect(rows, `round ${round}`).toHaveLength(1);
      expect(rows[0]).toMatchObject({ ipAddress: 'system' });
      expect(rows[0].userId.toString()).toBe(idOf(doctor));
    }
  });

  it(`${ROUNDS} rounds of a patient revoking a lapsed grant while it expires: exactly one terminal state, one audit row`, async () => {
    const patient = await createUser('patient');
    const doctor = await createUser('doctor');
    const documentId = (await uploadDocument(patient)).id;
    const outcomes = { REVOKED: 0, EXPIRED: 0 };

    for (let round = 0; round < ROUNDS; round += 1) {
      const grant = await EmergencyAccess.create({
        doctorId: doctor._id,
        patientId: patient._id,
        documentId,
        reason: `revoke race ${round}`,
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() - 1_000),
      });
      const grantId = grant._id.toString();

      const [revokeResponse] = await Promise.all([
        call('delete', `/api/emergency-access/${grantId}`, tokenFor(patient)),
        runExpirySweep(),
        expireEmergencyAccesses(doctor._id, documentId),
      ]);

      const status = (await EmergencyAccess.findById(grantId))!.status;
      const revokedRows = (await auditRows('EMERGENCY_ACCESS_REVOKED', grantId)).length;
      const expiredRows = (await auditRows('EMERGENCY_ACCESS_EXPIRED', grantId)).length;

      if (status === 'REVOKED') {
        expect({ revoke: revokeResponse.status, revokedRows, expiredRows }, `round ${round}`).toEqual({ revoke: 200, revokedRows: 1, expiredRows: 0 });
      } else {
        expect({ status, revoke: revokeResponse.status, revokedRows, expiredRows }, `round ${round}`).toEqual({ status: 'EXPIRED', revoke: 409, revokedRows: 0, expiredRows: 1 });
      }
      outcomes[status as keyof typeof outcomes] += 1;
    }

    expect(outcomes.REVOKED + outcomes.EXPIRED).toBe(ROUNDS);
  });
});

describe('C38 an expiry cannot overwrite a revocation that lands between its read and its write', () => {
  /**
   * The one interleaving the looped races above cannot force: the expiry job has READ the grant as ACTIVE, the
   * patient revokes it, and only then does the expiry WRITE. Only the status guard on that write
   * ({ _id, status: 'ACTIVE' }) stops the revocation being turned into an expiry.
   *
   * The ordering is made deterministic with a spy on EmergencyAccess.updateOne that pauses the expiry's write,
   * performs the real revoke over HTTP in that gap, then runs the real write. Nothing is faked: every database
   * operation is the real one, and the spy only decides when the expiry's write happens. This is the only place in
   * the suite that intercepts a call (see docs/TESTING.md).
   */
  it('the revocation stands: REVOKED, one revocation row, no expiry row', async () => {
    await runExpirySweep(); // clean slate: this grant must be the only lapsed one the sweep reads
    const patient = await createUser('patient');
    const doctor = await createUser('doctor');
    const documentId = (await uploadDocument(patient)).id;
    const grant = await EmergencyAccess.create({
      doctorId: doctor._id,
      patientId: patient._id,
      documentId,
      reason: 'interleaving',
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() - 1_000),
    });
    const grantId = grant._id.toString();

    const realUpdateOne = EmergencyAccess.updateOne.bind(EmergencyAccess);
    const setsStatus = (update: unknown, status: string) => Reflect.get(Reflect.get(Object(update), '$set') ?? {}, 'status') === status;
    let revokeStatusInGap: number | null = null;

    const spy = vi.spyOn(EmergencyAccess, 'updateOne').mockImplementation(((...args: Parameters<typeof EmergencyAccess.updateOne>) => {
      if (revokeStatusInGap !== null || !setsStatus(args[1], 'EXPIRED')) {
        return realUpdateOne(...args);
      }

      return (async () => {
        // The sweep has read this grant as ACTIVE and is about to write EXPIRED. The patient revokes it now.
        revokeStatusInGap = (await call('delete', `/api/emergency-access/${grantId}`, tokenFor(patient))).status;
        return realUpdateOne(...args);
      })();
    }) as unknown as typeof EmergencyAccess.updateOne);

    try {
      await runExpirySweep();
    } finally {
      spy.mockRestore();
    }

    expect(revokeStatusInGap, 'the revoke ran inside the gap').toBe(200);
    expect((await EmergencyAccess.findById(grantId))!.status).toBe('REVOKED');
    expect(await auditRows('EMERGENCY_ACCESS_REVOKED', grantId)).toHaveLength(1);
    expect(await auditRows('EMERGENCY_ACCESS_EXPIRED', grantId)).toHaveLength(0);
  });
});

describe('C39 the scheduled job ends lapsed grants on its own, and a backlog cannot starve', () => {
  it('with no request from the doctor, the running job expires the grant: one audit row, marked as the system', async () => {
    const patient = await createUser('patient');
    const doctor = await createUser('doctor');
    const documentId = (await uploadDocument(patient)).id;
    const grant = await breakGlass(doctor, patient, documentId);
    await lapse(grant.id);

    vi.stubEnv('EMERGENCY_EXPIRY_POLL_MS', '50');
    startExpiryWorker();
    await waitFor(async () => (await EmergencyAccess.findById(grant.id))!.status === 'EXPIRED', { timeoutMs: 10_000, description: 'the job to expire the grant' });
    stopExpiryWorker();
    await waitForExpiryWorkerIdle();

    const rows = await auditRows('EMERGENCY_ACCESS_EXPIRED', grant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ipAddress: 'system', metadata: { patientId: idOf(patient), doctorId: idOf(doctor) } });

    const patientExpired = (await call('get', '/api/emergency-access?status=EXPIRED', tokenFor(patient))).body.emergencyAccesses as { id: string }[];
    expect(patientExpired.map((entry) => entry.id)).toContain(grant.id);
  });

  it('a backlog larger than one batch drains in one sweep, oldest expiry first, one row per grant', async () => {
    await runExpirySweep(); // start from a clean slate: nothing lapsed left over from earlier tests
    vi.stubEnv('EMERGENCY_EXPIRY_BATCH_LIMIT', '5');
    const patient = await createUser('patient');
    const doctor = await createUser('doctor');

    // One document per grant: a doctor may hold only one ACTIVE grant per document (the partial unique index), and
    // expiry never reads the document itself, so distinct ids are all the backlog needs.
    const backlog: InstanceType<typeof EmergencyAccess>[] = [];
    for (let index = 0; index < 12; index += 1) {
      backlog.push(
        await EmergencyAccess.create({
          doctorId: doctor._id,
          patientId: patient._id,
          documentId: new Types.ObjectId(),
          reason: `backlog ${index}`,
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() - (12 - index) * 60_000), // index 0 lapsed first
        })
      );
    }

    expect(await expireDueGrants(5)).toBe(5);
    const statusOf = async () => Promise.all(backlog.map(async (grant) => (await EmergencyAccess.findById(grant._id))!.status));
    expect(await statusOf()).toEqual([...Array(5).fill('EXPIRED'), ...Array(7).fill('ACTIVE')]);

    expect(await runExpirySweep()).toBe(7);
    expect(await statusOf()).toEqual(Array(12).fill('EXPIRED'));
    for (const grant of backlog) {
      expect(await auditRows('EMERGENCY_ACCESS_EXPIRED', grant._id.toString())).toHaveLength(1);
    }
  });
});
