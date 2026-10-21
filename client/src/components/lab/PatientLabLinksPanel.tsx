import { Building2, CheckCircle2, FlaskConical, Loader2, RefreshCw, Unlink, XCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getApiErrorMessage, getApiErrorStatus } from '../../lib/api';
import { labService } from '../../services/lab.service';
import type { LabLink } from '../../types/lab';
import { Button } from '../ui/button';

/**
 * The patient's side of the lab flow: which labs are asking to upload into this vault, and which may.
 *
 * A lab link is lab-initiated and patient-approved (docs/API_LAB.md §2). Until the patient approves, the lab can
 * upload nothing; revoking stops every future upload, while reports the lab already issued stay readable by it,
 * because a lab must be able to stand behind what it signed. The revoke confirmation says exactly that, so the
 * patient is not surprised to find the lab still lists its old reports.
 *
 * After every action the list is reloaded from the server rather than patched locally: a 409 means someone (another
 * tab, a double-click) already decided, and only the server knows what was decided.
 *
 * Self-contained on purpose: it fetches and refreshes its own data, so mounting it costs one line.
 */

const REFRESH_INTERVAL_MS = 30_000;
const NOTICE_TIMEOUT_MS = 7_000;

type LinkAction = 'approve' | 'reject' | 'revoke';

const formatDateTime = (value: string) =>
  new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(
    new Date(value)
  );

/** The organisation is what a patient recognises; the account name is shown beside it when it differs. */
const labTitle = (link: LabLink) => link.lab.organisation ?? link.lab.name;

const NOTICE_BY_ACTION: Record<LinkAction, (link: LabLink) => string> = {
  approve: (link) => `${labTitle(link)} can now upload verified reports to your vault.`,
  reject: (link) => `You declined ${labTitle(link)}'s request.`,
  revoke: (link) => `${labTitle(link)} can no longer upload to your vault. Reports it already issued stay in your vault.`,
};

export default function PatientLabLinksPanel() {
  const [links, setLinks] = useState<LabLink[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [confirmingRevokeId, setConfirmingRevokeId] = useState<string | null>(null);

  const load = useCallback(async (options: { quiet?: boolean } = {}) => {
    if (options.quiet) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }

    try {
      setLinks(await labService.getLinks());
      setError(null);
    } catch (requestError) {
      setError(getApiErrorMessage(requestError));
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // Deferred by a tick, not run in the effect body (same shape as EmergencyAccessPanel and AnchorPanel).
    const timeoutId = window.setTimeout(() => void load(), 0);
    const intervalId = window.setInterval(() => void load({ quiet: true }), REFRESH_INTERVAL_MS);

    return () => {
      window.clearTimeout(timeoutId);
      window.clearInterval(intervalId);
    };
  }, [load]);

  useEffect(() => {
    if (!notice) {
      return;
    }

    const timeoutId = window.setTimeout(() => setNotice(null), NOTICE_TIMEOUT_MS);
    return () => window.clearTimeout(timeoutId);
  }, [notice]);

  const pendingLinks = useMemo(() => links.filter((link) => link.status === 'PENDING'), [links]);
  const activeLinks = useMemo(() => links.filter((link) => link.status === 'ACTIVE'), [links]);

  const act = async (link: LabLink, action: LinkAction) => {
    setActingId(link.id);
    setError(null);
    setNotice(null);

    try {
      if (action === 'approve') await labService.approveLink(link.id);
      if (action === 'reject') await labService.rejectLink(link.id);
      if (action === 'revoke') await labService.revokeLink(link.id);
      setConfirmingRevokeId(null);
      setNotice(NOTICE_BY_ACTION[action](link));
    } catch (requestError) {
      // 409: the link was already decided (another tab, a double-click). Nothing failed; show what the server holds.
      if (getApiErrorStatus(requestError) === 409) {
        setConfirmingRevokeId(null);
        setNotice('That request was already answered. The list below is up to date.');
      } else {
        setError(getApiErrorMessage(requestError));
      }
    } finally {
      setActingId(null);
      await load({ quiet: true });
    }
  };

  const renderLab = (link: LabLink, when: string) => (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-semibold text-white">{labTitle(link)}</p>
        {link.lab.organisation && link.lab.organisation !== link.lab.name ? (
          <span className="text-xs text-slate-500">account: {link.lab.name}</span>
        ) : null}
      </div>
      <p className="mt-2 text-xs text-slate-500">{when}</p>
    </div>
  );

  return (
    <div className="rounded-lg border border-white/10 bg-slate-900/70 p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-md bg-emerald-300/10">
            <FlaskConical className="h-5 w-5 text-emerald-200" />
          </span>
          <div>
            <h2 className="text-lg font-semibold text-white">Diagnostic labs</h2>
            <p className="mt-1 text-sm text-slate-400">
              A lab can upload verified reports to your vault only after you approve it. You can revoke a lab at any time.
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

      {isLoading ? (
        <div className="mt-5 flex items-center gap-2 rounded-md border border-dashed border-white/15 bg-slate-950/60 p-5 text-sm text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading lab requests&hellip;
        </div>
      ) : (
        <div className="mt-5 space-y-5">
          <section aria-label="Pending lab requests">
            <h3 className="text-sm font-semibold text-slate-200">Requests waiting for you ({pendingLinks.length})</h3>
            {pendingLinks.length > 0 ? (
              <div className="mt-3 space-y-3">
                {pendingLinks.map((link) => (
                  <div key={link.id} className="rounded-md border border-amber-300/25 bg-amber-300/[0.05] p-4 text-sm">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      {renderLab(link, `Requested ${formatDateTime(link.requestedAt)}`)}
                      <div className="flex shrink-0 flex-wrap gap-2">
                        <Button type="button" variant="secondary" size="sm" onClick={() => void act(link, 'reject')} disabled={actingId === link.id}>
                          <XCircle className="h-4 w-4" />
                          Reject
                        </Button>
                        <Button type="button" size="sm" onClick={() => void act(link, 'approve')} disabled={actingId === link.id}>
                          {actingId === link.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                          Approve
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 rounded-md border border-dashed border-white/15 bg-slate-950/60 p-4 text-sm text-slate-400">
                No lab is waiting for your approval.
              </p>
            )}
          </section>

          <section aria-label="Approved labs">
            <h3 className="text-sm font-semibold text-slate-200">Labs that can upload to your vault ({activeLinks.length})</h3>
            {activeLinks.length > 0 ? (
              <div className="mt-3 space-y-3">
                {activeLinks.map((link) => (
                  <div key={link.id} className="rounded-md border border-emerald-300/20 bg-emerald-300/[0.04] p-4 text-sm">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      {renderLab(
                        link,
                        `Requested ${formatDateTime(link.requestedAt)}${link.approvedAt ? ` · approved ${formatDateTime(link.approvedAt)}` : ''}`
                      )}
                      {confirmingRevokeId === link.id ? null : (
                        <Button type="button" variant="destructive" size="sm" className="shrink-0" onClick={() => setConfirmingRevokeId(link.id)}>
                          <Unlink className="h-4 w-4" />
                          Revoke
                        </Button>
                      )}
                    </div>

                    {confirmingRevokeId === link.id ? (
                      <div className="mt-4 rounded-md border border-white/10 bg-slate-950/70 p-4">
                        <p className="flex items-center gap-2 text-slate-200">
                          <Building2 className="h-4 w-4 text-slate-400" />
                          Stop {labTitle(link)} from uploading to your vault?
                        </p>
                        <p className="mt-1 text-xs leading-5 text-slate-400">
                          Its next upload will be refused. Reports it already issued stay in your vault, and the lab can still see the reports it
                          issued, so it can stand behind them. To let it upload again, it has to send a new request.
                        </p>
                        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                          <Button type="button" variant="secondary" size="sm" onClick={() => setConfirmingRevokeId(null)} disabled={actingId === link.id}>
                            Keep it
                          </Button>
                          <Button type="button" variant="destructive" size="sm" onClick={() => void act(link, 'revoke')} disabled={actingId === link.id}>
                            {actingId === link.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlink className="h-4 w-4" />}
                            Yes, revoke
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 rounded-md border border-dashed border-white/15 bg-slate-950/60 p-4 text-sm text-slate-400">
                No lab can upload to your vault.
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
