'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const SERVER_DIR = path.resolve(__dirname, '..');
const CLIENT_DIR = path.resolve(SERVER_DIR, '..', 'client');
const RPC_URL = 'http://127.0.0.1:8545';
const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ENV_PATH = path.join(SERVER_DIR, '.env');

const children = [];

const cleanup = (code = 0) => {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      // already exited
    }
  }
  process.exit(code);
};

process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));

const prefix = (proc, label) => {
  const write = (stream, chunk) => {
    for (const line of chunk.toString().split('\n')) {
      const trimmed = line.trimEnd();
      if (trimmed) {
        stream.write(`[${label}] ${trimmed}\n`);
      }
    }
  };

  if (proc.stdout) {
    proc.stdout.on('data', (data) => write(process.stdout, data));
  }
  if (proc.stderr) {
    proc.stderr.on('data', (data) => write(process.stderr, data));
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const rpcReady = async (url, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 });
        const req = http.request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
        req.write(body);
        req.end();
      });
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`Hardhat node did not respond within ${timeoutMs / 1000}s`);
};

const deployContract = () =>
  new Promise((resolve, reject) => {
    const proc = spawn(
      'npx',
      ['hardhat', 'run', 'scripts/deploy-document-registry.js', '--network', 'localhost'],
      { cwd: SERVER_DIR, shell: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let stdout = '';
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { process.stderr.write(`[deploy] ${data}`); });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Deploy exited with code ${code}`));
      }

      // We expect output containing both DOCUMENT_REGISTRY_ADDRESS=... and AUDIT_ANCHOR_ADDRESS=...
      const docMatch = stdout.match(/DOCUMENT_REGISTRY_ADDRESS=(0x[0-9a-fA-F]{40})/i);
      const auditMatch = stdout.match(/AUDIT_ANCHOR_ADDRESS=(0x[0-9a-fA-F]{40})/i);

      if (!docMatch || !auditMatch) {
        return reject(new Error(`Could not parse both contract addresses from: ${stdout.trim()}`));
      }

      resolve({
        documentRegistry: docMatch[1],
        auditAnchor: auditMatch[1]
      });
    });

    proc.on('error', reject);
  });

function updateEnv(documentRegistry, auditAnchor) {
  let content = '';
  if (fs.existsSync(ENV_PATH)) {
    content = fs.readFileSync(ENV_PATH, 'utf-8');
  }

  const lines = content.split('\n');
  const envVars = {
    DOCUMENT_REGISTRY_ADDRESS: documentRegistry,
    AUDIT_ANCHOR_ADDRESS: auditAnchor,
    BLOCKCHAIN_RPC_URL: RPC_URL,
    BLOCKCHAIN_PRIVATE_KEY: PRIVATE_KEY,
    DOCUMENT_MASTER_KEY_ID: 'primary'
  };

  // Generate master key if missing
  let hasMasterKey = false;
  for (const line of lines) {
    if (line.trim().startsWith('DOCUMENT_MASTER_KEY=')) {
      const val = line.split('=')[1].trim();
      if (val.length > 0) hasMasterKey = true;
    }
  }

  if (!hasMasterKey) {
    const masterKey = crypto.randomBytes(32).toString('base64');
    envVars.DOCUMENT_MASTER_KEY = masterKey;
    console.log('[dev] Generated new DOCUMENT_MASTER_KEY');
  }

  const updatedLines = [];
  const handledVars = new Set();

  for (const line of lines) {
    const parts = line.split('=');
    const key = parts[0].trim();
    if (envVars[key] !== undefined) {
      updatedLines.push(`${key}=${envVars[key]}`);
      handledVars.add(key);
    } else {
      updatedLines.push(line);
    }
  }

  for (const [key, value] of Object.entries(envVars)) {
    if (!handledVars.has(key)) {
      updatedLines.push(`${key}=${value}`);
    }
  }

  // Filter empty lines at the end to avoid trailing newlines accumulation
  const output = updatedLines.join('\n').replace(/\n{2,}$/, '\n');
  fs.writeFileSync(ENV_PATH, output);
  console.log('[dev] Updated server/.env with chain configuration.');
}

async function main() {
  console.log('[dev] Starting Hardhat node...');

  const hardhat = spawn('npx', ['hardhat', 'node'], {
    cwd: SERVER_DIR,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  children.push(hardhat);
  prefix(hardhat, 'chain');

  hardhat.on('close', (code) => {
    console.error(`[dev] Hardhat node exited unexpectedly (code ${code})`);
    cleanup(1);
  });

  await rpcReady(RPC_URL);
  console.log('[dev] Hardhat node is ready.');

  console.log('[dev] Deploying DocumentRegistry and AuditAnchor...');
  const addresses = await deployContract();
  console.log(`[dev] DocumentRegistry deployed at ${addresses.documentRegistry}`);
  console.log(`[dev] AuditAnchor deployed at ${addresses.auditAnchor}`);

  updateEnv(addresses.documentRegistry, addresses.auditAnchor);

  console.log('[dev] Starting server...');
  const server = spawn('npm', ['run', 'dev'], {
    cwd: SERVER_DIR,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env, // Server will pick up .env naturally because dotenv runs in index.ts
  });

  children.push(server);
  prefix(server, 'server');

  server.on('close', (code) => {
    console.error(`[dev] Server exited (code ${code})`);
    cleanup(1);
  });

  console.log('[dev] Starting client...');
  const client = spawn('npm', ['run', 'dev'], {
    cwd: CLIENT_DIR,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  children.push(client);
  prefix(client, 'client');

  client.on('close', (code) => {
    console.error(`[dev] Client exited (code ${code})`);
    cleanup(1);
  });

  console.log('[dev] All services started. Press Ctrl+C to stop.');
}

main().catch((error) => {
  console.error(`[dev] Startup failed: ${error.message}`);
  cleanup(1);
});
