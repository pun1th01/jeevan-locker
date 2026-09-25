import fs from 'fs';
import os from 'os';
import path from 'path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';
import { compileContracts, deployContracts, hardhatAccountKeys, startHardhatNode, type HardhatNode } from './hardhat';

/**
 * Runs once per `npm test`, in the main process, before any test file:
 *
 *   1. hardhat compile                          (no-op when artifacts are current)
 *   2. hardhat node on a free port  ||  mongod  (started in parallel; ready = the RPC / server answers)
 *   3. deploy DocumentRegistry + AuditAnchorRegistry from account 0
 *   4. provide { chain, mongoBaseUri, workspaceRoot } to the workers
 *
 * One chain and one mongod serve the whole run; files are kept apart by a database per file, a funded
 * account per worker (so parallel files never share a nonce) and fresh ObjectIds as anchor keys (so
 * write-once anchors never collide). Teardown stops both, waits for the chain's port to close, and deletes
 * the run's temp directory — which also sweeps up the workspace of any file that never reached its afterAll
 * (a crashed worker, or `vitest list`, which runs setup files but no hooks).
 */
export default async function setup(project: TestProject) {
  const startedAt = Date.now();
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jeevanlocker-test-run-'));
  compileContracts();

  const keys = hardhatAccountKeys();
  const [nodeResult, mongoResult] = await Promise.allSettled([startHardhatNode(), MongoMemoryServer.create()]);
  const node: HardhatNode | null = nodeResult.status === 'fulfilled' ? nodeResult.value : null;
  const mongo: MongoMemoryServer | null = mongoResult.status === 'fulfilled' ? mongoResult.value : null;

  const teardown = async () => {
    await Promise.allSettled([mongo?.stop(), node?.stop()]);
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  };

  if (!node || !mongo) {
    await teardown();
    const reason = nodeResult.status === 'rejected' ? nodeResult.reason : mongoResult.status === 'rejected' ? mongoResult.reason : null;
    throw reason instanceof Error ? reason : new Error('Test infrastructure failed to start');
  }

  try {
    const contracts = await deployContracts(node.rpcUrl, keys[0]);
    project.provide('chain', { rpcUrl: node.rpcUrl, ...contracts, accountKeys: keys });
    project.provide('mongoBaseUri', mongo.getUri());
    project.provide('workspaceRoot', workspaceRoot);
  } catch (error) {
    await teardown();
    throw error;
  }

  console.log(`[test] hardhat ${node.rpcUrl} + mongod ready, contracts deployed in ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);

  return teardown;
}
