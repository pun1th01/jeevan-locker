import { execFileSync, spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { ContractFactory, HDNodeWallet, JsonRpcProvider, Mnemonic, Wallet, type InterfaceAbi } from 'ethers';
import { waitFor } from './waitFor';

/**
 * A real Hardhat node, spawned and torn down by the suite. Nothing about the chain is mocked: uploads,
 * integrity checks and audit anchors in the tests send real transactions to real contract bytecode.
 */

export const SERVER_ROOT = path.resolve(__dirname, '..', '..');
const HARDHAT_CLI = path.join(SERVER_ROOT, 'node_modules', 'hardhat', 'internal', 'cli', 'cli.js');

/** The public mnemonic every `hardhat node` derives its 20 funded dev accounts from. Test-only keys. */
export const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';
export const HARDHAT_ACCOUNT_COUNT = 20;

/** Private keys of the node's funded accounts, index 0..19. Account 0 deploys; each test worker gets its own. */
export const hardhatAccountKeys = (): string[] => {
  const mnemonic = Mnemonic.fromPhrase(HARDHAT_MNEMONIC);
  return Array.from({ length: HARDHAT_ACCOUNT_COUNT }, (_, index) => HDNodeWallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/${index}`).privateKey);
};

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      server.close(() => (port ? resolve(port) : reject(new Error('Could not allocate a free port'))));
    });
  });

export const rpcAnswers = async (rpcUrl: string): Promise<boolean> => {
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
};

export interface HardhatNode {
  rpcUrl: string;
  port: number;
  /** Kills the node's whole process tree and resolves once the port has stopped answering. */
  stop: () => Promise<void>;
}

/**
 * Windows: `taskkill /T` takes the whole tree — a plain kill of a shell-wrapped child only kills the wrapper
 * and leaves the node answering on the port (the Phase 1 restart test was fooled by exactly that).
 * POSIX: the child leads its own process group, so the group is signalled.
 */
const killTree = (child: ChildProcess) => {
  if (!child.pid || child.exitCode !== null) {
    return;
  }

  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    // Already gone.
  }
};

export const startHardhatNode = async (options: { port?: number; readyTimeoutMs?: number } = {}): Promise<HardhatNode> => {
  const port = options.port ?? (await freePort());
  const rpcUrl = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, [HARDHAT_CLI, 'node', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: SERVER_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });

  // Drain both pipes (a full pipe would stall the node) and keep the tail for the error message.
  const tail: string[] = [];
  const keep = (chunk: Buffer) => {
    tail.push(chunk.toString());
    if (tail.length > 40) tail.shift();
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);

  let exitCode: number | null | undefined;
  child.once('exit', (code) => {
    exitCode = code;
  });

  try {
    await waitFor(
      async () => {
        if (exitCode !== undefined) {
          throw new Error(`hardhat node exited with code ${exitCode} before answering:\n${tail.join('')}`);
        }
        return rpcAnswers(rpcUrl);
      },
      { timeoutMs: options.readyTimeoutMs ?? 120_000, intervalMs: 100, description: `hardhat node on port ${port}` }
    );
  } catch (error) {
    killTree(child);
    throw error;
  }

  return {
    rpcUrl,
    port,
    stop: async () => {
      killTree(child);
      await waitFor(async () => !(await rpcAnswers(rpcUrl)), { timeoutMs: 15_000, intervalMs: 50, description: `port ${port} to close` });
    },
  };
};

/** No-op when nothing changed. On a fresh clone the first run downloads solc 0.8.24 once. */
export const compileContracts = () => {
  execFileSync(process.execPath, [HARDHAT_CLI, 'compile', '--quiet'], { cwd: SERVER_ROOT, stdio: 'pipe' });
};

const readArtifact = (name: string): { abi: InterfaceAbi; bytecode: string } => {
  const file = path.join(SERVER_ROOT, 'artifacts', 'contracts', `${name}.sol`, `${name}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as { abi: InterfaceAbi; bytecode: string };
};

export interface DeployedContracts {
  documentRegistryAddress: string;
  auditAnchorAddress: string;
}

/** Deploys both registries from `deployerKey`. On a fresh node from account 0 the addresses are deterministic. */
export const deployContracts = async (rpcUrl: string, deployerKey: string): Promise<DeployedContracts> => {
  // Same setting as the server's provider: without it, the second deploy reads a cached nonce and fails.
  const provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
  const wallet = new Wallet(deployerKey, provider);

  const deploy = async (name: string) => {
    const { abi, bytecode } = readArtifact(name);
    const contract = await new ContractFactory(abi, bytecode, wallet).deploy();
    await contract.waitForDeployment();
    return contract.getAddress();
  };

  try {
    return {
      documentRegistryAddress: await deploy('DocumentRegistry'),
      auditAnchorAddress: await deploy('AuditAnchorRegistry'),
    };
  } finally {
    provider.destroy();
  }
};
