import DashboardShell from '../../components/dashboard/DashboardShell';

const metrics = [
  { label: 'Registered users', value: '0', tone: 'text-emerald-300' },
  { label: 'System alerts', value: '0', tone: 'text-rose-300' },
  { label: 'Policy checks', value: 'Ready', tone: 'text-cyan-300' },
];

export default function AdminDashboard() {
  return (
    <DashboardShell
      title="Admin Dashboard"
      subtitle="Monitor access governance, user roles, and operational health from the administrator workspace."
      metrics={metrics}
    >
      <div className="rounded-lg border border-white/10 bg-slate-900/70 p-6">
        <h2 className="text-lg font-semibold text-white">User Governance</h2>
        <div className="mt-5 rounded-md border border-dashed border-white/15 bg-slate-950/60 p-6 text-sm text-slate-400">
          User management modules will appear here as Phase 1 expands.
        </div>
      </div>

      <div className="rounded-lg border border-white/10 bg-slate-900/70 p-6">
        <h2 className="text-lg font-semibold text-white">Security Posture</h2>
        <div className="mt-5 space-y-3 text-sm text-slate-400">
          <div className="flex items-center justify-between rounded-md bg-white/[0.03] px-4 py-3">
            <span>JWT auth</span>
            <span className="text-emerald-200">Online</span>
          </div>
          <div className="flex items-center justify-between rounded-md bg-white/[0.03] px-4 py-3">
            <span>RBAC routes</span>
            <span className="text-emerald-200">Online</span>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
