// Mirrors AnchorResponse / AnchorVerification in server/src/controllers/anchor.controller.ts — keep in sync.

export type ChainAnchorStatus = 'PENDING' | 'ANCHORED' | 'FAILED';
export type AnchorEvent = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'REVOKED' | 'GRANTED';

export interface ChainAnchorRow {
  id: string;
  /** Off-chain record key, e.g. "consent:<id>:APPROVED". */
  key: string;
  /** keccak256 of `key` — what the contract is indexed by. */
  onChainKey: string;
  recordType: 'consent' | 'emergency';
  recordId: string;
  event: AnchorEvent;
  status: ChainAnchorStatus;
  attempts: number;
  nextAttemptAt: string;
  lastAttemptAt?: string;
  lastError?: string;
  txHash?: string;
  blockNumber?: number;
  anchoredAt?: string;
  failedAt?: string;
  source: 'controller' | 'reconciliation' | 'retry';
  digest: string;
  preimage: string;
  createdAt: string;
  record: { patientName?: string; doctorName?: string; documentTitle?: string; documentId: string };
}

export interface AnchorListResponse {
  anchors: ChainAnchorRow[];
  counts: Record<ChainAnchorStatus, number>;
}

export interface AnchorVerification {
  anchor: ChainAnchorRow;
  recordFound: boolean;
  recomputedDigest: string | null;
  recomputedPreimage: string | null;
  storedDigest: string;
  chainReachable: boolean;
  chainDigest: string | null;
  chainTimestamp: string | null;
  chainAnchoredBy: string | null;
  /** recomputed === stored: the record has not been altered since anchoring. */
  matchesRecord: boolean;
  /** stored === chain: the on-chain anchor belongs to this row. */
  matchesChain: boolean;
  verified: boolean;
  differingFields: string[];
}
