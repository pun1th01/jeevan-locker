import { Types } from 'mongoose';
import { beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { freePort } from '../support/hardhat';

/**
 * Suite 6, claim C50 — the seed's two failure modes, in their own file (and so their own database): an unreachable
 * chain at seed time, and an id already registered on-chain with a different hash. Every src/ import is dynamic, after
 * NODE_ENV=development is set (see seed.test.ts).
 */

let seed: typeof import('../../src/utils/seedDemoUsers').seedDemoUsers;
let MedicalDocument: typeof import('../../src/models/MedicalDocument').MedicalDocument;
let registerDocumentHash: typeof import('../../src/services/documentRegistry.service').registerDocumentHash;
const warnings: string[] = [];
const errors: string[] = [];

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void warnings.push(args.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.join(' ')));

  seed = (await import('../../src/utils/seedDemoUsers')).seedDemoUsers;
  MedicalDocument = (await import('../../src/models/MedicalDocument')).MedicalDocument;
  registerDocumentHash = (await import('../../src/services/documentRegistry.service')).registerDocumentHash;
}, 120_000);

describe('C50 the seed never breaks boot, and never overwrites the chain', () => {
  it('with the chain unreachable, the seed completes, leaves every document unregistered, and says so', async () => {
    await MedicalDocument.deleteMany({}); // start from no documents, whichever test ran first
    vi.stubEnv('BLOCKCHAIN_RPC_URL', `http://127.0.0.1:${await freePort()}`); // nothing listens: a real outage
    warnings.length = 0;

    await expect(seed()).resolves.toBeUndefined();

    expect(await MedicalDocument.countDocuments()).toBe(10);
    expect(await MedicalDocument.countDocuments({ blockchainTxHash: { $exists: true } })).toBe(0);
    expect(warnings.some((line) => /10 demo document\(s\) left UNREGISTERED on-chain/.test(line))).toBe(true);

    // With the chain back, the next seed registers them all.
    vi.stubEnv('BLOCKCHAIN_RPC_URL', inject('chain').rpcUrl);
    await seed();
    expect(await MedicalDocument.countDocuments({ blockchainTxHash: { $exists: true } })).toBe(10);
  });

  it('an id already registered with a different hash is reported, left unregistered, and never overwritten', async () => {
    // The state a changed seed file plus a persistent database would produce: a row whose id the chain already holds
    // under another hash. Rebuilt here from a real seeded row, under a fresh id registered with the wrong hash.
    await seed(); // a seeded world with the chain up, whichever test ran first
    const original = (await MedicalDocument.collection.findOne({ title: 'Lipid & Glucose Panel' }))!;
    const conflictingId = new Types.ObjectId();
    const wrongHash = 'ab'.repeat(32);
    await MedicalDocument.collection.deleteOne({ _id: original._id });
    await MedicalDocument.collection.insertOne({ ...original, _id: conflictingId });
    await registerDocumentHash(conflictingId.toString(), wrongHash);
    errors.length = 0;

    await expect(seed()).resolves.toBeUndefined();

    const conflicting = (await MedicalDocument.findById(conflictingId))!;
    expect(errors.some((line) => line.includes('SEED CONFLICT') && line.includes('Lipid & Glucose Panel') && line.includes(conflictingId.toString()))).toBe(true);
    expect(conflicting.blockchainTxHash).toBeUndefined();
    expect(conflicting.documentHash).not.toBe(wrongHash);
    expect(await MedicalDocument.countDocuments({ _id: { $ne: conflictingId }, blockchainTxHash: { $exists: true } })).toBe(9);

    // Write-once held: the chain still says the wrong hash, exactly as registered.
    const { getRegisteredDocumentHash } = await import('../../src/services/documentRegistry.service');
    expect((await getRegisteredDocumentHash(conflictingId.toString()))?.hash).toBe(wrongHash);
  });
});
