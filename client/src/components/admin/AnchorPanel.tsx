import { AlertTriangle, CheckCircle2, Link2, Loader2, RefreshCw, RotateCcw, ShieldCheck, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { getApiErrorMessage } from '../../lib/api';
import { cn } from '../../lib/utils';
import { anchorService } from '../../services/anchor.service';
import type { AnchorVerification, ChainAnchorRow, ChainAnchorStatus } from '../../types/anchor';
import { Button } from '../ui/button';

/**
 * On-chain anchors for the admin dashboard. The Verify view is the viva demo of the immutability claim:
 * three independent digests side by side — recomputed from the record now, stored at enqueue time, read
 * back from the contract — and what each comparison means. Kept deliberately plain.
 */

const statusStyles: Record<ChainAnchorStatus, string> = {
  PENDING: 'bg-amber-300/10 text-amber-100 border-amber-300/25',
  ANCHORED: 'bg-emerald-300/10 text-emerald-100 border-emerald-300/25',
  FAILED: 'bg-rose-500/20 text-rose-100 border-rose-400/40',
};

const statusLabels: Record<ChainAnchorStatus, string> = {
  PENDING: 'Pending · retrying',
  ANCHORED: 'Anchored',
  FAILED: 'Failed · needs attention',
};

const formatDateTime = (value: string) =>
  new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(
    new Date(value)
  );

const short = (hex: string | null | undefined, keep = 10) => (hex ? `${hex.slice(0, keep)}…${hex.slice(-6)}` : '—');

const describeRecord = (anchor: ChainAnchorRow) => {
  const who = anchor.recordType === 'consent' ? `${anchor.record.doctorName ?? 'doctor'} ↔ ${anchor.record.patientName ?? 'patient'}` : `${anchor.record.doctorName ?? 'doctor'} → ${anchor.record.patientName ?? 'patient'}`;
  return `${anchor.recordType === 'consent' ? 'Consent' : 'Emergency'} ${anchor.event.toLowerCase()} · ${who} · ${anchor.record.documentTitle ?? 'document'}`;
};

interface DigestCardProps {
  title: string;
  subtitle: string;
  digest: string | null;
  tone: 'neutral' | 'ok' | 'bad';
  note?: string;
}

const DigestCard = ({ title, subtitle, digest, tone, note }: DigestCardProps) => (
  <div
    className={cn(
      'min-w-0 rounded-md border p-3',
      tone === 'ok' ? 'border-emerald-300/30 bg-emerald-300/[0.06]' : tone === 'bad' ? 'border-rose-400/40 bg-rose-500/10' : 'border-white/10 bg-slate-950/50'
    )}
  >
    <p className="text-xs font-semibold uppercase tracking-wide text-slate-300">{title}</p>
    <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>
    <p className="mt-2 break-all font-mono text-xs leading-5 text-white">{digest ?? '— (none)'}</p>
    {note ? <p className="mt-2 text-xs text-slate-400">{note}</p> : null}
  </div>
);

export default function AnchorPanel() {
  const [rows, setRows] = useState<ChainAnchorRow[]>([]);
  const [counts, setCounts] = useState<Record<ChainAnchorStatus, number>>({ PENDING: 0, ANCHORED: 0, FAILED: 0 });
  const [filter, setFilter] = useState<ChainAnchorStatus | ''>('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [verification, setVerification] = useState<AnchorVerification | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await anchorService.list(filter ? { status: filter, limit: 50 } : { limit: 50 });
      setRows(response.anchors);
      setCounts(response.counts);
    } catch (requestError) {
      setError(getApiErrorMessage(requestError));
    } finally {
      setIsLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [load]);

  const handleVerify = async (anchor: ChainAnchorRow) => {
    setVerifyingId(anchor.id);
    setVerification(null);
    setError(null);

    try {
      setVerification(await anchorService.verify(anchor.id));
    } catch (requestError) {
      setError(getApiErrorMessage(requestError));
    } finally {
      setVerifyingId(null);
    }
  };

  const handleRetry = async (anchor: ChainAnchorRow) => {
    setRetryingId(anchor.id);
    setError(null);

    try {
      const updated = await anchorService.retry(anchor.id);
      setRows((current) => current.map((row) => (row.id === updated.id ? updated : row)));
      window.setTimeout(() => void load(), 1500);
    } catch (requestError) {
      setError(getApiErrorMessage(requestError));
    } finally {
      setRetryingId(null);
    }
  };

  return (
    <div className="rounded-lg border border-white/10 bg-slate-900/70 p-6 xl:col-span-2">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-md bg-emerald-300/10">
            <Link2 className="h-5 w-5 text-emerald-200" />
          </span>
          <div>
            <h2 className="text-lg font-semibold text-white">On-chain Audit Anchors</h2>
            <p className="mt-1 text-sm text-slate-400">
              Every consent transition and emergency grant is hashed and written to the AuditAnchorRegistry contract. Verify recomputes the
              hash from the live record and compares it with what the chain holds.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(['', 'PENDING', 'ANCHORED', 'FAILED'] as const).map((value) => (
            <button
              key={value || 'all'}
              type="button"
              onClick={() => setFilter(value)}
              className={cn(
                'rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors',
                filter === value ? 'border-emerald-300/40 bg-emerald-300/10 text-emerald-100' : 'border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/[0.06]'
              )}
            >
              {value ? `${statusLabels[value].split(' ·')[0]} (${counts[value]})` : `All (${counts.PENDING + counts.ANCHORED + counts.FAILED})`}
            </button>
          ))}
          <Button type="button" variant="secondary" size="sm" onClick={() => void load()} disabled={isLoading} aria-label="Reload anchors">
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {counts.FAILED > 0 ? (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {counts.FAILED} anchor{counts.FAILED === 1 ? '' : 's'} failed after the retry cap and need attention. Check the chain configuration, then Retry.
        </div>
      ) : null}

      {error ? (
        <div className="mt-4 rounded-md border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">{error}</div>
      ) : null}

      {verification ? (
        <div className="mt-5 rounded-lg border border-white/15 bg-slate-950/70 p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold',
                    verification.verified ? 'bg-emerald-300/15 text-emerald-100' : 'bg-rose-500/20 text-rose-100'
                  )}
                >
                  {verification.verified ? <ShieldCheck className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                  {verification.verified ? 'VERIFIED — record, ledger and chain agree' : 'NOT VERIFIED'}
                </span>
              </div>
              <p className="mt-2 text-sm text-slate-300">{describeRecord(verification.anchor)}</p>
              <p className="mt-1 break-all font-mono text-xs text-slate-500">
                key {verification.anchor.key} · on-chain key {short(verification.anchor.onChainKey, 12)}
                {verification.anchor.txHash ? ` · tx ${short(verification.anchor.txHash, 12)}` : ''}
                {verification.chainTimestamp ? ` · block time ${formatDateTime(verification.chainTimestamp)}` : ''}
              </p>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setVerification(null)}>
              Close
            </Button>
          </div>

          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            <DigestCard
              title="1 · Recomputed"
              subtitle="SHA-256 of the preimage rebuilt from the record as it is right now"
              digest={verification.recomputedDigest}
              tone={verification.recomputedDigest === null ? 'bad' : verification.matchesRecord ? 'ok' : 'bad'}
              note={
                !verification.recordFound
                  ? 'The record no longer exists in the database.'
                  : verification.recomputedDigest === null
                    ? 'The record has not reached this event.'
                    : undefined
              }
            />
            <DigestCard title="2 · Stored" subtitle="What the anchor worker hashed at the time of the event" digest={verification.storedDigest} tone="neutral" />
            <DigestCard
              title="3 · On-chain"
              subtitle="Read back from AuditAnchorRegistry.getAnchor(key)"
              digest={verification.chainDigest}
              tone={!verification.chainReachable ? 'bad' : verification.matchesChain ? 'ok' : 'bad'}
              note={!verification.chainReachable ? 'The chain could not be reached.' : verification.chainDigest === null ? 'Nothing is anchored under this key.' : verification.chainAnchoredBy ? `Anchored by ${short(verification.chainAnchoredBy, 8)}` : undefined}
            />
          </div>

          <div className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
            <div className={cn('flex items-start gap-2 rounded-md px-3 py-2', verification.matchesRecord ? 'bg-emerald-300/[0.06] text-emerald-100' : 'bg-rose-500/10 text-rose-100')}>
              {verification.matchesRecord ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
              <span>
                <strong>1 = 2</strong>{' '}
                {verification.matchesRecord
                  ? 'The database record is unchanged since it was anchored.'
                  : `The database record was altered after it was anchored${verification.differingFields.length ? ` — field(s): ${verification.differingFields.join(', ')}` : ''}.`}
              </span>
            </div>
            <div className={cn('flex items-start gap-2 rounded-md px-3 py-2', verification.matchesChain ? 'bg-emerald-300/[0.06] text-emerald-100' : 'bg-rose-500/10 text-rose-100')}>
              {verification.matchesChain ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
              <span>
                <strong>2 = 3</strong>{' '}
                {verification.matchesChain
                  ? 'The on-chain anchor belongs to this record.'
                  : !verification.chainReachable
                    ? 'Could not read the chain; nothing can be concluded yet.'
                    : 'The on-chain anchor does not match this record — wrong key, wrong chain, or not yet anchored.'}
              </span>
            </div>
          </div>

          <details className="mt-3 text-xs text-slate-400">
            <summary className="cursor-pointer select-none text-slate-300">Show preimages</summary>
            <p className="mt-2 font-semibold text-slate-300">Stored</p>
            <pre className="mt-1 overflow-x-auto rounded-md bg-slate-950 p-2 font-mono text-[11px] leading-5 text-slate-200">{verification.anchor.preimage}</pre>
            <p className="mt-2 font-semibold text-slate-300">Recomputed</p>
            <pre className="mt-1 overflow-x-auto rounded-md bg-slate-950 p-2 font-mono text-[11px] leading-5 text-slate-200">{verification.recomputedPreimage ?? '— (record missing or event not reached)'}</pre>
          </details>
        </div>
      ) : null}

      {isLoading && rows.length === 0 ? (
        <div className="mt-5 flex items-center gap-2 text-sm text-slate-300">
          <Loader2 className="h-4 w-4 animate-spin text-emerald-300" />
          Loading anchors...
        </div>
      ) : rows.length === 0 ? (
        <p className="mt-5 rounded-md border border-dashed border-white/15 bg-slate-950/60 p-4 text-sm text-slate-400">
          No anchors yet. They appear as soon as a consent request, approval, rejection, revocation or emergency grant happens.
        </p>
      ) : (
        <div className="mt-5 overflow-hidden rounded-md border border-white/10">
          <div className="divide-y divide-white/10">
            {rows.map((anchor) => (
              <div key={anchor.id} className="flex flex-col gap-3 bg-slate-950/50 p-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn('inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold', statusStyles[anchor.status])}>
                      {statusLabels[anchor.status]}
                    </span>
                    <span className="rounded-md bg-white/[0.05] px-2 py-0.5 text-xs text-slate-300">
                      {anchor.recordType} · {anchor.event}
                    </span>
                    {anchor.source !== 'controller' ? (
                      <span className="rounded-md bg-white/[0.05] px-2 py-0.5 text-xs text-slate-400">via {anchor.source}</span>
                    ) : null}
                  </div>
                  <p className="mt-2 text-sm text-slate-200">{describeRecord(anchor)}</p>
                  <p className="mt-1 break-all font-mono text-xs text-slate-500">digest {short(anchor.digest, 12)}</p>
                  {anchor.status === 'ANCHORED' && anchor.txHash ? (
                    <p className="mt-1 break-all font-mono text-xs text-slate-500">
                      tx {short(anchor.txHash, 12)} · block {anchor.blockNumber} · {anchor.anchoredAt ? formatDateTime(anchor.anchoredAt) : ''}
                    </p>
                  ) : null}
                  {anchor.status !== 'ANCHORED' ? (
                    <p className="mt-1 text-xs text-slate-400">
                      {anchor.attempts} attempt{anchor.attempts === 1 ? '' : 's'}
                      {anchor.status === 'PENDING' ? ` · next ${formatDateTime(anchor.nextAttemptAt)}` : anchor.failedAt ? ` · failed ${formatDateTime(anchor.failedAt)}` : ''}
                      {anchor.lastError ? <span className="block break-all font-mono text-[11px] text-rose-200/90">{anchor.lastError}</span> : null}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button type="button" size="sm" variant="secondary" onClick={() => void handleVerify(anchor)} disabled={verifyingId === anchor.id}>
                    {verifyingId === anchor.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                    Verify
                  </Button>
                  {anchor.status === 'FAILED' ? (
                    <Button type="button" size="sm" variant="destructive" onClick={() => void handleRetry(anchor)} disabled={retryingId === anchor.id}>
                      {retryingId === anchor.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                      Retry
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
