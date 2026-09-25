import { beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../../src/app';
import { UNVERIFIED_DOCTOR_MESSAGE } from '../../src/middleware/auth.middleware';
import { AccessLog } from '../../src/models/AccessLog';
import { User, type IUser } from '../../src/models/User';
import { call, createUser, TEST_PASSWORD, tokenFor, uniqueSuffix, uploadDocument } from '../support/fixtures';

/**
 * Suite 5b — rate limits and the trust-proxy setting (claims C42–C45 in docs/TESTING.md). Specification: API_LAB.md
 * §6 (limits, keys, messages, draft-8 headers), API_ADMIN.md §3 (the lookup limiter runs before the verification
 * gate) and config/env.ts / .env.example (TRUST_PROXY).
 *
 * Every request from supertest comes from the loopback address. The limiters' counters live in this file's module
 * registry (fresh per file), so each IP-keyed limiter's loopback bucket is used by exactly one test below; the
 * trust-proxy tests use their own X-Forwarded-For addresses and never touch it.
 */

const LOOPBACK = /^(::ffff:127\.0\.0\.1|127\.0\.0\.1|::1)$/;
const LOGIN_LIMITED = { message: 'Too many login attempts. Try again in 15 minutes.' };
const REGISTER_LIMITED = { message: 'Too many accounts created from this address. Try again in an hour.' };
const LOOKUP_LIMITED = { message: 'Too many patient lookups. Try again later.' };

const login = (email: string, password: string, forwardedFor?: string) => {
  const pending = call('post', '/api/auth/login').send({ email, password });
  return forwardedFor ? pending.set('X-Forwarded-For', forwardedFor) : pending;
};

describe('C42 login: ten attempts per client address per 15 minutes, counted before the password is checked', () => {
  it('the 11th attempt is refused even with the right password, and X-Forwarded-For cannot reset the count', async () => {
    const patient = await createUser('patient');

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const response = await login(patient.email, 'wrong-password-123');
      expect(response.status, `attempt ${attempt}`).toBe(401);
    }

    const eleventh = await login(patient.email, TEST_PASSWORD);
    expect(eleventh.status).toBe(429);
    expect(eleventh.body).toEqual(LOGIN_LIMITED);
    expect(eleventh.headers['ratelimit-policy']).toMatch(/q=10/);
    expect(eleventh.headers.ratelimit).toBeDefined();
    expect(await AccessLog.countDocuments({ userId: patient._id, action: 'USER_LOGIN' })).toBe(0); // the right password never got through

    // TRUST_PROXY is unset: a client inventing a new address in X-Forwarded-For is still the same client.
    for (const spoofed of ['198.51.100.1', '203.0.113.77', '10.0.0.1']) {
      expect((await login(patient.email, TEST_PASSWORD, spoofed)).status, spoofed).toBe(429);
    }
  });
});

describe('C43 registration: five accounts per client address per hour', () => {
  it('the 6th registration is refused and creates nobody', async () => {
    for (let index = 1; index <= 5; index += 1) {
      const response = await call('post', '/api/auth/register').send({ name: `Patient ${index}`, email: `reg-${uniqueSuffix()}@test.jeevanlocker.dev`, password: 'Str0ngPass!', role: 'patient' });
      expect(response.status, `registration ${index}`).toBe(201);
    }

    const email = `reg-${uniqueSuffix()}@test.jeevanlocker.dev`;
    const sixth = await call('post', '/api/auth/register').send({ name: 'Patient 6', email, password: 'Str0ngPass!', role: 'patient' });
    expect(sixth.status).toBe(429);
    expect(sixth.body).toEqual(REGISTER_LIMITED);
    expect(await User.exists({ email })).toBeNull();
  });
});

describe('C44 patient lookups: thirty per account per 15 minutes, counted before the verification gate', () => {
  it('an unverified doctor is throttled, not merely refused: 30 x 403, then 429 — and another doctor is unaffected', async () => {
    const unverified = await createUser('doctor', { verified: false });
    const verified = await createUser('doctor');
    const patient = await createUser('patient');
    const lookup = (doctor: IUser) => call('get', `/api/patients/lookup?query=${encodeURIComponent(patient.email)}`, tokenFor(doctor));

    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const response = await lookup(unverified);
      expect(response.status, `attempt ${attempt}`).toBe(403);
      expect(response.body, `attempt ${attempt}`).toEqual({ message: UNVERIFIED_DOCTOR_MESSAGE });
    }

    const thirtyFirst = await lookup(unverified);
    expect(thirtyFirst.status).toBe(429);
    expect(thirtyFirst.body).toEqual(LOOKUP_LIMITED);

    // Keyed per account, not per address: every request here shares the loopback address.
    expect((await lookup(verified)).status).toBe(200);
  });

  it('a lab’s link requests (each one a lookup) are throttled the same way, per lab', async () => {
    const lab = await createUser('lab');
    const otherLab = await createUser('lab');
    const request = (who: IUser) => call('post', '/api/lab-links', tokenFor(who)).send({ query: `nobody-${uniqueSuffix()}@test.jeevanlocker.dev` });

    for (let attempt = 1; attempt <= 30; attempt += 1) {
      expect((await request(lab)).status, `attempt ${attempt}`).toBe(404);
    }

    const thirtyFirst = await request(lab);
    expect(thirtyFirst.status).toBe(429);
    expect(thirtyFirst.body).toEqual(LOOKUP_LIMITED);
    expect((await request(otherLab)).status).toBe(404);
  });
});

describe('C45 TRUST_PROXY decides whose address is audited and limited — and "trust everyone" is refused', () => {
  /** Parses TRUST_PROXY with the real config module, loaded fresh under the given value. */
  const parseTrustProxy = async (value: string) => {
    vi.resetModules();
    vi.stubEnv('TRUST_PROXY', value);
    return (await import('../../src/config/env')).env.trustProxy;
  };

  it.each([
    ['', false],
    ['false', false],
    ['0', false],
    ['1', 1],
    ['2', 2],
    ['loopback', 'loopback'],
    ['10.0.0.0/8, 127.0.0.1', '10.0.0.0/8, 127.0.0.1'],
  ] as const)('TRUST_PROXY=%j parses to %j', async (value, expected) => {
    expect(await parseTrustProxy(value)).toEqual(expected);
  });

  it.each(['true', 'TRUE', ' True '])('TRUST_PROXY=%j refuses to load (trusting every hop lets any client choose its IP)', async (value) => {
    await expect(parseTrustProxy(value)).rejects.toThrow(/TRUST_PROXY=true is not allowed/);
  });

  /** Runs `use` with the app's trust-proxy setting taken from a real parse of `value`, then restores it. */
  const withTrustProxy = async (value: string, use: () => Promise<void>) => {
    const original: unknown = app.get('trust proxy');
    app.set('trust proxy', await parseTrustProxy(value));
    try {
      await use();
    } finally {
      app.set('trust proxy', original);
    }
  };

  const auditedAddressOfRead = async (patient: IUser, documentId: string, forwardedFor: string) => {
    await call('get', `/api/documents/${documentId}`, tokenFor(patient)).set('X-Forwarded-For', forwardedFor).expect(200);
    const row = await AccessLog.findOne({ userId: patient._id, action: 'DOCUMENT_ACCESS' }).sort({ timestamp: -1 });
    return row!.ipAddress;
  };

  it('unset: X-Forwarded-For is ignored and the socket address is audited', async () => {
    const patient = await createUser('patient');
    const documentId = (await uploadDocument(patient)).id;
    expect(await auditedAddressOfRead(patient, documentId, '203.0.113.9')).toMatch(LOOPBACK);
  });

  it('one hop: the proxy-supplied address is audited, and a client cannot choose it by prepending its own', async () => {
    const patient = await createUser('patient');
    const documentId = (await uploadDocument(patient)).id;

    await withTrustProxy('1', async () => {
      expect(await auditedAddressOfRead(patient, documentId, '203.0.113.9')).toBe('203.0.113.9');
      // The client sent "198.51.100.7"; the one trusted proxy appended the real client address after it.
      expect(await auditedAddressOfRead(patient, documentId, '198.51.100.7, 203.0.113.10')).toBe('203.0.113.10');
    });
  });

  it('one hop: the login limit is kept per real client address', async () => {
    const patient = await createUser('patient');

    await withTrustProxy('1', async () => {
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        expect((await login(patient.email, 'wrong-password-123', '203.0.113.20')).status, `attempt ${attempt}`).toBe(401);
      }
      expect((await login(patient.email, TEST_PASSWORD, '203.0.113.20')).status).toBe(429);
      expect((await login(patient.email, TEST_PASSWORD, '203.0.113.21')).status).toBe(200); // a different client is unaffected
    });
  });

  it('"loopback": a proxy on this machine is trusted, so its X-Forwarded-For is audited', async () => {
    const patient = await createUser('patient');
    const documentId = (await uploadDocument(patient)).id;

    await withTrustProxy('loopback', async () => {
      expect(await auditedAddressOfRead(patient, documentId, '203.0.113.30')).toBe('203.0.113.30');
    });
  });
});
