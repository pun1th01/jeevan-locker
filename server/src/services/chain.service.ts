import { Contract, Interface, JsonRpcProvider, Wallet, isAddress, type LogDescription, type TransactionReceipt } from 'ethers';

/**
 * Everything the server needs to talk to the chain, in one place:
 *   - config from env (read on every call so tests and rotations can change it at runtime)
 *   - one cached provider + wallet per (rpcUrl, key) pair
 *   - sendSerialized(): all transactions from the wallet go through one in-process mutex. ethers picks
 *     the nonce per transaction; two concurrent sends from the same wallet race for it and one fails
 *     with "nonce too low" / "replacement underpriced". Uploads and audit anchors share this wallet.
 *     The provider is also created with its RPC cache disabled (see getSigner) — the two together are
 *     what make back-to-back sends safe.
 *   - verifyChainContractsAtBoot(): getCode() on every configured address, so a bare address that
 *     would silently accept transactions (and register nothing) is refused before the server listens
 *   - expectContractEvent(): the per-send guard — a transaction only counts if the receipt succeeded
 *     AND carries the event our contract emits. A transaction to an EOA succeeds with no logs.
 */

export const CHAIN_NOT_CONFIGURED_MESSAGE =
  'Blockchain is not configured. Set BLOCKCHAIN_RPC_URL, BLOCKCHAIN_PRIVATE_KEY, and DOCUMENT_REGISTRY_ADDRESS.';

/** 503 for callers: the feature exists but the deployment lacks the configuration it needs. */
export class ChainNotConfiguredError extends Error {
  readonly statusCode = 503;

  constructor(message = CHAIN_NOT_CONFIGURED_MESSAGE) {
    super(message);
    this.name = 'ChainNotConfiguredError';
  }
}

export interface ChainConfig {
  rpcUrl?: string;
  privateKey?: string;
  documentRegistryAddress?: string;
  auditAnchorAddress?: string;
}

const readEnv = (key: string) => {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
};

export const readChainConfig = (): ChainConfig => ({
  rpcUrl: readEnv('BLOCKCHAIN_RPC_URL'),
  privateKey: readEnv('BLOCKCHAIN_PRIVATE_KEY'),
  documentRegistryAddress: readEnv('DOCUMENT_REGISTRY_ADDRESS'),
  auditAnchorAddress: readEnv('AUDIT_ANCHOR_ADDRESS'),
});

interface SignerContext {
  key: string;
  provider: JsonRpcProvider;
  wallet: Wallet;
}

let signerContext: SignerContext | null = null;

/** Cached per (rpcUrl, privateKey); rebuilt only when either changes. */
export const getSigner = (config: ChainConfig = readChainConfig()): Wallet => {
  if (!config.rpcUrl || !config.privateKey) {
    throw new ChainNotConfiguredError();
  }

  const key = `${config.rpcUrl}|${config.privateKey}`;

  if (!signerContext || signerContext.key !== key) {
    // cacheTimeout: -1 disables ethers' 250 ms RPC result cache. With it on, a send issued right after the
    // previous one mined reads a stale eth_getTransactionCount and fails with "nonce too low" — even when
    // sends are serialized. That cache, not just concurrency, was the upload nonce race on main.
    const provider = new JsonRpcProvider(config.rpcUrl, undefined, { cacheTimeout: -1 });
    signerContext = { key, provider, wallet: new Wallet(config.privateKey, provider) };
  }

  return signerContext.wallet;
};

/** A contract bound to the cached signer. Throws ChainNotConfiguredError when the address or signer is missing. */
export const getContract = (address: string | undefined, abi: string[], missingMessage = CHAIN_NOT_CONFIGURED_MESSAGE): Contract => {
  if (!address) {
    throw new ChainNotConfiguredError(missingMessage);
  }

  if (!isAddress(address)) {
    throw new Error(`${address} is not a valid Ethereum address`);
  }

  return new Contract(address, abi, getSigner());
};

// ---------- one transaction at a time ----------

let sendQueue: Promise<unknown> = Promise.resolve();

/**
 * Runs `send` after every previously queued send has settled. Serialising all wallet transactions in
 * this process removes the nonce race between concurrent uploads and between uploads and anchors.
 */
export const sendSerialized = <T>(send: () => Promise<T>): Promise<T> => {
  const run = sendQueue.then(send, send);
  sendQueue = run.catch(() => undefined);
  return run;
};

// ---------- per-send guard ----------

/**
 * Confirms a mined receipt is a success AND that our contract emitted `eventName` from `contractAddress`.
 * Without this, a transaction to a bare address (no code) mines "successfully" and registers nothing.
 * Returns the parsed event so callers can read on-chain values (e.g. the block timestamp) for free.
 */
export const expectContractEvent = (
  receipt: TransactionReceipt | null,
  iface: Interface,
  contractAddress: string,
  eventName: string
): LogDescription => {
  if (!receipt) {
    throw new Error('Transaction was not confirmed');
  }

  if (receipt.status !== 1) {
    throw new Error(`Transaction ${receipt.hash} reverted`);
  }

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contractAddress.toLowerCase()) {
      continue;
    }

    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });

      if (parsed?.name === eventName) {
        return parsed;
      }
    } catch {
      // not one of ours
    }
  }

  throw new Error(
    `Transaction ${receipt.hash} did not emit ${eventName} from ${contractAddress} — the address is not the expected contract`
  );
};

// ---------- boot check ----------

export interface ContractBootCheck {
  variable: 'DOCUMENT_REGISTRY_ADDRESS' | 'AUDIT_ANCHOR_ADDRESS';
  address?: string;
  status: 'ok' | 'unset';
  codeBytes?: number;
}

export interface ChainBootStatus {
  configured: boolean;
  reachable: boolean;
  contracts: ContractBootCheck[];
}

const GET_CODE_TIMEOUT_MS = 5_000;

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

/**
 * Three deliberately different outcomes:
 *   - chain not configured           -> warn, run degraded (uploads 503, anchors stay PENDING)
 *   - configured but RPC unreachable -> warn, continue (an outage is not a misconfiguration)
 *   - reachable and an address has NO code -> throw: this is always a config error, and left alone it
 *     makes every upload "succeed" with a transaction that registered nothing
 */
export const verifyChainContractsAtBoot = async (log: (message: string) => void = console.log): Promise<ChainBootStatus> => {
  const config = readChainConfig();
  const contracts: Array<[ContractBootCheck['variable'], string | undefined]> = [
    ['DOCUMENT_REGISTRY_ADDRESS', config.documentRegistryAddress],
    ['AUDIT_ANCHOR_ADDRESS', config.auditAnchorAddress],
  ];

  if (!config.rpcUrl || !config.privateKey) {
    log('[chain] WARNING: BLOCKCHAIN_RPC_URL / BLOCKCHAIN_PRIVATE_KEY not set — uploads return 503 and audit anchors stay PENDING until configured');
    return { configured: false, reachable: false, contracts: contracts.map(([variable, address]) => ({ variable, address, status: 'unset' })) };
  }

  for (const [variable, address] of contracts) {
    if (address && !isAddress(address)) {
      throw new Error(`${variable}=${address} is not a valid Ethereum address`);
    }
  }

  const provider = getSigner(config).provider as JsonRpcProvider;
  const results: ContractBootCheck[] = [];

  for (const [variable, address] of contracts) {
    if (!address) {
      log(`[chain] WARNING: ${variable} not set — ${variable === 'DOCUMENT_REGISTRY_ADDRESS' ? 'uploads return 503' : 'audit anchors stay PENDING'} until configured`);
      results.push({ variable, status: 'unset' });
      continue;
    }

    let code: string;

    try {
      code = await withTimeout(provider.getCode(address), GET_CODE_TIMEOUT_MS, `getCode(${variable})`);
    } catch (error) {
      log(`[chain] WARNING: ${config.rpcUrl} unreachable (${error instanceof Error ? error.message : String(error)}) — could not verify ${variable}; continuing`);
      return { configured: true, reachable: false, contracts: results };
    }

    if (code === '0x') {
      throw new Error(
        `${variable}=${address} has no contract code on ${config.rpcUrl}. A bare address accepts transactions that register nothing. ` +
          'Run `npm run chain:deploy` and copy the printed address into server/.env.'
      );
    }

    const codeBytes = (code.length - 2) / 2;
    log(`[chain] ${variable}=${address} ok (${codeBytes} bytes of code)`);
    results.push({ variable, address, status: 'ok', codeBytes });
  }

  return { configured: true, reachable: true, contracts: results };
};
