import type { AnchorReference } from '../models/ConsentGrant';

export interface AnchorReferenceResponse {
  digest: string;
  txHash: string;
  blockNumber: number;
  /** ISO 8601 block timestamp. */
  anchoredAt: string;
}

/** Serializes a record's `anchors` sub-document; omitted from the response until at least one event is on-chain. */
export const serializeAnchorReferences = (
  anchors: Partial<Record<string, AnchorReference | undefined>> | undefined
): Record<string, AnchorReferenceResponse> | undefined => {
  if (!anchors) return undefined;

  // Mongoose hands us a subdocument here; enumerate its plain shape, not its internals.
  const plain = (anchors as { toObject?: () => Partial<Record<string, AnchorReference | undefined>> }).toObject?.() ?? anchors;
  const entries = Object.entries(plain).flatMap(([event, reference]) =>
    reference ? [[event, { digest: reference.digest, txHash: reference.txHash, blockNumber: reference.blockNumber, anchoredAt: reference.anchoredAt.toISOString() }] as const] : []
  );

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};
