'use strict';

/**
 * One-command development startup: chain -> deploy both contracts -> server/.env -> API -> client.
 *
 *   npm install          (repository root: installs server and client with `npm ci`)
 *   npm run dev          (repository root)  — or: node server/scripts/dev-startup.js
 *
 * On a fresh clone there is no server/.env: it is created from server/.env.example with a random JWT_SECRET and
 * DOCUMENT_MASTER_KEY. On every start the chain is new, so both contract addresses are written again. The API seeds the
 * demo accounts and documents (registered on-chain) into an in-memory database. Ctrl+C stops everything, process
 * trees included (on Windows, killing a `shell: true` child only kills its cmd.exe wrapper, hence taskkill).
 */

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const SERVER_DIR = path.resolve(__dirname, '..');
const CLIENT_DIR = path.resolve(SERVER_DIR, '..', 'client');
const ENV_PATH = path.join(SERVER_DIR, '.env');
const ENV_EXAMPLE_PATH = path.join(SERVER_DIR, '.env.example');
const RPC_URL = 'http://127.0.0.1:8545';
// Hardhat's well-known account #0 dev key: funded on every local `hardhat node`, worthless anywhere else.
const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const PORTS = [
  [8545, 'Hardhat chain'],
  [5000, 'API'],
  [5173, 'web client'],
];
const PLACEHOLDER_JWT_SECRET = 'replace-with-a-long-random-secret';

const children = [];
let stopping = false;

const killTree = (child) => {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
};

const cleanup = (code = 0) => {
  stopping = true;
  for (const child of children) killTree(child);
  process.exit(code);
};

process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));

const prefix = (proc, label) => {
  const write = (stream, chunk) => {
    for (const line of chunk.toString().split('\n')) {
      const trimmed = line.trimEnd();
      if (trimmed) stream.write(`[${label}] ${trimmed}\n`);
    }
  };
  proc.stdout?.on('data', (data) => write(process.stdout, data));
  proc.stderr?.on('data', (data) => write(process.stderr, data));
};

/** Runs a shell command line (one string: Node 24 deprecates separate args with shell: true). */
const start = (label, commandLine, cwd) => {
  // detached on POSIX so the whole group can be signalled; on Windows taskkill /T handles the tree.
  const child = spawn(commandLine, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  children.push(child);
  prefix(child, label);
  child.on('close', (code) => {
    if (stopping) return;
    console.error(`[dev] ${label} exited unexpectedly (code ${code}); stopping everything.`);
    cleanup(1);
  });
  return child;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Vite binds "localhost", which can be IPv6 only (::1); the chain and the API bind IPv4. Check both families.
const LOOPBACKS = ['127.0.0.1', '::1'];

const portOpenOn = (port, host) =>
  new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

const portInUse = async (port) => (await Promise.all(LOOPBACKS.map((host) => portOpenOn(port, host)))).some(Boolean);

const httpOk = (url, init = {}) =>
  new Promise((resolve) => {
    const request = http.request(url, { method: init.method ?? 'GET', headers: init.headers }, (response) => {
      response.resume();
      resolve(response.statusCode !== undefined && response.statusCode < 500);
    });
    request.on('error', () => resolve(false));
    request.setTimeout(2000, () => {
      request.destroy();
      resolve(false);
    });
    if (init.body) request.write(init.body);
    request.end();
  });

const waitFor = async (description, check, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(500);
  }
  throw new Error(`${description} did not come up within ${Math.round(timeoutMs / 1000)} s`);
};

const rpcReady = () =>
  httpOk(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }),
  });

const deployContracts = () =>
  new Promise((resolve, reject) => {
    const proc = spawn('npx hardhat run scripts/deploy-document-registry.js --network localhost', {
      cwd: SERVER_DIR,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    proc.stdout.on('data', (data) => (stdout += data.toString()));
    proc.stderr.on('data', (data) => process.stderr.write(`[deploy] ${data}`));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`deploy exited with code ${code}`));
      const documentRegistry = stdout.match(/DOCUMENT_REGISTRY_ADDRESS=(0x[0-9a-fA-F]{40})/)?.[1];
      const auditAnchor = stdout.match(/AUDIT_ANCHOR_ADDRESS=(0x[0-9a-fA-F]{40})/)?.[1];
      if (!documentRegistry || !auditAnchor) return reject(new Error(`could not read both addresses from: ${stdout.trim()}`));
      resolve({ documentRegistry, auditAnchor });
    });
  });

/** Reads KEY=value lines, keeping every other line (comments, blanks) exactly as it was. */
const readEnvLines = () => {
  if (fs.existsSync(ENV_PATH)) return fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
  if (!fs.existsSync(ENV_EXAMPLE_PATH)) throw new Error('server/.env.example is missing');
  console.log('[dev] No server/.env yet: creating it from server/.env.example.');
  return fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8').split(/\r?\n/);
};

const valueOf = (lines, key) => {
  const line = lines.find((candidate) => candidate.startsWith(`${key}=`));
  return line === undefined ? undefined : line.slice(key.length + 1).trim();
};

const updateEnv = ({ documentRegistry, auditAnchor }) => {
  const lines = readEnvLines();
  const updates = {
    BLOCKCHAIN_RPC_URL: RPC_URL,
    BLOCKCHAIN_PRIVATE_KEY: PRIVATE_KEY,
    DOCUMENT_REGISTRY_ADDRESS: documentRegistry,
    AUDIT_ANCHOR_ADDRESS: auditAnchor,
  };

  // Secrets are generated once and then kept: a new master key would make every stored document unreadable.
  const jwtSecret = valueOf(lines, 'JWT_SECRET');
  if (!jwtSecret || jwtSecret === PLACEHOLDER_JWT_SECRET) {
    updates.JWT_SECRET = crypto.randomBytes(48).toString('base64url');
    console.log('[dev] Generated a JWT_SECRET.');
  }
  if (!valueOf(lines, 'DOCUMENT_MASTER_KEY')) {
    updates.DOCUMENT_MASTER_KEY = crypto.randomBytes(32).toString('base64');
    console.log('[dev] Generated a DOCUMENT_MASTER_KEY (kept in server/.env; back it up if your data matters).');
  }
  if (!valueOf(lines, 'DOCUMENT_MASTER_KEY_ID')) updates.DOCUMENT_MASTER_KEY_ID = 'primary';

  const written = new Set();
  const output = lines.map((line) => {
    const key = line.split('=')[0].trim();
    if (updates[key] === undefined || line.trimStart().startsWith('#')) return line;
    written.add(key);
    return `${key}=${updates[key]}`;
  });
  for (const [key, value] of Object.entries(updates)) if (!written.has(key)) output.push(`${key}=${value}`);

  fs.writeFileSync(ENV_PATH, `${output.join('\n').replace(/\n+$/, '')}\n`);
  console.log('[dev] server/.env updated with the chain configuration.');
};

const requireInstalled = (dir, label) => {
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    throw new Error(`${label} dependencies are not installed. Run \`npm install\` in the repository root first.`);
  }
};

async function main() {
  requireInstalled(SERVER_DIR, 'Server');
  requireInstalled(CLIENT_DIR, 'Client');

  for (const [port, label] of PORTS) {
    if (await portInUse(port)) {
      throw new Error(`port ${port} (${label}) is already in use. Stop whatever is running there and try again.`);
    }
  }

  // Compile first, as its own step with no deadline: on a fresh clone it downloads the Solidity compiler once.
  console.log('[dev] Compiling the contracts (the first run downloads solc 0.8.24)...');
  const compile = spawnSync('npx hardhat compile', { cwd: SERVER_DIR, shell: true, stdio: 'inherit' });
  if (compile.status !== 0) throw new Error('hardhat compile failed');

  console.log('[dev] Starting the Hardhat chain...');
  start('chain', 'npx hardhat node', SERVER_DIR);
  await waitFor('The Hardhat chain', rpcReady, 180_000);

  console.log('[dev] Deploying DocumentRegistry and AuditAnchorRegistry...');
  const addresses = await deployContracts();
  console.log(`[dev] DocumentRegistry    ${addresses.documentRegistry}`);
  console.log(`[dev] AuditAnchorRegistry ${addresses.auditAnchor}`);
  updateEnv(addresses);

  console.log('[dev] Starting the API (in-memory MongoDB, demo data seeded on-chain)...');
  start('api', 'npm run dev', SERVER_DIR);
  console.log('[dev] Starting the web client...');
  start('web', 'npm run dev', CLIENT_DIR);

  await waitFor('The API', () => httpOk('http://127.0.0.1:5000/api/health'), 120_000);
  await waitFor('The web client', () => portInUse(5173), 120_000);
  console.log('\n[dev] Ready: open http://localhost:5173 (demo accounts: README.md, "Demo accounts"). Ctrl+C stops everything.\n');
}

main().catch((error) => {
  console.error(`[dev] Startup failed: ${error.message}`);
  cleanup(1);
});
