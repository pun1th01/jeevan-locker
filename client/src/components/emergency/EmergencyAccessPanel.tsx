import { AlertTriangle, ChevronDown, ChevronUp, Clock, History, Loader2, RefreshCw, ShieldAlert, ShieldOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getApiErrorMessage, getApiErrorStatus } from '../../lib/api';
import { cn } from '../../lib/utils';
import { emergencyAccessService } from '../../services/emergencyAccess.service';
import type { EmergencyAccess } from '../../types/emergencyAccess';
import { Button } from '../ui/button';

/**
 * Break-glass access on the patient's own records: what is open right now, and every grant that has ended.
 *
 * Emergency access is the one path where a doctor reads a record without being given permission first, so
 * the patient's compensating control is visibility plus the ability to end it. Two decisions follow from
 * that and should not be undone lightly:
 *
 *  - Revoking asks for confirmation. It is immediate and cannot be undone for that session, and an
 *    accidental click during a real emergency cuts off a doctor who is treating this patient.
 *  - A grant flagged `afterRevocation` is shown loudly. It is the answer to "what does revoking actually
 *    accomplish": the doctor can break glass again, but never quietly.
 *
 * Self-contained on purpose — it fetches and refreshes its own data, so mounting it costs one line.
 */

const REFRESH_INTERVAL_MS = 15_000;
const TICK_INTERVAL_MS = 1_000;
const NOTICE_TIMEOUT_MS = 7_000;

const formatDateTime = (value: string) =>
  new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));

/**
 * Live means ACTIVE *and* still inside its window — exactly the rule every server read path applies, so a
 * row the expiry job has not swept yet can never be displayed as though it still grants access.
 */
const isLive = (grant: EmergencyAccess, now: number) => grant.status === 'ACTIVE' && new Date(grant.expiresAt).getTime() > now;

const formatRemaining = (expiresAt: string, now: number) => {
  const remainingMs = new Date(expiresAt).getTime() - now;

  if (remainingMs <= 0) {
    return 'ending';
  }

  const totalSeconds = Math.ceil(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}:${String(seconds).padStart(2, '0')}`;
};

const describeEnding = (grant: EmergencyAccess) =>
  grant.status === 'REVOKED' && grant.revokedAt ? `You ended it on ${formatDateTime(grant.revokedAt)}` : `Expired on ${formatDateTime(grant.expiresAt)}`;

const doctorName = (grant: EmergencyAccess) => grant.doctor?.name ?? 'A doctor';
const documentTitle = (grant: EmergencyAccess) => grant.document?.title ?? 'a record';

/** The badge that makes a return after a revoke impossible to miss, wherever the grant is shown. */
const RegrantBadge = () => (
  <span className="inline-flex items-center gap-1 rounded-md border border-amber-300/50 bg-amber-300/15 px-2 py-1 text-xs font-semibold text-amber-100">
    <AlertTriangle className="h-3.5 w-3.5" />
    Re-opened after you revoked
  </span>
);

export default function EmergencyAccessPanel() {
  const [grants, setGrants] = useState<EmergencyAccess[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async (options: { quiet?: boolean } = {}) => {
    if (options.quiet) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }

    try {
      // `all` in one call: the live set is derived below with the same expiry rule the server uses, which
      // keeps the countdown and the list consistent without a second round trip.
      const allGrants = await emergencyAccessService.list('all');
      setGrants(allGrants);
      setNow(Date.now());
      setError(null);
    } catch (requestError) {
      setError(getApiErrorMessage(requestError));
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // The first fetch is deferred by a tick rather than run in the effect body, so this reads as a
    // subscription to server state instead of a synchronous setState (same shape as AnchorPanel).
    const timeoutId = window.setTimeout(() => void load(), 0);
    const intervalId = window.setInterval(() => void load({ quiet: true }), REFRESH_INTERVAL_MS);

    return () => {
      window.clearTimeout(timeoutId);
      window.clearInterval(intervalId);
    };
  }, [load]);

  // Only tick while something could still be counting down.
  const hasActiveRow = grants.some((grant) => grant.status === 'ACTIVE');

  useEffect(() => {
    if (!hasActiveRow) {
      return;
    }

    const intervalId = window.setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [hasActiveRow]);

  useEffect(() => {
    if (!notice) {
      return;
    }

    const timeoutId = window.setTimeout(() => setNotice(null), NOTICE_TIMEOUT_MS);
    return () => window.clearTimeout(timeoutId);
  }, [notice]);

  const liveGrants = useMemo(() => grants.filter((grant) => isLive(grant, now)), [grants, now]);
  const pastGrants = useMemo(() => grants.filter((grant) => !isLive(grant, now)), [grants, now]);
  const regrantCount = liveGrants.filter((grant) => grant.afterRevocation).length;

  const handleRevoke = async (grant: EmergencyAccess) => {
    setRevokingId(grant.id);
    setError(null);
    setNotice(null);

    try {
      await emergencyAccessService.revoke(grant.id);
      setConfirmingId(null);
      setNotice(`${doctorName(grant)} no longer has emergency access to "${documentTitle(grant)}". It ends on their next request.`);
      await load({ quiet: true });
    } catch (requestError) {
      // 409 means the grant stopped being ACTIVE between render and click — it lapsed, or the expiry job
      // got there first. Nothing failed and nothing is left to revoke, so this is a refresh, not an error.
      if (getApiErrorStatus(requestError) === 409) {
        setConfirmingId(null);
        setNotice('That access had already ended on its own — nothing left to revoke.');
        await load({ quiet: true });
        return;
      }

      setError(getApiErrorMessage(requestError));
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <div className="rounded-lg border border-white/10 bg-slate-900/70 p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-md bg-rose-400/10">
            <ShieldAlert className="h-5 w-5 text-rose-200" />
          </span>
          <div>
            <h2 className="text-lg font-semibold text-white">Emergency access on your records</h2>
            <p className="mt-1 text-sm text-slate-400">
              A doctor can break glass to read a record without waiting for your approval. Every use is logged and anchored on-chain, and you can end
              any of them immediately.
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0"
          onClick={() => void load({ quiet: true })}
          disabled={isLoading || isRefreshing}
        >
          {isRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      </div>

      {notice ? (
        <div aria-live="polite" className="mt-5 rounded-md border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-sm text-cyan-100">
          {notice}
        </div>
      ) : null}

      {error ? <div className="mt-5 rounded-md border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-sm text-rose-100">{error}</div> : null}

      {regrantCount > 0 ? (
        <div className="mt-5 flex items-start gap-2 rounded-md border border-amber-300/40 bg-amber-300/10 px-3 py-3 text-sm leading-6 text-amber-100">
          <AlertTriangle className="mt-1 h-4 w-4 shrink-0" />
          <span>
            {regrantCount === 1 ? 'One doctor has' : `${regrantCount} doctors have`} re-opened emergency access after you revoked it. Revoking works —
            it ends the session immediately — but it cannot stop a doctor from breaking glass again, so the return is flagged here and recorded in
            your audit trail.
          </span>
        </div>
      ) : null}

      {isLoading ? (
        <div className="mt-5 flex items-center gap-2 rounded-md border border-dashed border-white/15 bg-slate-950/60 p-5 text-sm text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking emergency access&hellip;
        </div>
      ) : liveGrants.length > 0 ? (
        <div className="mt-5 space-y-3">
          {liveGrants.map((grant) => (
            <div
              key={grant.id}
              className={cn(
                'rounded-md border p-4 text-sm',
                grant.afterRevocation ? 'border-amber-300/50 bg-amber-300/[0.07]' : 'border-rose-400/30 bg-rose-500/[0.07]'
              )}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-white">{doctorName(grant)}</p>
                    <span className="inline-flex items-center gap-1.5 rounded-md border border-rose-400/40 bg-rose-500/20 px-2 py-1 text-xs font-semibold text-rose-100">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-300" />
                      Active now
                    </span>
                    {grant.afterRevocation ? <RegrantBadge /> : null}
                  </div>
                  <p className="mt-2 text-slate-200">{documentTitle(grant)}</p>
                  <p className="mt-1 text-slate-400">Reason given: {grant.reason}</p>
                  <p className="mt-2 text-xs text-slate-500">
                    Started {formatDateTime(grant.createdAt)} &middot; ends {formatDateTime(grant.expiresAt)}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
                  <span className="inline-flex items-center gap-1.5 rounded-md bg-white/[0.06] px-2 py-1 font-mono text-sm text-slate-100">
                    <Clock className="h-4 w-4 text-slate-400" />
                    {formatRemaining(grant.expiresAt, now)}
                  </span>
                  {confirmingId === grant.id ? null : (
                    <Button type="button" variant="destructive" size="sm" onClick={() => setConfirmingId(grant.id)}>
                      <ShieldOff className="h-4 w-4" />
                      Revoke access
                    </Button>
                  )}
                </div>
              </div>

              {confirmingId === grant.id ? (
                <div className="mt-4 rounded-md border border-white/10 bg-slate-950/70 p-4">
                  <p className="text-slate-200">
                    End {doctorName(grant)}&rsquo;s emergency access to &ldquo;{documentTitle(grant)}&rdquo; now?
                  </p>
                  <p className="mt-1 text-xs leading-5 text-slate-400">
                    They lose access on their next request. This cannot be undone for this session — if they still need the record they will have to
                    break glass again, which will be flagged here.
                  </p>
                  <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <Button type="button" variant="secondary" size="sm" onClick={() => setConfirmingId(null)} disabled={revokingId === grant.id}>
                      Keep access active
                    </Button>
                    <Button type="button" variant="destructive" size="sm" onClick={() => void handleRevoke(grant)} disabled={revokingId === grant.id}>
                      {revokingId === grant.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldOff className="h-4 w-4" />}
                      Yes, end access now
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-5 rounded-md border border-dashed border-white/15 bg-slate-950/60 p-5 text-sm text-slate-400">
          No doctor has emergency access to your records right now.
        </div>
      )}

      {pastGrants.length > 0 ? (
        <div className="mt-5 border-t border-white/10 pt-4">
          <button
            type="button"
            aria-expanded={isHistoryOpen}
            onClick={() => setIsHistoryOpen((open) => !open)}
            className="flex w-full items-center justify-between gap-2 rounded-md px-1 py-2 text-sm text-slate-300 transition-colors hover:text-white"
          >
            <span className="flex items-center gap-2">
              <History className="h-4 w-4 text-slate-400" />
              Past emergency access ({pastGrants.length})
            </span>
            {isHistoryOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>

          {isHistoryOpen ? (
            <div className="mt-3 space-y-2">
              {pastGrants.map((grant) => (
                <div key={grant.id} className="rounded-md border border-white/10 bg-slate-950/50 p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-slate-200">{doctorName(grant)}</p>
                    <span
                      className={cn(
                        'rounded-md px-2 py-0.5 text-xs font-semibold',
                        grant.status === 'REVOKED' ? 'bg-cyan-300/10 text-cyan-100' : 'bg-white/[0.06] text-slate-300'
                      )}
                    >
                      {grant.status === 'REVOKED' ? 'Revoked by you' : 'Expired'}
                    </span>
                    {grant.afterRevocation ? <RegrantBadge /> : null}
                  </div>
                  <p className="mt-1 text-slate-400">{documentTitle(grant)}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {describeEnding(grant)} &middot; reason given: {grant.reason}
                  </p>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
