import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import { AccessLog } from '../../src/models/AccessLog';
import { EmergencyAccess } from '../../src/models/EmergencyAccess';
import type { IUser } from '../../src/models/User';
import { insertActiveGrant, type NewGrantFields } from '../../src/utils/emergencyAccess.util';
import { createKeyedMutex } from '../../src/utils/keyedMutex.util';
import { createUser, uploadDocument } from '../support/fixtures';

/**
 * Suite 4 (C36), the two mechanisms behind "one live grant per doctor per document, never past the cap":
 *   - the partial unique index {doctorId, documentId | status ACTIVE}, exercised through insertActiveGrant with NO
 *     lock around it — exactly the position of a second server process — including the lapsed-but-still-ACTIVE row
 *     that a time-blind partial filter keeps in the slot;
 *   - the per-doctor keyed mutex: same key serialised, different keys independent, released on every error path.
 * The HTTP-level concurrency proof is in breakglass.test.ts.
 */

let patient: IUser;
let doctor: IUser;

beforeAll(async () => {
  patient = await createUser('patient');
  doctor = await createUser('doctor');
});

const fieldsFor = async (): Promise<NewGrantFields> => ({
  doctorId: doctor._id,
  patientId: patient._id,
  documentId: new Types.ObjectId((await uploadDocument(patient)).id),
  reason: 'insert test',
  expiresAt: new Date(Date.now() + 15 * 60_000),
});

const activeRows = (fields: NewGrantFields) => EmergencyAccess.find({ doctorId: fields.doctorId, documentId: fields.documentId, status: 'ACTIVE' });
const expiredAuditRows = (grantId: Types.ObjectId) => AccessLog.countDocuments({ action: 'EMERGENCY_ACCESS_EXPIRED', 'metadata.emergencyAccessId': grantId.toString() });

describe('C36 the database allows one live grant per doctor per document — without any lock', () => {
  it('a live conflicting grant is returned as the existing grant; nothing new is written', async () => {
    const fields = await fieldsFor();
    const live = await EmergencyAccess.create({ ...fields, status: 'ACTIVE' });

    const result = await insertActiveGrant(fields);

    expect(result.created).toBe(false);
    expect(result.grant._id.toString()).toBe(live._id.toString());
    expect(await activeRows(fields)).toHaveLength(1);
    expect(await expiredAuditRows(live._id)).toBe(0);
  });

  it('a lapsed grant still marked ACTIVE is expired through the guarded transition (one audit row), then the insert succeeds', async () => {
    const fields = await fieldsFor();
    // The state a time-blind partial index cannot see past: status ACTIVE, window already over, not yet swept.
    const lapsed = await EmergencyAccess.create({ ...fields, status: 'ACTIVE', expiresAt: new Date(Date.now() - 1_000) });

    const result = await insertActiveGrant(fields);

    expect(result.created).toBe(true);
    expect(result.grant._id.toString()).not.toBe(lapsed._id.toString());
    expect((await EmergencyAccess.findById(lapsed._id))!.status).toBe('EXPIRED');
    expect(await expiredAuditRows(lapsed._id)).toBe(1);
    expect((await activeRows(fields)).map((row) => row._id.toString())).toEqual([result.grant._id.toString()]);
  });

  it('concurrent inserts with no lock — as separate server processes would make — produce exactly one live grant', async () => {
    const fields = await fieldsFor();

    const results = await Promise.all(Array.from({ length: 8 }, () => insertActiveGrant(fields)));

    const created = results.filter((result) => result.created);
    expect(created).toHaveLength(1);
    expect(new Set(results.map((result) => result.grant._id.toString()))).toEqual(new Set([created[0].grant._id.toString()]));
    expect(await activeRows(fields)).toHaveLength(1);
  });

  it('concurrent inserts racing a lapsed-but-ACTIVE row: it is expired exactly once, and one new grant wins', async () => {
    const fields = await fieldsFor();
    const lapsed = await EmergencyAccess.create({ ...fields, status: 'ACTIVE', expiresAt: new Date(Date.now() - 1_000) });

    const results = await Promise.allSettled(Array.from({ length: 6 }, () => insertActiveGrant(fields)));

    // Every caller gets an answer; none may leave a second live grant behind.
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof insertActiveGrant>>> => result.status === 'fulfilled');
    expect(fulfilled.length, JSON.stringify(results.filter((result) => result.status === 'rejected'))).toBe(6);
    expect(fulfilled.filter((result) => result.value.created)).toHaveLength(1);
    expect(await activeRows(fields)).toHaveLength(1);
    expect((await EmergencyAccess.findById(lapsed._id))!.status).toBe('EXPIRED');
    expect(await expiredAuditRows(lapsed._id)).toBe(1);
  });
});

describe('C36 the per-doctor lock: one key at a time, keys independent, always released', () => {
  const deferred = () => {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };

  it('work under the same key runs one at a time, in arrival order', async () => {
    const lock = createKeyedMutex();
    const gate = deferred();
    const order: string[] = [];

    const first = lock('doctor-a', async () => {
      order.push('first:start');
      await gate.promise;
      order.push('first:end');
    });
    const second = lock('doctor-a', async () => {
      order.push('second:start');
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['first:start']); // second is queued behind first

    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('work under another key does not wait for a held key', async () => {
    const lock = createKeyedMutex();
    const gate = deferred();

    const held = lock('doctor-a', () => gate.promise);
    await expect(lock('doctor-b', async () => 'ran')).resolves.toBe('ran'); // completes while doctor-a is still held

    gate.resolve();
    await held;
  });

  it('a throwing holder releases the key, and the error still reaches its caller', async () => {
    const lock = createKeyedMutex();

    await expect(lock('doctor-a', async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    await expect(lock('doctor-a', async () => 'after')).resolves.toBe('after');
  });
});
