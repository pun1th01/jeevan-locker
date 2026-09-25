import { Contract, Interface, JsonRpcProvider, keccak256, toUtf8Bytes } from 'ethers';
import { Types } from 'mongoose';
import { inject } from 'vitest';
import { ChainAnchor } from '../../src/models/ChainAnchor';
import { processNextAnchor } from '../../src/services/anchorWorker.service';

/** Test-side view of AuditAnchorRegistry, read directly with ethers rather than through the server. */
export const ANCHOR_ABI = [
  'function anchor(bytes32 key, bytes32 digest)',
  'function getAnchor(bytes32 key) view returns (bytes32 digest, uint256 timestamp, address anchoredBy)',
  'event Anchored(bytes32 indexed key, bytes32 indexed digest, address indexed anchoredBy, uint256 timestamp)',
];
export const anchorInterface = new Interface(ANCHOR_ABI);

export const onChainKey = (recordKey: string) => keccak256(toUtf8Bytes(recordKey));

/** Drains every due anchor through the real worker step. Bounded so a bug cannot loop forever. */
export const drainAnchors = async () => {
  for (let step = 0; step < 500 && (await processNextAnchor()); step += 1) {
    // each step sends at most one transaction
  }
};

export const withRegistry = async <T>(
  rpcUrl: string,
  address: string,
  use: (registry: Contract, provider: JsonRpcProvider) => Promise<T>
): Promise<T> => {
  const provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
  try {
    return await use(new Contract(address, ANCHOR_ABI, provider), provider);
  } finally {
    provider.destroy();
  }
};

/** The digest stored on-chain under a record key, as 0x-hex (all zeros when nothing is anchored). */
export const readChainDigest = async (recordKey: string, rpcUrl = inject('chain').rpcUrl, address = inject('chain').auditAnchorAddress) =>
  withRegistry(rpcUrl, address, async (registry) => {
    const [digest] = (await registry.getAnchor(onChainKey(recordKey))) as [string, bigint, string];
    return digest;
  });

export const anchorsFor = (recordId: string) => ChainAnchor.find({ recordId: new Types.ObjectId(recordId) }).sort({ createdAt: 1 });
