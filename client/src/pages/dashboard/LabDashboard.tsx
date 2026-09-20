import { FlaskConical } from 'lucide-react';
import DashboardShell from '../../components/dashboard/DashboardShell';
import { useAuthStore } from '../../store/useAuthStore';

/**
 * Placeholder so a lab login lands on a role-appropriate page. The real lab workspace (patient linking,
 * report upload with test values) is built by the lab-UI owner against docs/API_LAB.md.
 */
export default function LabDashboard() {
  const user = useAuthStore((state) => state.user);

  return (
    <DashboardShell
      title="Lab Dashboard"
      subtitle="Request patient authorisation, then upload verified reports into their vault."
      metrics={[
        { label: 'Organisation', value: user?.organisation ?? '—', tone: 'text-emerald-300' },
        { label: 'Linked patients', value: '—', tone: 'text-cyan-300' },
        { label: 'Reports issued', value: '—', tone: 'text-amber-300' },
      ]}
    >
      <div className="rounded-lg border border-dashed border-white/15 bg-slate-900/70 p-8 text-center xl:col-span-2">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-emerald-300/10">
          <FlaskConical className="h-5 w-5 text-emerald-200" />
        </span>
        <h2 className="mt-4 text-lg font-semibold text-white">Lab workspace — UI in progress</h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-400">
          The server side is live: <code className="text-slate-200">POST /api/lab-links</code>,{' '}
          <code className="text-slate-200">GET /api/lab-links</code> and{' '}
          <code className="text-slate-200">POST /api/lab/reports</code>. See <code className="text-slate-200">docs/API_LAB.md</code>.
        </p>
      </div>
    </DashboardShell>
  );
}
