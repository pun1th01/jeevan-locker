import { createHash } from 'crypto';
import { JsonRpcProvider } from 'ethers';
import { Types } from 'mongoose';
import { beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { AccessLog } from '../../src/models/AccessLog';
import { ChainAnchor, type IChainAnchor } from '../../src/models/ChainAnchor';
import { ConsentGrant } from '../../src/models/ConsentGrant';
import { EmergencyAccess } from '../../src/models/EmergencyAccess';
import { MedicalDocument } from '../../src/models/MedicalDocument';
import type { IUser } from '../../src/models/User';
import { reconcileMissingAnchors } from '../../src/services/anchorQueue.service';
import { approvedConsent, breakGlass, call, createUser, decideConsent, requestConsent, revokeGrant, tokenFor, uploadDocument } from '../support/fixtures';
import { anchorInterface, anchorsFor, drainAnchors, onChainKey, readChainDigest, withRegistry } from '../support/anchors';
import { freePort } from '../support/hardhat';
import { waitFor } from '../support/waitFor';

/**
 * Suite 3 — on-chain audit anchoring (claims C26–C29 and C31–C33 in docs/TESTING.md; C30, the real outage, is
 * outage.test.ts). The specification is docs/ANCHORING.md.
 *
 * The preimages below are rebuilt by THIS file from ANCHORING.md §2 — the key order and fields as documented —
 * and never by calling the server's preimage builder. If the server and the document disagree, this suite fails.
 * The chain is read directly with ethers.
 */

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

// ---------- the specification, written out: ANCHORING.md §2 ----------

const CONSENT_TIMESTAMP = { REQUESTED: 'requestedAt', APPROVED: 'approvedAt', REJECTED: 'rejectedAt', REVOKED: 'revokedAt' } as const;

const specPreimage = async (anchor: IChainAnchor): Promise<string | null> => {
  if (anchor.recordType === 'consent') {
    const consent = await ConsentGrant.findById(anchor.recordId);
    if (!consent) return null;
    const document = await MedicalDocument.findById(consent.documentId);
    const occurredAt = consent[CONSENT_TIMESTAMP[anchor.event as keyof typeof CONSENT_TIMESTAMP]];
    if (!occurredAt) return null;
    return JSON.stringify({
      v: 1,
      type: 'consent',
      event: anchor.event,
      consentId: consent._id.toString(),
      patientId: consent.patientId.toString(),
      doctorId: consent.doctorId.toString(),
      documentId: consent.documentId.toString(),
      documentHash: document?.documentHash ?? null,
      purpose: consent.purpose,
      occurredAt: occurredAt.toISOString(),
    });
  }

  const grant = await EmergencyAccess.findById(anchor.recordId);
  if (!grant) return null;
  const document = await MedicalDocument.findById(grant.documentId);

  if (anchor.event === 'GRANTED') {
    return JSON.stringify({
      v: 1,
      type: 'emergency',
      event: 'GRANTED',
      emergencyAccessId: grant._id.toString(),
      doctorId: grant.doctorId.toString(),
      patientId: grant.patientId.toString(),
      documentId: grant.documentId.toString(),
      documentHash: document?.documentHash ?? null,
      reason: grant.reason,
      createdAt: grant.createdAt.toISOString(),
      expiresAt: grant.expiresAt.toISOString(),
    });
  }

  if (!grant.revokedAt || !grant.revokedBy) return null;
  return JSON.stringify({
    v: 1,
    type: 'emergency',
    event: 'REVOKED',
    emergencyAccessId: grant._id.toString(),
    doctorId: grant.doctorId.toString(),
    patientId: grant.patientId.toString(),
    documentId: grant.documentId.toString(),
    documentHash: document?.documentHash ?? null,
    grantedAt: grant.createdAt.toISOString(),
    revokedBy: grant.revokedBy.toString(),
    revokedAt: grant.revokedAt.toISOString(),
  });
};

// ---------- fixtures ----------

let admin: IUser;

/** One consent that was approved and then revoked: REQUESTED, APPROVED and REVOKED anchored. */
const consentCase = async () => {
  const patient = await createUser('patient');
  const doctor = await createUser('doctor');
  const documentId = (await uploadDocument(patient)).id;
  const consent = await approvedConsent(doctor, patient, documentId);
  await decideConsent(patient, consent.id, 'revoke');
  await drainAnchors();
  return { patient, doctor, documentId, consentId: consent.id };
};

/** One break-glass grant that the patient revoked: GRANTED and REVOKED anchored. */
const grantCase = async () => {
  const patient = await createUser('patient');
  const doctor = await createUser('doctor');
  const documentId = (await uploadDocument(patient)).id;
  const grant = await breakGlass(doctor, patient, documentId);
  await revokeGrant(patient, grant.id);
  await drainAnchors();
  return { patient, doctor, documentId, grantId: grant.id };
};

/** The full set: every consent outcome and both grant outcomes. */
interface World {
  approvedThenRevoked: string;
  rejected: string;
  grantRevoked: string;
  grantLive: string;
  patient: IUser;
  doctor: IUser;
  documentId: string;
}
let world: World;

const verify = async (anchor: IChainAnchor) => (await call('get', `/api/admin/anchors/${anchor._id.toString()}/verify`, tokenFor(admin))).body;

beforeAll(async () => {
  admin = await createUser('admin');
  const patient = await createUser('patient');
  const doctor = await createUser('doctor');
  const [documentId, rejectedDocument, revokedGrantDocument, liveGrantDocument] = [
    (await uploadDocument(patient)).id,
    (await uploadDocument(patient)).id,
    (await uploadDocument(patient)).id,
    (await uploadDocument(patient)).id,
  ];

  const approved = await approvedConsent(doctor, patient, documentId);
  await decideConsent(patient, approved.id, 'revoke');
  const rejected = await requestConsent(doctor, patient, rejectedDocument);
  await decideConsent(patient, rejected.id, 'reject');
  const grantRevoked = await breakGlass(doctor, patient, revokedGrantDocument);
  await revokeGrant(patient, grantRevoked.id);
  const grantLive = await breakGlass(doctor, patient, liveGrantDocument);
  await drainAnchors();

  world = { approvedThenRevoked: approved.id, rejected: rejected.id, grantRevoked: grantRevoked.id, grantLive: grantLive.id, patient, doctor, documentId };
});

describe('C26 every anchored event is recomputable from the database record alone', () => {
  it('exactly the events that happened are anchored, and nothing else', async () => {
    const events = async (recordId: string) => (await anchorsFor(recordId)).map((anchor) => `${anchor.event}:${anchor.status}`).sort();

    expect(await events(world.approvedThenRevoked)).toEqual(['APPROVED:ANCHORED', 'REQUESTED:ANCHORED', 'REVOKED:ANCHORED']);
    expect(await events(world.rejected)).toEqual(['REJECTED:ANCHORED', 'REQUESTED:ANCHORED']);
    expect(await events(world.grantRevoked)).toEqual(['GRANTED:ANCHORED', 'REVOKED:ANCHORED']);
    expect(await events(world.grantLive)).toEqual(['GRANTED:ANCHORED']);
  });

  it('the preimage rebuilt from ANCHORING.md §2 equals the stored preimage, and its SHA-256 is the digest on-chain', async () => {
    const ids = [world.approvedThenRevoked, world.rejected, world.grantRevoked, world.grantLive].map((id) => new Types.ObjectId(id));
    const anchors = await ChainAnchor.find({ recordId: { $in: ids } });
    expect(anchors).toHaveLength(8);

    for (const anchor of anchors) {
      const preimage = await specPreimage(anchor);
      expect(anchor.key, anchor.key).toBe(`${anchor.recordType}:${anchor.recordId.toString()}:${anchor.event}`);
      expect(preimage, anchor.key).toBe(anchor.preimage);
      expect(sha256(preimage!), anchor.key).toBe(anchor.digest);
      expect(await readChainDigest(anchor.key), anchor.key).toBe(`0x${anchor.digest}`);
    }
  });

  it('the proof is copied onto the record it belongs to', async () => {
    const approvedRow = (await ChainAnchor.findOne({ recordId: new Types.ObjectId(world.approvedThenRevoked), event: 'APPROVED' }))!;
    const stored = (await ConsentGrant.collection.findOne({ _id: new Types.ObjectId(world.approvedThenRevoked) }))!;
    expect(stored.anchors?.approved).toMatchObject({ digest: approvedRow.digest, txHash: approvedRow.txHash, blockNumber: approvedRow.blockNumber });
  });
});

describe('C27 the chain holds a key and a digest — nothing that identifies anyone', () => {
  it('each anchoring transaction carries exactly anchor(keccak(recordKey), digest) and nothing else', async () => {
    const provider = new JsonRpcProvider(inject('chain').rpcUrl);

    try {
      for (const anchor of await anchorsFor(world.approvedThenRevoked)) {
        const transaction = (await provider.getTransaction(anchor.txHash!))!;
        expect(transaction.data, anchor.key).toBe(anchorInterface.encodeFunctionData('anchor', [onChainKey(anchor.key), `0x${anchor.digest}`]));

        // And, for the avoidance of doubt, no identifier or free text appears in the calldata in any encoding used here.
        for (const secret of [world.patient._id.toString(), world.doctor._id.toString(), world.documentId, 'Test consultation']) {
          expect(transaction.data.toLowerCase(), `${anchor.key} leaks ${secret}`).not.toContain(Buffer.from(secret, 'utf8').toString('hex'));
        }
      }
    } finally {
      provider.destroy();
    }
  });
});

describe('C28 three-way verification: record, stored digest and chain agree', () => {
  it('every anchor verifies: recomputed = stored = on-chain', async () => {
    for (const recordId of [world.approvedThenRevoked, world.rejected, world.grantRevoked, world.grantLive]) {
      for (const anchor of await anchorsFor(recordId)) {
        expect(await verify(anchor), anchor.key).toMatchObject({
          recordFound: true,
          chainReachable: true,
          matchesRecord: true,
          matchesChain: true,
          verified: true,
          differingFields: [],
          recomputedDigest: anchor.digest,
          storedDigest: anchor.digest,
          chainDigest: anchor.digest,
        });
      }
    }
  });

  it('a row not yet on-chain does not verify, and the verdict says the chain — not the record — is the gap', async () => {
    const patient = await createUser('patient');
    const doctor = await createUser('doctor');
    const pending = await requestConsent(doctor, patient, (await uploadDocument(patient)).id);
    const [anchor] = await anchorsFor(pending.id); // enqueued, not yet drained

    expect(anchor.status).toBe('PENDING');
    expect(await verify(anchor)).toMatchObject({ matchesRecord: true, matchesChain: false, chainDigest: null, verified: false });
    await drainAnchors();
  });

  it('nothing verifies without the chain: an unreachable node is reported, never assumed', async () => {
    const [anchor] = await anchorsFor(world.grantLive);
    vi.stubEnv('BLOCKCHAIN_RPC_URL', `http://127.0.0.1:${await freePort()}`);
    expect(await verify(anchor)).toMatchObject({ chainReachable: false, matchesRecord: true, verified: false });
  });
});

describe('C29 a record edited after anchoring is caught, and the changed field is named', () => {
  it.each([
    ['consent purpose', { purpose: 'Something else entirely' }, { REQUESTED: ['purpose'], APPROVED: ['purpose'], REVOKED: ['purpose'] }],
    ['consent approval time', { approvedAt: new Date('2020-01-01T00:00:00.000Z') }, { REQUESTED: [], APPROVED: ['occurredAt'], REVOKED: [] }],
    ['consent doctor and purpose', { doctorId: new Types.ObjectId(), purpose: 'x' }, { REQUESTED: ['doctorId', 'purpose'], APPROVED: ['doctorId', 'purpose'], REVOKED: ['doctorId', 'purpose'] }],
  ] as const)('%s', async (_label, change, expectedByEvent) => {
    const { consentId } = await consentCase();
    await ConsentGrant.updateOne({ _id: consentId }, { $set: change });

    for (const anchor of await anchorsFor(consentId)) {
      const differing = expectedByEvent[anchor.event as keyof typeof expectedByEvent] as readonly string[];
      const result = await verify(anchor);

      // Only the record moved: the stored digest still matches the chain, so the finding is about the record.
      expect(result.matchesChain, anchor.key).toBe(true);
      expect([...result.differingFields].sort(), anchor.key).toEqual([...differing].sort());
      expect(result.matchesRecord, anchor.key).toBe(differing.length === 0);
      expect(result.verified, anchor.key).toBe(differing.length === 0);
    }
  });

  it.each([
    ['emergency reason', { reason: 'Rewritten after the fact' }, { GRANTED: ['reason'], REVOKED: [] }],
    ['emergency expiry', { expiresAt: new Date('2099-01-01T00:00:00.000Z') }, { GRANTED: ['expiresAt'], REVOKED: [] }],
    ['emergency revoked-by', { revokedBy: new Types.ObjectId() }, { GRANTED: [], REVOKED: ['revokedBy'] }],
  ] as const)('%s', async (_label, change, expectedByEvent) => {
    const { grantId } = await grantCase();
    await EmergencyAccess.updateOne({ _id: grantId }, { $set: change });

    for (const anchor of await anchorsFor(grantId)) {
      const differing = expectedByEvent[anchor.event as keyof typeof expectedByEvent] as readonly string[];
      const result = await verify(anchor);

      expect(result.matchesChain, anchor.key).toBe(true);
      expect([...result.differingFields].sort(), anchor.key).toEqual([...differing].sort());
      expect(result.verified, anchor.key).toBe(differing.length === 0);
    }
  });

  it('changing the anchored document’s hash is caught on every event that names that document', async () => {
    const { consentId, documentId } = await consentCase();
    await MedicalDocument.updateOne({ _id: documentId }, { $set: { documentHash: 'f'.repeat(64) } });

    for (const anchor of await anchorsFor(consentId)) {
      const result = await verify(anchor);
      expect(result.differingFields, anchor.key).toEqual(['documentHash']);
      expect(result.verified, anchor.key).toBe(false);
    }
  });

  it('a deleted record cannot verify', async () => {
    const { grantId } = await grantCase();
    await EmergencyAccess.deleteOne({ _id: grantId });

    for (const anchor of await anchorsFor(grantId)) {
      expect(await verify(anchor), anchor.key).toMatchObject({ recordFound: false, recomputedDigest: null, matchesRecord: false, matchesChain: true, verified: false });
    }
  });
});

describe('C31 at-least-once without duplicates: a retry never writes a second anchor or a different digest', () => {
  it('a row that was sent but not recorded (crash between send and save) recovers the original transaction', async () => {
    const { grantId } = await grantCase();
    const [anchor] = await anchorsFor(grantId);
    const original = { txHash: anchor.txHash, blockNumber: anchor.blockNumber };

    // The state a crash right after the transaction mined would leave behind.
    await ChainAnchor.updateOne({ _id: anchor._id }, { $set: { status: 'PENDING', nextAttemptAt: new Date(0) }, $unset: { txHash: 1, blockNumber: 1, anchoredAt: 1 } });
    await drainAnchors();

    const recovered = (await ChainAnchor.findById(anchor._id))!;
    expect(recovered.status).toBe('ANCHORED');
    expect({ txHash: recovered.txHash, blockNumber: recovered.blockNumber }).toEqual(original);

    const { rpcUrl, auditAnchorAddress } = inject('chain');
    const events = await withRegistry(rpcUrl, auditAnchorAddress, (registry) => registry.queryFilter(registry.filters.Anchored(onChainKey(anchor.key)), 0));
    expect(events).toHaveLength(1);
  });

  it('a row whose digest no longer matches what is on-chain fails immediately and loudly — it cannot overwrite', async () => {
    const { grantId } = await grantCase();
    const [anchor] = await anchorsFor(grantId);
    await ChainAnchor.updateOne({ _id: anchor._id }, { $set: { status: 'PENDING', digest: 'a'.repeat(64), nextAttemptAt: new Date(0) } });
    await drainAnchors();

    const failed = (await ChainAnchor.findById(anchor._id))!;
    expect(failed.status).toBe('FAILED');
    expect(failed.attempts).toBe(anchor.attempts + 1); // on the first retry, not after the attempt cap
    expect(failed.lastError).toMatch(/different digest/);
    expect(await readChainDigest(anchor.key)).toBe(`0x${anchor.digest}`); // the chain still holds the original
    expect(await AccessLog.countDocuments({ action: 'CHAIN_ANCHOR_FAILED', 'metadata.anchorId': anchor._id.toString() })).toBe(1);
  });
});

describe('C32 reconciliation re-derives a lost anchor row from the record itself', () => {
  it('a deleted row is re-created for exactly the missing event, with the same digest, and anchors cleanly', async () => {
    const { consentId } = await consentCase();
    const lost = (await ChainAnchor.findOne({ recordId: new Types.ObjectId(consentId), event: 'APPROVED' }))!;
    await ChainAnchor.deleteOne({ _id: lost._id });

    expect((await reconcileMissingAnchors(() => undefined)).enqueued).toBe(1);
    const rebuilt = (await ChainAnchor.findOne({ key: lost.key }))!;
    expect(rebuilt).toMatchObject({ event: 'APPROVED', source: 'reconciliation', digest: lost.digest, preimage: lost.preimage, status: 'PENDING' });

    // Idempotent, and it invents nothing: a rejected consent never gains an APPROVED or REVOKED row.
    expect((await reconcileMissingAnchors(() => undefined)).enqueued).toBe(0);
    expect(await ChainAnchor.countDocuments({ recordId: new Types.ObjectId(world.rejected), event: { $in: ['APPROVED', 'REVOKED'] } })).toBe(0);

    // The digest is already on-chain from the first time, so the worker recovers the original transaction.
    await drainAnchors();
    expect((await ChainAnchor.findById(rebuilt._id))!).toMatchObject({ status: 'ANCHORED', txHash: lost.txHash, blockNumber: lost.blockNumber });
  });
});

describe('C33 a row that exhausts its attempts is FAILED, visible to admins, audited, and retryable', () => {
  it('fails after the attempt cap, is listed and counted, retries to ANCHORED, and cannot be retried again', async () => {
    const patient = await createUser('patient');
    const doctor = await createUser('doctor');
    const documentId = (await uploadDocument(patient)).id;

    vi.stubEnv('ANCHOR_MAX_ATTEMPTS', '2');
    vi.stubEnv('ANCHOR_BACKOFF_BASE_MS', '20');
    vi.stubEnv('BLOCKCHAIN_RPC_URL', `http://127.0.0.1:${await freePort()}`); // nothing listens: the chain is down

    const consent = await requestConsent(doctor, patient, documentId);
    const [anchor] = await anchorsFor(consent.id);

    await waitFor(
      async () => {
        await drainAnchors();
        return (await ChainAnchor.findById(anchor._id))!.status === 'FAILED';
      },
      { timeoutMs: 10_000, description: 'the row to exhaust two attempts' }
    );

    const failed = (await ChainAnchor.findById(anchor._id))!;
    expect(failed.attempts).toBe(2);
    expect(failed.failedAt).toBeInstanceOf(Date);
    const audit = await AccessLog.findOne({ action: 'CHAIN_ANCHOR_FAILED', 'metadata.anchorId': anchor._id.toString() });
    expect(audit?.metadata).toMatchObject({ key: anchor.key, attempts: '2' });
    expect(audit?.userId.toString()).toBe(doctor._id.toString()); // the actor of the event that could not be anchored

    const listed = await call('get', '/api/admin/anchors?status=FAILED', tokenFor(admin));
    expect(listed.status).toBe(200);
    expect((listed.body.anchors as { id: string }[]).map((row) => row.id)).toContain(anchor._id.toString());
    expect(listed.body.counts.FAILED).toBeGreaterThanOrEqual(1);

    vi.stubEnv('BLOCKCHAIN_RPC_URL', inject('chain').rpcUrl); // the chain is back
    const retried = await call('post', `/api/admin/anchors/${anchor._id.toString()}/retry`, tokenFor(admin));
    expect(retried.status).toBe(200);
    expect(retried.body.message).toBe('Anchor re-queued');
    expect((await ChainAnchor.findById(anchor._id))!).toMatchObject({ status: 'PENDING', attempts: 0, source: 'retry' });

    await drainAnchors();
    expect((await ChainAnchor.findById(anchor._id))!.status).toBe('ANCHORED');
    expect(await readChainDigest(anchor.key)).toBe(`0x${anchor.digest}`);

    const again = await call('post', `/api/admin/anchors/${anchor._id.toString()}/retry`, tokenFor(admin));
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ message: 'Only pending or failed anchors can be retried' });
    expect((await call('post', `/api/admin/anchors/${new Types.ObjectId().toString()}/retry`, tokenFor(admin))).status).toBe(404);
  });

  it('rejects malformed list filters', async () => {
    for (const query of ['status=LOST', 'recordType=lab', 'limit=0', 'limit=201']) {
      expect((await call('get', `/api/admin/anchors?${query}`, tokenFor(admin))).status, query).toBe(400);
    }
  });
});
