import { Interface, zeroPadValue } from 'ethers';
import { expectContractEvent, getContract, readChainConfig, sendSerialized } from './chain.service';

const DOCUMENT_REGISTRY_ABI = [
  'function registerDocument(string documentId, bytes32 documentHash)',
  'function getDocumentHash(string documentId) view returns (bytes32)',
  'function getDocument(string documentId) view returns (bytes32 hash, uint256 timestamp, address uploader)',
  'event DocumentRegistered(string indexed documentId, bytes32 indexed documentHash, address indexed uploader, uint256 timestamp)',
];

const documentRegistryInterface = new Interface(DOCUMENT_REGISTRY_ABI);
const ZERO_HASH = `0x${'0'.repeat(64)}`;

const getRegistry = () => {
  const { documentRegistryAddress } = readChainConfig();
  return { contract: getContract(documentRegistryAddress, DOCUMENT_REGISTRY_ABI), address: documentRegistryAddress ?? '' };
};

const toBytes32 = (hash: string) => zeroPadValue(`0x${hash.replace(/^0x/, '')}`, 32);

export interface BlockchainDocumentRecord {
  hash: string;
  timestamp: Date;
  uploader: string;
}

export interface DocumentRegistration {
  transactionHash: string;
  blockNumber: number;
  /** Block timestamp from the DocumentRegistered event — the chain's clock, not the server's. */
  registeredAt: Date;
}

/**
 * Registers the PLAINTEXT SHA-256 of a document. Serialized with every other wallet transaction, and only
 * reported as a success when the receipt carries DocumentRegistered from the configured registry — a
 * transaction to a bare address would otherwise mine fine and register nothing.
 */
export const registerDocumentHash = (documentId: string, sha256Hash: string): Promise<DocumentRegistration> =>
  sendSerialized(async () => {
    const { contract, address } = getRegistry();
    const transaction = await contract.registerDocument(documentId, toBytes32(sha256Hash));
    const receipt = await transaction.wait();
    const event = expectContractEvent(receipt, documentRegistryInterface, address, 'DocumentRegistered');

    return {
      transactionHash: transaction.hash,
      blockNumber: receipt.blockNumber,
      registeredAt: new Date(Number(event.args.timestamp) * 1000),
    };
  });

export const getRegisteredDocumentHash = async (documentId: string): Promise<BlockchainDocumentRecord | null> => {
  const { contract } = getRegistry();
  const [hash, timestamp, uploader] = (await contract.getDocument(documentId)) as [string, bigint, string];

  if (hash.toLowerCase() === ZERO_HASH) {
    return null;
  }

  return { hash: hash.slice(2).toLowerCase(), timestamp: new Date(Number(timestamp) * 1000), uploader };
};
