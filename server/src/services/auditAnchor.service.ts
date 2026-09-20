import { Interface, keccak256, toUtf8Bytes, zeroPadValue } from 'ethers';
import { expectContractEvent, getContract, readChainConfig, sendSerialized } from './chain.service';

const AUDIT_ANCHOR_ABI = [
  'function anchor(bytes32 key, bytes32 digest)',
  'function getAnchor(bytes32 key) view returns (bytes32 digest, uint256 timestamp, address anchoredBy)',
  'event Anchored(bytes32 indexed key, bytes32 indexed digest, address indexed anchoredBy, uint256 timestamp)',
];

export const AUDIT_ANCHOR_NOT_CONFIGURED_MESSAGE = 'Audit anchoring is not configured. Set AUDIT_ANCHOR_ADDRESS.';

const auditAnchorInterface = new Interface(AUDIT_ANCHOR_ABI);
const ZERO_HASH = `0x${'0'.repeat(64)}`;

const getAnchorRegistry = () => {
  const { auditAnchorAddress } = readChainConfig();
  return { contract: getContract(auditAnchorAddress, AUDIT_ANCHOR_ABI, AUDIT_ANCHOR_NOT_CONFIGURED_MESSAGE), address: auditAnchorAddress ?? '' };
};

/** On-chain key for an off-chain record key such as "consent:<id>:APPROVED". Documented in docs/ANCHORING.md. */
export const anchorKeyFor = (recordKey: string): string => keccak256(toUtf8Bytes(recordKey));

const toBytes32 = (hex: string) => zeroPadValue(`0x${hex.replace(/^0x/, '')}`, 32);

export interface AnchorResult {
  transactionHash: string;
  blockNumber: number;
  /** Block timestamp from the Anchored event. */
  anchoredAt: Date;
}

export interface OnChainAnchor {
  /** SHA-256 hex (64 chars, lower-case). */
  digest: string;
  timestamp: Date;
  anchoredBy: string;
}

/** Writes a digest under a key, once. Serialized with every other wallet transaction; guarded by the Anchored event. */
export const anchorDigest = (recordKey: string, sha256Hex: string): Promise<AnchorResult> =>
  sendSerialized(async () => {
    const { contract, address } = getAnchorRegistry();
    const transaction = await contract.anchor(anchorKeyFor(recordKey), toBytes32(sha256Hex));
    const receipt = await transaction.wait();
    const event = expectContractEvent(receipt, auditAnchorInterface, address, 'Anchored');

    return {
      transactionHash: transaction.hash,
      blockNumber: receipt.blockNumber,
      anchoredAt: new Date(Number(event.args.timestamp) * 1000),
    };
  });

export const getAnchor = async (recordKey: string): Promise<OnChainAnchor | null> => {
  const { contract } = getAnchorRegistry();
  const [digest, timestamp, anchoredBy] = (await contract.getAnchor(anchorKeyFor(recordKey))) as [string, bigint, string];

  if (digest.toLowerCase() === ZERO_HASH) {
    return null;
  }

  return { digest: digest.slice(2).toLowerCase(), timestamp: new Date(Number(timestamp) * 1000), anchoredBy };
};
