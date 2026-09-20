export type ConsentStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'REVOKED';

/** Proof that one event of a record is anchored on-chain (see docs/ANCHORING.md). */
export interface AnchorReference {
  digest: string;
  txHash: string;
  blockNumber: number;
  /** ISO 8601 block timestamp. */
  anchoredAt: string;
}

export interface ConsentGrant {
  id: string;
  patient: { id: string; name: string };
  doctor: { id: string; name: string };
  document: { id: string; title: string };
  purpose: string;
  status: ConsentStatus;
  requestedAt: string;
  approvedAt?: string;
  rejectedAt?: string;
  revokedAt?: string;
  /** Present once at least one event is on-chain; keys are requested | approved | rejected | revoked. */
  anchors?: Partial<Record<'requested' | 'approved' | 'rejected' | 'revoked', AnchorReference>>;
}

export interface RequestConsentInput {
  patientId: string;
  documentId: string;
  purpose: string;
}
