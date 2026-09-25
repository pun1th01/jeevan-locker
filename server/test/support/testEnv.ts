import { randomBytes } from 'crypto';

/**
 * The complete environment a test file runs under. EVERY variable the server reads is pinned here, so a
 * developer's local server/.env can never change a result: a teammate with TRUST_PROXY=1 or
 * EMERGENCY_MAX_ACTIVE_GRANTS=2 gets the same run as a fresh clone. (dotenv never overrides a variable that is
 * already set, and each test file also runs from an empty temp directory, so there is no .env to find.)
 *
 * The harness test scans src/ for env reads and fails if one appears that is not pinned here — add the new
 * variable to this object, with the production default, in the same change that introduces it.
 *
 * Values are the production defaults unless a test needs otherwise; individual tests override with
 * vi.stubEnv, which the config reverts after every test (unstubEnvs).
 */

export interface TestEnvironmentInput {
  mongoUri: string;
  rpcUrl: string;
  privateKey: string;
  documentRegistryAddress: string;
  auditAnchorAddress: string;
}

export const buildTestEnvironment = (input: TestEnvironmentInput) =>
  ({
    NODE_ENV: 'test',
    // Unused (supertest binds the app to an ephemeral port per request) but parsed at import, so it must be valid.
    PORT: '5000',
    MONGO_URI: input.mongoUri,
    JWT_SECRET: randomBytes(48).toString('hex'),
    CLIENT_ORIGIN: 'http://localhost:5173',
    // Empty = unset: req.ip is the socket address and X-Forwarded-For is ignored (the safe default).
    TRUST_PROXY: '',

    BLOCKCHAIN_RPC_URL: input.rpcUrl,
    BLOCKCHAIN_PRIVATE_KEY: input.privateKey,
    DOCUMENT_REGISTRY_ADDRESS: input.documentRegistryAddress,
    AUDIT_ANCHOR_ADDRESS: input.auditAnchorAddress,

    // A fresh key per test file: nothing a test encrypts is readable by any other file or by the dev server.
    DOCUMENT_MASTER_KEY: randomBytes(32).toString('base64'),
    DOCUMENT_MASTER_KEY_ID: 'test',

    ANCHOR_RECONCILE_WINDOW_DAYS: '0',
    ANCHOR_POLL_MS: '5000',
    ANCHOR_BACKOFF_BASE_MS: '5000',
    ANCHOR_BACKOFF_MAX_MS: '3600000',
    ANCHOR_MAX_ATTEMPTS: '60',

    EMERGENCY_ACCESS_DURATION_MINUTES: '15',
    EMERGENCY_MAX_ACTIVE_GRANTS: '5',
    EMERGENCY_REGRANT_WINDOW_HOURS: '24',
    EMERGENCY_EXPIRY_POLL_MS: '60000',
    EMERGENCY_EXPIRY_BATCH_LIMIT: '200',
  }) satisfies Record<string, string>;

export type TestEnvironment = ReturnType<typeof buildTestEnvironment>;
