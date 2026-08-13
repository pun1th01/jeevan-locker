import { Contract, JsonRpcProvider, Wallet, isAddress, zeroPadValue } from 'ethers';

const DOCUMENT_REGISTRY_ABI = [
  'function registerDocument(string documentId, bytes32 documentHash)',
  'function getDocumentHash(string documentId) view returns (bytes32)',
  'function getDocument(string documentId) view returns (bytes32 hash, uint256 timestamp, address uploader)',
];

const ZERO_HASH = `0x${'0'.repeat(64)}`;

const getBlockchainConfig = () => {
  const rpcUrl = process.env.BLOCKCHAIN_RPC_URL;
  const privateKey = process.env.BLOCKCHAIN_PRIVATE_KEY;
  const contractAddress = process.env.DOCUMENT_REGISTRY_ADDRESS;

  if (!rpcUrl || !privateKey || !contractAddress) {
    const error = new Error('Blockchain is not configured. Set BLOCKCHAIN_RPC_URL, BLOCKCHAIN_PRIVATE_KEY, and DOCUMENT_REGISTRY_ADDRESS.');
    (error as Error & { statusCode?: number }).statusCode = 503;
    throw error;
  }

  if (!isAddress(contractAddress)) {
    throw new Error('DOCUMENT_REGISTRY_ADDRESS is not a valid Ethereum contract address');
  }

  return { rpcUrl, privateKey, contractAddress };
};

const getRegistry = () => {
  const { rpcUrl, privateKey, contractAddress } = getBlockchainConfig();
  const provider = new JsonRpcProvider(rpcUrl);
  return new Contract(contractAddress, DOCUMENT_REGISTRY_ABI, new Wallet(privateKey, provider));
};

const toBytes32 = (hash: string) => zeroPadValue(`0x${hash.replace(/^0x/, '')}`, 32);

export interface BlockchainDocumentRecord {
  hash: string;
  timestamp: Date;
  uploader: string;
}

export const registerDocumentHash = async (documentId: string, sha256Hash: string) => {
  const registry = getRegistry();
  const transaction = await registry.registerDocument(documentId, toBytes32(sha256Hash));
  const receipt = await transaction.wait();

  if (!receipt) {
    throw new Error('Blockchain registration transaction was not confirmed');
  }

  return { transactionHash: transaction.hash, registeredAt: new Date() };
};

export const getRegisteredDocumentHash = async (documentId: string): Promise<BlockchainDocumentRecord | null> => {
  const registry = getRegistry();
  const [hash, timestamp, uploader] = (await registry.getDocument(documentId)) as [string, bigint, string];

  if (hash.toLowerCase() === ZERO_HASH) {
    return null;
  }

  return { hash: hash.slice(2).toLowerCase(), timestamp: new Date(Number(timestamp) * 1000), uploader };
};
