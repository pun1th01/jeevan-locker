import { afterAll, describe, expect, inject, it, vi } from 'vitest';
import { createUser, decideConsent, requestConsent, uploadDocument } from '../support/fixtures';
import { anchorsFor, drainAnchors, readChainDigest } from '../support/anchors';
import { deployContracts, startHardhatNode, type HardhatNode } from '../support/hardhat';
import { waitFor } from '../support/waitFor';

/**
 * Suite 3, claim C30 in docs/TESTING.md — its own file because it owns a private Hardhat node that it kills and
 * restarts (a real outage, not a wrong URL), which takes ~10 s and must not disturb any other file's chain.
 * Specification: docs/ANCHORING.md §8 ("The request never blocks on the chain and never fails because of it").
 */

describe('C30 a chain outage never fails a request, and anchoring completes once the chain returns', () => {
  let privateNode: HardhatNode | null = null;

  afterAll(async () => {
    await privateNode?.stop();
  });

  it('requests succeed during a real outage; rows wait PENDING and explain why; the restarted chain receives them', async () => {
    const patient = await createUser('patient');
    const doctor = await createUser('doctor');
    const documentId = (await uploadDocument(patient)).id; // registered on the shared chain before the outage

    const { accountKeys } = inject('chain');
    privateNode = await startHardhatNode();
    const port = privateNode.port;
    const contracts = await deployContracts(privateNode.rpcUrl, accountKeys[0]);
    vi.stubEnv('BLOCKCHAIN_RPC_URL', privateNode.rpcUrl);
    vi.stubEnv('AUDIT_ANCHOR_ADDRESS', contracts.auditAnchorAddress);
    vi.stubEnv('ANCHOR_BACKOFF_BASE_MS', '20');

    await privateNode.stop(); // the outage: process tree killed, port closed

    const consent = await requestConsent(doctor, patient, documentId); // the fixture asserts 201
    await decideConsent(patient, consent.id, 'approve'); // the fixture asserts 200
    await drainAnchors();

    const pending = await anchorsFor(consent.id);
    expect(pending.map((anchor) => anchor.event).sort()).toEqual(['APPROVED', 'REQUESTED']);
    for (const anchor of pending) {
      expect(anchor.status, anchor.key).toBe('PENDING');
      expect(anchor.attempts, anchor.key).toBeGreaterThanOrEqual(1);
      expect(anchor.lastError, anchor.key).toMatch(/ECONNREFUSED|connect/i);
      expect(anchor.lastAttemptAt, anchor.key).toBeInstanceOf(Date);
      expect(anchor.nextAttemptAt.getTime(), anchor.key).toBeGreaterThan(anchor.lastAttemptAt!.getTime());
    }

    // The chain comes back on the same port. A fresh node redeploys to the same deterministic addresses.
    privateNode = await startHardhatNode({ port });
    expect(await deployContracts(privateNode.rpcUrl, accountKeys[0])).toEqual(contracts);

    await waitFor(
      async () => {
        await drainAnchors();
        return (await anchorsFor(consent.id)).every((anchor) => anchor.status === 'ANCHORED');
      },
      { timeoutMs: 15_000, description: 'both anchors to reach ANCHORED after the chain returned' }
    );

    for (const anchor of await anchorsFor(consent.id)) {
      expect(anchor.txHash, anchor.key).toMatch(/^0x[0-9a-f]{64}$/);
      expect(anchor.lastError, anchor.key).toBeUndefined();
      expect(await readChainDigest(anchor.key, privateNode.rpcUrl, contracts.auditAnchorAddress), anchor.key).toBe(`0x${anchor.digest}`);
    }
  });
});
