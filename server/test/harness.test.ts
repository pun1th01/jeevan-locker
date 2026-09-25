import fs from 'fs';
import os from 'os';
import path from 'path';
import mongoose from 'mongoose';
import { JsonRpcProvider, Wallet } from 'ethers';
import { describe, expect, inject, it } from 'vitest';
import { UPLOAD_DIRECTORY } from '../src/middleware/upload.middleware';
import { call, createUser, tokenFor, uploadDocument } from './support/fixtures';
import { SERVER_ROOT } from './support/hardhat';
import { buildTestEnvironment } from './support/testEnv';

/**
 * Proves the harness itself: that a test file is isolated from the developer's machine and from every other
 * file, and that the chain it talks to is real. If one of these fails, no other result in the run can be trusted.
 */

const PINNED_KEYS = new Set(
  Object.keys(
    buildTestEnvironment({ mongoUri: 'x', rpcUrl: 'x', privateKey: 'x', documentRegistryAddress: 'x', auditAnchorAddress: 'x' })
  )
);

/** Scripts and the dev seed are never run by the suite, so their env reads (e.g. createUser's MONGO_URI) are out of scope. */
const isServerRuntimeFile = (relativePath: string) =>
  relativePath.endsWith('.ts') && !relativePath.startsWith(`scripts${path.sep}`) && path.basename(relativePath) !== 'seedDemoUsers.ts';

const listSourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? listSourceFiles(full) : [full];
  });

/** The only files allowed to read process.env[...] dynamically: each wraps it in a helper whose calls the scan sees. */
const DYNAMIC_ENV_READERS = new Set(
  ['config/env.ts', 'services/anchorWorker.service.ts', 'services/chain.service.ts', 'utils/emergencyAccess.util.ts'].map((file) =>
    path.normalize(file)
  )
);
const ENV_HELPER_CALL = /\b(?:getRequiredEnv|readEnv|readNumber|readPositiveNumber|readPositiveIntSetting)\(\s*'([A-Z][A-Z0-9_]*)'/g;
const DIRECT_ENV_READ = /process\.env\.([A-Z][A-Z0-9_]*)/g;

describe('harness: the environment is pinned, not inherited', () => {
  it('pins every environment variable the server reads', () => {
    const srcRoot = path.join(SERVER_ROOT, 'src');
    const readKeys = new Map<string, string>();
    const unexpectedDynamicReaders: string[] = [];

    for (const file of listSourceFiles(srcRoot)) {
      const relative = path.relative(srcRoot, file);
      if (!isServerRuntimeFile(relative)) continue;

      const source = fs.readFileSync(file, 'utf8');
      for (const pattern of [ENV_HELPER_CALL, DIRECT_ENV_READ]) {
        for (const match of source.matchAll(pattern)) readKeys.set(match[1], relative);
      }
      if (/process\.env\[/.test(source) && !DYNAMIC_ENV_READERS.has(relative)) {
        unexpectedDynamicReaders.push(relative);
      }
    }

    // A new file reading process.env[...] dynamically hides its keys from this scan: pin them and allowlist it.
    expect(unexpectedDynamicReaders).toEqual([]);
    expect(readKeys.size).toBeGreaterThan(15);

    const unpinned = [...readKeys].filter(([key]) => !PINNED_KEYS.has(key)).map(([key, file]) => `${key} (read in ${file})`);
    expect(unpinned, 'add these to test/support/testEnv.ts with their production defaults').toEqual([]);

    for (const key of PINNED_KEYS) {
      expect(process.env[key], key).toBeDefined();
    }
  });

  it('pins every variable documented in .env.example', () => {
    const documented = fs
      .readFileSync(path.join(SERVER_ROOT, '.env.example'), 'utf8')
      .split(/\r?\n/)
      .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
      .filter((key): key is string => Boolean(key));

    expect(documented.length).toBeGreaterThan(10);
    expect(documented.filter((key) => !PINNED_KEYS.has(key))).toEqual([]);
  });

  it('runs from an empty temp directory, so no .env can be read and uploads never touch server/uploads', () => {
    const cwd = fs.realpathSync(process.cwd());

    expect(cwd.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
    expect(cwd).not.toContain(fs.realpathSync(SERVER_ROOT));
    expect(fs.existsSync(path.join(cwd, '.env'))).toBe(false);
    expect(fs.realpathSync(UPLOAD_DIRECTORY)).toBe(path.join(cwd, 'uploads'));
  });
});

describe('harness: isolation from other test files', () => {
  it('uses a database of its own on the shared mongod', async () => {
    expect(mongoose.connection.readyState).toBe(1);
    expect(mongoose.connection.name).toMatch(/^jl_\d+_[0-9a-f]{8}$/);
    expect(process.env.MONGO_URI).toContain(mongoose.connection.name);
  });

  it('signs with this worker’s own funded account, never the deployer', async () => {
    const { accountKeys, rpcUrl } = inject('chain');
    const workerKey = process.env.BLOCKCHAIN_PRIVATE_KEY ?? '';
    const provider = new JsonRpcProvider(rpcUrl);

    try {
      expect(workerKey).not.toBe(accountKeys[0]);
      expect(accountKeys.indexOf(workerKey)).toBe(Number(process.env.VITEST_POOL_ID));
      expect(await provider.getBalance(new Wallet(workerKey).address)).toBeGreaterThan(0n);
    } finally {
      provider.destroy();
    }
  });
});

describe('harness: the chain is real', () => {
  it('has contract bytecode at both configured addresses', async () => {
    const provider = new JsonRpcProvider(inject('chain').rpcUrl);

    try {
      for (const address of [process.env.DOCUMENT_REGISTRY_ADDRESS, process.env.AUDIT_ANCHOR_ADDRESS]) {
        expect((await provider.getCode(address ?? '')).length).toBeGreaterThan(2);
      }
    } finally {
      provider.destroy();
    }
  });

  it('round-trips a real upload: encrypted on disk in this file’s workspace, hash registered on-chain', async () => {
    const patient = await createUser('patient');
    const document = await uploadDocument(patient);

    const stored = fs.readdirSync(UPLOAD_DIRECTORY);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatch(/\.enc$/);
    expect(fs.readFileSync(path.join(UPLOAD_DIRECTORY, stored[0])).subarray(0, 4).toString('latin1')).toBe('JLE1');

    const integrity = await call('get', `/api/documents/${document.id}/integrity`, tokenFor(patient));
    expect(integrity.status).toBe(200);
    expect(integrity.body).toMatchObject({ verified: true });
    expect(integrity.body.blockchainHash).toBe(integrity.body.currentHash);
  });

  it('answers the health check without a token', async () => {
    const response = await call('get', '/api/health');
    expect(response.status).toBe(200);
  });
});
