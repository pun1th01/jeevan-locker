import { describe, expect, it, vi } from 'vitest';
import type { IUser } from '../../src/models/User';

/**
 * Suite 5b, claim C45 — the boot wiring. limits.test.ts proves how TRUST_PROXY is parsed and how the app behaves
 * under each setting; this file proves that app.ts actually applies a non-default value it was started with. It
 * imports the app for the first time only after setting TRUST_PROXY=1, exactly as a server started behind one proxy
 * would, so nothing here calls app.set itself.
 */

describe('C45 a server started with TRUST_PROXY=1 applies it', () => {
  it('reads the setting at boot and audits the proxy-supplied client address', async () => {
    vi.stubEnv('TRUST_PROXY', '1');
    const { app } = await import('../../src/app');
    const { AccessLog } = await import('../../src/models/AccessLog');
    const { call, createUser, tokenFor, uploadDocument } = await import('../support/fixtures');

    expect(app.get('trust proxy')).toBe(1);

    const patient: IUser = await createUser('patient');
    const documentId = (await uploadDocument(patient)).id;
    await call('get', `/api/documents/${documentId}`, tokenFor(patient)).set('X-Forwarded-For', '198.51.100.40, 203.0.113.40').expect(200);

    const row = await AccessLog.findOne({ userId: patient._id, action: 'DOCUMENT_ACCESS' });
    expect(row?.ipAddress).toBe('203.0.113.40');
  });
});
