import {
  Activity,
  BadgeCheck,
  Bell,
  CheckCircle2,
  Database,
  Download,
  Eye,
  FileSearch,
  FileUp,
  FlaskConical,
  Link2,
  Link2Off,
  Loader2,
  LogIn,
  Pencil,
  Search,
  Share2,
  ShieldAlert,
  ShieldCheck,
  Siren,
  TimerOff,
  Trash2,
  UserPlus,
  UsersRound,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import DashboardShell from '../../components/dashboard/DashboardShell';
import { getApiErrorMessage } from '../../lib/api';
import { auditService } from '../../services/audit.service';
import type { AuditAction, AuditSummary } from '../../types/audit';

const actionLabels: Record<AuditAction, string> = {
  USER_LOGIN: 'User login',
  DOCUMENT_UPLOAD: 'Document upload',
  DOCUMENT_ACCESS: 'Document access',
  DOCUMENT_PREVIEW: 'Document preview',
  DOCUMENT_DOWNLOAD: 'Document download',
  DOCUMENT_SHARE: 'Document sharing',
  DOCUMENT_UNSHARED: 'Document unshared',
  DOCUMENT_DELETED: 'Document deleted',
  DOCUMENT_UPDATED: 'Document updated',
  INTEGRITY_VERIFIED: 'Integrity check',
  DOCUMENT_INTEGRITY_FAILED: 'Integrity FAILURE',
  CONSENT_REQUESTED: 'Consent requested',
  CONSENT_APPROVED: 'Consent approved',
  CONSENT_REJECTED: 'Consent rejected',
  CONSENT_REVOKED: 'Consent revoked',
  EMERGENCY_ACCESS_GRANTED: 'Emergency access granted',
  EMERGENCY_ACCESS_REVOKED: 'Emergency access revoked',
  EMERGENCY_ACCESS_EXPIRED: 'Emergency access expired',
  PATIENT_LOOKUP: 'Patient lookup',
  LAB_LINK_REQUESTED: 'Lab link requested',
  LAB_LINKED: 'Lab linked',
  LAB_LINK_REJECTED: 'Lab link rejected',
  LAB_UNLINKED: 'Lab unlinked',
  LAB_REPORT_UPLOADED: 'Lab report uploaded',
  NOTIFICATION_SENT: 'Notification sent',
  ADMIN_CREATED: 'Admin created',
  DOCTOR_VERIFIED: 'Doctor verified',
  LAB_CREATED: 'Lab created',
  CHAIN_ANCHOR_FAILED: 'On-chain anchor FAILED',
};

const actionStyles: Record<AuditAction, string> = {
  USER_LOGIN: 'bg-cyan-300/10 text-cyan-100',
  DOCUMENT_UPLOAD: 'bg-emerald-300/10 text-emerald-100',
  DOCUMENT_ACCESS: 'bg-amber-300/10 text-amber-100',
  DOCUMENT_PREVIEW: 'bg-sky-300/10 text-sky-100',
  DOCUMENT_DOWNLOAD: 'bg-rose-300/10 text-rose-100',
  DOCUMENT_SHARE: 'bg-violet-300/10 text-violet-100',
  DOCUMENT_UNSHARED: 'bg-violet-300/10 text-violet-100',
  DOCUMENT_DELETED: 'bg-rose-400/15 text-rose-100',
  DOCUMENT_UPDATED: 'bg-sky-300/10 text-sky-100',
  INTEGRITY_VERIFIED: 'bg-emerald-300/10 text-emerald-100',
  DOCUMENT_INTEGRITY_FAILED: 'bg-rose-500/20 text-rose-100',
  CONSENT_REQUESTED: 'bg-cyan-300/10 text-cyan-100',
  CONSENT_APPROVED: 'bg-emerald-300/10 text-emerald-100',
  CONSENT_REJECTED: 'bg-amber-300/10 text-amber-100',
  CONSENT_REVOKED: 'bg-rose-300/10 text-rose-100',
  EMERGENCY_ACCESS_GRANTED: 'bg-rose-400/15 text-rose-100',
  EMERGENCY_ACCESS_REVOKED: 'bg-rose-300/10 text-rose-100',
  EMERGENCY_ACCESS_EXPIRED: 'bg-slate-300/10 text-slate-200',
  PATIENT_LOOKUP: 'bg-amber-300/10 text-amber-100',
  LAB_LINK_REQUESTED: 'bg-cyan-300/10 text-cyan-100',
  LAB_LINKED: 'bg-emerald-300/10 text-emerald-100',
  LAB_LINK_REJECTED: 'bg-amber-300/10 text-amber-100',
  LAB_UNLINKED: 'bg-rose-300/10 text-rose-100',
  LAB_REPORT_UPLOADED: 'bg-emerald-300/10 text-emerald-100',
  NOTIFICATION_SENT: 'bg-slate-300/10 text-slate-200',
  ADMIN_CREATED: 'bg-violet-300/10 text-violet-100',
  DOCTOR_VERIFIED: 'bg-emerald-300/10 text-emerald-100',
  LAB_CREATED: 'bg-violet-300/10 text-violet-100',
  CHAIN_ANCHOR_FAILED: 'bg-rose-500/20 text-rose-100',
};

const actionDescriptions: Record<AuditAction, string> = {
  USER_LOGIN: 'Authenticated session started',
  DOCUMENT_UPLOAD: 'Patient added a medical record',
  DOCUMENT_ACCESS: 'Authorized record details opened',
  DOCUMENT_PREVIEW: 'Secure in-app document preview opened',
  DOCUMENT_DOWNLOAD: 'Authorized document download started',
  DOCUMENT_SHARE: 'Patient granted doctor access',
  DOCUMENT_UNSHARED: 'Patient removed doctor access',
  DOCUMENT_DELETED: 'Document removed from the vault',
  DOCUMENT_UPDATED: 'Document metadata changed',
  INTEGRITY_VERIFIED: 'File hash compared against the blockchain record',
  DOCUMENT_INTEGRITY_FAILED: 'Encrypted file failed authentication — tampering or disk corruption',
  CONSENT_REQUESTED: 'Doctor requested patient-approved document access',
  CONSENT_APPROVED: 'Patient approved document access',
  CONSENT_REJECTED: 'Patient rejected document access',
  CONSENT_REVOKED: 'Patient revoked document access',
  EMERGENCY_ACCESS_GRANTED: 'Doctor received time-limited Break-Glass access',
  EMERGENCY_ACCESS_REVOKED: 'Break-Glass access was revoked before expiry',
  EMERGENCY_ACCESS_EXPIRED: 'Break-Glass access window lapsed',
  PATIENT_LOOKUP: 'Doctor or lab looked up a patient by email or ID',
  LAB_LINK_REQUESTED: 'Lab asked a patient for upload authorisation',
  LAB_LINKED: 'Patient authorised a lab to upload reports',
  LAB_LINK_REJECTED: 'Patient declined a lab link request',
  LAB_UNLINKED: 'Patient revoked a lab authorisation',
  LAB_REPORT_UPLOADED: 'Lab uploaded a verified report to a patient vault',
  NOTIFICATION_SENT: 'In-app notification delivered',
  ADMIN_CREATED: 'Administrator account created',
  DOCTOR_VERIFIED: 'Admin verified a doctor account',
  LAB_CREATED: 'Admin provisioned a lab account',
  CHAIN_ANCHOR_FAILED: 'Audit event could not be anchored on-chain after the retry cap — needs attention',
};

const formatDateTime = (value: string) =>
  new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));

const actionIcons: Record<AuditAction, typeof Eye> = {
  USER_LOGIN: LogIn,
  DOCUMENT_UPLOAD: FileUp,
  DOCUMENT_ACCESS: Eye,
  DOCUMENT_PREVIEW: FileSearch,
  DOCUMENT_DOWNLOAD: Download,
  DOCUMENT_SHARE: Share2,
  DOCUMENT_UNSHARED: Link2Off,
  DOCUMENT_DELETED: Trash2,
  DOCUMENT_UPDATED: Pencil,
  INTEGRITY_VERIFIED: ShieldCheck,
  DOCUMENT_INTEGRITY_FAILED: ShieldAlert,
  CONSENT_REQUESTED: Share2,
  CONSENT_APPROVED: CheckCircle2,
  CONSENT_REJECTED: XCircle,
  CONSENT_REVOKED: XCircle,
  EMERGENCY_ACCESS_GRANTED: Siren,
  EMERGENCY_ACCESS_REVOKED: XCircle,
  EMERGENCY_ACCESS_EXPIRED: TimerOff,
  PATIENT_LOOKUP: Search,
  LAB_LINK_REQUESTED: Link2,
  LAB_LINKED: Link2,
  LAB_LINK_REJECTED: Link2Off,
  LAB_UNLINKED: Link2Off,
  LAB_REPORT_UPLOADED: FlaskConical,
  NOTIFICATION_SENT: Bell,
  ADMIN_CREATED: UserPlus,
  DOCTOR_VERIFIED: BadgeCheck,
  LAB_CREATED: FlaskConical,
  CHAIN_ANCHOR_FAILED: Link2Off,
};

const AuditActionIcon = ({ action }: { action: AuditAction }) => {
  const Icon = actionIcons[action];
  return <Icon className="h-4 w-4" />;
};

export default function AdminDashboard() {
  const [summary, setSummary] = useState<AuditSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);

  const loadSummary = useCallback(async () => {
    setIsLoading(true);
    setPageError(null);

    try {
      setSummary(await auditService.getSummary());
    } catch (error) {
      setPageError(getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const metrics = useMemo(
    () => [
      { label: 'Registered users', value: String(summary?.totalUsers ?? 0), tone: 'text-emerald-300' },
      { label: 'Medical documents', value: String(summary?.totalDocuments ?? 0), tone: 'text-cyan-300' },
      { label: 'Recent activity', value: String(summary?.recentActivity.length ?? 0), tone: 'text-amber-300' },
    ],
    [summary]
  );

  return (
    <DashboardShell
      title="Admin Dashboard"
      subtitle="Monitor platform activity, document volume, and access events across JeevanLocker."
      metrics={metrics}
    >
      <div className="rounded-lg border border-white/10 bg-slate-900/70 p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-md bg-emerald-300/10">
            <Activity className="h-5 w-5 text-emerald-200" />
          </span>
          <div>
            <h2 className="text-lg font-semibold text-white">Recent Activity Logs</h2>
            <p className="mt-1 text-sm text-slate-400">Latest login, upload, access, and sharing events.</p>
          </div>
        </div>

        {pageError ? (
          <div className="mt-5 rounded-md border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">
            {pageError}
          </div>
        ) : null}

        {isLoading ? (
          <div className="mt-5 rounded-lg border border-white/10 bg-slate-950/60 p-5">
            <div className="flex items-center gap-2 text-sm text-slate-300">
              <Loader2 className="h-4 w-4 animate-spin text-emerald-300" />
              Loading audit summary...
            </div>
            <div className="mt-4 space-y-3">
              <div className="h-16 rounded-md bg-white/[0.03]" />
              <div className="h-16 rounded-md bg-white/[0.025]" />
              <div className="h-16 rounded-md bg-white/[0.02]" />
            </div>
          </div>
        ) : summary && summary.recentActivity.length > 0 ? (
          <div className="mt-5 max-h-[520px] overflow-y-auto rounded-md border border-white/10">
            <div className="divide-y divide-white/10">
              {summary.recentActivity.map((log) => (
                <div key={log.id} className="bg-slate-950/50 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold ${actionStyles[log.action]}`}
                        >
                          <AuditActionIcon action={log.action} />
                          {actionLabels[log.action]}
                        </span>
                        <span className="rounded-md bg-white/[0.04] px-2 py-1 text-xs text-slate-400">
                          {log.user.role}
                        </span>
                      </div>
                      <p className="mt-3 text-sm font-semibold text-white">{log.user.name}</p>
                      <p className="mt-1 text-xs leading-5 text-slate-400">{actionDescriptions[log.action]}</p>
                      {log.targetDocument ? (
                        <p className="mt-2 truncate text-xs text-slate-300">{log.targetDocument.title}</p>
                      ) : null}
                      {log.metadata?.reason ? (
                        <p className="mt-2 text-xs leading-5 text-rose-100/90">Reason: {log.metadata.reason}</p>
                      ) : null}
                      {log.metadata?.purpose ? (
                        <p className="mt-2 text-xs leading-5 text-cyan-100/90">Purpose: {log.metadata.purpose}</p>
                      ) : null}
                      {log.metadata?.accessMethod === 'emergency' ? (
                        <p className="mt-2 text-xs leading-5 text-rose-100/90">
                          Emergency access used{log.metadata.expiresAt ? ` · Expires ${formatDateTime(log.metadata.expiresAt)}` : ''}
                        </p>
                      ) : null}
                      {log.action === 'EMERGENCY_ACCESS_GRANTED' && log.metadata?.expiresAt ? (
                        <p className="mt-2 text-xs leading-5 text-rose-100/90">
                          Expires {formatDateTime(log.metadata.expiresAt)}
                        </p>
                      ) : null}
                      {log.action === 'EMERGENCY_ACCESS_EXPIRED' && log.metadata?.expiresAt ? (
                        <p className="mt-2 text-xs leading-5 text-slate-300">
                          Expired {formatDateTime(log.metadata.expiresAt)}
                        </p>
                      ) : null}
                      {log.action === 'DOCUMENT_INTEGRITY_FAILED' && log.metadata?.reason ? (
                        <p className="mt-2 text-xs font-semibold leading-5 text-rose-200">
                          Reason: {log.metadata.reason}
                          {log.metadata.operation ? ` · during ${log.metadata.operation}` : ''}
                        </p>
                      ) : null}
                      {log.action === 'INTEGRITY_VERIFIED' && log.metadata?.integrityVerified ? (
                        <p
                          className={`mt-2 text-xs font-semibold leading-5 ${
                            log.metadata.integrityVerified === 'true' ? 'text-emerald-200' : 'text-rose-200'
                          }`}
                        >
                          {log.metadata.integrityVerified === 'true' ? 'Result: hash matches blockchain' : 'Result: HASH MISMATCH'}
                        </p>
                      ) : null}
                    </div>
                    <div className="shrink-0 text-left text-xs leading-5 text-slate-500 sm:text-right">
                      <p>{formatDateTime(log.timestamp)}</p>
                      <p className="truncate sm:max-w-32">{log.ipAddress}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="mt-5 rounded-lg border border-dashed border-white/15 bg-slate-950/60 p-8 text-center">
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-white/[0.04]">
              <Activity className="h-5 w-5 text-slate-300" />
            </span>
            <h3 className="mt-4 text-sm font-semibold text-white">No audit events yet</h3>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-slate-400">
              Login, upload, access, and sharing events will appear once users begin using the platform.
            </p>
          </div>
        )}
      </div>

      <div className="rounded-lg border border-white/10 bg-slate-900/70 p-6">
        <h2 className="text-lg font-semibold text-white">System Totals</h2>
        <p className="mt-1 text-sm text-slate-400">Live operational counts from the database.</p>
        <div className="mt-5 space-y-3 text-sm text-slate-300">
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2">
                <UsersRound className="h-4 w-4 text-emerald-300" />
                Total users
              </span>
              <span className="text-lg font-semibold text-white">{summary?.totalUsers ?? 0}</span>
            </div>
            <p className="mt-1 text-xs text-slate-500">Patients, doctors, and admins</p>
          </div>
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2">
                <Database className="h-4 w-4 text-cyan-300" />
                Total documents
              </span>
              <span className="text-lg font-semibold text-white">{summary?.totalDocuments ?? 0}</span>
            </div>
            <p className="mt-1 text-xs text-slate-500">Uploaded medical records</p>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
