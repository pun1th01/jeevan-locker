import { randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import mongoose from 'mongoose';
import { afterAll, beforeAll, inject } from 'vitest';
import { buildTestEnvironment } from './testEnv';

/**
 * Runs before every test file, in that file's worker, BEFORE the file imports anything from src/:
 *
 *   - chdir into a fresh empty temp directory. UPLOAD_DIRECTORY is `cwd/uploads` (fixed at import), so every
 *     file writes to its own uploads folder and never touches server/uploads; and dotenv, which reads
 *     `cwd/.env`, finds nothing — a developer's server/.env cannot leak into a result.
 *   - pin the complete environment (testEnv.ts): its own database on the shared mongod, its own master key and
 *     JWT secret, and this worker's own funded chain account.
 *
 * Nothing in this file may import from src/: config/env.ts parses the environment the moment it is imported.
 */

const originalCwd = process.cwd();
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jeevanlocker-test-'));
process.chdir(workspace);

const chain = inject('chain');
const poolId = Number(process.env.VITEST_POOL_ID ?? '1');

// Account 0 deployed the contracts; worker N signs with account N. More workers than accounts would share a nonce.
if (!Number.isInteger(poolId) || poolId < 1 || poolId >= chain.accountKeys.length) {
  throw new Error(`VITEST_POOL_ID=${String(process.env.VITEST_POOL_ID)} has no dedicated Hardhat account; lower maxWorkers`);
}

const databaseName = `jl_${poolId}_${randomBytes(4).toString('hex')}`;
const environment = buildTestEnvironment({
  mongoUri: `${inject('mongoBaseUri').replace(/\/+$/, '')}/${databaseName}`,
  rpcUrl: chain.rpcUrl,
  privateKey: chain.accountKeys[poolId],
  documentRegistryAddress: chain.documentRegistryAddress,
  auditAnchorAddress: chain.auditAnchorAddress,
});

Object.assign(process.env, environment);

beforeAll(async () => {
  await mongoose.connect(environment.MONGO_URI, { serverSelectionTimeoutMS: 10_000 });
  // Unique indexes (e.g. User.email) must exist before a test relies on them.
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
});

afterAll(async () => {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
  }
  await mongoose.disconnect();
  process.chdir(originalCwd);
  fs.rmSync(workspace, { recursive: true, force: true });
});
