import type { RequestHandler } from 'express';
import { Types } from 'mongoose';
import {
  CHAIN_ANCHOR_STATUSES,
  ChainAnchor,
  type ChainAnchorStatus,
  type ConsentAnchorEvent,
  type EmergencyAnchorEvent,
  type IChainAnchor,
} from '../models/ChainAnchor';
import { ConsentGrant } from '../models/ConsentGrant';
import { EmergencyAccess } from '../models/EmergencyAccess';
import { MedicalDocument } from '../models/MedicalDocument';
import { User } from '../models/User';
import { buildConsentPreimage, buildEmergencyPreimage, sha256Hex } from '../services/anchorPreimage.service';
import { retryAnchor } from '../services/anchorQueue.service';
import { anchorKeyFor, getAnchor, type OnChainAnchor } from '../services/auditAnchor.service';
import { asyncHandler } from '../utils/asyncHandler.util';

/** Wire shape of one anchor row. Mirrored in client/src/types/anchor.ts and docs/ANCHORING.md. */
export interface AnchorResponse {
  id: string;
  key: string;
  onChainKey: string;
  recordType: 'consent' | 'emergency';
  recordId: string;
  event: IChainAnchor['event'];
  status: ChainAnchorStatus;
  attempts: number;
  nextAttemptAt: string;
  lastAttemptAt?: string;
  lastError?: string;
  txHash?: string;
  blockNumber?: number;
  anchoredAt?: string;
  failedAt?: string;
  source: IChainAnchor['source'];
  digest: string;
  preimage: string;
  createdAt: string;
  record: { patientName?: string; doctorName?: string; documentTitle?: string; documentId: string };
}

/** The viva screen: three digests side by side and what each comparison means. */
export interface AnchorVerification {
  anchor: AnchorResponse;
  recordFound: boolean;
  /** SHA-256 of the preimage rebuilt from the CURRENT database record; null if the record is gone or never reached the event. */
  recomputedDigest: string | null;
  recomputedPreimage: string | null;
  /** What the worker hashed and sent (the ChainAnchor row). */
  storedDigest: string;
  chainReachable: boolean;
  /** What the contract holds under this key; null if nothing is anchored (or the chain is unreachable). */
  chainDigest: string | null;
  chainTimestamp: string | null;
  chainAnchoredBy: string | null;
  /** recomputed === stored: the record has not been altered since it was anchored. */
  matchesRecord: boolean;
  /** stored === chain: the anchor on-chain belongs to this row. */
  matchesChain: boolean;
  /** Both, and the chain answered. */
  verified: boolean;
  /** Preimage fields whose values differ between stored and recomputed — names the edit. */
  differingFields: string[];
}

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;

const getIdParam = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] ?? '' : value ?? '');
const getQueryString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const isStatus = (value: string): value is ChainAnchorStatus => (CHAIN_ANCHOR_STATUSES as readonly string[]).includes(value);

interface RecordContext {
  patientId?: Types.ObjectId;
  doctorId?: Types.ObjectId;
  documentId: Types.ObjectId;
}

const loadRecordContext = async (anchor: IChainAnchor): Promise<RecordContext | null> => {
  if (anchor.recordType === 'consent') {
    const consent = await ConsentGrant.findById(anchor.recordId).select('patientId doctorId documentId');
    return consent ? { patientId: consent.patientId, doctorId: consent.doctorId, documentId: consent.documentId } : null;
  }

  const grant = await EmergencyAccess.findById(anchor.recordId).select('patientId doctorId documentId');
  return grant ? { patientId: grant.patientId, doctorId: grant.doctorId, documentId: grant.documentId } : null;
};

const serializeAnchor = async (anchor: IChainAnchor, context: RecordContext | null): Promise<AnchorResponse> => {
  const [patient, doctor, document] = await Promise.all([
    context?.patientId ? User.findById(context.patientId).select('name') : null,
    context?.doctorId ? User.findById(context.doctorId).select('name') : null,
    MedicalDocument.findById(anchor.documentId).select('title'),
  ]);

  return {
    id: anchor._id.toString(),
    key: anchor.key,
    onChainKey: anchorKeyFor(anchor.key),
    recordType: anchor.recordType,
    recordId: anchor.recordId.toString(),
    event: anchor.event,
    status: anchor.status,
    attempts: anchor.attempts,
    nextAttemptAt: anchor.nextAttemptAt.toISOString(),
    lastAttemptAt: anchor.lastAttemptAt?.toISOString(),
    lastError: anchor.lastError,
    txHash: anchor.txHash,
    blockNumber: anchor.blockNumber,
    anchoredAt: anchor.anchoredAt?.toISOString(),
    failedAt: anchor.failedAt?.toISOString(),
    source: anchor.source,
    digest: anchor.digest,
    preimage: anchor.preimage,
    createdAt: anchor.createdAt.toISOString(),
    record: {
      patientName: patient?.name,
      doctorName: doctor?.name,
      documentTitle: document?.title,
      documentId: anchor.documentId.toString(),
    },
  };
};

/**
 * GET /api/admin/anchors?status=PENDING|ANCHORED|FAILED&recordType=consent|emergency&limit=50
 * Newest first, plus counts by status for the panel header.
 */
export const listAnchors: RequestHandler = asyncHandler(async (req, res) => {
  const status = getQueryString(req.query.status).toUpperCase();
  const recordType = getQueryString(req.query.recordType).toLowerCase();
  const limitRaw = Number(getQueryString(req.query.limit) || LIST_LIMIT_DEFAULT);
  const filter: Record<string, unknown> = {};

  if (status) {
    if (!isStatus(status)) {
      res.status(400).json({ message: 'status must be PENDING, ANCHORED or FAILED' });
      return;
    }
    filter.status = status;
  }

  if (recordType) {
    if (recordType !== 'consent' && recordType !== 'emergency') {
      res.status(400).json({ message: 'recordType must be consent or emergency' });
      return;
    }
    filter.recordType = recordType;
  }

  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > LIST_LIMIT_MAX) {
    res.status(400).json({ message: `limit must be an integer between 1 and ${LIST_LIMIT_MAX}` });
    return;
  }

  const [rows, countRows] = await Promise.all([
    ChainAnchor.find(filter).sort({ createdAt: -1 }).limit(limitRaw),
    ChainAnchor.aggregate<{ _id: ChainAnchorStatus; count: number }>([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);
  const counts: Record<ChainAnchorStatus, number> = { PENDING: 0, ANCHORED: 0, FAILED: 0 };
  for (const row of countRows) counts[row._id] = row.count;

  const anchors = await Promise.all(rows.map(async (anchor) => serializeAnchor(anchor, await loadRecordContext(anchor))));
  res.json({ anchors, counts });
});

/** Rebuilds the preimage from the current record, exactly as the enqueue did. */
const recomputePreimage = async (anchor: IChainAnchor): Promise<string | null> => {
  const document = await MedicalDocument.findById(anchor.documentId).select('documentHash');
  const documentHash = document?.documentHash ?? null;

  if (anchor.recordType === 'consent') {
    const consent = await ConsentGrant.findById(anchor.recordId);
    return consent ? buildConsentPreimage(consent, anchor.event as ConsentAnchorEvent, documentHash) : null;
  }

  const grant = await EmergencyAccess.findById(anchor.recordId);
  return grant ? buildEmergencyPreimage(grant, anchor.event as EmergencyAnchorEvent, documentHash) : null;
};

const differingFields = (stored: string, recomputed: string | null): string[] => {
  if (recomputed === null) return [];

  try {
    const a = JSON.parse(stored) as Record<string, unknown>;
    const b = JSON.parse(recomputed) as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((field) => JSON.stringify(a[field]) !== JSON.stringify(b[field]));
  } catch {
    return ['<unparseable preimage>'];
  }
};

/**
 * GET /api/admin/anchors/:id/verify
 * Three independent values, compared pairwise:
 *   recomputed — SHA-256 of the preimage rebuilt from the record as it is NOW
 *   stored     — the digest the worker hashed at enqueue time (ChainAnchor row)
 *   chain      — what the contract returns for this key
 * recomputed != stored  => the database row was altered after it was anchored (differingFields says where)
 * stored != chain       => the on-chain anchor is not this row's (wrong key, wrong chain, or nothing anchored)
 */
export const verifyAnchor: RequestHandler = asyncHandler(async (req, res) => {
  const anchorId = getIdParam(req.params.id);

  if (!Types.ObjectId.isValid(anchorId)) {
    res.status(400).json({ message: 'A valid anchor ID is required' });
    return;
  }

  const anchor = await ChainAnchor.findById(anchorId);

  if (!anchor) {
    res.status(404).json({ message: 'Anchor not found' });
    return;
  }

  const context = await loadRecordContext(anchor);
  const recomputedPreimage = await recomputePreimage(anchor);
  const recomputedDigest = recomputedPreimage === null ? null : sha256Hex(recomputedPreimage);

  let chain: OnChainAnchor | null = null;
  let chainReachable = true;

  try {
    chain = await getAnchor(anchor.key);
  } catch {
    chainReachable = false;
  }

  const matchesRecord = recomputedDigest !== null && recomputedDigest === anchor.digest;
  const matchesChain = chain !== null && chain.digest === anchor.digest;
  const verification: AnchorVerification = {
    anchor: await serializeAnchor(anchor, context),
    recordFound: context !== null,
    recomputedDigest,
    recomputedPreimage,
    storedDigest: anchor.digest,
    chainReachable,
    chainDigest: chain?.digest ?? null,
    chainTimestamp: chain?.timestamp.toISOString() ?? null,
    chainAnchoredBy: chain?.anchoredBy ?? null,
    matchesRecord,
    matchesChain,
    verified: chainReachable && matchesRecord && matchesChain,
    differingFields: differingFields(anchor.preimage, recomputedPreimage),
  };

  res.json(verification);
});

/** POST /api/admin/anchors/:id/retry — re-queues a FAILED (or stuck PENDING) row. */
export const retryAnchorHandler: RequestHandler = asyncHandler(async (req, res) => {
  const anchorId = getIdParam(req.params.id);

  if (!Types.ObjectId.isValid(anchorId)) {
    res.status(400).json({ message: 'A valid anchor ID is required' });
    return;
  }

  const anchor = await retryAnchor(anchorId);

  if (!anchor) {
    const exists = await ChainAnchor.exists({ _id: anchorId });
    res.status(exists ? 409 : 404).json({ message: exists ? 'Only pending or failed anchors can be retried' : 'Anchor not found' });
    return;
  }

  res.json({ message: 'Anchor re-queued', anchor: await serializeAnchor(anchor, await loadRecordContext(anchor)) });
});
